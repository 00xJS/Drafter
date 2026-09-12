import { describe, expect, it } from 'vitest'
import { dueLabel, dueTone, hasDueTime } from '../taskutils'
import { Task } from '../types'

const task = (dueAt: string, status: Task['status'] = 'todo'): Task => ({
  kind: 'task',
  id: 't',
  title: 't',
  description: '',
  status,
  priority: 'normal',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  tags: [],
  dueAt,
})

// built from local parts, the way the editor's datetime-local field writes them;
// a task with a date and no time is stored at that day's local midnight
const on12th = (h: number, m = 0) => new Date(2026, 8, 12, h, m).toISOString()
const now = (day: number, h: number, m = 0) => new Date(2026, 8, day, h, m)

describe('an untimed task is due all day, not late from midnight', () => {
  it('reads as due today at every hour of its day', () => {
    const t = task(on12th(0))
    for (const h of [0, 1, 7, 12, 18, 23]) expect(dueTone(t, now(12, h, 30))).toBe('today')
    expect(dueLabel(t, now(12, 17))).toBe('Today')
  })

  it('becomes overdue once its day is over', () => {
    const t = task(on12th(0))
    expect(dueTone(t, now(13, 0, 1))).toBe('overdue')
    expect(dueLabel(t, now(13, 0, 1))).toBe('Overdue 1d')
  })

  it('still calls a timed task late once its time has passed', () => {
    const t = task(on12th(15))
    expect(dueTone(t, now(12, 14))).toBe('today')
    expect(dueTone(t, now(12, 17))).toBe('late')
    expect(dueLabel(t, now(12, 17))).toMatch(/^Was /)
  })

  it('treats any minute past midnight as a time', () => {
    expect(hasDueTime(on12th(0))).toBe(false)
    expect(hasDueTime(on12th(0, 30))).toBe(true)
    expect(dueTone(task(on12th(0, 30)), now(12, 9))).toBe('late')
  })

  it('leaves a finished task without a tone', () => {
    expect(dueTone(task(on12th(0), 'done'), now(12, 9))).toBe('none')
  })
})
