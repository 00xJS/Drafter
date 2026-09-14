import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Forecast, WEATHER_KEY, WEATHER_REFRESH_EVENT, getWeather, onWeatherRefresh, requestWeatherRefresh, watchWeather } from '../weather'

// Pull to refresh (and the sync pill) asks the briefing's weather to refresh.
// That is someone asking for the sky as it is now, so it fetches past the
// half-hour cache; coming back to the foreground still lets the cache answer.
// No jsdom here: EventTargets stand in for the window and the document, and
// localStorage and fetch are stubbed by hand.

const mem = new Map<string, string>()
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const readMem = () => JSON.parse(mem.get(WEATHER_KEY) ?? '{}')

const NOW = 1_800_000_000_000
const answer = {
  current: { temperature_2m: 17.6, weather_code: 2, precipitation: 0 },
  current_units: { temperature_2m: '°C' },
  daily: { temperature_2m_max: [21.4], temperature_2m_min: [11.2], precipitation_probability_max: [35] },
}
/** Open-Meteo answering, as a fetch the tests can count. */
const answering = () => vi.fn(async () => ({ ok: true, json: async () => answer }))
/** No signal: every fetch throws. */
const offline = () =>
  vi.fn(async () => {
    throw new Error('offline')
  })
/** What the tile shows before the pull. */
const old: Forecast = { tempC: 9, hiC: 10, loC: 5, rainPct: 0, code: 3, unit: '°C' }
const cachedAt = (fetchedAt: number) => mem.set(WEATHER_KEY, JSON.stringify({ enabled: true, lat: 51.5, lon: -0.12, forecast: old, fetchedAt }))
/** Ten minutes before NOW: well inside the half-hour. */
const TEN_MINUTES_AGO = NOW - 10 * 60_000

beforeEach(() => {
  mem.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.stubGlobal('navigator', { language: 'en-GB' })
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('asking the weather to refresh', () => {
  it('reaches whoever is listening, and nobody once they let go', () => {
    const target = new EventTarget()
    const heard = vi.fn()
    const off = onWeatherRefresh(heard, target)
    requestWeatherRefresh(target)
    requestWeatherRefresh(target)
    expect(heard).toHaveBeenCalledTimes(2)
    off()
    requestWeatherRefresh(target)
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('goes out as the one named event', () => {
    const target = new EventTarget()
    const heard = vi.fn()
    target.addEventListener(WEATHER_REFRESH_EVENT, heard)
    requestWeatherRefresh(target)
    expect(heard).toHaveBeenCalledOnce()
  })

  it('is a quiet no-op where there is no window or document', () => {
    expect(typeof window).toBe('undefined')
    expect(typeof document).toBe('undefined')
    expect(() => requestWeatherRefresh()).not.toThrow()
    expect(() => onWeatherRefresh(() => {})()).not.toThrow()
    expect(() => watchWeather(() => {})()).not.toThrow()
  })
})

describe('getWeather, forced: the sky now, past the half-hour cache', () => {
  it('fetches a forecast that is still fresh, and keeps the new one', async () => {
    const fetchMock = answering()
    vi.stubGlobal('fetch', fetchMock)
    cachedAt(TEN_MINUTES_AGO)
    // unforced, the cache answers
    expect(await getWeather(NOW)).toEqual(old)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await getWeather(NOW, { force: true })).toMatchObject({ tempC: 18, hiC: 21, loC: 11 })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(readMem()).toMatchObject({ fetchedAt: NOW, forecast: { tempC: 18 } })
  })

  it('answers the last forecast when the fetch fails, and leaves the cache as it was', async () => {
    for (const failing of [offline(), vi.fn(async () => ({ ok: false, json: async () => ({}) }))]) {
      vi.stubGlobal('fetch', failing)
      cachedAt(TEN_MINUTES_AGO)
      expect(await getWeather(NOW, { force: true })).toEqual(old)
      expect(failing).toHaveBeenCalledOnce()
      expect(readMem()).toMatchObject({ fetchedAt: TEN_MINUTES_AGO, forecast: old })
    }
  })

  it('asks nothing while weather is off or has no place', async () => {
    const fetchMock = answering()
    vi.stubGlobal('fetch', fetchMock)
    mem.set(WEATHER_KEY, JSON.stringify({ enabled: false }))
    expect(await getWeather(NOW, { force: true })).toBeNull()
    mem.set(WEATHER_KEY, JSON.stringify({ enabled: true }))
    expect(await getWeather(NOW, { force: true })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('watchWeather: what the briefing strip runs', () => {
  const page = () => ({ win: new EventTarget(), doc: Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState }) })

  it('lets the cache answer on mount and on coming back, and fetches on every pull, even a minute apart', async () => {
    const fetchMock = answering()
    vi.stubGlobal('fetch', fetchMock)
    cachedAt(TEN_MINUTES_AGO)
    const { win, doc } = page()
    const shown: (Forecast | null)[] = []
    const stop = watchWeather(f => void shown.push(f), { win, doc })
    await flush()
    doc.dispatchEvent(new Event('visibilitychange'))
    await flush()
    // mounted, then brought back, inside the half-hour: the cache both times, and no request
    expect(fetchMock).not.toHaveBeenCalled()
    expect(shown).toEqual([old, old])

    // a pull goes out at once
    requestWeatherRefresh(win)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(shown[2]).toMatchObject({ tempC: 18 })
    expect(readMem().fetchedAt).toBe(NOW)

    // and so does a second pull a minute later, with that forecast still fresh
    vi.setSystemTime(NOW + 60_000)
    requestWeatherRefresh(win)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(readMem().fetchedAt).toBe(NOW + 60_000)

    // while coming back to the front stays with the cache
    doc.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(shown).toHaveLength(5)

    // once let go, neither is heard
    stop()
    requestWeatherRefresh(win)
    doc.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(shown).toHaveLength(5)
  })

  it('keeps the last forecast showing when a pull cannot reach Open-Meteo', async () => {
    const failing = offline()
    vi.stubGlobal('fetch', failing)
    cachedAt(TEN_MINUTES_AGO)
    const { win, doc } = page()
    const shown: (Forecast | null)[] = []
    const stop = watchWeather(f => void shown.push(f), { win, doc })
    await flush()
    requestWeatherRefresh(win)
    await flush()
    expect(failing).toHaveBeenCalledOnce()
    expect(shown).toEqual([old, old])
    // the old stamp stands, so the next look past the half-hour still retries
    expect(readMem()).toMatchObject({ fetchedAt: TEN_MINUTES_AGO, forecast: old })
    stop()
  })

  it('does not count a page that is still hidden as coming back', async () => {
    const fetchMock = answering()
    vi.stubGlobal('fetch', fetchMock)
    // off while the strip mounts, so mounting asks nothing…
    mem.set(WEATHER_KEY, JSON.stringify({ enabled: false }))
    const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' as DocumentVisibilityState })
    const stop = watchWeather(() => {}, { win: new EventTarget(), doc })
    await flush()
    // …then an hour-old forecast, which a real return to the front fetches past
    cachedAt(NOW - 60 * 60_000)
    doc.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(fetchMock).toHaveBeenCalledOnce()
    stop()
  })
})
