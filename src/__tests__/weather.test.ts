import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STALE_MS, WEATHER_KEY, describeCode, disableWeather, fetchForecast, forecastUrl, getWeather, isStale, requestLocation } from '../weather'
import { briefingFacts, greeting } from '../components/BriefingCard'
import { CalendarEvent, Habit } from '../types'
import { fmtTime } from '../utils'

// No jsdom here: localStorage and fetch are stubbed by hand, as the sync-state
// and MCP tests do, and every clock reading is a fixed timestamp.

const mem = new Map<string, string>()

beforeEach(() => {
  mem.clear()
  // Node ships a real navigator, and getWeather reads its language to pick a
  // scale — pinned, so the URL these tests capture is the same on every machine.
  vi.stubGlobal('navigator', { language: 'en-GB' })
  globalThis.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, String(v))
    },
    removeItem: (k: string) => {
      mem.delete(k)
    },
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size
    },
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const sample = {
  current: { temperature_2m: 17.6, weather_code: 2, precipitation: 0 },
  current_units: { temperature_2m: '°C' },
  daily: { temperature_2m_max: [21.4], temperature_2m_min: [11.2], precipitation_probability_max: [35] },
}

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
function stubFetch(handler: FetchStub = async () => new Response(JSON.stringify(sample), { status: 200 })) {
  const fn = vi.fn<FetchStub>(handler)
  vi.stubGlobal('fetch', fn as unknown as typeof fetch)
  return fn
}

const readMem = () => JSON.parse(mem.get(WEATHER_KEY) ?? '{}')

describe('WMO codes become a short label and a face', () => {
  it.each([
    [0, 'Clear'],
    [2, 'Partly cloudy'],
    [3, 'Overcast'],
    [45, 'Fog'],
    [48, 'Fog'],
    [53, 'Drizzle'],
    [63, 'Rain'],
    [67, 'Rain'],
    [73, 'Snow'],
    [77, 'Snow'],
    [81, 'Showers'],
    [85, 'Snow showers'],
    [95, 'Thunder'],
    [99, 'Thunder'],
    [42, 'Weather'],
  ])('code %i reads %s', (code, label) => {
    const d = describeCode(code)
    expect(d.label).toBe(label)
    expect(d.glyph.length).toBeGreaterThan(0)
  })
})

describe('a forecast goes stale after half an hour', () => {
  const t0 = Date.UTC(2026, 8, 10, 8, 0, 0)
  it('never fetched counts as stale', () => {
    expect(isStale(undefined, t0)).toBe(true)
  })
  it('is fresh just under the line and stale on it', () => {
    expect(isStale(t0, t0 + 29 * 60_000)).toBe(false)
    expect(isStale(t0, t0 + STALE_MS)).toBe(true)
  })
  it('honours a custom max age', () => {
    expect(isStale(t0, t0 + 5_000, 10_000)).toBe(false)
    expect(isStale(t0, t0 + 10_000, 10_000)).toBe(true)
  })
  it('treats a clock that went backwards as stale', () => {
    expect(isStale(t0 + 60_000, t0)).toBe(true)
  })
})

describe('the forecast URL', () => {
  it('asks for today only and rounds the position to about a kilometre', () => {
    const url = forecastUrl(51.507351, -0.127758)
    expect(url).toMatch(/^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/)
    expect(url).toContain('latitude=51.51')
    expect(url).toContain('longitude=-0.13')
    expect(url).toContain('current=temperature_2m%2Cweather_code%2Cprecipitation')
    expect(url).toContain('forecast_days=1')
    expect(url).not.toContain('51.507')
  })
})

