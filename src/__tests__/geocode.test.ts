import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NOMINATIM_SEARCH,
  USER_AGENT,
  createCache,
  createGate,
  createGeocodeHandler,
  formatAddress,
  nominatim,
  parseResults,
  roughPoint,
  searchUrl,
  usStreet,
  viewboxAround,
} from '../../netlify/functions/lib/geocode.mjs'
import { slidingWindow } from '../../netlify/functions/lib/ratelimit.mjs'
// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import geocodeFunction from '../../netlify/functions/geocode.mjs'
import { centroidOf } from '../geo'
import { AREA_KEY, LOOKUP_GAP_MS, LookupError, NEEDS_SERVER, findAddress, lookupArea, lookupQuery, readTypedArea, resetLookupClock, writeTypedArea } from '../geocode'
import { withAddress } from '../places'
import type { Place } from '../types'

// Find address: a place's name looked up on OpenStreetMap, near the user's
// area, through Drafter's own server. These pin the pure helpers (the box, the
// request, the reading and wording of the answer, the one-a-second gate), the
// endpoint's sign-in gate and its answers, and the device's side.

/** Nominatim's jsonv2 for a Phoenix Chipotle and a bare address. */
const CHIPOTLE = {
  lat: '33.5091234',
  lon: '-112.0290987',
  name: 'Chipotle Mexican Grill',
  display_name: 'Chipotle Mexican Grill, 2502, East Camelback Road, Biltmore, Phoenix, Maricopa County, Arizona, 85016, United States',
  address: { amenity: 'Chipotle Mexican Grill', house_number: '2502', road: 'East Camelback Road', suburb: 'Biltmore', city: 'Phoenix', county: 'Maricopa County', state: 'Arizona', postcode: '85016', country: 'United States', country_code: 'us' },
}
const BARE = {
  lat: '33.4484',
  lon: '-112.074',
  name: '',
  display_name: '100, North Central Avenue, Phoenix, Arizona, 85004, United States',
  address: { house_number: '100', road: 'North Central Avenue', city: 'Phoenix', state: 'Arizona', postcode: '85004', country: 'United States', country_code: 'us' },
}

describe('the box a lookup leans to', () => {
  it('rounds the area to about a kilometre before anything leaves', () => {
    expect(roughPoint({ lat: 33.456789, lon: -112.074321 })).toEqual({ lat: 33.46, lon: -112.07 })
    expect(roughPoint({ lat: '33.4', lon: '-112' })).toEqual({ lat: 33.4, lon: -112 })
    expect(roughPoint({ lat: 91, lon: 0 })).toBeNull()
    expect(roughPoint({ lat: 33 })).toBeNull()
    expect(roughPoint(null)).toBeNull()
  })

  it('is left,top,right,bottom, about 50 km each way, wider in longitude away from the equator', () => {
    const [left, top, right, bottom] = viewboxAround({ lat: 33.45, lon: -112.07 }).split(',').map(Number)
    expect(top - 33.45).toBeCloseTo(50 / 111.32, 3)
    expect(33.45 - bottom).toBeCloseTo(50 / 111.32, 3)
    expect(right - left).toBeGreaterThan(top - bottom)
    expect((left + right) / 2).toBeCloseTo(-112.07, 3)
    // never past the ends of the map
    expect(viewboxAround({ lat: 89.9, lon: 179.9 }).split(',').map(Number).every(v => Math.abs(v) <= 180)).toBe(true)
  })

  it('asks Nominatim for jsonv2 with the address parts, five at most, kept to the box when bounded', () => {
    const url = new URL(searchUrl('Chipotle', { viewbox: '-112.6,33.9,-111.5,33', bounded: true }))
    expect(`${url.origin}${url.pathname}`).toBe(NOMINATIM_SEARCH)
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'Chipotle', format: 'jsonv2', addressdetails: '1', limit: '5', viewbox: '-112.6,33.9,-111.5,33', bounded: '1' })
    expect(new URL(searchUrl('Chipotle', { viewbox: '-112.6,33.9,-111.5,33' })).searchParams.has('bounded')).toBe(false)
    expect(new URL(searchUrl('Phoenix, AZ', { limit: 1 })).searchParams.get('viewbox')).toBeNull()
  })
})

