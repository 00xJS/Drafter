import { useMemo } from 'react'
import { localDayKey } from './journal'
import { noonOf, useDayKey } from './useDayKey'

/**
 * The time now, on `day` — useDayKey's key, which a view reads as it renders
 * and names as a dependency of whatever it works out with this. Inside a memo
 * keyed on the records and the day, it is read afresh whenever either changes
 * and never in between: what a list of people or places counts from.
 *
 * A `new Date()` in that memo read the same, until the React Compiler compiled
 * the view: a clock read with nothing it depends on is one the compiler may
 * keep from the first render on, and a list left open overnight kept
 * yesterday. Naming the day makes midnight a change like any other.
 *
 * Should the clock have moved past `day` before the view has caught up, the
 * answer is `day`'s noon, so it is always on the day it was asked about.
 */
export function timeOn(day: string): Date {
  const now = new Date()
  return localDayKey(now) === day ? now : noonOf(day)
}

/**
 * One instant for a view that counts by the day — the Stats views, where
 * every figure is worked out from the same `now`: read when the view mounts
 * and again when the local day rolls over (useDayKey), and the same Date in
 * between, so a keystroke in a find box or a sync round leaves every figure
 * memoised on it alone. A time handed in (a test's, a caller's) is used as
 * it is.
 */
export function useDayClock(handed?: Date): Date {
  const today = useDayKey()
  return useMemo(() => handed ?? timeOn(today), [handed, today])
}
