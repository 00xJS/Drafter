// Today's weather for the morning briefing, from Open-Meteo: free, no key,
// CORS-open, so the browser can ask it directly. This is a per-device
// preference and cache, not a synced record — where you are standing is not
// household data — so it lives in localStorage under a drafter:* key (wiped
// with the rest on sign-out) and never touches the Item table. Nothing in
// here throws: a phone in a tunnel gets the last forecast or nothing, never
// a broken Today.

export interface Forecast {
  /** Current, high and low, already rounded to whole degrees. */
  tempC: number
  hiC: number
  loC: number
  /** Today's highest chance of rain, 0–100. */
  rainPct: number
  /** WMO weather code — see describeCode. */
  code: number
  /** What Open-Meteo reports the temperatures in, e.g. °C. */
  unit: string
}

export interface WeatherCache {
  /** The user opted in and location was granted. Off means show the Enable button. */
  enabled: boolean
  lat?: number
  lon?: number
  forecast?: Forecast
  /** Epoch ms of the fetch the cached forecast came from. */
  fetchedAt?: number
}

export const WEATHER_KEY = 'drafter:weather'
/** A forecast older than this is refetched — often enough to notice a shower coming, rare enough to be free. */
export const STALE_MS = 30 * 60_000

/**
 * WMO weather codes, in the ranges Open-Meteo documents. The glyph is content
 * (a weather face), not chrome. Anything the table doesn't know is still shown
 * as a temperature, just without a story.
 */
export function describeCode(code: number): { label: string; glyph: string } {
  if (code === 0) return { label: 'Clear', glyph: '☀️' }
  if (code === 1) return { label: 'Mostly clear', glyph: '🌤️' }
  if (code === 2) return { label: 'Partly cloudy', glyph: '⛅' }
  if (code === 3) return { label: 'Overcast', glyph: '☁️' }
  if (code === 45 || code === 48) return { label: 'Fog', glyph: '🌫️' }
  if (code >= 51 && code <= 57) return { label: 'Drizzle', glyph: '🌦️' }
  if (code >= 61 && code <= 67) return { label: 'Rain', glyph: '🌧️' }
  if (code >= 71 && code <= 77) return { label: 'Snow', glyph: '🌨️' }
  if (code >= 80 && code <= 82) return { label: 'Showers', glyph: '🌦️' }
  if (code === 85 || code === 86) return { label: 'Snow showers', glyph: '🌨️' }
  if (code >= 95 && code <= 99) return { label: 'Thunder', glyph: '⛈️' }
  return { label: 'Weather', glyph: '🌡️' }
}

/** Nothing fetched yet counts as stale; so does a clock that went backwards. */
export function isStale(fetchedAt: number | undefined, now: number, maxAge = STALE_MS): boolean {
  if (fetchedAt === undefined || !Number.isFinite(fetchedAt)) return true
  const age = now - fetchedAt
  return age < 0 || age >= maxAge
}

export function readCache(): WeatherCache {
  try {
    if (typeof localStorage === 'undefined') return { enabled: false }
    const raw = localStorage.getItem(WEATHER_KEY)
    if (!raw) return { enabled: false }
    const c = JSON.parse(raw) as Partial<WeatherCache>
    return { ...c, enabled: c.enabled === true }
  } catch {
    return { enabled: false }
  }
}

export function writeCache(c: WeatherCache): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(WEATHER_KEY, JSON.stringify(c))
  } catch {
    // quota or private mode: the strip just refetches next time
  }
}

/**
 * The one URL. Coordinates are rounded to two decimals (about a kilometre)
 * before they leave the device: the forecast is the same, and the third party
 * learns the neighbourhood rather than the doorstep.
 */
export function forecastUrl(lat: number, lon: number): string {
  const q = new URLSearchParams({
    latitude: lat.toFixed(2),
    longitude: lon.toFixed(2),
    current: 'temperature_2m,weather_code,precipitation',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: '1',
  })
  return `https://api.open-meteo.com/v1/forecast?${q.toString()}`
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Fetch and shape today's forecast; null on any network, HTTP or shape problem. */
export async function fetchForecast(lat: number, lon: number, fetchFn: typeof fetch = fetch): Promise<Forecast | null> {
  try {
    const res = await fetchFn(forecastUrl(lat, lon))
    if (!res.ok) return null
    const json = (await res.json()) as any
    const temp = num(json?.current?.temperature_2m)
    const code = num(json?.current?.weather_code)
    const hi = num(json?.daily?.temperature_2m_max?.[0])
    const lo = num(json?.daily?.temperature_2m_min?.[0])
    const rain = num(json?.daily?.precipitation_probability_max?.[0])
    if (temp === null || code === null || hi === null || lo === null) return null
    const unit = typeof json?.current_units?.temperature_2m === 'string' ? json.current_units.temperature_2m : '°C'
    return { tempC: Math.round(temp), hiC: Math.round(hi), loC: Math.round(lo), rainPct: Math.round(rain ?? 0), code, unit }
  } catch {
    return null
  }
}

/**
 * The forecast to show right now: cached while fresh, refetched when stale,
 * and the stale one when the refetch fails — an old forecast beats an empty
 * tile when the signal drops. Null when weather is off or nothing has ever
 * loaded. `now` is injectable so the tests never read the clock.
 */
export async function getWeather(now = Date.now()): Promise<Forecast | null> {
  const c = readCache()
  if (!c.enabled || !Number.isFinite(c.lat) || !Number.isFinite(c.lon)) return null
  if (c.forecast && !isStale(c.fetchedAt, now)) return c.forecast
  const f = await fetchForecast(c.lat!, c.lon!)
  // Re-read after the wait: a "Weather off" tap while the fetch was in flight
  // has already forgotten the location, and writing the pre-fetch snapshot
  // back would quietly switch weather on again with the coordinates it asked
  // to drop. Only the forecast is merged, onto whatever is there now.
  const fresh = readCache()
  if (!fresh.enabled) return null
  if (f) {
    writeCache({ ...fresh, forecast: f, fetchedAt: now })
    return f
  }
  return fresh.forecast ?? null
}

/**
 * Ask for the device's position — only ever called from the Enable tap, so the
 * permission prompt is something the user asked for. Granted: remember the
 * coordinates and switch weather on. Refused or timed out: switch it off, so
 * the strip shows the Enable button again instead of asking on every visit.
 */
export function requestLocation(): Promise<{ lat: number; lon: number } | null> {
  return new Promise(resolve => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      writeCache({ ...readCache(), enabled: false })
      resolve(null)
      return
    }
    try {
      navigator.geolocation.getCurrentPosition(
        pos => {
          const lat = pos.coords.latitude
          const lon = pos.coords.longitude
          writeCache({ ...readCache(), enabled: true, lat, lon })
          resolve({ lat, lon })
        },
        () => {
          writeCache({ ...readCache(), enabled: false })
          resolve(null)
        },
        { timeout: 10_000, maximumAge: 600_000 },
      )
    } catch {
      writeCache({ ...readCache(), enabled: false })
      resolve(null)
    }
  })
}

/** Opting out forgets the location and the forecast, not just the switch. */
export function disableWeather(): void {
  writeCache({ enabled: false })
}
