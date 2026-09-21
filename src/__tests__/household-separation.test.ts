import { describe, expect, it } from 'vitest'
import { ownVisit, seenTasks } from '../../shared/people.mjs'
import { outingsAt, placeCadenceStatus } from '../../shared/places.mjs'
import { workDaysOf } from '../calgrid'
import { briefingFacts } from '../components/BriefingCard'
import { entryToEvent } from '../calendars'
import { sanitizeSnooze } from '../schema'
import { makeSnooze, snoozeBackLabel, snoozeId, snoozeUntil, snoozedIds, snoozedUntil } from '../snooze'
import type { CalendarEntry, Meal, Place, Task } from '../types'

// Two people share this planner and are not in the same room. The address book
// is the household's — one Mum, one favourite café — but the log of who saw
// whom, went where and worked which hours is each member's own. Before v3.24
// none of it was: a fortnight in which Maria saw her mother twice read on
// Joseph's Today and in his weekly recap as though he had, and the calendar
// drew whichever work day it found first on a day as his.

const JOE = '11111111-1111-1111-1111-111111111111'
const MARIA = '22222222-2222-2222-2222-222222222222'
const NOW = new Date('2026-09-21T12:00:00.000Z')

const visit = (over: Partial<Task> & { id: string }): Task =>
  ({
    kind: 'task',
    title: 'Saw Mum',
    description: '',
    status: 'done',
    priority: 'normal',
    completedAt: '2026-09-20T18:00:00.000Z',
    createdAt: '2026-09-20T18:00:00.000Z',
    updatedAt: '2026-09-20T18:00:00.000Z',
    tags: ['visit'],
    peopleIds: ['mum'],
    ...over,
  }) as Task

describe('a visit is whoever logged it’s', () => {
  it('counts a row you wrote, a row handed to you, and a row nobody owns', () => {
    expect(ownVisit({ ownerId: JOE }, JOE)).toBe(true)
    expect(ownVisit({ ownerId: MARIA, assigneeId: JOE }, JOE)).toBe(true)
    // no owner: written on this device and not yet synced, or local mode
    expect(ownVisit({}, JOE)).toBe(true)
    expect(ownVisit({ ownerId: MARIA }, JOE)).toBe(false)
  })

  it('counts everything when there is no viewer to be wrong about', () => {
    // a local copy with no account, and every caller that had none before v3.24
    expect(ownVisit({ ownerId: MARIA }, null)).toBe(true)
    const rows = [visit({ id: 'a', ownerId: JOE }), visit({ id: 'b', ownerId: MARIA })]
    expect(seenTasks(rows, [], NOW)).toHaveLength(2)
  })

  it('leaves the other member’s visits out of yours', () => {
    const rows = [visit({ id: 'a', ownerId: JOE }), visit({ id: 'b', ownerId: MARIA })]
    expect(seenTasks(rows, [], NOW, JOE).map(t => t.id)).toEqual(['a'])
    expect(seenTasks(rows, [], NOW, MARIA).map(t => t.id)).toEqual(['b'])
  })

  it('leaves the other member’s past events out too — they are read as visits', () => {
    const entry = (id: string, ownerId: string): CalendarEntry =>
      ({
        kind: 'event',
        id,
        title: 'Lunch with Mum',
        start: '2026-09-20T12:00:00.000Z',
        end: '2026-09-20T13:00:00.000Z',
        allDay: false,
        peopleIds: ['mum'],
        ownerId,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      }) as CalendarEntry
    const entries = [entry('e1', JOE), entry('e2', MARIA)]
    expect(seenTasks([], entries, NOW, JOE).map(t => t.id)).toEqual(['e1'])
  })
})

describe('an outing is whoever went’s — except a meal you shared', () => {
  const task = (id: string, ownerId: string): Task => visit({ id, ownerId, peopleIds: undefined, placeId: 'cafe' } as Partial<Task> & { id: string })
  const meal = (id: string, ownerId: string, shared?: boolean): Meal =>
    ({ kind: 'meal', id, date: '2026-09-20', slot: 'dinner', title: 'Out', out: true, placeId: 'cafe', ownerId, shared, createdAt: '', updatedAt: '' }) as unknown as Meal

  it('counts only your own logged outings', () => {
    const tasks = [task('t1', JOE), task('t2', MARIA)]
    expect(outingsAt('cafe', tasks, [], NOW, JOE).map(o => (o.kind === 'task' ? o.task.id : o.meal.id))).toEqual(['t1'])
  })

  it('counts a meal shared with the household for both of you', () => {
    // the evening you both ate out is a household fact, not one member's log
    const shared = outingsAt('cafe', [], [meal('m1', MARIA, true)], NOW, JOE)
    expect(shared).toHaveLength(1)
    // a meal written before v3.22 carries no flag and reads as shared
    expect(outingsAt('cafe', [], [meal('m2', MARIA)], NOW, JOE)).toHaveLength(1)
    // one kept to herself is hers alone
    expect(outingsAt('cafe', [], [meal('m3', MARIA, false)], NOW, JOE)).toHaveLength(0)
  })

  it('does not let the other member’s trip reset your rhythm', () => {
    const place = { id: 'cafe', cadenceDays: 14 } as Place
    const theirs = [task('t1', MARIA)]
    expect(placeCadenceStatus(place, theirs, NOW, [], JOE).status).not.toBe('ok')
    expect(placeCadenceStatus(place, theirs, NOW, [], MARIA).status).toBe('ok')
  })
})