describe('fetchForecast', () => {
  it('shapes a good response into whole degrees', async () => {
    const fn = stubFetch()
    const f = await fetchForecast(51.5, -0.12, fn as unknown as typeof fetch)
    expect(f).toEqual({ tempC: 18, hiC: 21, loC: 11, rainPct: 35, code: 2, unit: '°C' })
  })
  it('names the scale it asked for when the body does not say', async () => {
    const bare = { current: sample.current, daily: sample.daily }
    const fn = async () => new Response(JSON.stringify(bare), { status: 200 })
    expect((await fetchForecast(0, 0, fn as unknown as typeof fetch, 'f'))?.unit).toBe('°F')
    expect((await fetchForecast(0, 0, fn as unknown as typeof fetch))?.unit).toBe('°C')
  })
  it('returns null on a bad status, a malformed body, or a thrown fetch', async () => {
    expect(await fetchForecast(0, 0, async () => new Response('nope', { status: 500 }))).toBeNull()
    expect(await fetchForecast(0, 0, async () => new Response('{}', { status: 200 }))).toBeNull()
    expect(
      await fetchForecast(0, 0, async () => {
        throw new Error('offline')
      }),
    ).toBeNull()
  })
})

describe('getWeather', () => {
  const now = Date.UTC(2026, 8, 10, 8, 0, 0)
  const fresh = { tempC: 12, hiC: 15, loC: 8, rainPct: 10, code: 0, unit: '°C' }

  it('is null and never fetches while weather is off', async () => {
    const fn = stubFetch()
    mem.set(WEATHER_KEY, JSON.stringify({ enabled: false, lat: 51.5, lon: -0.12, forecast: fresh, fetchedAt: now }))
    expect(await getWeather(now)).toBeNull()
    expect(fn).not.toHaveBeenCalled()
  })

  it('is null without a location even when enabled', async () => {
    const fn = stubFetch()
    mem.set(WEATHER_KEY, JSON.stringify({ enabled: true }))
    expect(await getWeather(now)).toBeNull()
    expect(fn).not.toHaveBeenCalled()
  })

  it('serves the cached forecast while it is fresh', async () => {
    const fn = stubFetch()
    mem.set(WEATHER_KEY, JSON.stringify({ enabled: true, lat: 51.5, lon: -0.12, forecast: fresh, fetchedAt: now - 5 * 60_000 }))
    expect(await getWeather(now)).toEqual(fresh)
    expect(fn).not.toHaveBeenCalled()
  })

  it('refetches once when stale and rewrites the cache', async () => {
    const fn = stubFetch()
    mem.set(WEATHER_KEY, JSON.stringify({ enabled: true, lat: 51.5, lon: -0.12, forecast: fresh, fetchedAt: now - STALE_MS }))
    const f = await getWeather(now)
    expect(f?.tempC).toBe(18)
    expect(fn).toHaveBeenCalledTimes(1)
    const url = String(fn.mock.calls[0][0])
    expect(url).toContain('latitude=')
    expect(url).toContain('current=temperature_2m%2Cweather_code%2Cprecipitation')
    expect(url).not.toContain('temperature_unit')
    const stored = readMem()
    expect(stored.fetchedAt).toBe(now)
    expect(stored.forecast.tempC).toBe(18)
    expect(stored.lat).toBe(51.5)
  })

  it('falls back to the stale forecast when the network fails, and never throws', async () => {
    stubFetch(async () => {
      throw new Error('offline')
    })
    mem.set(WEATHER_KEY, JSON.stringify({ enabled: true, lat: 51.5, lon: -0.12, forecast: fresh, fetchedAt: now - 2 * STALE_MS }))
    expect(await getWeather(now)).toEqual(fresh)
    // the cache is left as it was: the old stamp keeps the next look retrying
    expect(readMem().fetchedAt).toBe(now - 2 * STALE_MS)
  })

  it('is null when there is nothing cached and the body is malformed', async () => {
    stubFetch(async () => new Response('{}', { status: 200 }))
    mem.set(WEATHER_KEY, JSON.stringify({ enabled: true, lat: 51.5, lon: -0.12 }))
    expect(await getWeather(now)).toBeNull()
  })

  it('does not switch weather back on when it was turned off mid-fetch', async () => {
    // Enable → grant → the first fetch is slow → "Weather off" → the fetch lands.
    // The opt-out must stick, and the forgotten coordinates must stay forgotten.
    stubFetch(async () => {
      disableWeather()
      return new Response(JSON.stringify(sample), { status: 200 })
    })
    mem.set(WEATHER_KEY, JSON.stringify({ enabled: true, lat: 51.5, lon: -0.12 }))
    expect(await getWeather(now)).toBeNull()
    expect(readMem()).toEqual({ enabled: false })
  })
})

