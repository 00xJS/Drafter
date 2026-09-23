// Find address: a place's name looked up on OpenStreetMap (Nominatim), near
// where the user's places are. The endpoint is netlify/functions/geocode.mjs;
// everything it does lives here, pure where it can be: the box a search leans
// to, the request, reading and wording the answer, and the one-a-second gate
// Nominatim's usage policy asks for.
//
// What reaches OpenStreetMap is what the user typed as the place's name and a
// box around their rough area (a point rounded to about a kilometre, widened
// to ~50 km). Never an account, never another record.

import { slidingWindow } from './ratelimit.mjs'
import { requireUser } from './session.mjs'

export const NOMINATIM_SEARCH = 'https://nominatim.openstreetmap.org/search'
/** Nominatim refuses a generic client: the app says who it is and where it lives. */
export const USER_AGENT = 'Drafter/1.1 (+https://drafterz.netlify.app)'
export const MAX_CANDIDATES = 5
/** At most one request a second from an instance: Nominatim's own limit. */
export const REQUEST_GAP_MS = 1000
export const TIMEOUT_MS = 6000
/** How far round the user's area a search leans: a metro area, not a street. */
export const AREA_RADIUS_KM = 50
/** Longer than this in the queue and the request is turned away rather than kept waiting. */
export const MAX_QUEUE_MS = 3000
/** The whole request's budget, inside a function's own 10 s. */
export const BUDGET_MS = 9000
const MAX_QUERY = 200
const MAX_AREA = 100

/** A number that is a coordinate, or NaN. */
const coord = (v, max) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) && Math.abs(n) <= max ? n : NaN
}

/** A point to two decimals (about a kilometre): the rough area, never the doorstep. Null unless both ends are coordinates. */
export function roughPoint(raw) {
  const lat = coord(raw?.lat, 90)
  const lon = coord(raw?.lon, 180)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 }
}

/**
 * Nominatim's viewbox round a point: "left,top,right,bottom" in degrees, the
 * box `radiusKm` each way. A degree of longitude narrows towards the poles, so
 * its share is widened by the latitude (never past ten times, near a pole).
 */
export function viewboxAround(point, radiusKm = AREA_RADIUS_KM) {
  const dLat = radiusKm / 111.32
  const dLon = radiusKm / (111.32 * Math.max(0.1, Math.cos((point.lat * Math.PI) / 180)))
  const clamp = (v, max) => Math.max(-max, Math.min(max, v))
  const f = v => Number(v.toFixed(4))
  return [f(clamp(point.lon - dLon, 180)), f(clamp(point.lat + dLat, 90)), f(clamp(point.lon + dLon, 180)), f(clamp(point.lat - dLat, 90))].join(',')
}

/**
 * The search URL: jsonv2 with the parts of each address, at most `limit`, leaning to (or, bounded, kept inside) the box.
 * @param {string} q
 * @param {{ viewbox?: string | null, bounded?: boolean, limit?: number }} [options]
 */
export function searchUrl(q, { viewbox = null, bounded = false, limit = MAX_CANDIDATES } = {}) {
  const params = new URLSearchParams({ q, format: 'jsonv2', addressdetails: '1', limit: String(limit) })
  if (viewbox) {
    params.set('viewbox', viewbox)
    if (bounded) params.set('bounded', '1')
  }
  return `${NOMINATIM_SEARCH}?${params.toString()}`
}

const US_STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'puerto rico': 'PR', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN',
  texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
}

const DIRECTIONS = { north: 'N', south: 'S', east: 'E', west: 'W', northeast: 'NE', northwest: 'NW', southeast: 'SE', southwest: 'SW' }
const SUFFIXES = {
  street: 'St', avenue: 'Ave', road: 'Rd', boulevard: 'Blvd', drive: 'Dr', lane: 'Ln', court: 'Ct', place: 'Pl', parkway: 'Pkwy',
  highway: 'Hwy', circle: 'Cir', terrace: 'Ter', trail: 'Trl', square: 'Sq', freeway: 'Fwy', expressway: 'Expy',
}

