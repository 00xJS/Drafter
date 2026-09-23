// Types for the helpers src/ imports in tests. The runtime is geocode.mjs.
import type { Take } from './ratelimit.mjs'

export declare const NOMINATIM_SEARCH: string
export declare const USER_AGENT: string
export declare const MAX_CANDIDATES: number
export declare const REQUEST_GAP_MS: number
export declare const TIMEOUT_MS: number
export declare const AREA_RADIUS_KM: number
export declare const MAX_QUEUE_MS: number
export declare const BUDGET_MS: number

export interface Point {
  lat: number
  lon: number
}

/** One address OpenStreetMap offered: a name (empty for a bare address), one readable line, and the point to five decimals. */
export interface Candidate {
  name: string
  address: string
  lat: number
  lon: number
}

export declare function roughPoint(raw: unknown): Point | null
export declare function viewboxAround(point: Point, radiusKm?: number): string
export declare function searchUrl(q: string, opts?: { viewbox?: string | null; bounded?: boolean; limit?: number }): string
export declare function usStreet(road: string): string
export declare function formatAddress(address: unknown, fallback?: string): string
export declare function parseResults(json: unknown, limit?: number): Candidate[]

export interface Gate {
  wait(maxWaitMs?: number): Promise<boolean>
}
export declare function createGate(gapMs?: number, opts?: { now?: () => number; sleep?: (ms: number) => Promise<void> }): Gate

export interface Cache {
  get(key: string): unknown
  set(key: string, value: unknown): void
}
export declare function createCache(opts?: { max?: number; ttlMs?: number; now?: () => number }): Cache

export declare function nominatim(
  url: string,
  opts: { fetchImpl: (url: string, init?: RequestInit) => Promise<Response>; gate?: Gate; cache?: Cache; timeoutMs?: number; maxWaitMs?: number },
): Promise<unknown[]>

export declare function createGeocodeHandler(deps?: {
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>
  gate?: Gate
  cache?: Cache
  perUser?: { take(key: string): Take }
  now?: () => number
}): (req: Request) => Promise<Response>
