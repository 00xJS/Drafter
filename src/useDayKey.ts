import { useEffect, useState } from 'react'
import { localDayKey } from './journal'

/**
 * Today's day key, which changes when the local day does.
 *
 * Every view here works out its own day with `localDayKey()` or `new Date()`
 * as it renders, which is right as far as it goes — and nothing ever made them
 * render again at midnight. On the web a tab left open overnight kept
 * yesterday; on the phone it is worse, because iOS suspends and resumes the
 * same page rather than killing it, so the app can sit on a day for as long as
 * it is never force-quit. The Wardrobe showed it plainest: the composer stayed
 * on yesterday, holding yesterday's look, and "Wearing this" would have
 * written the wear to yesterday's date.
 *
 * So: one timer to the next local midnight, and a check whenever the page
 * comes back, because a suspended timer does not fire on time.
 */
export function useDayKey(): string {
  const [key, setKey] = useState(localDayKey)
  useEffect(() => {
    // a server render has no window to hang a timer on, and these tests run
    // components in node: the key it already has is the right answer there
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    let timer = 0
    const tick = () => {
      // the same string keeps the render: only a real roll re-renders the tree
      setKey(k => {
        const now = localDayKey()
        return k === now ? k : now
      })
      clearTimeout(timer)
      timer = window.setTimeout(tick, untilNextDay())
    }
    timer = window.setTimeout(tick, untilNextDay())
    document.addEventListener('visibilitychange', tick)
    window.addEventListener('focus', tick)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', tick)
      window.removeEventListener('focus', tick)
    }
  }, [])
  return key
}

/**
 * Which day a view should show once the local day has rolled from `was` to
 * `now`: the new day when it was sitting on the old one, and the day it is on
 * otherwise.
 *
 * The distinction is the whole rule. A view left on today should follow the
 * clock — that is the bug this fixes. A day the reader went to themselves is
 * theirs, and being moved off it at midnight, mid-thought, would be its own
 * bug.
 */
export function dayAfterRoll(showing: string, was: string, now: string): string {
  return showing === was ? now : showing
}

/**
 * Milliseconds to the next local midnight, plus a second so the tick lands
 * inside the new day rather than on its edge. `setHours(24, …)` is the next
 * midnight in local time, which is what a day key is counted in — on the two
 * days a year that are 23 or 25 hours long, it is still the right instant.
 */
export function untilNextDay(now: Date = new Date()): number {
  const next = new Date(now)
  next.setHours(24, 0, 0, 0)
  return next.getTime() - now.getTime() + 1000
}
