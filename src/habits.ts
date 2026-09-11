import { Habit } from './types'
import { dateKey } from './utils'

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

/** Tick or un-tick a day, returning the updated record (sorted, de-duped). */
export function toggleDone(habit: Habit, key: string, now = new Date().toISOString()): Habit {
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
