// Today's weather for the morning briefing, from Open-Meteo: free, no key,
// CORS-open, so the browser can ask it directly. This is a per-device
// preference and cache, not a synced record — where you are standing is not
// household data — so it lives in localStorage under a drafter:* key (wiped
// with the rest on sign-out) and never touches the Item table. Nothing in
// here throws: a phone in a tunnel gets the last forecast or nothing, never
// a broken Today.

export interface Forecast {
  /**
   * Current, high and low, already rounded to whole degrees. Named for the
   * default unit, but they hold whatever `unit` says — a US city asks for
   * Fahrenheit (see unitFor) and these are then °F.
   */
  tempC: number
  hiC: number
  loC: number
  /** Today's highest chance of rain, 0–100. */
  rainPct: number
  /** WMO weather code — see describeCode. */
  code: number
  /** What Open-Meteo reports the temperatures in, e.g. °C or °F. */
  unit: string
}

export interface WeatherCache {
  /** The user opted in, by sharing a location or picking a city. Off means show the picker's Off state. */
  enabled: boolean
  lat?: number
  lon?: number
  /**
   * Set when the coordinates are a chosen city's rather than the device's —
   * the id from CITIES. Nothing was shared with anyone to get them.
   */
  city?: string
  forecast?: Forecast
  /** Epoch ms of the fetch the cached forecast came from. */
  fetchedAt?: number
}

export const WEATHER_KEY = 'drafter:weather'
/** A forecast older than this is refetched — often enough to notice a shower coming, rare enough to be free. */
export const STALE_MS = 30 * 60_000

export type CityRegion = 'United States' | 'Canada & Mexico' | 'Europe' | 'Asia & Pacific' | 'Elsewhere'
export const CITY_REGIONS: CityRegion[] = ['United States', 'Canada & Mexico', 'Europe', 'Asia & Pacific', 'Elsewhere']

export interface City {
  id: string
  name: string
  region: CityRegion
  lat: number
  lon: number
}

/**
 * Somewhere to be weather-wise without saying where you are. Picking a city
 * never asks for the device's position: its coordinates are the city centre
 * to two decimals — public knowledge, and all a forecast needs. Not every
 * city on earth, just the ones people are likely to mean; a town nearby gets
 * the same sky.
 */
