// Device position and how far a saved place is from it. Weather already
// asks for a location (and remembers it as a forecast preference). This is
// the same ask, without touching that cache: "I'm here" only wants where
// you are standing right now, and a pin on a place is saved on that place.

import { expectSystemPrompt } from './native'

export interface Coord {
  lat: number
  lon: number
}

/** How close a saved place has to be to count as nearby. */
export const NEARBY_METERS = 400
/** Close enough that "I'm here" can pick it without asking. */
export const HERE_METERS = 150

/**
 * A coordinate the app will keep: finite, in range, to five decimals
 * (about a metre). Anything else is dropped, so a bad GPS reading does
 * not stick to a place.
 */
export function tidyCoord(n: unknown, kind: 'lat' | 'lon'): number | undefined {
  const v = typeof n === 'number' ? n : typeof n === 'string' && n.trim() ? Number(n) : NaN
  if (!Number.isFinite(v)) return undefined
  const max = kind === 'lat' ? 90 : 180
  if (Math.abs(v) > max) return undefined
  return Math.round(v * 1e5) / 1e5
}

/** Both ends, or neither: a place with only a latitude is not somewhere. */
export function tidyCoords(raw: { lat?: unknown; lon?: unknown }): Coord | undefined {
  const lat = tidyCoord(raw.lat, 'lat')
  const lon = tidyCoord(raw.lon, 'lon')
  return lat !== undefined && lon !== undefined ? { lat, lon } : undefined
}

/**
 * The middle of the places that have a pin: where Find address leans its
 * search. Null with none pinned. A plain average, which is right for places
 * spread over one town or metro area, the only spread it is asked about.
 */
export function centroidOf(places: readonly { lat?: unknown; lon?: unknown; deletedAt?: string }[]): Coord | null {
  const pins = places.flatMap(p => (p.deletedAt ? [] : (tidyCoords(p) ?? [])))
  if (!pins.length) return null
  const mean = (k: 'lat' | 'lon') => pins.reduce((s, c) => s + c[k], 0) / pins.length
  return { lat: mean('lat'), lon: mean('lon') }
}

/** Great-circle metres between two points. */
export function haversineMeters(a: Coord, b: Coord): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const r = 6_371_000
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(1)} km`
}

export interface NearbyPlace<T> {
  place: T
  meters: number
}

/** Saved places with a pin, nearest first, inside `maxMeters`. */
export function nearbyPlaces<T>(places: readonly T[], here: Coord, maxMeters = NEARBY_METERS): NearbyPlace<T>[] {
  return places
    .flatMap(place => {
      const pin = tidyCoords(place as { lat?: unknown; lon?: unknown })
      if (!pin) return []
      const meters = haversineMeters(here, pin)
      return meters <= maxMeters ? [{ place, meters }] : []
    })
    .sort((a, b) => a.meters - b.meters || 0)
}

/**
 * Ask for the device's position. Only call from a tap ("I'm here", "Pin this
 * spot") so the permission prompt is something the user asked for. Granted:
 * the coordinates. Refused, timed out, or no geolocation: null. Does not
 * write the weather cache.
 */
export function requestDevicePosition(): Promise<Coord | null> {
  return new Promise(resolve => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve(null)
      return
    }
    // the first ask puts iOS's own alert up: the shell leaves the page in sight behind it
    void expectSystemPrompt().then(() => {
      try {
        navigator.geolocation.getCurrentPosition(
          pos => {
            const here = tidyCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude })
            resolve(here ?? null)
          },
          () => resolve(null),
          { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 },
        )
      } catch {
        resolve(null)
      }
    })
  })
}
