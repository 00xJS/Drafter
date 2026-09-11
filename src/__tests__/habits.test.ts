import { describe, it, expect } from 'vitest'
import { Habit } from '../types'
import { isDueOn, isDoneOn, toggleDone, streakOf, rangeStats, habitsConsistency } from '../habits'
import { sanitizeHabit } from '../schema'

function habit(over: Partial<Habit> = {}): Habit {
  return { kind: 'habit', id: 'h1', name: 'Read', done: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over }
}
// Sep 2026: 10 Thu, 11 Fri, 12 Sat, 13 Sun, 14 Mon, 15 Tue.
const day = (n: number) => new Date(2026, 8, n)

describe('a habit is due on its scheduled days', () => {
  it('with no days set, is due every day', () => {
    const h = habit()
    expect(isDueOn(h, day(12))).toBe(true) // Saturday
    expect(isDueOn(h, day(14))).toBe(true) // Monday
  })
  it('with weekdays chosen, is due only on those', () => {
    const h = habit({ days: [1, 2, 3, 4, 5] }) // Mon–Fri
    expect(isDueOn(h, day(11))).toBe(true) // Friday
    expect(isDueOn(h, day(12))).toBe(false) // Saturday
    expect(isDueOn(h, day(13))).toBe(false) // Sunday
    expect(isDueOn(h, day(14))).toBe(true) // Monday
  })
})

describe('ticking a day', () => {
  it('adds, removes, and keeps the list sorted and unique', () => {
    let h = habit()
    h = toggleDone(h, '2026-09-10')
    h = toggleDone(h, '2026-09-08')
    expect(h.done).toEqual(['2026-09-08', '2026-09-10'])
    expect(isDoneOn(h, '2026-09-10')).toBe(true)
    h = toggleDone(h, '2026-09-10')
    expect(h.done).toEqual(['2026-09-08'])
  })
})

describe('the streak', () => {
  it('counts consecutive done days up to today', () => {
    const h = habit({ done: ['2026-09-08', '2026-09-09', '2026-09-10'] })
    expect(streakOf(h, day(10))).toBe(3)
  })
  it('breaks on a missed day in the past', () => {
    const h = habit({ done: ['2026-09-08', '2026-09-10'] }) // 9th missed
    expect(streakOf(h, day(10))).toBe(1)
  })
  it('an unticked today does not zero a run still in progress', () => {
    const h = habit({ done: ['2026-09-08', '2026-09-09'] }) // today (10th) not yet ticked
    expect(streakOf(h, day(10))).toBe(2)
  })
  it('skips days the habit is not due on, so a weekday streak survives the weekend', () => {
    const h = habit({ days: [1, 2, 3, 4, 5], done: ['2026-09-10', '2026-09-11', '2026-09-14', '2026-09-15'] })
    // Tue15 ← Mon14 ← (skip Sun/Sat) ← Fri11 ← Thu10 = 4
    expect(streakOf(h, day(15))).toBe(4)
  })
  it('is zero when nothing is done', () => {
    expect(streakOf(habit(), day(10))).toBe(0)
  })
})

describe('range stats for the review', () => {
  it('counts done against due across the range', () => {
    const h = habit({ days: [1, 2, 3, 4, 5], done: ['2026-09-10', '2026-09-14'] })
    // Thu10..Mon14 inclusive: due on 10,11,14 (weekdays); done 10 and 14
    expect(rangeStats(h, day(10), day(14))).toEqual({ done: 2, due: 3 })
  })
})

describe('habits consistency for the review', () => {
  // review ranges end EXCLUSIVE: Sun 6 → Sun 13 is the week of the 6th–12th
  const start = day(6)
  const end = day(13)
  it('totals done against due across every habit, ignoring the exclusive end day', () => {
    const read = habit({ id: 'a', done: ['2026-09-07', '2026-09-08', '2026-09-13'] }) // 13th is outside
    const gym = habit({ id: 'b', days: [1, 3, 5], done: ['2026-09-07'] }) // Mon/Wed/Fri: due 7, 9, 11
    const c = habitsConsistency([read, gym], start, end, day(20))
    expect(c.rows.map(r => [r.habit.id, r.done, r.due])).toEqual([
      ['a', 2, 7],
      ['b', 1, 3],
    ])
    expect(c).toMatchObject({ done: 3, due: 10, pct: 30 })
  })
  it('only counts days up to today when the period is still in progress', () => {
    const h = habit({ done: ['2026-09-06', '2026-09-07', '2026-09-08'] })
    const c = habitsConsistency([h], start, end, day(8)) // Tuesday
    expect(c).toMatchObject({ done: 3, due: 3, pct: 100 })
  })
  it('drops habits with nothing due and is empty when nothing was due at all', () => {
    const weekday = habit({ days: [1, 2, 3, 4, 5] })
    const c = habitsConsistency([weekday], day(12), day(14), day(20)) // Sat 12 – Sun 13
    expect(c.rows).toEqual([])
    expect(c).toMatchObject({ done: 0, due: 0, pct: 0 })
    expect(habitsConsistency([], start, end, day(20)).due).toBe(0)
  })
  it('counts nothing for a period entirely in the future', () => {
    expect(habitsConsistency([habit()], day(20), day(27), day(10)).due).toBe(0)
  })
  it('starts counting the day a habit was created, not the start of the period', () => {
    // created and ticked on Thu 10 in the week Sun 6 – Sat 12, reviewed on Thu 10
    const born = new Date(2026, 8, 10, 14, 30).toISOString()
    const fresh = habit({ id: 'new', createdAt: born, updatedAt: born, done: ['2026-09-10'] })
    expect(habitsConsistency([fresh], start, end, day(10))).toMatchObject({ done: 1, due: 1, pct: 100 })
    // last month never had it: no row, rather than 0 of 31
    expect(habitsConsistency([fresh], new Date(2026, 7, 1), new Date(2026, 8, 1), day(10)).rows).toEqual([])
    // and a habit that predates the period is unaffected
    expect(habitsConsistency([habit()], start, end, day(20)).due).toBe(7)
  })
})

describe('sanitizeHabit', () => {
  it('drops invalid weekdays and de-dupes completions', () => {
    const h = sanitizeHabit({ kind: 'habit', id: 'h9', name: 'Walk', days: [0, 1, 9, -1, 'x'], done: ['2026-09-10', '2026-09-10', 'nope'] })
    expect(h).not.toBeNull()
    expect(h!.days).toEqual([0, 1])
    expect(h!.done).toEqual(['2026-09-10'])
  })
  it('needs an id', () => {
    expect(sanitizeHabit({ kind: 'habit', name: 'x' })).toBeNull()
  })
  it('treats a full week the same as every day (no days)', () => {
    // seven days chosen is stored as given; the UI collapses it to "every day"
    const h = sanitizeHabit({ kind: 'habit', id: 'h', name: 'x', days: [0, 1, 2, 3, 4, 5, 6] })
    expect(h!.days).toEqual([0, 1, 2, 3, 4, 5, 6])
  })
})
