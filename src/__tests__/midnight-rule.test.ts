import { afterAll, describe, expect, it } from 'vitest'
import { buildDigest } from '../../shared/digest.mts'
import { hasDueTime, isOverdue } from '../../shared/due.mts'
import { reviewLists } from '../../shared/review.mts'
import { billMonth } from '../bills'
import { dueSections } from '../components/Today'
import { dueNotices } from '../notify'
import { buildReview, weekRange } from '../review'
import { dueTone } from '../taskutils'
import type { Task } from '../types'

// The midnight rule, asked of every place that answers it. A task with a date
// and no time is stored at local midnight and is due all of that day: it is
// overdue once the day is over, never from the 00:00 it is stored at. A task
// with a time is late once the time has gone by, and overdue from the next
// day. Home's sections have always gone by that (dueTone); the weekly review,
// Bills and the browser's reminders compared the stored instant with now, so
// from 00:00 they called today's tasks overdue, or rang "due now" at midnight.
//
// Here Home, Bills, the weekly review, the browser's reminders and the morning
// digest all read the same tasks at the same instants around midnight, in the
// household's own zone, and must give the same answer. Each task is a bill, so
// Bills sees every one of them too.

const ZONE = 'America/Phoenix'
const zone = process.env.TZ
process.env.TZ = ZONE
afterAll(() => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})

const STAMP = '2026-09-01T00:00:00.000Z'
/** 22–24 September 2026 is a Tuesday to a Thursday; Phoenix keeps no daylight saving. */
const on = (d: number, h = 0, m = 0) => new Date(2026, 8, d, h, m)

const bill = (id: string, due: Date): Task => ({
  kind: 'task',
  id,
  title: id,
  description: '',
  status: 'todo',
  priority: 'normal',
  tags: [],
  dueAt: due.toISOString(),
  bill: { kind: 'bill' },
  estimateCost: 10,
  createdAt: STAMP,
  updatedAt: STAMP,
})

/** Built in Phoenix, whichever zone the process is in afterwards: the instants are absolute. */
const fixture = (): Task[] => [
  bill('tue-untimed', on(22)),
  bill('tue-2330', on(22, 23, 30)),
  bill('wed-untimed', on(23)),
  bill('wed-0830', on(23, 8, 30)),
  bill('wed-2330', on(23, 23, 30)),
  bill('thu-untimed', on(24)),
]

const ids = (list: readonly { id: string }[]) => list.map(t => t.id).sort()

/** Every place's answer at one instant, on this device's calendar. */
function answers(tasks: Task[], now: Date) {
  const home = dueSections(tasks, now)
  const review = buildReview(weekRange(now), tasks, [], [], now)
  const digest = buildDigest(tasks, ZONE, now)
  return {
    home: { overdue: ids(home.overdue), today: ids(home.today), late: ids(home.late) },
    billsOverdue: ids(billMonth(tasks, now, now).overdue),
    reviewOverdue: ids(review.overdueNow),
    reviewSlipped: ids(review.slipped),
    digest: { overdue: ids(digest.overdue), today: ids(digest.dueToday) },
    tonedOverdue: ids(tasks.filter(t => dueTone(t, now) === 'overdue')),
    ringing: dueNotices(tasks, now.getTime()).map(n => n.title),
  }
}

// what each instant should read: overdue, Home's Today, its "already past", and what a browser rings
const EXPECTED: [string, () => Date, { overdue: string[]; today: string[]; late: string[]; ringing: string[] }][] = [
  [
    'the evening before, 23:59',
    () => on(22, 23, 59),
    { overdue: [], today: ['tue-2330', 'tue-untimed'], late: ['tue-2330'], ringing: ['tue-untimed is due today', 'tue-2330 is due now'] },
  ],
  [
    'midnight',
    () => on(23, 0, 0),
    { overdue: ['tue-2330', 'tue-untimed'], today: ['wed-0830', 'wed-2330', 'wed-untimed'], late: [], ringing: ['tue-2330 is due now'] },
  ],
  [
    'a minute past midnight',
    () => on(23, 0, 1),
    { overdue: ['tue-2330', 'tue-untimed'], today: ['wed-0830', 'wed-2330', 'wed-untimed'], late: [], ringing: ['tue-2330 is due now'] },
  ],
  [
    'nine in the morning',
    () => on(23, 9, 0),
    {
      overdue: ['tue-2330', 'tue-untimed'],
      today: ['wed-0830', 'wed-2330', 'wed-untimed'],
      late: ['wed-0830'],
      ringing: ['tue-2330 is due now', 'wed-untimed is due today', 'wed-0830 is due now'],
    },
  ],
  [
    'the day’s last minute',
    () => on(23, 23, 59),
    {
      overdue: ['tue-2330', 'tue-untimed'],
      today: ['wed-0830', 'wed-2330', 'wed-untimed'],
      late: ['wed-0830', 'wed-2330'],
      ringing: ['wed-untimed is due today', 'wed-0830 is due now', 'wed-2330 is due now'],
    },
  ],
  [
    'a minute past the next midnight',
    () => on(24, 0, 1),
    { overdue: ['tue-2330', 'tue-untimed', 'wed-0830', 'wed-2330', 'wed-untimed'], today: ['thu-untimed'], late: [], ringing: ['wed-0830 is due now', 'wed-2330 is due now'] },
  ],
]

