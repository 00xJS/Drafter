// Types for the helper src/ imports in tests. The runtime is ratelimit.mjs.
export interface Take {
  ok: boolean
  remaining: number
  retryAfterMs: number
}

export declare function slidingWindow(opts: { limit: number; windowMs: number; now?: () => number; maxKeys?: number }): { take(key: string): Take }
