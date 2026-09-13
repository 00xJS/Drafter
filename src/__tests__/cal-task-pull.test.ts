import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type GoogleChange, mirrorChangeWrites } from '../calendars'
import type { Task } from '../types'

// A task mirrored into Google or Outlook comes back when it is moved or
// deleted there. What that does to the task lived in a closure inside the
// planner's calendar hook, where no test reached it, and each rule has already
// shipped its bug once: the pull rewrote every untimed task to 09:00 and said
// Google had moved it, and moving a task to Wishlist marked it done seconds
// later. These run in London, where the 09:00 rewrite was seen: in summer, a
// task's local midnight is 23:00 the day before in UTC.

const zone = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'Europe/London'
})
afterAll(() => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})

const STAMP = '2026-09-10T10:00:00.000Z'
/** A provider's edit five minutes after the task's own last one. */
const LATER = '2026-09-10T10:05:00.000Z'

/** Local midnight on a September day: a task with a day and no time. */
const day = (d: number) => new Date(2026, 8, d).toISOString()
const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).toISOString()

function task(over: Partial<Task> = {}): Task {
  return {
    kind: 'task',
    id: 't1',
    title: 'Pay rent',
    description: '',
    status: 'todo',
    priority: 'normal',
    dueAt: day(20),
    tags: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: STAMP,
    ...over,
  }
}

/** What googlePullRows (or the Outlook pull) hands back for a mirrored task. */
const change = (over: Partial<GoogleChange> = {}): GoogleChange => ({ taskId: 't1', deleted: false, start: '2026-09-20', allDay: true, updated: LATER, ...over })
const deleted = (over: Partial<GoogleChange> = {}) => change({ deleted: true, start: null, allDay: false, ...over })

const NOTHING = { writes: [], done: [] }

describe('mirrorChangeWrites: a task moved in Google or Outlook', () => {
  it('runs where a local day starts the evening before in UTC', () => {
    expect(day(20)).toBe('2026-09-19T23:00:00.000Z')
  })

  it('writes nothing for an all-day change on the task’s own local day', () => {
    // what Google hands back straight after the push wrote the task as all-day
    expect(mirrorChangeWrites([task()], [change()])).toEqual(NOTHING)
  })

  it('writes nothing for a Google 09:00 echo', () => {
    // the old pull sent a date-only start as `${date}T09:00:00`: read by its date, it has not moved
    expect(mirrorChangeWrites([task()], [change({ start: '2026-09-20T09:00:00' })])).toEqual(NOTHING)
    // and a task that pull already moved to 09:00 is left alone by its own all-day event
    expect(mirrorChangeWrites([task({ dueAt: at(20, 9) })], [change()])).toEqual(NOTHING)
    // nor is one just after local midnight, which is the day before in UTC
    expect(mirrorChangeWrites([task({ dueAt: at(20, 0, 30) })], [change()])).toEqual(NOTHING)
  })

  it('moves an untimed task to local midnight of the day it was moved to', () => {
    const t = task()
    const { writes, done } = mirrorChangeWrites([t], [change({ start: '2026-09-22' })])
    expect(done).toEqual([])
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ id: 't1', title: 'Pay rent', status: 'todo', dueAt: day(22) })
    expect(writes[0].dueAt).toBe('2026-09-21T23:00:00.000Z')
    expect(writes[0].updatedAt > t.updatedAt).toBe(true)
  })

  it('moves a timed task to the instant the provider gives, whatever zone it answers in', () => {
    const [row] = mirrorChangeWrites([task({ dueAt: at(20, 14) })], [change({ allDay: false, start: '2026-09-21T15:30:00+01:00' })]).writes
    expect(row.dueAt).toBe('2026-09-21T14:30:00.000Z')
  })

  it('ignores a change no newer than the task’s own last edit, one with no start, and one for a task it does not have', () => {
    expect(mirrorChangeWrites([task()], [change({ start: '2026-09-22', updated: STAMP })])).toEqual(NOTHING)
    expect(mirrorChangeWrites([task()], [change({ start: null })])).toEqual(NOTHING)
    expect(mirrorChangeWrites([task()], [change({ taskId: 'gone', start: '2026-09-22' })])).toEqual(NOTHING)
  })
})

describe('mirrorChangeWrites: a task deleted in Google or Outlook', () => {
  it('marks a mirrored task done, keeping the status Undo puts back', () => {
    const tasks = [task(), task({ id: 't2', status: 'doing' }), task({ id: 't3', status: 'blocked', dueAt: at(20, 14) })]
    const { writes, done } = mirrorChangeWrites(tasks, [deleted(), deleted({ taskId: 't2' }), deleted({ taskId: 't3' })])
    expect(writes).toEqual([])
    expect(done).toEqual([
      { id: 't1', prevStatus: 'todo' },
      { id: 't2', prevStatus: 'doing' },
      { id: 't3', prevStatus: 'blocked' },
    ])
  })

  it('does not mark done a task just moved to Wishlist: that cancellation was the mirror’s own', () => {
    // moved to Wishlist at 10:05, the mirror took the event down, and the pull saw it cancelled at 10:05:03
    const t = task({ status: 'wishlist', updatedAt: LATER })
    expect(mirrorChangeWrites([t], [deleted({ updated: '2026-09-10T10:05:03.000Z' })])).toEqual(NOTHING)
  })

  it('does not mark done a task whose date was cleared, or one already finished', () => {
    expect(mirrorChangeWrites([task({ dueAt: undefined })], [deleted()])).toEqual(NOTHING)
    expect(mirrorChangeWrites([task({ status: 'done' })], [deleted()])).toEqual(NOTHING)
    expect(mirrorChangeWrites([task({ status: 'canceled' })], [deleted()])).toEqual(NOTHING)
  })

  it('ignores a delete no newer than the task’s own last edit', () => {
    expect(mirrorChangeWrites([task()], [deleted({ updated: STAMP })])).toEqual(NOTHING)
  })
})
