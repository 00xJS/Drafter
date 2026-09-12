import { describe, expect, it } from 'vitest'
import {
  FocusTask,
  MAX_FOCUS,
  allocateBlocks,
  focusCandidates,
  freeSlots,
  leftovers,
  planDayWrites,
  rescheduledDueAt,
  restoreSnapshots,
  shutdownWrites,
  todayDueAt,
} from '../focus'
import { shiftRange, weekRange } from '../review'
import { duplicateTask } from '../taskutils'
import { nextOccurrence } from '../../shared/domain.mjs'
import { focusTasks, isFocusFor } from '../../shared/today.mjs'
import type { CalendarEvent, Review } from '../types'

// Plan my day and Shut down write focus, dates and time blocks in one go, with
// one Undo. These pin the rules: who a focus belongs to, the three-pick cap,
// where free time is, what each plan writes, and what Undo puts back.

const now = new Date(2026, 8, 14, 7, 0) // Monday 14 September 2026, 07:00 local
const TODAY = '2026-09-14'
const TOMORROW = '2026-09-15'
/** A September day in local time. */
const at = (d: number, h = 0, m = 0) => new Date(2026, 8, d, h, m).toISOString()
const STAMP = '2026-09-01T00:00:00.000Z'
const task = (id: string, over: Partial<FocusTask> = {}): FocusTask => ({
  kind: 'task',
  id,
  title: id,
  description: '',
  status: 'todo',
  priority: 'normal',
  createdAt: STAMP,
  updatedAt: STAMP,
  tags: [],
  ...over,
})
const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
const byId = <T extends { id: string }>(xs: T[]) => new Map(xs.map(x => [x.id, x]))

describe('isFocusFor / focusTasks', () => {
  it('belongs to whoever chose it — or anyone, when nobody is recorded', () => {
    const t = task('a', { focusOn: TODAY })
    expect(isFocusFor(t, TODAY, 'me')).toBe(true)
    expect(isFocusFor(t, TODAY, null)).toBe(true)
    expect(isFocusFor({ ...t, focusBy: 'me' }, TODAY, 'me')).toBe(true)
    expect(isFocusFor({ ...t, focusBy: 'peer' }, TODAY, 'me')).toBe(false)
    // local mode has no one to tell apart
    expect(isFocusFor({ ...t, focusBy: 'peer' }, TODAY, null)).toBe(true)
    expect(isFocusFor(t, TOMORROW, 'me')).toBe(false)
    expect(isFocusFor(task('b'), TODAY, 'me')).toBe(false)
  })

  it('lists open focus first, then done — never wishlist, tombstones or a peer’s', () => {
    const tasks = [
      task('done', { focusOn: TODAY, status: 'done', completedAt: at(14, 6) }),
      task('open1', { focusOn: TODAY, focusBy: 'me' }),
      task('wish', { focusOn: TODAY, status: 'wishlist' }),
      task('gone', { focusOn: TODAY, deletedAt: at(13) }),
      task('peer', { focusOn: TODAY, focusBy: 'peer' }),
      task('open2', { focusOn: TODAY }),
      task('yesterday', { focusOn: '2026-09-13' }),
    ]
    expect(focusTasks(tasks, TODAY, 'me').map(t => t.id)).toEqual(['open1', 'open2', 'done'])
  })

  it('is not copied to a repeat or a duplicate', () => {
    const t = task('r', { focusOn: TODAY, focusBy: 'me', recurrence: { freq: 'daily' }, status: 'done', completedAt: at(14, 8) })
    expect(nextOccurrence(t, () => 'x')).not.toHaveProperty('focusOn')
    expect(nextOccurrence(t, () => 'x')).not.toHaveProperty('focusBy')
    expect(duplicateTask(t)).not.toHaveProperty('focusOn')
  })
})