describe('requestLocation', () => {
  it('switches weather off when there is no geolocation to ask', async () => {
    vi.stubGlobal('navigator', undefined)
    mem.set(WEATHER_KEY, JSON.stringify({ enabled: true, lat: 1, lon: 2 }))
    expect(await requestLocation()).toBeNull()
    expect(readMem().enabled).toBe(false)
  })

  it('stores the position and switches weather on when granted', async () => {
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: (ok: (p: { coords: { latitude: number; longitude: number } }) => void) => ok({ coords: { latitude: 51.5, longitude: -0.12 } }),
      },
    })
    expect(await requestLocation()).toEqual({ lat: 51.5, lon: -0.12 })
    expect(readMem()).toMatchObject({ enabled: true, lat: 51.5, lon: -0.12 })
  })

  it('switches weather off when the prompt is refused', async () => {
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: (_ok: unknown, err: (e: { code: number }) => void) => err({ code: 1 }),
      },
    })
    mem.set(WEATHER_KEY, JSON.stringify({ enabled: true, lat: 1, lon: 2 }))
    expect(await requestLocation()).toBeNull()
    expect(readMem().enabled).toBe(false)
  })
})

describe('the briefing greets by the hour', () => {
  it('morning, afternoon, evening', () => {
    expect(greeting(8)).toBe('Good morning')
    expect(greeting(14)).toBe('Good afternoon')
    expect(greeting(20)).toBe('Good evening')
    expect(greeting(17)).toBe('Good evening')
  })
})

describe('the briefing states only the facts the day has', () => {
  // Thursday 10 Sep 2026, 09:00 local
  const now = new Date(2026, 8, 10, 9, 0)
  const iso = (h: number, m = 0) => new Date(2026, 8, 10, h, m).toISOString()
  const ev = (over: Partial<CalendarEvent> & { id: string }): CalendarEvent => ({
    sourceId: 'local',
    title: 'Thing',
    start: iso(10),
    end: iso(11),
    allDay: false,
    ...over,
  })
  const habit = (over: Partial<Habit> & { id: string }): Habit => ({
    kind: 'habit',
    name: 'Read',
    done: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  })

  it('reads work hours, counts events without the work day, and tallies habits', () => {
    const events = [
      ev({ id: 'w', start: iso(9), end: iso(17, 30), work: 'home' }),
      ev({ id: 'e1', start: iso(10), end: iso(11) }),
      ev({ id: 'e2', start: '2026-09-10', end: '2026-09-11', allDay: true }),
      ev({ id: 'tomorrow', start: new Date(2026, 8, 11, 10).toISOString(), end: new Date(2026, 8, 11, 11).toISOString() }),
    ]
    const habits = [habit({ id: 'h1', days: [1, 2, 3, 4, 5], done: ['2026-09-10'] }), habit({ id: 'h2' }), habit({ id: 'h3', days: [6] })]
    const facts = briefingFacts(events, habits, now)
    expect(facts.work?.hours).toBe('9am–5:30pm')
    expect(facts.work?.label).toBe('Working from home')
    expect(facts.events).toEqual({ count: 2, first: fmtTime(iso(10)) })
    expect(facts.habits).toEqual({ done: 1, due: 2 })
  })

  it('leaves out what there is none of', () => {
    expect(briefingFacts([], [], now)).toEqual({})
    const facts = briefingFacts([ev({ id: 'a', start: '2026-09-10', end: '2026-09-11', allDay: true })], [], now)
    expect(facts.events).toEqual({ count: 1, first: undefined })
    expect(facts.work).toBeUndefined()
  })

  it('shows an all-day work day without hours', () => {
    const facts = briefingFacts([ev({ id: 'w', start: '2026-09-10', end: '2026-09-11', allDay: true, work: 'office' })], [], now)
    expect(facts.work).toEqual({ label: 'In the office', short: 'Office', emoji: '🏢', hours: '' })
    expect(facts.events).toBeUndefined()
  })
})