/** "East Camelback Road" → "E Camelback Rd": the way a US envelope, and a calendar's location, writes a street. */
export function usStreet(road) {
  const words = String(road).trim().split(/\s+/)
  if (words.length > 1 && DIRECTIONS[words[0].toLowerCase()]) words[0] = DIRECTIONS[words[0].toLowerCase()]
  const last = words.length - 1
  if (last > 0 && SUFFIXES[words[last].toLowerCase()]) words[last] = SUFFIXES[words[last].toLowerCase()]
  return words.join(' ')
}

/**
 * Nominatim's address parts as one line a US reader expects: "2502 E Camelback
 * Rd, Phoenix, AZ 85016". Outside the US the same order, the region spelled
 * out and the country last. Nothing usable falls back to `fallback`
 * (Nominatim's own display name).
 */
export function formatAddress(a, fallback = '') {
  const parts = a && typeof a === 'object' ? a : {}
  const us = String(parts.country_code ?? '').toLowerCase() === 'us'
  const road = parts.road ?? parts.pedestrian ?? parts.footway ?? parts.square ?? parts.path
  const street = [parts.house_number, road ? (us ? usStreet(road) : road) : null].filter(Boolean).join(' ')
  const town = parts.city ?? parts.town ?? parts.village ?? parts.hamlet ?? parts.municipality ?? parts.suburb
  const state = parts.state && us ? (US_STATES[String(parts.state).toLowerCase()] ?? parts.state) : parts.state
  const region = [state, parts.postcode].filter(Boolean).join(' ')
  const line = [street, town, region, us ? null : parts.country].filter(Boolean).join(', ')
  return line || String(fallback ?? '').replace(/\s+/g, ' ').trim()
}

/** Five decimals, as the app keeps a pin (about a metre). */
const pinned = n => Math.round(n * 1e5) / 1e5

/**
 * Nominatim's answer as the app's candidates: a name (empty for a bare
 * address), one readable line, and the point. Anything without a usable point
 * or line is dropped, and one place listed twice is kept once.
 */