describe('focusCandidates', () => {
  it('orders carried over, due today, the week’s 3, then six of Next up — each task once', () => {
    const review: Review = {
      kind: 'review',
      id: 'r1',
      period: 'week',
      key: shiftRange(weekRange(now), -1).key,
      top: ['Finish taxes', 'Call the bank'],
      topDone: [false, true],
      createdAt: STAMP,
      updatedAt: STAMP,
    }
    const tasks: FocusTask[] = [
      task('carried', { focusOn: '2026-09-13', focusBy: 'me' }),
      task('carried-peer', { focusOn: '2026-09-13', focusBy: 'peer' }),
      task('carried-old', { focusOn: '2026-09-01', focusBy: 'me' }),
      task('carried-done', { focusOn: '2026-09-13', status: 'done', completedAt: at(13, 18) }),
      task('due-3pm', { dueAt: at(14, 15) }),
      task('due-untimed', { dueAt: at(14) }),
      task('moved', { dueAt: at(10, 9) }),
      task('taxes', { title: 'Finish taxes' }),
      task('bank', { title: 'Call the bank' }),
      ...Array.from({ length: 8 }, (_, i) => task(`backlog-${i}`)),
    ]
    const c = focusCandidates({ tasks, projects: [], reviews: [review], today: TODAY, now, myId: 'me', movedToday: new Set(['moved']) })
    expect(c.slice(0, 5).map(x => [x.group, x.task.id, x.reason])).toEqual([
      ['carried', 'carried', 'from yesterday'],
      ['dueToday', 'moved', 'moved to today'],
      ['dueToday', 'due-untimed', 'due today'],
      ['dueToday', 'due-3pm', 'due 3pm'],
      ['weekTop', 'taxes', "this week's 3"],
    ])
    expect(c.slice(5).every(x => x.group === 'nextUp')).toBe(true)
    expect(c.slice(5)).toHaveLength(6)
    expect(new Set(c.map(x => x.task.id)).size).toBe(c.length)
    // a line of the week's 3 already ticked is not offered as one
    expect(c.find(x => x.task.id === 'bank')?.group).not.toBe('weekTop')
    expect(c.some(x => x.task.id === 'carried-done')).toBe(false)
  })
})

describe('freeSlots', () => {
  const ev = (id: string, start: string, end: string, over: Partial<CalendarEvent> = {}): CalendarEvent => ({ id, sourceId: 's', title: id, start, end, allDay: false, ...over })
  const show = (slots: { start: Date; end: Date }[]) => slots.map(s => `${hm(s.start)}-${hm(s.end)}`)

  it('keeps ten minutes either side of an event and starts each slot on :00 or :30', () => {
    expect(show(freeSlots([ev('meeting', at(14, 10), at(14, 11))], TODAY, now))).toEqual(['08:00-09:50', '11:30-21:30'])
  })

  it('takes a work day’s hours whole, with no buffer', () => {
    expect(show(freeSlots([ev('work', at(14, 9), at(14, 17, 30), { work: 'home' })], TODAY, now))).toEqual(['08:00-09:00', '17:30-21:30'])
  })

  it('ignores all-day events and other days', () => {
    const allDay = ev('holiday', '2026-09-14', '2026-09-15', { allDay: true })
    expect(show(freeSlots([allDay, ev('tomorrow', at(15, 10), at(15, 11))], TODAY, now))).toEqual(['08:00-21:30'])
  })

  it('merges overlapping events', () => {
    expect(show(freeSlots([ev('a', at(14, 10), at(14, 12)), ev('b', at(14, 11), at(14, 13))], TODAY, now))).toEqual(['08:00-09:50', '13:30-21:30'])
  })

  it('starts from now, rounded up, and honours its options', () => {
    expect(show(freeSlots([], TODAY, new Date(2026, 8, 14, 13, 7)))).toEqual(['13:30-21:30'])
    expect(show(freeSlots([ev('m', at(14, 10), at(14, 11))], TODAY, now, { from: '09:00', to: '12:00', bufferMin: 0 }))).toEqual(['09:00-10:00', '11:00-12:00'])
    expect(freeSlots([], TODAY, new Date(2026, 8, 14, 22, 0))).toEqual([])
    // a gap too short to use — or gone once its start is rounded to the half hour — is not offered
    expect(freeSlots([ev('a', at(14, 8, 10), at(14, 9, 5)), ev('b', at(14, 9, 25), at(14, 21, 30))], TODAY, now, { bufferMin: 0 })).toEqual([])
  })
})

describe('allocateBlocks', () => {
  it('fills the first slot with room, in the order picked; no block for 0 minutes or no room', () => {
    const slots = freeSlots([{ id: 'm', sourceId: 's', title: 'm', start: at(14, 10), end: at(14, 11), allDay: false }], TODAY, now)
    const blocks = allocateBlocks(slots, [
      { taskId: 'a', minutes: 60 },
      { taskId: 'b', minutes: 90 },
      { taskId: 'c', minutes: 0 },
      { taskId: 'd', minutes: 30 },
      { taskId: 'e', minutes: 900 },
    ])
    expect(blocks.map(b => [b.taskId, hm(new Date(b.start)), hm(new Date(b.end))])).toEqual([
      ['a', '08:00', '09:00'],
      ['b', '11:30', '13:00'],
      ['d', '09:00', '09:30'],
    ])
  })
})

