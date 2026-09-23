import { useEffect, useState } from 'react'

/**
 * The time, for a view that says how long ago or how soon something is.
 *
 * Read as the view mounts, then every `stepMs` and whenever the page comes
 * back — never while it renders, so a render gives the same answer however
 * often React runs it, and a page left open still moves on (iOS resumes the
 * same page for days rather than reloading it; see useDayKey).
 */
export function useNow(stepMs = 60_000): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    // a server render, and these tests in node, keep the time they started with
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    const tick = () => setNow(Date.now())
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick()
    }
    const timer = window.setInterval(tick, stepMs)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [stepMs])
  return now
}
