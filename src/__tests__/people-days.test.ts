import { describe, expect, it } from 'vitest'
import { makeClock } from '../../shared/clock.mjs'
import { visitDays as sharedVisitDays } from '../../shared/people.mjs'
import { personStats, seenLabel, visitDays, visitSummary, yearReport } from '../people'
import { buildReview, weekRange } from '../review'
import { CalendarEntry, Person, Task } from '../types'

// "How often" on People is days seen: several events with someone on one day
// are one day. An event is still what visitsFor lists — a completed task they
// are attached to — and these pin where the two counts part.

const now = new Date(2026, 8, 12, 12, 0) // Saturday 12 September 2026, local noon
const local = (m: number, d: number, h = 12, min = 0) => new Date(2026, m - 1, d, h, min).toISOString()
const STAMP = '2026-01-01T00:00:00.000Z'

const person = (id: string, name = id): Person => ({ kind: 'person', id, name, color: '#f97316', group: 'family', createdAt: STAMP, updatedAt: STAMP })
let seq = 0
const event = (at: string, peopleIds: string[] = ['mum']): Task => ({
  kind: 'task',
  id: `e${++seq}`,
  title: `Event ${seq}`,
  description: '',
  status: 'done',
  priority: 'normal',
  tags: ['visit'],
  peopleIds,
  completedAt: at,
  createdAt: STAMP,
  updatedAt: STAMP,
})

describe('visitDays', () => {
  const london = makeClock('Europe/London').dayKeyOf

  it('makes three events on one day one day, keeping the visits\' order', () => {
    const visits = [{ at: '2026-09-05T18:00:00.000Z' }, { at: '2026-09-05T13:00:00.000Z' }, { at: '2026-09-05T09:00:00.000Z' }, { at: '2026-09-01T09:00:00.000Z' }]
    expect(sharedVisitDays(visits, london)).toEqual(['2026-09-05', '2026-09-01'])
  })

  it('puts events either side of local midnight on two days, in the zone it is given', () => {
    // 23:50 and 00:10 in London (summer time) are both on the 5th in UTC
    const late = [{ at: '2026-09-05T23:10:00.000Z' }, { at: '2026-09-05T22:50:00.000Z' }]
    expect(sharedVisitDays(late, london)).toEqual(['2026-09-06', '2026-09-05'])
    expect(sharedVisitDays(late, makeClock('UTC').dayKeyOf)).toEqual(['2026-09-05'])
  })

  it('skips an instant that is not a date', () => {
    expect(sharedVisitDays([{ at: 'not a date' }, { at: '2026-09-05T12:00:00.000Z' }], london)).toEqual(['2026-09-05'])
  })

  it('reads the viewer\'s own calendar in the app', () => {
    expect(visitDays([{ at: local(9, 5, 23, 50) }, { at: local(9, 6, 0, 10) }])).toEqual(['2026-09-05', '2026-09-06'])
  })

  it('labels days, and the events only when they differ', () => {
    expect(seenLabel(2, 3)).toBe('2 days · 3 events')
    expect(seenLabel(1, 1)).toBe('1 day')
  })
})

