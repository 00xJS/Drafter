import { Habit } from './types'
import { dateKey } from './utils'
import { newerStamp } from './itemops'

// The rules a habit is kept by. Completions are day keys on the record; the
// streak is derived from them and the schedule, never stored, so it can never
// drift out of sync with the ticks.

/** Due on this weekday? No days (or an empty list) means every day. */
export function isDueOn(habit: Habit, d: Date): boolean {
  if (!habit.days || habit.days.length === 0) return true
  return habit.days.includes(d.getDay())
}

export function isDoneOn(habit: Habit, key: string): boolean {
  return habit.done.includes(key)
}

/**
 * Tick or un-tick a day, returning the updated record (sorted, de-duped).
 * Stamped with newerStamp, not the wall clock: a tick made on a device whose
 * clock trails the copy it pulled would carry an older updatedAt, the server's
 * strictly-newer upsert would drop it silently — not rejected, not echoed —
 * and the sync would still count it confirmed. Strictly newer always lands.
 */
export function toggleDone(habit: Habit, key: string, now = newerStamp(habit.updatedAt)): Habit {
  const done = habit.done.includes(key) ? habit.done.filter(k => k !== key) : [...habit.done, key].sort()
  return { ...habit, done, updatedAt: now }
}

/**
 * Current streak: consecutive DUE days up to today that are done. A due day
 * that was missed breaks it; a day the habit isn't due on is skipped, not
 * counted, so a weekday habit's streak survives the weekend. Today counts once
 * it is ticked, but an as-yet-unticked today does not break a run you are still
 * in — it just isn't added yet.
 */
export function streakOf(habit: Habit, today = new Date()): number {
  const doneSet = new Set(habit.done)
  let streak = 0
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  for (let i = 0; i < 3660; i++) {
    if (isDueOn(habit, d)) {
      if (doneSet.has(dateKey(d))) streak++
      else if (i > 0) break // a missed day in the past ends the streak; today just waits
    }
    d.setDate(d.getDate() - 1)
  }
  return streak
}

/** Done and due counts over an inclusive day range — for the weekly review. */
export function rangeStats(habit: Habit, start: Date, end: Date): { done: number; due: number } {
  const doneSet = new Set(habit.done)
  let done = 0
  let due = 0
  const d = new Date(start.getFullYear(), start.getMonth(), start.getDate())
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate())
  while (d.getTime() <= last.getTime()) {
    if (isDueOn(habit, d)) {
      due++
      if (doneSet.has(dateKey(d))) done++
    }
    d.setDate(d.getDate() + 1)
  }
  return { done, due }
}

export interface HabitConsistency {
  rows: { habit: Habit; done: number; due: number }[]
  done: number
  due: number
  /** 0–100, rounded; 0 when nothing was due. */
  pct: number
}

/**
 * Every habit's done/due over a review period, plus the total. `end` is
 * EXCLUSIVE to match a review Range, where rangeStats is inclusive — passing it
 * straight through would count the first day of the next period. Days after
 * `today` are not yet due, so a week still in progress reads "3/3 so far"
 * rather than "3/7" and the summary isn't told you are slacking. Days before
 * the habit existed are not owed either: one created and ticked on Thursday
 * is 1/1, not 1/5, and a review of last month shows nothing for it at all.
 */
export function habitsConsistency(habits: Habit[], start: Date, end: Date, today = new Date()): HabitConsistency {
  // calendar-date arithmetic, never milliseconds, so a DST day doesn't shift the edge
  const lastInRange = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1)
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const last = lastInRange.getTime() < todayStart.getTime() ? lastInRange : todayStart
  const rows = habits
    .map(habit => {
      // createdAt is an instant; the habit's first day is that instant's LOCAL day
      const born = new Date(habit.createdAt)
      const bornDay = Number.isNaN(born.getTime()) ? start : new Date(born.getFullYear(), born.getMonth(), born.getDate())
      const from = bornDay.getTime() > start.getTime() ? bornDay : start
      return { habit, ...rangeStats(habit, from, last) }
    })
    .filter(r => r.due > 0)
  const done = rows.reduce((s, r) => s + r.done, 0)
  const due = rows.reduce((s, r) => s + r.due, 0)
  return { rows, done, due, pct: due ? Math.round((done / due) * 100) : 0 }
}
