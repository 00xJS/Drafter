import { afterAll, describe, expect, it } from 'vitest'
import { buildDigest } from '../../shared/digest.mjs'
import { dueSections } from '../components/Today'
import type { Task } from '../types'

// Today's Overdue and Today sections and the morning digest's "n overdue" and
// "n due today" lines are one rule, shared/today.mjs bucketByDue: Today reads
// it on the device's calendar, the digest in the zone the account saved. In
// the same zone they must put every task in the same place. That includes a
// task due at 23:30, which west of Greenwich is already tomorrow in UTC, and
// one at 00:30 tomorrow, which east of it is still today in UTC.

const zone = process.env.TZ
afterAll(() => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})

const STAMP = '2026-09-01T00:00:00.000Z'

function task(id: string, over: Partial<Task> = {}): Task {
  return { kind: 'task', id, title: id, description: '', status: 'todo', priority: 'normal', tags: [], createdAt: STAMP, updatedAt: STAMP, ...over }
}

/** The fixture, built in whatever zone the process is in when it is called. Now is Sunday 13 September, local noon. */
function fixture(): Task[] {
  const at = (d: number, h = 0, m = 0) => new Date(2026, 8, d, h, m).toISOString()
  return [
    task('yesterday-2330', { dueAt: at(12, 23, 30) }),
    task('blocked-last-week', { status: 'blocked', dueAt: at(6, 9) }),
    task('today-untimed', { dueAt: at(13) }),
    task('this-morning', { dueAt: at(13, 8) }),
    task('tonight-2330', { status: 'doing', dueAt: at(13, 23, 30) }),
    task('tomorrow-0030', { dueAt: at(14, 0, 30) }),
    task('friday', { dueAt: at(18) }),
    task('in-seven-days', { dueAt: at(20) }),
    task('in-eight-days', { dueAt: at(21) }),
    task('done-yesterday', { status: 'done', dueAt: at(12, 9), completedAt: at(12, 10) }),
    task('wishlist-yesterday', { status: 'wishlist', dueAt: at(12) }),
    task('deleted-yesterday', { dueAt: at(12), deletedAt: at(12, 12) }),
    task('undated'),
  ]
}

const ids = (list: { id: string }[]) => list.map(t => t.id)
const sorted = (list: { id: string }[]) => ids(list).sort()

/** Minutes behind UTC at noon on 13 September, to prove the zone took. */
const OFFSETS: Record<string, number> = { 'America/Los_Angeles': 420, 'Europe/London': -60, UTC: 0, 'Asia/Tokyo': -540 }

describe.each(Object.keys(OFFSETS))('Today and the morning digest, in %s', tz => {
  it('put the same tasks in Overdue and in Due today, and Today keeps its own cuts of them', () => {
    process.env.TZ = tz
    const now = new Date(2026, 8, 13, 12)
    expect(now.getTimezoneOffset()).toBe(OFFSETS[tz])

    const tasks = fixture()
    const s = dueSections(tasks, now)
    const digest = buildDigest(tasks, tz, now)

    expect(sorted(s.overdue)).toEqual(sorted(digest.overdue))
    expect(sorted(s.today)).toEqual(sorted(digest.dueToday))

    // soonest first, as Today lists them
    expect(ids(s.overdue)).toEqual(['blocked-last-week', 'yesterday-2330'])
    expect(ids(s.today)).toEqual(['today-untimed', 'this-morning', 'tonight-2330'])
    // "already past": a time that has gone by; an untimed task is due all day
    expect(ids(s.late)).toEqual(['this-morning'])
    // "This week": the next seven days of what bucketByDue calls due soon
    expect(ids(s.week)).toEqual(['tomorrow-0030', 'friday', 'in-seven-days'])
    // finished, wished-for, deleted and undated tasks are in none of them
    expect(ids(s.open)).not.toContain('wishlist-yesterday')
    expect(ids(s.open)).not.toContain('deleted-yesterday')
    expect(ids(s.open)).not.toContain('done-yesterday')
  })
})