describe('personStats counts days seen', () => {
  it('counts three events on one day as one day and three events', () => {
    const s = personStats(person('mum'), [event(local(9, 5, 10)), event(local(9, 5, 14)), event(local(9, 5, 19))], now)
    expect(s).toMatchObject({ days30: 1, count30: 3, days90: 1, count90: 3, daysAll: 1, eventsAll: 3 })
    expect(s.weekly.reduce((a, b) => a + b, 0)).toBe(1)
    expect(s.avgGapDays).toBeUndefined()
  })

  it('counts events either side of local midnight as two days', () => {
    const s = personStats(person('mum'), [event(local(9, 5, 23, 50)), event(local(9, 6, 0, 10))], now)
    expect(s).toMatchObject({ days30: 2, count30: 2, daysAll: 2, eventsAll: 2 })
    expect(s.avgGapDays).toBe(1)
  })

  it('measures the average gap between days seen, so a same-day repeat is not a 0-day gap', () => {
    const tasks = [event(local(9, 1, 9)), event(local(9, 1, 13)), event(local(9, 1, 18)), event(local(9, 11, 12))]
    const s = personStats(person('mum'), tasks, now)
    expect(s.avgGapDays).toBe(10)
    expect(s.count30).toBe(4)
    // places keep averaging outings: the same four instants are three gaps there
    expect(visitSummary(s.visits, now).avgGapDays).toBeCloseTo((Date.parse(local(9, 11, 12)) - Date.parse(local(9, 1, 9))) / 3 / 86_400_000)
  })

  it('draws the 12-week bars as days seen per week, up to 7, the last week ending today', () => {
    const tasks = Array.from({ length: 7 }, (_, i) => [event(local(9, 12 - i, 9)), event(local(9, 12 - i, 11))]).flat()
    const s = personStats(person('mum'), tasks, now)
    expect(s.weekly).toHaveLength(12)
    expect(s.weekly[11]).toBe(7)
    expect(s.weekly.slice(0, 11).every(n => n === 0)).toBe(true)
    expect(s).toMatchObject({ days30: 7, count30: 14 })
  })
})

describe('yearReport counts days per month', () => {
  const tasks = [
    // three on one March day, then one more
    event(local(3, 3, 10)),
    event(local(3, 3, 13)),
    event(local(3, 3, 19)),
    event(local(3, 20)),
    // two on one July day
    event(local(7, 4, 12)),
    event(local(7, 4, 18)),
    // Dad: seven events, all on one August day
    ...Array.from({ length: 7 }, (_, i) => event(local(8, 22, 9 + i), ['dad'])),
  ]
  const [first, second] = yearReport([person('dad'), person('mum')], tasks, 2026, now)

  it('fills the months with days and carries the year\'s events beside them', () => {
    expect(first.person.id).toBe('mum')
    expect(first.months[2]).toBe(2)
    expect(first.months[6]).toBe(1)
    expect(first).toMatchObject({ total: 3, events: 6 })
    expect(second).toMatchObject({ total: 1, events: 7 })
  })

  it('sorts by days, so one busy day does not outrank three', () => {
    expect([first.person.id, second.person.id]).toEqual(['mum', 'dad'])
  })

  it('reads the trend in days: two events on one July day are not "more lately" than one in March', () => {
    // by events the last 90 days (2) beat the 90 before (1); by days they are level
    expect(first.trend).toBe(0)
    expect(second.trend).toBe(1)
  })
})

describe('buildReview counts days seen per person', () => {
  it('gives each person their days and events, and the week one count of each', () => {
    const tasks = [
      // three on Saturday, Dad at one of them
      event(local(9, 12, 9)),
      event(local(9, 12, 10), ['mum', 'dad']),
      event(local(9, 12, 11)),
      // one on Tuesday
      event(local(9, 8, 18)),
    ]
    const data = buildReview(weekRange(now), tasks, [], [person('mum', 'Mum'), person('dad', 'Dad')], now)
    expect(data.people.map(p => [p.person.name, p.days, p.visits.length])).toEqual([
      ['Mum', 2, 4],
      ['Dad', 1, 1],
    ])
    expect(data.seen).toEqual({ days: 2, events: 4 })
  })

  it('counts an event of your own that has happened, one day with a task on the same day', () => {
    const own = (id: string, start: string): CalendarEntry => ({ kind: 'event', id, title: id, start, end: start, allDay: false, peopleIds: ['mum'], createdAt: STAMP, updatedAt: STAMP })
    const tasks = [event(local(9, 11, 10))]
    // Friday evening's dinner has happened; Sunday's has not
    const entries = [own('dinner', local(9, 11, 19)), own('sunday', local(9, 13, 13))]
    const data = buildReview(weekRange(now), tasks, [], [person('mum', 'Mum')], now, [], entries)
    expect(data.people.map(p => [p.person.name, p.days, p.visits.length])).toEqual([['Mum', 1, 2]])
    expect(data.seen).toEqual({ days: 1, events: 2 })
  })
})