export const CITIES: City[] = [
  { id: 'phoenix', name: 'Phoenix, AZ', region: 'United States', lat: 33.45, lon: -112.07 },
  { id: 'tucson', name: 'Tucson, AZ', region: 'United States', lat: 32.22, lon: -110.97 },
  { id: 'los-angeles', name: 'Los Angeles, CA', region: 'United States', lat: 34.05, lon: -118.24 },
  { id: 'san-diego', name: 'San Diego, CA', region: 'United States', lat: 32.72, lon: -117.16 },
  { id: 'san-francisco', name: 'San Francisco, CA', region: 'United States', lat: 37.77, lon: -122.42 },
  { id: 'las-vegas', name: 'Las Vegas, NV', region: 'United States', lat: 36.17, lon: -115.14 },
  { id: 'salt-lake-city', name: 'Salt Lake City, UT', region: 'United States', lat: 40.76, lon: -111.89 },
  { id: 'denver', name: 'Denver, CO', region: 'United States', lat: 39.74, lon: -104.99 },
  { id: 'seattle', name: 'Seattle, WA', region: 'United States', lat: 47.61, lon: -122.33 },
  { id: 'portland', name: 'Portland, OR', region: 'United States', lat: 45.52, lon: -122.68 },
  { id: 'dallas', name: 'Dallas, TX', region: 'United States', lat: 32.78, lon: -96.8 },
  { id: 'houston', name: 'Houston, TX', region: 'United States', lat: 29.76, lon: -95.37 },
  { id: 'austin', name: 'Austin, TX', region: 'United States', lat: 30.27, lon: -97.74 },
  { id: 'chicago', name: 'Chicago, IL', region: 'United States', lat: 41.88, lon: -87.63 },
  { id: 'minneapolis', name: 'Minneapolis, MN', region: 'United States', lat: 44.98, lon: -93.27 },
  { id: 'atlanta', name: 'Atlanta, GA', region: 'United States', lat: 33.75, lon: -84.39 },
  { id: 'miami', name: 'Miami, FL', region: 'United States', lat: 25.76, lon: -80.19 },
  { id: 'washington', name: 'Washington, DC', region: 'United States', lat: 38.91, lon: -77.04 },
  { id: 'new-york', name: 'New York, NY', region: 'United States', lat: 40.71, lon: -74.01 },
  { id: 'boston', name: 'Boston, MA', region: 'United States', lat: 42.36, lon: -71.06 },
  { id: 'toronto', name: 'Toronto', region: 'Canada & Mexico', lat: 43.65, lon: -79.38 },
  { id: 'vancouver', name: 'Vancouver', region: 'Canada & Mexico', lat: 49.28, lon: -123.12 },
  { id: 'montreal', name: 'Montreal', region: 'Canada & Mexico', lat: 45.5, lon: -73.57 },
  { id: 'mexico-city', name: 'Mexico City', region: 'Canada & Mexico', lat: 19.43, lon: -99.13 },
  { id: 'london', name: 'London', region: 'Europe', lat: 51.51, lon: -0.13 },
  { id: 'manchester', name: 'Manchester', region: 'Europe', lat: 53.48, lon: -2.24 },
  { id: 'edinburgh', name: 'Edinburgh', region: 'Europe', lat: 55.95, lon: -3.19 },
  { id: 'dublin', name: 'Dublin', region: 'Europe', lat: 53.35, lon: -6.26 },
  { id: 'paris', name: 'Paris', region: 'Europe', lat: 48.86, lon: 2.35 },
  { id: 'amsterdam', name: 'Amsterdam', region: 'Europe', lat: 52.37, lon: 4.9 },
  { id: 'berlin', name: 'Berlin', region: 'Europe', lat: 52.52, lon: 13.41 },
  { id: 'zurich', name: 'Zurich', region: 'Europe', lat: 47.38, lon: 8.54 },
  { id: 'madrid', name: 'Madrid', region: 'Europe', lat: 40.42, lon: -3.7 },
  { id: 'barcelona', name: 'Barcelona', region: 'Europe', lat: 41.39, lon: 2.17 },
  { id: 'lisbon', name: 'Lisbon', region: 'Europe', lat: 38.72, lon: -9.14 },
  { id: 'rome', name: 'Rome', region: 'Europe', lat: 41.9, lon: 12.5 },
  { id: 'stockholm', name: 'Stockholm', region: 'Europe', lat: 59.33, lon: 18.07 },
  { id: 'tokyo', name: 'Tokyo', region: 'Asia & Pacific', lat: 35.68, lon: 139.69 },
  { id: 'hong-kong', name: 'Hong Kong', region: 'Asia & Pacific', lat: 22.32, lon: 114.17 },
  { id: 'singapore', name: 'Singapore', region: 'Asia & Pacific', lat: 1.35, lon: 103.82 },
  { id: 'mumbai', name: 'Mumbai', region: 'Asia & Pacific', lat: 19.08, lon: 72.88 },
  { id: 'dubai', name: 'Dubai', region: 'Asia & Pacific', lat: 25.2, lon: 55.27 },
  { id: 'sydney', name: 'Sydney', region: 'Asia & Pacific', lat: -33.87, lon: 151.21 },
  { id: 'melbourne', name: 'Melbourne', region: 'Asia & Pacific', lat: -37.81, lon: 144.96 },
  { id: 'auckland', name: 'Auckland', region: 'Asia & Pacific', lat: -36.85, lon: 174.76 },
  { id: 'sao-paulo', name: 'São Paulo', region: 'Elsewhere', lat: -23.55, lon: -46.63 },
  { id: 'johannesburg', name: 'Johannesburg', region: 'Elsewhere', lat: -26.2, lon: 28.05 },
  { id: 'cape-town', name: 'Cape Town', region: 'Elsewhere', lat: -33.93, lon: 18.42 },
]

export function cityById(id: string | undefined): City | undefined {
  return id ? CITIES.find(c => c.id === id) : undefined
}

export type TempUnit = 'c' | 'f'

/**
 * Which scale to ask for. A chosen US city reads in Fahrenheit, everywhere
 * else in Celsius; with the device's own location the locale decides, so a
 * phone set to English (US) is not handed 40 °C on a Phoenix afternoon.
 */
