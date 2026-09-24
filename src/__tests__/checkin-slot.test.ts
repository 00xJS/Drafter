import { describe, expect, it } from 'vitest'
import { CHECK_IN_PREFIX, nextOccurrence } from '../../shared/domain.mts'
import type { Task } from '../types'

// Finance's "Check in weekly" is a repeating task, so Home, the calendar and
// the reminders carry it with nothing new behind them. A chore comes round a
// week after it was last done; this one has a slot — Sunday at six — and a
// check-in done on Saturday afternoon must not make next week's due Saturday
// afternoon, or the reminder walks round the week.

const STAMP = '2026-09-01T00:00:00.000Z'
const sunday6pm = new Date(2026, 8, 27, 18, 0) // Sunday 27 September 2026
const task = (id: string, over: Partial<Task> = {}): Task => ({
  kind: 'task',
  id,
  title: 'Check in your balances',
  description: '',
  status: 'done',
  priority: 'normal',
  tags: [],
  createdAt: STAMP,
  updatedAt: STAMP,
  recurrence: { freq: 'weekly' },
  dueAt: sunday6pm.toISOString(),
  ...over,
})
const checkIn = (completed: Date) => task(`${CHECK_IN_PREFIX}abc`, { completedAt: completed.toISOString() })
const due = (t: Task | null) => (t?.dueAt ? new Date(t.dueAt) : null)

describe('the weekly check-in keeps its slot', () => {
  it('done a day early, is next due the Sunday after, at six', () => {
    expect(due(nextOccurrence(checkIn(new Date(2026, 8, 26, 14, 23)), () => 'x'))).toEqual(new Date(2026, 9, 4, 18, 0))
  })

  it('done on time, or a day late, is next due the coming Sunday at six', () => {
    expect(due(nextOccurrence(checkIn(new Date(2026, 8, 27, 18, 5)), () => 'x'))).toEqual(new Date(2026, 9, 4, 18, 0))
    expect(due(nextOccurrence(checkIn(new Date(2026, 8, 28, 9, 0)), () => 'x'))).toEqual(new Date(2026, 9, 4, 18, 0))
  })

  it('missed for three weeks, comes round on the next slot rather than three in the past', () => {
    expect(due(nextOccurrence(checkIn(new Date(2026, 9, 15, 20, 0)), () => 'x'))).toEqual(new Date(2026, 9, 18, 18, 0))
  })

  it('keeps its prefix, so every occurrence is still the check-in', () => {
    expect(nextOccurrence(checkIn(new Date(2026, 8, 27, 18, 5)), () => 'x')?.id.startsWith(CHECK_IN_PREFIX)).toBe(true)
  })

  it('leaves a chore as it was: a week from when it was done', () => {
    const chore = task('bins', { completedAt: new Date(2026, 8, 26, 14, 23).toISOString() })
    expect(due(nextOccurrence(chore, () => 'x'))).toEqual(new Date(2026, 9, 3, 14, 23))
  })

  it('leaves a bill as it was: every month it missed is still owed', () => {
    const rent = task('rent', { bill: { kind: 'bill' }, recurrence: { freq: 'monthly' }, dueAt: new Date(2026, 5, 1).toISOString(), completedAt: new Date(2026, 8, 20).toISOString() })
    expect(due(nextOccurrence(rent, () => 'x'))).toEqual(new Date(2026, 6, 1))
  })
})