describe('todayDueAt', () => {
  it('keeps a time still ahead today, and otherwise means today with no time', () => {
    expect(todayDueAt(task('a', { dueAt: at(10, 15) }), now)).toBe(at(14, 15))
    expect(todayDueAt(task('b', { dueAt: at(10, 6) }), now)).toBe(at(14))
    expect(todayDueAt(task('c', { dueAt: at(10) }), now)).toBe(at(14))
    expect(todayDueAt(task('d'), now)).toBe(at(14))
  })

  it('reschedules with the planner’s rule: the same time, or 09:00 with no date', () => {
    expect(rescheduledDueAt(task('a', { dueAt: at(10, 15, 30) }), TOMORROW)).toBe(at(15, 15, 30))
    expect(rescheduledDueAt(task('b', { dueAt: at(10) }), TOMORROW)).toBe(at(15))
    expect(rescheduledDueAt(task('c'), TOMORROW)).toBe(at(15, 9))
  })
})

describe('planDayWrites', () => {
  const tasks: FocusTask[] = [
    task('o1', { dueAt: at(10, 15) }),
    task('o2', { dueAt: at(11) }),
    task('o3', { dueAt: at(12, 8, 30), status: 'blocked' }),
    task('o4', { dueAt: at(9) }),
    task('o5', { dueAt: at(8) }),
    task('f1', { focusOn: TODAY, focusBy: 'me' }),
    task('f2', { focusOn: TODAY, focusBy: 'peer' }),
    task('f3', { focusOn: TODAY, focusBy: 'me', status: 'done', completedAt: at(14, 6) }),
    task('p1', { title: 'Sort the garage' }),
    task('p2', { focusOn: TODAY, focusBy: 'me' }),
  ]
  let n = 0
  const plan = planDayWrites(
    tasks,
    {
      moves: [
        { id: 'o1', to: 'today' },
        { id: 'o2', to: 'tomorrow' },
        { id: 'o3', to: 'nextweek' },
        { id: 'o4', to: 'wishlist' },
        { id: 'o5', to: 'done' },
      ],
      focusIds: ['p1', 'o4', 'p2', 'missing', 'new1', 'o1'],
      blocks: [
        { taskId: 'p1', title: '', start: at(14, 9), end: at(14, 10) },
        { taskId: 'missing', title: 'x', start: at(14, 11), end: at(14, 12) },
        { taskId: 'p2', title: 'Deep work', start: at(14, 12), end: at(14, 11) },
      ],
      newTasks: [{ id: 'new1', title: '  Call the plumber ' }],
    },
    { today: TODAY, myId: 'me', now, newId: () => `ev-${++n}` },
  )
  const up = byId(plan.upserts)

  it('moves dates by the reschedule rule, and leaves Wishlist and Done to setStatus', () => {
    expect(up.get('o1')?.dueAt).toBe(at(14, 15))
    expect(up.get('o2')?.dueAt).toBe(at(15))
    expect(up.get('o3')).toMatchObject({ dueAt: at(21, 8, 30), status: 'blocked' })
    expect(plan.statuses).toEqual([
      { id: 'o4', status: 'wishlist' },
      { id: 'o5', status: 'done' },
    ])
    expect(up.has('o4') || up.has('o5')).toBe(false)
  })

  it('focuses at most three picks, skipping ones that moved off the list or do not exist', () => {
    expect(MAX_FOCUS).toBe(3)
    expect(up.get('p1')).toMatchObject({ focusOn: TODAY, focusBy: 'me' })
    // already in today's focus: nothing to write
    expect(up.has('p2')).toBe(false)
    expect(up.get('new1')).toMatchObject({ title: 'Call the plumber', status: 'todo', dueAt: at(14), focusOn: TODAY, focusBy: 'me' })
    // the fourth valid pick is past the cap
    expect(up.get('o1')?.focusOn).toBeUndefined()
    expect(plan.createdIds).toEqual(['new1'])
  })

  it('takes focus off a deselected pick of yours, but not a done one or a peer’s', () => {
    expect(up.get('f1')).toMatchObject({ focusOn: undefined, focusBy: undefined })
    expect(up.has('f2')).toBe(false)
    expect(up.has('f3')).toBe(false)
    expect(new Set(plan.upserts.map(t => t.id))).toEqual(new Set(['new1', 'o1', 'o2', 'o3', 'p1', 'f1']))
  })

  it('turns each valid block into an event carrying its task', () => {
    expect(plan.events).toEqual([
      { kind: 'event', id: 'ev-1', title: 'Sort the garage', start: at(14, 9), end: at(14, 10), allDay: false, taskId: 'p1', createdAt: now.toISOString(), updatedAt: now.toISOString() },
    ])
  })

  it('keeps every touched task as it was, and Undo wins against the plan’s own write', () => {
    const snaps = byId(plan.snapshots)
    expect([...snaps.keys()].sort()).toEqual(['f1', 'o1', 'o2', 'o3', 'o4', 'o5', 'p1'])
    expect(snaps.get('o1')?.dueAt).toBe(at(10, 15))
    expect((snaps.get('p1') as FocusTask).focusOn).toBeUndefined()
    expect((snaps.get('f1') as FocusTask).focusOn).toBe(TODAY)
    for (const t of plan.upserts) if (t.id !== 'new1') expect(t.updatedAt > STAMP).toBe(true)
    const restored = byId(restoreSnapshots(plan.snapshots, plan.upserts))
    expect(restored.get('o1')?.dueAt).toBe(at(10, 15))
    expect(restored.get('o1')!.updatedAt > up.get('o1')!.updatedAt).toBe(true)
    expect((restored.get('f1') as FocusTask).focusOn).toBe(TODAY)
  })

  it('never changes the tasks it was given', () => {
    expect(tasks.find(t => t.id === 'o1')?.dueAt).toBe(at(10, 15))
    expect(tasks.find(t => t.id === 'f1')?.focusOn).toBe(TODAY)
  })

  it('caps picks at three however many are sent', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map(id => task(id))
    const res = planDayWrites(five, { moves: [], focusIds: ['a', 'b', 'c', 'd', 'e'], blocks: [] }, { today: TODAY, myId: null, now, newId: () => 'x' })
    expect(res.upserts.filter(t => t.focusOn === TODAY).map(t => t.id)).toEqual(['a', 'b', 'c'])
    // local mode: no one to record
    expect(res.upserts.every(t => t.focusBy === undefined)).toBe(true)
  })
})