export function unitFor(cache: Pick<WeatherCache, 'city'>, locale: string = typeof navigator !== 'undefined' ? (navigator.language ?? '') : ''): TempUnit {
  const city = cityById(cache.city)
  if (city) return city.region === 'United States' ? 'f' : 'c'
  return /-us$/i.test(locale) ? 'f' : 'c'
}

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
export function forecastUrl(lat: number, lon: number, unit: TempUnit = 'c'): string {
  const q = new URLSearchParams({
    latitude: lat.toFixed(2),
    longitude: lon.toFixed(2),
    current: 'temperature_2m,weather_code,precipitation',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: '1',
  })
  if (unit === 'f') q.set('temperature_unit', 'fahrenheit')
  return `https://api.open-meteo.com/v1/forecast?${q.toString()}`
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Fetch and shape today's forecast; null on any network, HTTP or shape problem. */
export async function fetchForecast(lat: number, lon: number, fetchFn: typeof fetch = fetch, unit: TempUnit = 'c'): Promise<Forecast | null> {
  try {
    const res = await fetchFn(forecastUrl(lat, lon, unit))
    if (!res.ok) return null
    const json = (await res.json()) as any
    const temp = num(json?.current?.temperature_2m)
    const code = num(json?.current?.weather_code)
    const hi = num(json?.daily?.temperature_2m_max?.[0])
    const lo = num(json?.daily?.temperature_2m_min?.[0])
    const rain = num(json?.daily?.precipitation_probability_max?.[0])
    if (temp === null || code === null || hi === null || lo === null) return null
    const reported = typeof json?.current_units?.temperature_2m === 'string' ? json.current_units.temperature_2m : unit === 'f' ? '°F' : '°C'
    return { tempC: Math.round(temp), hiC: Math.round(hi), loC: Math.round(lo), rainPct: Math.round(rain ?? 0), code, unit: reported }
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
  const f = await fetchForecast(c.lat!, c.lon!, fetch, unitFor(c))
  // Re-read after the wait: a "Weather off" pick while the fetch was in flight
  // has already forgotten the location, and writing the pre-fetch snapshot
  // back would quietly switch weather on again with the coordinates it asked
  // to drop. A different place by now — the picker moved from Phoenix to
  // London, or to the device — means this sky belongs to somewhere the cache
  // no longer names, and merging it would label Phoenix's sky "London" for
  // half an hour. Either way the answer is nothing; the fetch for the current
  // place is already on its way. Only a forecast for the same place is merged,
  // onto whatever is there now.
  const fresh = readCache()
  if (!fresh.enabled || fresh.lat !== c.lat || fresh.lon !== c.lon || fresh.city !== c.city) return null
  if (f) {
    writeCache({ ...fresh, forecast: f, fetchedAt: now })
    return f
  }
  return fresh.forecast ?? null
}

/**
 * Choose a city instead of sharing a location: weather comes on with the
 * city's coordinates, and whatever forecast was cached for somewhere else is
 * dropped so the tile never shows the old place's sky for half an hour.
 * Unknown ids change nothing.
 */
export function setCity(id: string): City | null {
  const city = cityById(id)
  if (!city) return null
  writeCache({ enabled: true, lat: city.lat, lon: city.lon, city: city.id })
  return city
}

/**
 * Ask for the device's position — only ever called from the picker's "Use my
 * location", so the permission prompt is something the user asked for.
 * Granted: remember the coordinates, forget any chosen city and its forecast,
 * and switch weather on. Refused or timed out: a chosen city that was working
 * before the prompt keeps working — losing Phoenix because the device said no
 * would punish the try — and otherwise weather goes off, so the strip shows
 * the picker's Off state again instead of asking on every visit.
 */
export function requestLocation(): Promise<{ lat: number; lon: number } | null> {
  // Off, not half-off: `{...cache, enabled:false}` would keep the city and its
  // forecast under a switch that says off, and the next mount would show that
  // sky beside a picker reading "Weather off".
  const refuse = () => {
    const c = readCache()
    if (!(c.enabled && c.city)) disableWeather()
  }
  return new Promise(resolve => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      refuse()
      resolve(null)
      return
    }
    try {
      navigator.geolocation.getCurrentPosition(
        pos => {
          const lat = pos.coords.latitude
          const lon = pos.coords.longitude
          writeCache({ enabled: true, lat, lon })
          resolve({ lat, lon })
        },
        () => {
          refuse()
          resolve(null)
        },
        { timeout: 10_000, maximumAge: 600_000 },
      )
    } catch {
      refuse()
      resolve(null)
    }
  })
}

/** Opting out forgets the location, the city and the forecast, not just the switch. */
export function disableWeather(): void {
  writeCache({ enabled: false })
}
