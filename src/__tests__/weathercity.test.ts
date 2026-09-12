import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CITIES, CITY_REGIONS, Forecast, cityById, forecastUrl, getWeather, readCache, requestLocation, setCity, unitFor, writeCache } from '../weather'
import { weatherChoice } from '../components/BriefingCard'

// Picking a city is the way to see the weather without sharing where you are:
// these pin that a choice switches weather on with public coordinates, never
// touches geolocation, drops a forecast cached for somewhere else, and — now
// that the place can change while weather stays on — that a fetch for the old
// place never lands in the cache under the new one's name.

function memoryStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => {
      m.set(k, String(v))
    },
    removeItem: (k: string) => {
      m.delete(k)
    },
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  }
}
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  // a fixed device locale, so nothing here depends on the machine running it
  vi.stubGlobal('navigator', { language: 'en-GB' })
})
afterEach(() => vi.unstubAllGlobals())

const sky: Forecast = { tempC: 30, hiC: 33, loC: 21, rainPct: 5, code: 0, unit: '°C' }
const now = Date.UTC(2026, 8, 10, 8, 0, 0)

/** An Open-Meteo body whose current temperature is `temp`, so a response can be told apart by where it was for. */
const body = (temp: number) =>
  JSON.stringify({
    current: { temperature_2m: temp, weather_code: 0, precipitation: 0 },
    current_units: { temperature_2m: '°F' },
    daily: { temperature_2m_max: [temp + 3], temperature_2m_min: [temp - 12], precipitation_probability_max: [5] },
  })

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
function stubFetch(handler: FetchStub) {
  const fn = vi.fn<FetchStub>(handler)
  vi.stubGlobal('fetch', fn as unknown as typeof fetch)
  return fn
}

describe('the city list', () => {
  it('has unique ids, real coordinates, and only the regions the picker groups by', () => {
    const ids = new Set(CITIES.map(c => c.id))
    expect(ids.size).toBe(CITIES.length)
    for (const c of CITIES) {
      expect(c.lat).toBeGreaterThan(-90)
      expect(c.lat).toBeLessThan(90)
      expect(c.lon).toBeGreaterThan(-180)
      expect(c.lon).toBeLessThan(180)
      expect(CITY_REGIONS).toContain(c.region)
      expect(c.name.trim()).toBe(c.name)
    }
  })

  it('knows Phoenix', () => {
    expect(cityById('phoenix')).toMatchObject({ name: 'Phoenix, AZ', region: 'United States', lat: 33.45, lon: -112.07 })
    expect(cityById('nowhere')).toBeUndefined()
    expect(cityById(undefined)).toBeUndefined()
  })
})

describe('choosing a city', () => {
  it('switches weather on with the city’s coordinates and no location of the device', () => {
    expect(setCity('phoenix')).toMatchObject({ id: 'phoenix' })
    expect(readCache()).toEqual({ enabled: true, lat: 33.45, lon: -112.07, city: 'phoenix' })
  })

  it('drops a forecast cached for somewhere else', () => {
    writeCache({ enabled: true, lat: 51.51, lon: -0.13, city: 'london', forecast: sky, fetchedAt: 1_000 })
    setCity('phoenix')
    const c = readCache()
    expect(c.forecast).toBeUndefined()
    expect(c.fetchedAt).toBeUndefined()
    expect(c.city).toBe('phoenix')
  })

  it('changes nothing for an id it does not know', () => {
    writeCache({ enabled: false })
    expect(setCity('atlantis')).toBeNull()
    expect(readCache()).toEqual({ enabled: false })
  })
})

describe('the scale to ask for', () => {
  it('is Fahrenheit for a US city and Celsius elsewhere, whatever the device locale', () => {
    expect(unitFor({ city: 'phoenix' }, 'en-GB')).toBe('f')
    expect(unitFor({ city: 'london' }, 'en-US')).toBe('c')
  })
  it('follows the locale when the device’s own location is in use', () => {
    expect(unitFor({}, 'en-US')).toBe('f')
    expect(unitFor({}, 'en-GB')).toBe('c')
    expect(unitFor({}, '')).toBe('c')
  })
  it('only adds the unit to the URL when it is Fahrenheit', () => {
    expect(forecastUrl(33.45, -112.07, 'f')).toContain('temperature_unit=fahrenheit')
    expect(forecastUrl(33.45, -112.07)).not.toContain('temperature_unit')
  })
  it('reaches the request: a US city asks in Fahrenheit, the device on an en-GB phone does not', async () => {
    const fn = stubFetch(async () => new Response(body(95), { status: 200 }))
    setCity('phoenix')
    await getWeather(now)
    expect(String(fn.mock.calls[0][0])).toContain('temperature_unit=fahrenheit')
    writeCache({ enabled: true, lat: 51.5, lon: -0.1 })
    await getWeather(now)
    expect(String(fn.mock.calls[1][0])).not.toContain('temperature_unit')
  })
})

