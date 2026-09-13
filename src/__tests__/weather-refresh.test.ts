import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Forecast, STALE_MS, WEATHER_KEY, WEATHER_REFRESH_EVENT, getWeather, onWeatherRefresh, requestWeatherRefresh } from '../weather'

// Pull to refresh (and the sync pill) asks the briefing's weather to refresh,
// as coming back to the foreground does. No jsdom here: an EventTarget stands
// in for the window, and localStorage and fetch are stubbed by hand.

const mem = new Map<string, string>()
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  mem.clear()
  vi.stubGlobal('navigator', { language: 'en-GB' })
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  })
})

afterEach(() => {
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

  it('is a quiet no-op where there is no window', () => {
    expect(typeof window).toBe('undefined')
    expect(() => requestWeatherRefresh()).not.toThrow()
    expect(() => onWeatherRefresh(() => {})()).not.toThrow()
  })

  it('fetches a stale forecast, and leaves a fresh one to its half-hour cache', async () => {
    const answer = {
      current: { temperature_2m: 17.6, weather_code: 2, precipitation: 0 },
      current_units: { temperature_2m: '°C' },
      daily: { temperature_2m_max: [21.4], temperature_2m_min: [11.2], precipitation_probability_max: [35] },
    }
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => answer }))
    vi.stubGlobal('fetch', fetchMock)
    const now = 1_800_000_000_000
    const old: Forecast = { tempC: 9, hiC: 10, loC: 5, rainPct: 0, code: 3, unit: '°C' }
    mem.set(WEATHER_KEY, JSON.stringify({ enabled: true, lat: 51.5, lon: -0.12, forecast: old, fetchedAt: now - STALE_MS }))

    // what the strip does with the ask
    const target = new EventTarget()
    const shown: (Forecast | null)[] = []
    const off = onWeatherRefresh(() => void getWeather(now).then(f => shown.push(f)), target)

    requestWeatherRefresh(target)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(shown).toEqual([expect.objectContaining({ tempC: 18, hiC: 21, loC: 11 })])

    // asked again at once: that forecast is fresh, so the cache answers
    requestWeatherRefresh(target)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(shown).toHaveLength(2)
    expect(shown[1]).toEqual(shown[0])
    off()
  })
})