describe('a work day is whoever set it’s', () => {
  const workDay = (id: string, ownerId: string | undefined, work: 'home' | 'office'): CalendarEntry =>
    ({
      kind: 'event',
      id,
      title: 'Work',
      start: '2026-09-21T09:00:00.000Z',
      end: '2026-09-21T17:00:00.000Z',
      allDay: false,
      work,
      ownerId,
      createdAt: '',
      updatedAt: '',
    }) as CalendarEntry

  it('counts only yours as the days you are working', () => {
    const entries = [workDay('w1', MARIA, 'home'), workDay('w2', JOE, 'office')]
    expect(workDaysOf(entries, JOE).size).toBe(1)
    // an entry with no owner has not synced yet, so it is this device's own
    expect(workDaysOf([workDay('w3', undefined, 'home')], JOE).size).toBe(1)
  })

  it('keeps the entry’s owner when it is projected onto the calendar', () => {
    expect(entryToEvent(workDay('w1', MARIA, 'home')).ownerId).toBe(MARIA)
  })

  it('gives the briefing your hours, and names theirs beside them', () => {
    const events = [entryToEvent(workDay('w1', MARIA, 'home')), entryToEvent(workDay('w2', JOE, 'office'))]
    const nameOf = (id?: string) => (id === MARIA ? 'Maria' : id === JOE ? 'Joe' : null)
    const facts = briefingFacts(events, [], new Date('2026-09-21T10:00:00.000Z'), JOE, nameOf)
    expect(facts.work?.label).toBe('In the office')
    expect(facts.theirWork).toEqual([{ whose: 'Maria', short: 'Home', emoji: '🏠', hours: expect.any(String) }])
  })

  it('takes the first work day it finds when nobody is signed in, as it always did', () => {
    const events = [entryToEvent(workDay('w1', MARIA, 'home'))]
    expect(briefingFacts(events, [], new Date('2026-09-21T10:00:00.000Z')).work?.short).toBe('Home')
  })
})

describe('a nudge put off comes back', () => {
  it('keys one row per thing, so asking again overwrites', () => {
    expect(snoozeId('person', 'mum')).toBe('snooze~person~mum')
    expect(makeSnooze('person', 'mum', snoozeUntil(14, NOW), NOW).id).toBe('snooze~person~mum')
  })

  it('stops counting once its day has come', () => {
    const put = [makeSnooze('person', 'mum', snoozeUntil(14, NOW), NOW)]
    expect(snoozedIds(put, 'person', NOW).has('mum')).toBe(true)
    const later = new Date(NOW.getTime() + 15 * 86_400_000)
    expect(snoozedIds(put, 'person', later).has('mum')).toBe(false)
    expect(snoozedUntil(put, 'person', 'mum', later)).toBeNull()
  })

  it('never reads as forever — every row carries the day it is back', () => {
    const until = snoozeUntil(14, NOW)
    expect(snoozeBackLabel(until, NOW)).toBe('back in 14 days')
    expect(snoozeBackLabel(snoozeUntil(1, NOW), NOW)).toBe('back tomorrow')
  })

  it('does not let one target’s snooze silence another’s', () => {
    const put = [makeSnooze('place', 'cafe', snoozeUntil(30, NOW), NOW)]
    expect(snoozedIds(put, 'person', NOW).size).toBe(0)
    expect(snoozedIds(put, 'place', NOW).has('cafe')).toBe(true)
  })

  it('reads a row back off its id alone, so an older client’s write still lands', () => {
    const row = sanitizeSnooze({ id: 'snooze~place~cafe', until: '2026-10-01T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z' })
    expect(row).toMatchObject({ kind: 'snooze', target: 'place', targetId: 'cafe' })
    // no instant to come back on, and not a tombstone: nothing at all
    expect(sanitizeSnooze({ id: 'snooze~place~cafe' })).toBeNull()
    expect(sanitizeSnooze({ id: 'nonsense', until: '2026-10-01T00:00:00.000Z' })).toBeNull()
  })
})