describe('the midnight rule, in Phoenix', () => {
  it.each(EXPECTED)('at %s, Home, Bills, the review, the digest and the reminders agree', (_, when, want) => {
    const tasks = fixture()
    const now = when()
    const a = answers(tasks, now)

    // one overdue list, wherever it is read
    expect(a.home.overdue).toEqual(want.overdue)
    expect(a.billsOverdue).toEqual(want.overdue)
    expect(a.reviewOverdue).toEqual(want.overdue)
    expect(a.digest.overdue).toEqual(want.overdue)
    expect(a.tonedOverdue).toEqual(want.overdue)
    expect(ids(tasks.filter(t => isOverdue(t.dueAt, now, ZONE)))).toEqual(want.overdue)
    // every task is due inside the review's week, so what slipped is what is overdue
    expect(a.reviewSlipped).toEqual(want.overdue)

    // Home's Today is the digest's "due today", and none of it is overdue anywhere
    expect(a.home.today).toEqual(want.today)
    expect(a.digest.today).toEqual(want.today)
    expect(a.home.late).toEqual(want.late)
    for (const id of a.home.today) expect(want.overdue).not.toContain(id)

    // a browser rings a day with no time at 9am on it, never at midnight, and
    // not once the day is over; a time, as it comes, for a day after
    expect(a.ringing).toEqual(want.ringing)
  })

  it('Push all to Monday, on the review, moves Home’s Overdue and nothing due today', () => {
    // at 00:01 the bulk buttons act on overdueNow: yesterday's two, none of today's three
    const review = buildReview(weekRange(on(23, 0, 1)), fixture(), [], [], on(23, 0, 1))
    expect(ids(review.overdueNow)).toEqual(['tue-2330', 'tue-untimed'])
  })

  it('Bills keeps a bill due today among what is still to pay this month, not what is overdue', () => {
    const month = billMonth(fixture(), on(23, 0, 1), on(23, 0, 1))
    expect(ids(month.upcoming)).toEqual(['thu-untimed', 'wed-0830', 'wed-2330', 'wed-untimed'])
    expect(month.stillToPay).toBe(60)
  })
})

describe('the same rule on the server, which runs in UTC', () => {
  it('reads each task in the account’s zone, and answers as the phone in Phoenix does', () => {
    const tasks = fixture()
    const instants = EXPECTED.map(([, when]) => when())
    // the phone's answers, on its own calendar
    const phone = instants.map(now => ({ overdue: ids(tasks.filter(t => isOverdue(t.dueAt, now))), timed: ids(tasks.filter(t => hasDueTime(t.dueAt))) }))
    const weeks = instants.map(now => weekRange(now))
    const drafts = instants.map((now, i) => ids(reviewLists(tasks, weeks[i], now).slipped))
    expect(phone[1].timed).toEqual(['tue-2330', 'wed-0830', 'wed-2330'])

    process.env.TZ = 'UTC'
    try {
      // 00:00 in Phoenix is 07:00 in UTC: read without the zone, a day with no time has one
      expect(new Date(tasks[2].dueAt!).getHours()).toBe(7)
      instants.forEach((now, i) => {
        expect(ids(tasks.filter(t => isOverdue(t.dueAt, now, ZONE))), EXPECTED[i][0]).toEqual(phone[i].overdue)
        expect(ids(tasks.filter(t => hasDueTime(t.dueAt, ZONE)))).toEqual(phone[i].timed)
        // Sunday's draft reads what slipped through the account's zone too
        expect(ids(reviewLists(tasks, weeks[i], now, ZONE).slipped), EXPECTED[i][0]).toEqual(drafts[i])
        expect(ids(buildDigest(tasks, ZONE, now).overdue)).toEqual(phone[i].overdue)
      })
    } finally {
      process.env.TZ = ZONE
    }
  })

  it('reads the device’s own zone when it is given none, and when the zone is not one', () => {
    const due = on(23).toISOString()
    expect(hasDueTime(due)).toBe(false)
    expect(hasDueTime(due, 'Not/AZone')).toBe(false)
    expect(isOverdue(due, on(24, 0, 1), 'Not/AZone')).toBe(true)
    expect(isOverdue('not a date', on(24))).toBe(false)
    expect(isOverdue(undefined, on(24))).toBe(false)
    expect(hasDueTime(undefined)).toBe(false)
  })
})
