import { describe, expect, it } from 'vitest'
import { sanitizeEvent, sanitizeItem, sanitizeTask } from '../schema'
import { duplicateTask } from '../taskutils'
import { nextOccurrence } from '../../shared/domain.mjs'
import type { CalendarEntry, Task } from '../types'

// B1: today's focus lives on the task (focusOn / focusBy) and a time block on
// its event (taskId). Every pulled row is rebuilt from a fixed field list, so a
// field the sanitizer does not know vanishes on the next sync — these pin that
// the three survive, that garbage does not, and that a copy starts unfocused.

const STAMP = '2026-09-01T00:00:00.000Z'
const task = (over: Partial<Task> = {}): Task => ({
  kind: 'task',
  id: 't1',
  title: 'Sort the garage',
  description: '',
  status: 'todo',
  priority: 'normal',
  createdAt: STAMP,
  updatedAt: STAMP,
  tags: [],
  ...over,
})

describe('sanitizeTask keeps today’s focus', () => {
  it('round-trips focusOn and focusBy', () => {
    const t = sanitizeTask(task({ focusOn: '2026-09-14', focusBy: 'user-1' }))
    expect(t).toMatchObject({ focusOn: '2026-09-14', focusBy: 'user-1' })
    // and through the entry point every pulled row takes
    expect(sanitizeItem(task({ focusOn: '2026-09-14', focusBy: 'user-1' }))).toMatchObject({ focusOn: '2026-09-14', focusBy: 'user-1' })
  })

  it('takes only a real local day key, never an instant turned into its UTC date', () => {
    // dateOnly would have made this "2026-09-14" — the wrong day west of Greenwich
    expect(sanitizeTask(task({ focusOn: '2026-09-14T23:30:00.000Z' }))!.focusOn).toBeUndefined()
    expect(sanitizeTask(task({ focusOn: '2026-02-30' }))!.focusOn).toBeUndefined()
    expect(sanitizeTask(task({ focusOn: '14/09/2026' }))!.focusOn).toBeUndefined()
    expect(sanitizeTask({ ...task(), focusOn: 20260914 })!.focusOn).toBeUndefined()
    expect(sanitizeTask(task({ focusOn: '' }))!.focusOn).toBeUndefined()
    // surrounding space is forgiven, the key itself is not
    expect(sanitizeTask(task({ focusOn: ' 2026-09-14 ' }))!.focusOn).toBe('2026-09-14')
  })

  it('drops a blank or non-string focusBy', () => {
    expect(sanitizeTask(task({ focusOn: '2026-09-14', focusBy: '   ' }))!.focusBy).toBeUndefined()
    expect(sanitizeTask({ ...task(), focusBy: { id: 'x' } })!.focusBy).toBeUndefined()
  })

  it('leaves a task that never had a focus without one', () => {
    const t = sanitizeTask(task())!
    expect(t.focusOn).toBeUndefined()
    expect(t.focusBy).toBeUndefined()
  })
})

describe('sanitizeEvent keeps the task a time block belongs to', () => {
  const block: CalendarEntry = {
    kind: 'event',
    id: 'ev1',
    title: 'Sort the garage',
    start: '2026-09-14T09:00:00.000Z',
    end: '2026-09-14T10:00:00.000Z',
    allDay: false,
    taskId: 't1',
    createdAt: STAMP,
    updatedAt: STAMP,
  }

  it('round-trips taskId', () => {
    expect(sanitizeEvent(block)!.taskId).toBe('t1')
    expect(sanitizeItem(block)).toMatchObject({ kind: 'event', taskId: 't1' })
  })

  it('drops a blank one, and an ordinary event has none', () => {
    expect(sanitizeEvent({ ...block, taskId: '  ' })!.taskId).toBeUndefined()
    const { taskId: _, ...plain } = block
    expect(sanitizeEvent(plain)!.taskId).toBeUndefined()
  })
})

describe('a copy of a focused task starts unfocused', () => {
  const focused = task({ focusOn: '2026-09-14', focusBy: 'user-1', recurrence: { freq: 'weekly' }, status: 'done', completedAt: '2026-09-14T08:00:00.000Z' })

  it('is not carried to the next occurrence of a repeat', () => {
    const next = nextOccurrence(focused, () => 'x')
    expect(next).not.toBeNull()
    expect(next).not.toHaveProperty('focusOn')
    expect(next).not.toHaveProperty('focusBy')
  })

  it('is not carried to a duplicate', () => {
    const copy = duplicateTask(focused)
    expect(copy).not.toHaveProperty('focusOn')
    expect(copy).not.toHaveProperty('focusBy')
  })
})