describe('what comes back, in words', () => {
  it('writes a US address the way an envelope does', () => {
    expect(formatAddress(CHIPOTLE.address)).toBe('2502 E Camelback Rd, Phoenix, AZ 85016')
    expect(formatAddress(BARE.address)).toBe('100 N Central Ave, Phoenix, AZ 85004')
    expect(usStreet('West Indian School Road')).toBe('W Indian School Rd')
    // a word that only looks like one stays: "East" alone is a street's whole name
    expect(usStreet('East')).toBe('East')
  })

  it('writes one abroad in the same order, the region spelled out and the country last', () => {
    expect(formatAddress({ house_number: '21', road: 'Warwick Street', city: 'London', postcode: 'W1B 5NE', country: 'United Kingdom', country_code: 'gb' })).toBe('21 Warwick Street, London, W1B 5NE, United Kingdom')
  })

  it('falls back to the display name when the parts say nothing', () => {
    expect(formatAddress({}, '  Somewhere,   Arizona ')).toBe('Somewhere, Arizona')
    expect(formatAddress(undefined, '')).toBe('')
  })

  it('keeps a name, one line and the point to five decimals; drops the unusable and the repeated', () => {
    const out = parseResults([CHIPOTLE, BARE, CHIPOTLE, { ...BARE, lat: 'x' }, { lat: '1', lon: '2', display_name: '', address: {} }])
    expect(out).toEqual([
      { name: 'Chipotle Mexican Grill', address: '2502 E Camelback Rd, Phoenix, AZ 85016', lat: 33.50912, lon: -112.0291 },
      { name: '', address: '100 N Central Ave, Phoenix, AZ 85004', lat: 33.4484, lon: -112.074 },
    ])
    expect(parseResults({ error: 'nope' })).toEqual([])
    // nine branches: five at most
    expect(parseResults(Array.from({ length: 9 }, (_, i) => ({ ...CHIPOTLE, address: { ...CHIPOTLE.address, house_number: String(100 + i) } })))).toHaveLength(5)
  })
})

