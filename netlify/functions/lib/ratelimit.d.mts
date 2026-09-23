// Types for the helper src/ imports in tests. The runtime is ratelimit.mjs.
export interface Take {
  ok: boolean
  remaining: number
  retryAfterMs: number
}

/** What public.rate_limit_take answers (migration v3.33). */
export interface SharedTake {
  allowed: boolean
  remaining: number
  retry_after_ms: number
}

export type Rpc = (name: string, args: Record<string, unknown>) => Promise<unknown>

export declare const SHARED_TIMEOUT_MS: number
export declare const SHARED_PAUSE_MS: number

export declare function slidingWindow(opts: { limit: number; windowMs: number; now?: () => number; maxKeys?: number }): { take(key: string): Take }

export declare function serviceRpc(name: string, args: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<unknown>

export declare function sharedWindow(opts: {
  bucket: string
  limit: number
  windowMs: number
  now?: () => number
  rpc?: Rpc
  pauseMs?: number
  local?: { take(key: string): Take }
}): { take(key: string): Promise<Take> }
