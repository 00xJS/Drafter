// A sliding-window rate limit, per key, in this process's memory.
//
// Best effort by design: Netlify runs a function on several instances and
// recycles them, so a limit kept here caps a runaway loop or a leaked session
// on one warm instance — not a determined abuser spreading calls across cold
// starts. Anything stricter needs a shared store, and the one we have
// (Postgres) is not worth a round trip on every call for this.

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
