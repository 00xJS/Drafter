import { ApiError, apiFetch } from './api'
import { centroidOf, type Coord } from './geo'
import { isSupabaseConfigured } from './supabase'
import type { Place } from './types'
import { readCache } from './weather'

// Find address, on the device's side: which area a lookup leans to, the one
// request, and what each way it can fail says. Drafter's own server does the
// asking (/api/geocode → OpenStreetMap), so a copy of the app running on its
// own can offer the button and explain, but not look anything up.

/** One address OpenStreetMap offered, as /api/geocode answers it. */
export interface AddressCandidate {
  /** The place's name there, or '' for a bare address. */
  name: string
  /** One line: "2502 E Camelback Rd, Phoenix, AZ 85016". */
  address: string
  lat: number
  lon: number
}

/**
 * Where a lookup leans: the middle of your pinned places, else the weather's
 * location if you turned weather on, else a town you typed once. Each carries
 * the words the finder shows for it.
 */
export type LookupArea = { near: Coord; from: 'places' | 'weather' | 'typed'; label: string } | { typed: string; from: 'typed'; label: string }

/** The town typed for Find address, remembered on this device, and its point once the server has looked it up. */
export interface TypedArea {
  text: string
  lat?: number
  lon?: number
}

export const AREA_KEY = 'drafter:places-area'

export function readTypedArea(): TypedArea | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = JSON.parse(localStorage.getItem(AREA_KEY) ?? 'null') as Partial<TypedArea> | null
    const text = typeof raw?.text === 'string' ? raw.text.trim() : ''
    if (!text) return null
    const point = Number.isFinite(raw?.lat) && Number.isFinite(raw?.lon) ? { lat: raw!.lat!, lon: raw!.lon! } : {}
    return { text, ...point }
  } catch {
    return null
  }
}

/** Keep the typed town (and its point, when known); an empty one forgets it. */
export function writeTypedArea(area: TypedArea | null): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (!area || !area.text.trim()) localStorage.removeItem(AREA_KEY)
    else localStorage.setItem(AREA_KEY, JSON.stringify({ ...area, text: area.text.trim() }))
  } catch {
    // private mode or a full store: the town is asked for again next time
  }
}

/** Two decimals, about a kilometre: the rough area, never the doorstep. */
const rough = (c: Coord): Coord => ({ lat: Math.round(c.lat * 100) / 100, lon: Math.round(c.lon * 100) / 100 })

/**
 * The area a lookup leans to, in that order: your pinned places' middle, the
 * weather's location (only while weather is on), then the town you typed.
 * Null when there is none of them, and the finder asks for a town.
 */
export function lookupArea(places: readonly Place[], weather = readCache(), typed = readTypedArea()): LookupArea | null {
  const middle = centroidOf(places)
  if (middle) return { near: rough(middle), from: 'places', label: 'near your pinned places' }
  if (weather.enabled && Number.isFinite(weather.lat) && Number.isFinite(weather.lon)) return { near: rough({ lat: weather.lat!, lon: weather.lon! }), from: 'weather', label: 'near your weather location' }
  if (typed?.text) {
    return Number.isFinite(typed.lat) && Number.isFinite(typed.lon)
      ? { near: rough({ lat: typed.lat!, lon: typed.lon! }), from: 'typed', label: `near ${typed.text}` }
      : { typed: typed.text, from: 'typed', label: `near ${typed.text}` }
  }
  return null
}

/** Why a lookup found nothing to show, in words for the finder. */
export class LookupError extends Error {
  constructor(
    message: string,
    public kind: 'server' | 'signin' | 'busy' | 'upstream' | 'other',
  ) {
    super(message)
  }
}

export const NEEDS_SERVER =
  "Finding an address needs Drafter's server: it works on the hosted site and in the iPhone app, not in a copy of the app running on its own."

/** Lookups from this device go at least this far apart, whoever asks: OpenStreetMap allows one a second. */
export const LOOKUP_GAP_MS = 1100

let lastLookupAt = 0

/** For tests: the next lookup goes at once. */
export function resetLookupClock(): void {
  lastLookupAt = 0
}

export interface LookupDeps {
  fetch?: (path: string, init: RequestInit & { timeoutMs?: number }) => Promise<Response>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Look a place up: its name (and whatever else was typed) near `area`. Waits
 * its turn so no two lookups from this device are closer than LOOKUP_GAP_MS.
 * Answers the candidates, and the point of a typed town the server looked up
 * (the caller keeps it, so the town is looked up once). Throws a LookupError
 * whose message says what to do.
 */
export async function findAddress(q: string, area: LookupArea | null, deps: LookupDeps = {}): Promise<{ candidates: AddressCandidate[]; area?: Coord }> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  // the turn is taken before the wait, so two asked at once still go apart
  const t = now()
  const at = lastLookupAt ? Math.max(t, lastLookupAt + LOOKUP_GAP_MS) : t
  lastLookupAt = at
  if (at > t) await sleep(at - t)
  const body = { q, ...(area && 'near' in area ? { near: area.near } : {}), ...(area && 'typed' in area ? { area: area.typed } : {}) }
  let res: Response
  try {
    res = await (deps.fetch ?? apiFetch)('/api/geocode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 15_000 })
  } catch (e) {
    throw new LookupError(e instanceof ApiError || !isSupabaseConfigured() ? NEEDS_SERVER : 'The lookup did not go through. Try again in a moment.', 'server')
  }
  // a copy served without the functions answers the app page, or a 404
  const json = (await res.json().catch(() => null)) as { candidates?: unknown; area?: unknown; error?: unknown } | null
  if (!json || res.status === 404 || res.status === 405) throw new LookupError(NEEDS_SERVER, 'server')
  const said = typeof json.error === 'string' ? json.error : ''
  if (res.status === 401 || res.status === 503) throw new LookupError('Sign in to Drafter to look up addresses.', 'signin')
  if (res.status === 429) throw new LookupError(said || 'Too many lookups just now. Try again in a minute.', 'busy')
  if (!res.ok) throw new LookupError(said || 'OpenStreetMap did not answer. Try again in a moment.', res.status >= 500 ? 'upstream' : 'other')
  const candidates = (Array.isArray(json.candidates) ? json.candidates : []).flatMap((c): AddressCandidate[] => {
    const x = c as Partial<AddressCandidate> | null
    return x && typeof x.address === 'string' && Number.isFinite(x.lat) && Number.isFinite(x.lon)
      ? [{ name: typeof x.name === 'string' ? x.name : '', address: x.address, lat: x.lat!, lon: x.lon! }]
      : []
  })
  const point = json.area as Partial<Coord> | undefined
  return { candidates, ...(point && Number.isFinite(point.lat) && Number.isFinite(point.lon) ? { area: { lat: point.lat!, lon: point.lon! } } : {}) }
}

/**
 * What to look a place up by: its name, and the address as far as it was
 * typed ("Nopi, Warwick St"), so a half-remembered street narrows it.
 */
export function lookupQuery(name: string, address?: string): string {
  return [name, address].map(s => (s ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(', ')
}