describe('a fetch that lands after the place changed', () => {
  it('is dropped, not written under the new city’s name', async () => {
    // Phoenix's first fetch is slow; London is picked while it is in flight.
    stubFetch(async () => {
      setCity('london')
      return new Response(body(95), { status: 200 })
    })
    setCity('phoenix')
    expect(await getWeather(now)).toBeNull()
    expect(readCache()).toEqual({ enabled: true, lat: 51.51, lon: -0.13, city: 'london' })
  })

  it('leaves the second city’s sky in the cache when the two answers arrive out of order', async () => {
    // Phoenix then Tucson a second later — Tucson answers first, Phoenix last.
    const pending: Array<(r: Response) => void> = []
    stubFetch(() => new Promise<Response>(resolve => pending.push(resolve)))
    setCity('phoenix')
    const phoenix = getWeather(now)
    setCity('tucson')
    const tucson = getWeather(now)
    pending[1](new Response(body(88), { status: 200 }))
    expect((await tucson)?.tempC).toBe(88)
    pending[0](new Response(body(95), { status: 200 }))
    expect(await phoenix).toBeNull()
    expect(readCache()).toMatchObject({ city: 'tucson', lat: 32.22, forecast: { tempC: 88 }, fetchedAt: now })
  })

  it('is dropped when the device took over from the city', async () => {
    stubFetch(async () => {
      writeCache({ enabled: true, lat: 51.5, lon: -0.1 })
      return new Response(body(95), { status: 200 })
    })
    setCity('phoenix')
    expect(await getWeather(now)).toBeNull()
    expect(readCache()).toEqual({ enabled: true, lat: 51.5, lon: -0.1 })
  })
})

const grant = (ok: (p: { coords: { latitude: number; longitude: number } }) => void) => ok({ coords: { latitude: 51.5, longitude: -0.1 } })
const deny = (_ok: unknown, err: (e: { code: number }) => void) => err({ code: 1 })

describe('switching back to the device’s location', () => {
  it('forgets the chosen city and its forecast', async () => {
    writeCache({ enabled: true, lat: 33.45, lon: -112.07, city: 'phoenix', forecast: sky, fetchedAt: 1_000 })
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: grant }, language: 'en-GB' })
    await expect(requestLocation()).resolves.toEqual({ lat: 51.5, lon: -0.1 })
    expect(readCache()).toEqual({ enabled: true, lat: 51.5, lon: -0.1 })
  })

  it('keeps a working city when the prompt is refused', async () => {
    const phoenix = { enabled: true, lat: 33.45, lon: -112.07, city: 'phoenix', forecast: sky, fetchedAt: 1_000 }
    writeCache(phoenix)
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: deny }, language: 'en-GB' })
    await expect(requestLocation()).resolves.toBeNull()
    expect(readCache()).toEqual(phoenix)
  })

  it('switches fully off when refused with no city to fall back on — never a forecast under an off switch', async () => {
    writeCache({ enabled: true, lat: 51.5, lon: -0.1, forecast: sky, fetchedAt: 1_000 })
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: deny }, language: 'en-GB' })
    await expect(requestLocation()).resolves.toBeNull()
    expect(readCache()).toEqual({ enabled: false })
    // and with no geolocation to ask at all
    writeCache({ enabled: false, lat: 33.45, lon: -112.07, city: 'phoenix', forecast: sky, fetchedAt: 1_000 })
    vi.stubGlobal('navigator', { language: 'en-GB' })
    await expect(requestLocation()).resolves.toBeNull()
    expect(readCache()).toEqual({ enabled: false })
  })
})

describe('the picker reflects the cache', () => {
  it('is off, the device, or the city', () => {
    expect(weatherChoice({ enabled: false })).toBe('')
    expect(weatherChoice({ enabled: true, lat: 1, lon: 1 })).toBe('location')
    expect(weatherChoice({ enabled: true, lat: 1, lon: 1, city: 'phoenix' })).toBe('phoenix')
  })
})