export function parseResults(json, limit = MAX_CANDIDATES) {
  if (!Array.isArray(json)) return []
  const out = []
  const seen = new Set()
  for (const r of json) {
    const lat = coord(r?.lat, 90)
    const lon = coord(r?.lon, 180)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    const address = formatAddress(r.address, r.display_name).slice(0, 200)
    if (!address) continue
    const name = typeof r.name === 'string' ? r.name.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
    const key = `${name.toLowerCase()}|${address.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name, address, lat: pinned(lat), lon: pinned(lon) })
    if (out.length === limit) break
  }
  return out
}

/**
 * One request at a time, `gapMs` apart, on this instance. `wait` reserves the
 * next free moment and sleeps until it; a turn further off than `maxWaitMs` is
 * not taken and answers false, so a queue never outlives the request.
 */
export function createGate(gapMs = REQUEST_GAP_MS, { now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let next = 0
  return {
    async wait(maxWaitMs = Infinity) {
      const t = now()
      const at = Math.max(t, next)
      if (at - t > maxWaitMs) return false
      next = at + gapMs
      if (at > t) await sleep(at - t)
      return true
    },
  }
}

/** The answers already had, for a day: Nominatim asks that the same search is not made twice. */
export function createCache({ max = 200, ttlMs = 86_400_000, now = () => Date.now() } = {}) {
  const hits = new Map()
  return {
    get(key) {
      const hit = hits.get(key)
      if (!hit) return undefined
      if (now() - hit.at >= ttlMs) {
        hits.delete(key)
        return undefined
      }
      return hit.value
    },
    set(key, value) {
      hits.delete(key)
      hits.set(key, { at: now(), value })
      // the oldest first out: a Map keeps the order things went in
      while (hits.size > max) hits.delete(hits.keys().next().value)
    },
  }
}

/** An error with the status the endpoint answers it with. */
const failure = (status, message) => Object.assign(new Error(message), { status })

/**
 * One Nominatim search, through the cache and the gate, with a timeout. The
 * answer is the parsed JSON; anything else is thrown with a status: 429 when
 * the queue is too long, 504 when OpenStreetMap is too slow, 502 when it
 * answers with anything but a list.
 */
export async function nominatim(url, { fetchImpl, gate, cache, timeoutMs = TIMEOUT_MS, maxWaitMs = MAX_QUEUE_MS }) {
  const cached = cache?.get(url)
  if (cached !== undefined) return cached
  if (gate && !(await gate.wait(maxWaitMs))) throw failure(429, 'Address lookups are busy right now. Try again in a moment.')
  let res
  try {
    res = await fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json', 'accept-language': 'en-US,en' },
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    })
  } catch (e) {
    const slow = e?.name === 'TimeoutError' || e?.name === 'AbortError'
    throw failure(slow ? 504 : 502, slow ? 'OpenStreetMap took too long to answer. Try again in a moment.' : 'OpenStreetMap could not be reached. Try again in a moment.')
  }
  if (!res.ok) throw failure(502, `OpenStreetMap could not answer (${res.status}). Try again in a moment.`)
  let json
  try {
    json = await res.json()
  } catch {
    throw failure(502, 'OpenStreetMap answered with something that is not a list of places.')
  }
  if (!Array.isArray(json)) throw failure(502, 'OpenStreetMap answered with something that is not a list of places.')
  cache?.set(url, json)
  return json
}

/** One line, single spaces, at most `max` characters. */
const tidy = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max).trim() : '')

/**
 * POST /api/geocode { q, near?: { lat, lon }, area? } for a signed-in account:
 * up to five candidates { name, address, lat, lon }. `near` is the middle of
 * the user's area (the app works it out: their pinned places, else the
 * weather's location); `area` is a place name typed instead ("Phoenix, AZ"),
 * looked up first and handed back as `area: { lat, lon }` for the device to
 * keep, so it is looked up once. A search is kept inside that area's box, and
 * tried once without the box when nothing is found in it.
 *
 * Built by a function so a test can hand in its own fetch, gate, cache, rate
 * limit and clock; the endpoint uses the defaults, kept per instance.
 */
export function createGeocodeHandler({
  fetchImpl = (url, init) => fetch(url, init),
  gate = createGate(),
  cache = createCache(),
  perUser = slidingWindow({ limit: 60, windowMs: 10 * 60_000 }),
  now = () => Date.now(),
} = {}) {
  return async req => {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
    const { user, response } = await requireUser(req)
    if (response) return response

    let body
    try {
      body = await req.json()
    } catch {
      return Response.json({ error: 'invalid JSON' }, { status: 400 })
    }
    const q = tidy(body?.q, MAX_QUERY)
    if (!q) return Response.json({ error: 'Say what to look for: the place’s name.' }, { status: 400 })
    const slot = await perUser.take(user.id)
    if (!slot.ok) {
      const seconds = Math.ceil(slot.retryAfterMs / 1000)
      return Response.json({ error: 'That is a lot of lookups at once. Try again in a few minutes.' }, { status: 429, headers: { 'retry-after': String(seconds) } })
    }

    const deadline = now() + BUDGET_MS
    const left = () => deadline - now()
    const ask = url => nominatim(url, { fetchImpl, gate, cache, timeoutMs: Math.min(TIMEOUT_MS, left() - 250) })
    try {
      let near = roughPoint(body?.near)
      let area = null
      const areaText = tidy(body?.area, MAX_AREA)
      if (!near && areaText) {
        const [hit] = parseResults(await ask(searchUrl(areaText, { limit: 1 })), 1)
        if (hit) near = area = roughPoint(hit)
      }
      const viewbox = near ? viewboxAround(near) : null
      let found = await ask(searchUrl(q, { viewbox, bounded: !!viewbox }))
      // nothing inside the box: once more leaning to it but not kept in it,
      // while there is time for a turn at the gate and a whole answer
      if (viewbox && !found.length && left() > REQUEST_GAP_MS + 2000) found = await ask(searchUrl(q, { viewbox }))
      return Response.json({ candidates: parseResults(found), ...(area ? { area } : {}) })
    } catch (e) {
      const status = typeof e?.status === 'number' ? e.status : 502
      return Response.json({ error: e instanceof Error ? e.message : 'The lookup failed.' }, { status })
    }
  }
}
