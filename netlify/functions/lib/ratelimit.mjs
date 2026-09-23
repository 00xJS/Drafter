// Rate limits: a sliding window in this process's memory, and a window every
// instance shares, kept in Postgres.
//
// The memory one alone is best effort: Netlify runs a function on several
// instances and recycles them, so it caps a runaway loop or a leaked session
// on one warm instance, but not calls spread across cold starts. /api/ai
// spends the owner's AI quota, so the endpoints that matter ask the shared one
// too (sharedWindow): public.rate_limit_take (migration v3.33) counts a call
// per account and bucket in one statement, whichever instance asks.

import { keyHeaders } from './supabasekeys.mjs'

export function slidingWindow({ limit, windowMs, now = () => Date.now(), maxKeys = 1000 }) {
  const hits = new Map()

  /** Forget keys with nothing left in the window, so a long-lived instance cannot grow without bound. */
  function sweep(t) {
    for (const [key, list] of hits) {
      if (!list.length || t - list[list.length - 1] >= windowMs) hits.delete(key)
    }
  }

  return {
    /**
     * Count one call for `key` if it fits in the window. A refused call is not
     * counted, so a client that backs off is let back in on time.
     */
    take(key) {
      const t = now()
      const recent = (hits.get(key) ?? []).filter(at => t - at < windowMs)
      if (recent.length >= limit) {
        hits.set(key, recent)
        return { ok: false, remaining: 0, retryAfterMs: Math.max(0, windowMs - (t - recent[0])) }
      }
      recent.push(t)
      hits.set(key, recent)
      if (hits.size > maxKeys) sweep(t)
      return { ok: true, remaining: limit - recent.length, retryAfterMs: 0 }
    },
  }
}

/** How long the shared window is given to answer before a call goes ahead on this instance's count alone. */
export const SHARED_TIMEOUT_MS = 2_500
/** After the shared window fails to answer, how long this instance counts on its own before asking again. */
export const SHARED_PAUSE_MS = 60_000

/**
 * A Postgres function called with the service key, resolving what it returned;
 * null when this host has no service key (local development), so the caller
 * counts in memory without a request that could only fail.
 */
export async function serviceRpc(name, args, { timeoutMs = SHARED_TIMEOUT_MS } = {}) {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) return null
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: keyHeaders(key, { 'content-type': 'application/json' }),
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`rpc/${name}: ${res.status}`)
  return res.json()
}

const count = v => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0)

/**
 * A limit of `limit` calls per `windowMs` for each key in `bucket`, counted
 * across every instance. A call has to fit this instance's own sliding window
 * first (as every call did before this existed, and without a round trip for
 * one that does not), and then the shared window, which starts at its first
 * call and is refused until it ends. When the shared window is not there — the
 * migration not applied yet, no service key, Postgres slow or down — the
 * instance's own answer stands, and it asks again after `pauseMs`. So code
 * deployed before v3.33 limits exactly as it did.
 *
 * `take` resolves { ok, remaining, retryAfterMs }, as slidingWindow's does.
 */
export function sharedWindow({ bucket, limit, windowMs, now = () => Date.now(), rpc = serviceRpc, pauseMs = SHARED_PAUSE_MS, local = slidingWindow({ limit, windowMs, now }) }) {
  const seconds = Math.max(1, Math.ceil(windowMs / 1000))
  let pausedUntil = 0
  return {
    async take(key) {
      const mine = local.take(key)
      if (!mine.ok || now() < pausedUntil) return mine
      let shared
      try {
        shared = await rpc('rate_limit_take', { p_subject: String(key), p_bucket: bucket, p_limit: limit, p_window_seconds: seconds })
      } catch {
        shared = undefined
      }
      if (shared === null) return mine
      if (!shared || typeof shared !== 'object' || typeof shared.allowed !== 'boolean') {
        pausedUntil = now() + pauseMs
        return mine
      }
      if (!shared.allowed) return { ok: false, remaining: 0, retryAfterMs: count(shared.retry_after_ms) }
      return { ok: true, remaining: Math.min(mine.remaining, count(shared.remaining)), retryAfterMs: 0 }
    },
  }
}