describe('leftovers', () => {
  it('lists your unfinished focus first, then everything open due today or overdue', () => {
    const tasks = [
      task('due-today', { dueAt: at(14, 18) }),
      task('focus-open', { focusOn: TODAY, focusBy: 'me' }),
      task('focus-done', { focusOn: TODAY, status: 'done', completedAt: at(14, 6) }),
      task('focus-peer', { focusOn: TODAY, focusBy: 'peer' }),
      task('overdue', { dueAt: at(12) }),
      task('tomorrow', { dueAt: at(15) }),
      task('wish', { status: 'wishlist', dueAt: at(14) }),
    ]
    expect(leftovers(tasks, TODAY, 'me').map(t => t.id)).toEqual(['focus-open', 'overdue', 'due-today'])
  })
})

describe('shutdownWrites', () => {
  const evening = new Date(2026, 8, 14, 21, 0)
  const tasks = [
    task('l1', { focusOn: TODAY, focusBy: 'me', dueAt: at(14, 16) }),
    task('l2', { dueAt: at(12) }),
    task('l3', { dueAt: at(14) }),
    task('t4', { focusOn: TOMORROW, focusBy: 'me' }),
    task('x5'),
    task('x6'),
    task('x7'),
  ]
  const res = shutdownWrites(
    tasks,
    {
      moves: [
        { id: 'l1', to: 'tomorrow' },
        { id: 'l2', to: 'nextweek' },
        { id: 'l3', to: 'done' },
      ],
      tomorrowFocusIds: ['l1', 'x5', 'x6', 'x7'],
    },
    { today: TODAY, tomorrow: TOMORROW, myId: 'me', now: evening },
  )
  const up = byId(res.upserts)

  it('moves the leftovers and sets tomorrow’s focus, three at most', () => {
    expect(up.get('l1')).toMatchObject({ dueAt: at(15, 16), focusOn: TOMORROW, focusBy: 'me' })
    expect(up.get('l2')?.dueAt).toBe(at(21))
    expect(res.statuses).toEqual([{ id: 'l3', status: 'done' }])
    expect(up.get('x5')?.focusOn).toBe(TOMORROW)
    expect(up.get('x6')?.focusOn).toBe(TOMORROW)
    expect(up.has('x7')).toBe(false)
  })

  it('replaces whatever was picked for tomorrow before', () => {
    expect(up.get('t4')?.focusOn).toBeUndefined()
    expect([...byId(res.snapshots).keys()].sort()).toEqual(['l1', 'l2', 'l3', 't4', 'x5', 'x6'])
  })
})