describe('one request a second', () => {
  it('lets the first go at once and holds each after it to a second past the one before', async () => {
    let t = 1_000
    const slept: number[] = []
    const gate = createGate(1000, { now: () => t, sleep: async ms => void slept.push(ms) })
    expect(await gate.wait()).toBe(true)
    t += 200
    expect(await gate.wait()).toBe(true)
    expect(await gate.wait()).toBe(true)
    // asked at 1200 and 1200: the turns are 2000 and 3000
    expect(slept).toEqual([800, 1800])
    t = 10_000
    slept.length = 0
    expect(await gate.wait()).toBe(true)
    expect(slept).toEqual([])
  })

  it('turns a request away rather than queue it past the limit', async () => {
    const t = 0
    const gate = createGate(1000, { now: () => t, sleep: async () => {} })
    for (let i = 0; i < 4; i++) expect(await gate.wait(3000)).toBe(true)
    expect(await gate.wait(3000)).toBe(false)
  })

  it('asks the same search once a day, from the cache', async () => {
    let t = 0
    const cache = createCache({ now: () => t })
    const fetchImpl = vi.fn(async () => Response.json([CHIPOTLE]))
    const url = searchUrl('Chipotle')
    await nominatim(url, { fetchImpl, cache })
    await nominatim(url, { fetchImpl, cache })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    t = 86_400_000
    await nominatim(url, { fetchImpl, cache })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('says who is asking, and answers a slow or broken Nominatim with a status', async () => {
    const seen: Headers[] = []
    await nominatim(searchUrl('x'), {
      fetchImpl: async (_url, init) => {
        seen.push(new Headers(init?.headers))
        return Response.json([])
      },
    })
    expect(seen[0].get('user-agent')).toBe(USER_AGENT)
    expect(USER_AGENT).toBe('Drafter/1.1 (+https://drafterz.netlify.app)')
    const slow = Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    await expect(nominatim(searchUrl('x'), { fetchImpl: async () => Promise.reject(slow) })).rejects.toMatchObject({ status: 504 })
    await expect(nominatim(searchUrl('x'), { fetchImpl: async () => new Response('busy', { status: 503 }) })).rejects.toMatchObject({ status: 502 })
    await expect(nominatim(searchUrl('x'), { fetchImpl: async () => Response.json({ not: 'a list' }) })).rejects.toMatchObject({ status: 502 })
  })
})

const SUPABASE = 'https://db.example.test'

describe('/api/geocode', () => {
  let asked: string[] = []
  const nominatimFake = vi.fn(async (url: string) => {
    asked.push(url)
    const q = new URL(url).searchParams
    if (q.get('q') === 'Phoenix, AZ') return Response.json([{ ...BARE, lat: '33.4484', lon: '-112.074', name: 'Phoenix' }])
    if (q.get('q') === 'Nowhere Diner') return Response.json([])
    return Response.json([CHIPOTLE, BARE])
  })

  beforeEach(() => {
    vi.stubEnv('SUPABASE_URL', SUPABASE)
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
    asked = []
    nominatimFake.mockClear()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === `${SUPABASE}/auth/v1/user`) {
          // "good-<id>" is a valid session for user <id>; anything else is refused
          const m = /^Bearer good-(.+)$/.exec(new Headers(init?.headers).get('authorization') ?? '')
          return m ? Response.json({ id: m[1], email: `${m[1]}@example.test` }) : Response.json({ msg: 'invalid JWT' }, { status: 401 })
        }
        if (url.startsWith(NOMINATIM_SEARCH)) return nominatimFake(url)
        throw new Error(`unexpected fetch ${url}`)
      }),
    )
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  const post = (body: unknown, token?: string, headers: Record<string, string> = {}) =>
    new Request('https://site.test/api/geocode', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) })
  /** A handler with a gate that never waits, so these run at once. */
  const handler = (over: Parameters<typeof createGeocodeHandler>[0] = {}) => createGeocodeHandler({ gate: { wait: async () => true }, cache: createCache(), ...over })

  describe('signed-in accounts only', () => {
    const endpoint = geocodeFunction as (req: Request) => Promise<Response>

    it('refuses a request without a session, before OpenStreetMap is asked', async () => {
      const res = await endpoint(post({ q: 'Chipotle' }))
      expect(res.status).toBe(401)
      expect(nominatimFake).not.toHaveBeenCalled()
    })

    it('refuses a session the auth server does not recognise', async () => {
      const res = await endpoint(post({ q: 'Chipotle' }, 'forged'))
      expect(res.status).toBe(401)
      expect(nominatimFake).not.toHaveBeenCalled()
    })

    it('answers 503 on a site with no auth settings, instead of serving anyone', async () => {
      vi.stubEnv('SUPABASE_URL', '')
      vi.stubEnv('SUPABASE_ANON_KEY', '')
      const res = await endpoint(post({ q: 'Chipotle' }, 'good-u1'))
      expect(res.status).toBe(503)
      expect(nominatimFake).not.toHaveBeenCalled()
    })

    it('serves a signed-in account, and the iPhone app’s origin gets its CORS headers', async () => {
      const res = await endpoint(post({ q: 'Chipotle', near: { lat: 33.45, lon: -112.07 } }, 'good-u1', { origin: 'capacitor://drafter' }))
      expect(res.status).toBe(200)
      expect(res.headers.get('access-control-allow-origin')).toBe('capacitor://drafter')
      expect((await res.json()).candidates[0]).toMatchObject({ name: 'Chipotle Mexican Grill', address: '2502 E Camelback Rd, Phoenix, AZ 85016' })
    })

    it('answers the preflight for the app shell, and refuses GET', async () => {
      const pre = await endpoint(new Request('https://site.test/api/geocode', { method: 'OPTIONS', headers: { origin: 'capacitor://drafter' } }))
      expect(pre.status).toBe(204)
      expect((await endpoint(new Request('https://site.test/api/geocode', { headers: { authorization: 'Bearer good-u1' } }))).status).toBe(405)
    })
  })

  it('keeps the search inside the area’s box, sending the rough area and the name, nothing else', async () => {
    const res = await handler()(post({ q: '  Chipotle  ', near: { lat: 33.456789, lon: -112.074321 } }, 'good-u1'))
    expect(res.status).toBe(200)
    expect(asked).toHaveLength(1)
    const q = new URL(asked[0]).searchParams
    expect(q.get('q')).toBe('Chipotle')
    expect(q.get('bounded')).toBe('1')
    expect(q.get('viewbox')).toBe(viewboxAround({ lat: 33.46, lon: -112.07 }))
    expect((await res.json()).candidates).toHaveLength(2)
  })

  it('looks a typed town up first, and hands its point back for the device to keep', async () => {
    const res = await handler()(post({ q: 'Chipotle', area: 'Phoenix, AZ' }, 'good-u1'))
    const body = await res.json()
    expect(body.area).toEqual({ lat: 33.45, lon: -112.07 })
    expect(asked.map(u => new URL(u).searchParams.get('q'))).toEqual(['Phoenix, AZ', 'Chipotle'])
    expect(new URL(asked[1]).searchParams.get('viewbox')).toBe(viewboxAround({ lat: 33.45, lon: -112.07 }))
  })

  it('tries once more without keeping to the box when nothing is in it', async () => {
    const res = await handler()(post({ q: 'Nowhere Diner', near: { lat: 33.45, lon: -112.07 } }, 'good-u1'))
    expect((await res.json()).candidates).toEqual([])
    expect(asked.map(u => new URL(u).searchParams.get('bounded'))).toEqual(['1', null])
  })

  it('needs something to look for', async () => {
    const res = await handler()(post({ q: '   ' }, 'good-u1'))
    expect(res.status).toBe(400)
    expect(asked).toEqual([])
  })

  it('stops an account that asks too often, and only that account', async () => {
    const h = handler({ perUser: slidingWindow({ limit: 2, windowMs: 60_000 }) })
    expect((await h(post({ q: 'Chipotle' }, 'good-busy'))).status).toBe(200)
    expect((await h(post({ q: 'Chipotle' }, 'good-busy'))).status).toBe(200)
    const refused = await h(post({ q: 'Chipotle' }, 'good-busy'))
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await h(post({ q: 'Chipotle' }, 'good-quiet'))).status).toBe(200)
  })

  it('says so when the queue is full or OpenStreetMap is down', async () => {
    const busy = await handler({ gate: { wait: async () => false } })(post({ q: 'Chipotle' }, 'good-u1'))
    expect(busy.status).toBe(429)
    const down = await handler({ fetchImpl: async () => new Response('', { status: 500 }) })(post({ q: 'Chipotle' }, 'good-u1'))
    expect(down.status).toBe(502)
    expect((await down.json()).error).toMatch(/OpenStreetMap could not answer/)
  })
})

describe('on the device', () => {
  const pinned = (id: string, lat: number, lon: number): Place => ({ kind: 'place', id, name: id, category: 'cafe', color: '#888888', lat, lon, createdAt: 'x', updatedAt: 'x' })
  const store = new Map<string, string>()
  beforeEach(() => {
    store.clear()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) })
    resetLookupClock()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('leans to the middle of your pinned places, else the weather’s location, else a town you typed', () => {
    const places = [pinned('a', 33.5, -112.1), pinned('b', 33.4, -111.9), { ...pinned('gone', 0, 0), deletedAt: 'x' }]
    expect(centroidOf(places)).toEqual({ lat: 33.45, lon: -112 })
    const weather = { enabled: true, lat: 33.4484, lon: -112.074 }
    expect(lookupArea(places, weather, null)).toMatchObject({ near: { lat: 33.45, lon: -112 }, from: 'places' })
    expect(lookupArea([], weather, null)).toMatchObject({ near: { lat: 33.45, lon: -112.07 }, from: 'weather' })
    // weather that is off is not a location
    expect(lookupArea([], { ...weather, enabled: false }, { text: 'Tempe, AZ' })).toEqual({ typed: 'Tempe, AZ', from: 'typed', label: 'near Tempe, AZ' })
    expect(lookupArea([], { enabled: false }, { text: 'Tempe, AZ', lat: 33.43, lon: -111.94 })).toMatchObject({ near: { lat: 33.43, lon: -111.94 }, from: 'typed' })
    expect(lookupArea([], { enabled: false }, null)).toBeNull()
  })

  it('keeps the typed town on this device, and forgets an empty one', () => {
    writeTypedArea({ text: '  Phoenix, AZ ' })
    expect(readTypedArea()).toEqual({ text: 'Phoenix, AZ' })
    writeTypedArea({ text: 'Phoenix, AZ', lat: 33.45, lon: -112.07 })
    expect(JSON.parse(store.get(AREA_KEY)!)).toEqual({ text: 'Phoenix, AZ', lat: 33.45, lon: -112.07 })
    writeTypedArea({ text: ' ' })
    expect(readTypedArea()).toBeNull()
  })

  it('sends the name and the rough area, and never two lookups within 1.1 s', async () => {
    let t = 50_000
    const slept: number[] = []
    const sent: unknown[] = []
    const deps = {
      now: () => t,
      sleep: async (ms: number) => {
        slept.push(ms)
        t += ms
      },
      fetch: async (_path: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)))
        return Response.json({ candidates: [{ name: 'Chipotle', address: '2502 E Camelback Rd, Phoenix, AZ 85016', lat: 33.50912, lon: -112.0291 }], area: { lat: 33.45, lon: -112.07 } })
      },
    }
    const first = await findAddress('Chipotle', { near: { lat: 33.45, lon: -112 }, from: 'places', label: '' }, deps)
    expect(first.candidates).toHaveLength(1)
    t += 300
    await findAddress('Nopi', { typed: 'Phoenix, AZ', from: 'typed', label: '' }, deps)
    expect(slept).toEqual([LOOKUP_GAP_MS - 300])
    expect(sent).toEqual([
      { q: 'Chipotle', near: { lat: 33.45, lon: -112 } },
      { q: 'Nopi', area: 'Phoenix, AZ' },
    ])
  })

  it('explains that a copy on its own needs Drafter’s server, and says sign in when that is what is wrong', async () => {
    const answer = (res: Response | Error) => ({ fetch: async () => (res instanceof Error ? Promise.reject(res) : res), sleep: async () => {} })
    // the app page where JSON was expected: served without the functions
    await expect(findAddress('x', null, answer(new Response('<!doctype html>', { status: 200 })))).rejects.toMatchObject({ message: NEEDS_SERVER, kind: 'server' })
    await expect(findAddress('x', null, answer(new Response('Not Found', { status: 404 })))).rejects.toMatchObject({ kind: 'server' })
    await expect(findAddress('x', null, answer(new Error('offline')))).rejects.toBeInstanceOf(LookupError)
    await expect(findAddress('x', null, answer(Response.json({ error: 'sign in required' }, { status: 401 })))).rejects.toMatchObject({ kind: 'signin' })
    await expect(findAddress('x', null, answer(Response.json({ error: 'Address lookups are busy right now.' }, { status: 429 })))).rejects.toMatchObject({ kind: 'busy', message: 'Address lookups are busy right now.' })
  })

  it('looks a place up by its name and the address as far as it is typed', () => {
    expect(lookupQuery(' Nopi ', ' Warwick   St ')).toBe('Nopi, Warwick St')
    expect(lookupQuery('Nopi', '')).toBe('Nopi')
  })

  it('a pick fills the address and the pin together, in the fields I’m here reads', () => {
    const cafe: Place = { kind: 'place', id: 'c', name: 'Cafe', category: 'cafe', color: '#888888', createdAt: 'x', updatedAt: 'x' }
    expect(withAddress(cafe, { address: '  2502 E Camelback Rd,  Phoenix, AZ 85016 ', lat: 33.509123456, lon: -112.029098765 })).toEqual({ ...cafe, address: '2502 E Camelback Rd, Phoenix, AZ 85016', lat: 33.50912, lon: -112.0291 })
  })
})
