import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { compareStats, personMatcher, personStats, seenTasks, upcomingOccasions, visitDays, yearReport, type PersonFilter, type PersonStats } from '../people'
import {
  COMING_UP_DAYS,
  NEVER_SEEN_DAYS,
  TOGETHER_MIN_DAYS,
  comingUp,
  daysByMonth,
  daysInMonth,
  daysSeenIn,
  getTogethers,
  groupShares,
  mostSeen,
  namesOf,
  neverSeen,
  notSeenLately,
  occasionLine,
  oftenTogether,
  peopleSeen,
  peopleTiles,
  togetherCounts,
  whoByDay,
  within,
  yearWithPeople,
} from '../peoplestats'
import type { CalendarEntry, Person, Task } from '../types'

// People → Stats, counted (peoplestats.ts): every figure off what the People
// list reads, so each agrees with the row or card that shows the same thing —
// days seen, the rows' windows back from now, the list's group chips — with
// no Mine / Everyone narrowing and nothing personal. The screen that draws
// them is people-stats-view.test.tsx's.

const NOW = new Date(2026, 8, 14, 12, 0) // Monday 14 September 2026, local noon
const TODAY = '2026-09-14'
const STAMP = '2026-01-01T00:00:00.000Z'
/** An instant in local time. */
const on = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).toISOString()
const at = (m: number, d: number, h = 12, min = 0) => on(2026, m, d, h, min)

const person = (id: string, over: Partial<Person> = {}): Person => ({ kind: 'person', id, name: id.charAt(0).toUpperCase() + id.slice(1), color: '#f97316', group: 'family', createdAt: STAMP, updatedAt: STAMP, ...over })
let seq = 0
/** A done task with these people on it: a logged visit, a dinner, a task done together. */
const done = (when: string, peopleIds: string[], over: Partial<Task> = {}): Task => ({
  kind: 'task',
  id: `t${++seq}`,
  title: 'Visit',
  description: '',
  status: 'done',
  priority: 'normal',
  tags: ['visit'],
  peopleIds,
  completedAt: when,
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
})
/** An event of your own with people on it. */
const event = (id: string, start: string, peopleIds: string[]): CalendarEntry => ({ kind: 'event', id, title: 'Lunch', start, end: start, allDay: false, peopleIds, createdAt: STAMP, updatedAt: STAMP })
/** The people a group chip leaves, by the list's own rule (personMatcher), as Stats reads them. */
const inChip = (all: readonly PersonStats[], group: PersonFilter['group']) => all.filter(s => personMatcher({ group, q: '' })(s.person))
/** What the list reads, at NOW. */
const read = (people: Person[], tasks: Task[], entries?: CalendarEntry[]) => peopleSeen(people, tasks, entries, NOW)
const source = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

describe('what Stats reads is what the list reads', () => {
  it('reads each person exactly as the list does: seenTasks, then personStats', () => {
    const people = [person('mum'), person('sam', { group: 'friends' })]
    const tasks = [done(at(9, 12), ['mum', 'sam']), done(at(8, 1), ['mum'])]
    const entries = [event('lunch', at(9, 13), ['sam'])]
    const { seen, all } = read(people, tasks, entries)
    expect(seen).toEqual(seenTasks(tasks, entries, NOW))
    expect(all).toEqual(people.map(p => personStats(p, seenTasks(tasks, entries, NOW), NOW)))
  })

  it('reads nothing into nobody', () => {
    expect(read([], [])).toEqual({ seen: [], all: [] })
    const none = read([], []).all
    expect(togetherCounts(none, [])).toEqual({ days: 0, occasions: 0, personVisits: 0, attention: { overdue: 0, due: 0 } })
    expect(peopleTiles(none, [], TODAY)).toEqual({ people: 0, thisMonth: { days: 0, of: 14 }, seenLately: 0, streak: { current: 0, best: 0, today: false } })
    expect(mostSeen(none, 'all', NOW)).toEqual([])
    expect(notSeenLately(none)).toEqual([])
    expect(neverSeen(none, TODAY)).toEqual([])
    expect(whoByDay(none).size).toBe(0)
    expect(groupShares(none, [], 'all', NOW)).toEqual({ days: 0, groups: [] })
    expect(oftenTogether(none)).toEqual([])
    expect(comingUp(none, NOW)).toEqual([])
    expect(yearWithPeople(none, [], 2026, NOW)).toEqual([])
    expect(daysByMonth([], 2026, NOW)).toEqual({ months: Array.from({ length: 12 }, () => 0), total: 0, trend: 0 })
  })

  it('leaves everyone on All, one group’s people on its chip, in order, and nobody on an empty group', () => {
    const { all } = read([person('ann'), person('bob', { group: 'friends' }), person('cy')], [])
    expect(inChip(all, 'all').map(s => s.person.id)).toEqual(['ann', 'bob', 'cy'])
    expect(inChip(all, 'all')).not.toBe(all)
    expect(inChip(all, 'family').map(s => s.person.id)).toEqual(['ann', 'cy'])
    expect(inChip(all, 'other')).toEqual([])
  })
})

describe('Mine / Everyone narrows nothing here, as it narrows nothing on the list or in Today’s nudges', () => {
  it('counts a visit another member of the household logged exactly as one of yours', () => {
    const mine = done(at(9, 10), ['mum'], { ownerId: 'me' })
    const theirs = done(at(9, 12), ['mum'], { ownerId: 'partner', assigneeId: 'partner' })
    const { seen, all } = read([person('mum')], [mine, theirs])
    expect(all[0].daysAll).toBe(2)
    expect(togetherCounts(all, getTogethers(all, seen))).toMatchObject({ days: 2, occasions: 2, personVisits: 2 })
    expect(mostSeen(all, 30, NOW)[0].count).toBe(2)
    expect(peopleTiles(all, getTogethers(all, seen), TODAY).thisMonth.days).toBe(2)
  })
})

describe('the tiles the list carried, counted as it counted them', () => {
  it('counts one dinner with three as one occasion, three people seen and one day', () => {
    const { seen, all } = read(['mum', 'dad', 'gran'].map(id => person(id)), [done(at(9, 12, 19), ['mum', 'dad', 'gran'])])
    expect(togetherCounts(all, getTogethers(all, seen))).toEqual({ days: 1, occasions: 1, personVisits: 3, attention: { overdue: 0, due: 0 } })
  })

  it('counts three get-togethers on one Saturday as three occasions and one day', () => {
    const { seen, all } = read([person('mum')], [done(at(9, 12, 9), ['mum']), done(at(9, 12, 13), ['mum']), done(at(9, 12, 19), ['mum'])])
    expect(togetherCounts(all, getTogethers(all, seen))).toMatchObject({ days: 1, occasions: 3, personVisits: 3 })
  })

  it('leaves out what is not done, and whoever the chip leaves off', () => {
    const tasks = [done(at(9, 12), ['mum', 'sam']), done(at(9, 13), ['mum'], { status: 'todo' }), done(at(9, 13), ['mum'], { completedAt: undefined }), done(at(9, 13), [])]
    const { seen, all } = read([person('mum'), person('sam', { group: 'friends' })], tasks)
    const friends = inChip(all, 'friends')
    expect(getTogethers(friends, seen)).toEqual([{ id: tasks[0].id, at: tasks[0].completedAt, peopleIds: ['sam'] }])
    expect(togetherCounts(friends, getTogethers(friends, seen))).toMatchObject({ days: 1, occasions: 1, personVisits: 1 })
  })

  it('counts who is overdue and who is due a catch-up by the rows’ own status', () => {
    const people = [person('mum', { cadenceDays: 14 }), person('dad', { cadenceDays: 14 }), person('sam'), person('kit')]
    // Mum 30 days ago, past one and a half times her 14; Dad 20 days ago, past his 14; Sam 10 days ago; Kit never
    const { seen, all } = read(people, [done(at(8, 15), ['mum']), done(at(8, 25), ['dad']), done(at(9, 4), ['sam'])])
    expect(all.map(s => s.status)).toEqual(['overdue', 'due', 'ok', 'never'])
    expect(togetherCounts(all, getTogethers(all, seen)).attention).toEqual({ overdue: 1, due: 1 })
  })

  it('counts an event of your own once it has happened, and not before', () => {
    const { seen, all } = read([person('mum')], [], [event('lunch', at(9, 12, 13), ['mum']), event('later', at(9, 20, 13), ['mum'])])
    expect(togetherCounts(all, getTogethers(all, seen))).toMatchObject({ days: 1, occasions: 1, personVisits: 1 })
  })
})

describe('the tiles at the head of Stats', () => {
  const streak = (days: number[]) => {
    const { seen, all } = read([person('mum')], days.map(d => done(at(9, d), ['mum'])))
    return peopleTiles(all, getTogethers(all, seen), TODAY).streak
  }

  it('counts one person seen today, and a streak that includes today', () => {
    const { seen, all } = read([person('mum')], [done(at(9, 14, 9), ['mum'])])
    expect(peopleTiles(all, getTogethers(all, seen), TODAY)).toEqual({ people: 1, thisMonth: { days: 1, of: 14 }, seenLately: 1, streak: { current: 1, best: 1, today: true } })
  })

  it('lets today wait rather than break a run, as a habit’s does, and lets a gap end one', () => {
    expect(streak([12, 13])).toEqual({ current: 2, best: 2, today: false })
    expect(streak([9, 10, 11, 13])).toEqual({ current: 1, best: 3, today: false })
    expect(streak([10, 11])).toEqual({ current: 0, best: 2, today: false })
  })

  it('counts this month’s days up to today, whoever was there, and no day still to come', () => {
    const tasks = [done(at(8, 31), ['mum']), done(at(9, 1), ['mum']), done(at(9, 1, 18), ['sam']), done(at(9, 5), ['sam']), done(at(9, 20), ['mum'])]
    const { seen, all } = read([person('mum'), person('sam')], tasks)
    expect(peopleTiles(all, getTogethers(all, seen), TODAY).thisMonth).toEqual({ days: 2, of: 14 })
  })

  it('counts as seen lately exactly those whose row shows a 90-day figure', () => {
    const { seen, all } = read([person('mum'), person('sam'), person('kit')], [done(at(6, 1), ['mum']), done(at(9, 4), ['sam'])])
    expect(all.map(s => s.days90)).toEqual([0, 1, 0])
    expect(peopleTiles(all, getTogethers(all, seen), TODAY).seenLately).toBe(1)
  })
})

describe('the windows, counted as a row counts them: by the instant, back from now', () => {
  it('counts the last 30 days as the row’s 30-day figure does, and all time as its all time', () => {
    // noon on Monday: 29 days 18 hours back counts, though its day is 30 days back; 30 days 18 hours does not
    const tasks = [done(at(8, 15, 18), ['mum']), done(at(8, 14, 18), ['mum']), done(at(9, 1), ['mum']), done(at(9, 1, 19), ['mum'])]
    const { all } = read([person('mum')], tasks)
    expect(daysSeenIn(all[0].visits, 30, NOW)).toBe(2)
    expect(daysSeenIn(all[0].visits, 30, NOW)).toBe(all[0].days30)
    expect(daysSeenIn(all[0].visits, 'all', NOW)).toBe(3)
    expect(daysSeenIn(all[0].visits, 'all', NOW)).toBe(all[0].daysAll)
  })

  it('counts 12 months back from now', () => {
    const { all } = read([person('mum')], [done(on(2025, 9, 15, 13), ['mum']), done(on(2025, 9, 14, 11), ['mum']), done(at(9, 1), ['mum'])])
    expect(daysSeenIn(all[0].visits, 365, NOW)).toBe(2)
    expect(daysSeenIn(all[0].visits, 'all', NOW)).toBe(3)
  })

  it('hands back a copy of all of them for all time, and none that is not a date', () => {
    const items = [{ at: at(1, 1) }]
    expect(within(items, 'all', NOW)).toEqual(items)
    expect(within(items, 'all', NOW)).not.toBe(items)
    expect(within([{ at: 'not a date' }], 30, NOW)).toEqual([])
  })
})

describe('the most seen, and the podium', () => {
  it('ranks by days seen, never by events', () => {
    const tasks = [done(at(9, 12, 9), ['mum']), done(at(9, 12, 13), ['mum']), done(at(9, 12, 19), ['mum']), done(at(9, 10), ['sam']), done(at(9, 11), ['sam'])]
    const { all } = read([person('mum'), person('sam')], tasks)
    expect(mostSeen(all, 30, NOW).map(r => [r.name, r.count, r.events])).toEqual([
      ['Sam', 2, 2],
      ['Mum', 1, 3],
    ])
  })

  it('gives a tie on days to more events, then to the name', () => {
    const tasks = [done(at(9, 12, 9), ['bob']), done(at(9, 12, 13), ['bob']), done(at(9, 10), ['cy']), done(at(9, 10), ['ann'])]
    const { all } = read([person('cy'), person('bob'), person('ann')], tasks)
    expect(mostSeen(all, 'all', NOW).map(r => r.name)).toEqual(['Bob', 'Ann', 'Cy'])
  })

  it('stands two of one name in one order, by id, whichever the store holds first', () => {
    const sams = [person('sam-b', { name: 'Sam' }), person('sam-a', { name: 'Sam' })]
    const tasks = [done(at(9, 10), ['sam-b']), done(at(9, 11), ['sam-a'])]
    for (const order of [sams, [...sams].reverse()]) {
      expect(mostSeen(read(order, tasks).all, 'all', NOW).map(r => r.key)).toEqual(['sam-a', 'sam-b'])
      expect(mostSeen(read(order, tasks).all, 'all', NOW, 1).map(r => r.key)).toEqual(['sam-a'])
    }
  })

  it('ranks one person, and nobody unseen in the window', () => {
    const { all } = read([person('mum'), person('kit')], [done(at(6, 1), ['mum'])])
    expect(mostSeen(all, 30, NOW)).toEqual([])
    expect(mostSeen(all, 365, NOW).map(r => r.key)).toEqual(['mum'])
    expect(mostSeen(all, 'all', NOW)).toEqual([{ key: 'mum', name: 'Mum', count: 1, events: 1, person: all[0].person }])
  })

  it('agrees with every row: 30 days is its 30-day figure, all time its all time', () => {
    const tasks = [done(at(9, 12), ['mum', 'sam']), done(at(9, 12, 19), ['sam']), done(at(8, 15, 18), ['mum']), done(at(8, 14, 18), ['jo']), done(at(3, 3), ['mum', 'jo'])]
    const { all } = read([person('mum'), person('sam'), person('jo')], tasks)
    for (const s of all) {
      expect(mostSeen([s], 30, NOW)[0]?.count ?? 0, s.person.name).toBe(s.days30)
      expect(mostSeen([s], 'all', NOW)[0]?.count ?? 0, s.person.name).toBe(s.daysAll)
    }
  })

  it('stands the first three of all time on the podium', () => {
    const tasks = [done(at(9, 1), ['ann', 'bob', 'cy', 'dee']), done(at(9, 2), ['ann', 'bob', 'cy']), done(at(9, 3), ['ann', 'bob']), done(at(9, 4), ['ann'])]
    const { all } = read(['dee', 'cy', 'bob', 'ann'].map(id => person(id)), tasks)
    expect(mostSeen(all, 'all', NOW, 3).map(r => [r.name, r.count])).toEqual([
      ['Ann', 4],
      ['Bob', 3],
      ['Cy', 2],
    ])
  })
})

describe('not seen lately, and never seen', () => {
  it('lists who is past their rhythm, overdue first and a planned catch-up last, as Today does', () => {
    const plan: Task = { ...done(at(9, 1), ['cy']), id: 'plan', status: 'todo', completedAt: undefined, dueAt: at(9, 20) }
    const tasks = [
      done(at(8, 25), ['ann']), // 20 days, every 14: due
      done(at(8, 1), ['bob']), // 44 days, every 14: overdue
      done(at(8, 10), ['cy']), // 35 days: overdue, with a catch-up planned
      plan,
      done(at(9, 10), ['dee']), // on track
    ]
    const people = [person('ann', { cadenceDays: 14 }), person('bob', { cadenceDays: 14 }), person('cy', { cadenceDays: 14 }), person('dee'), person('kit')]
    const { all } = read(people, tasks)
    expect(notSeenLately(all).map(s => s.person.id)).toEqual(['bob', 'ann', 'cy'])
    expect(notSeenLately(all)).toEqual(all.filter(s => s.status === 'overdue' || s.status === 'due').sort(compareStats))
  })

  it('lists who was added two weeks ago or more and never seen, the longest waiting first', () => {
    const people = [
      person('ann', { createdAt: at(8, 31, 9) }), // 14 days
      person('bob', { createdAt: at(9, 1, 9) }), // 13 days: not yet
      person('cy', { createdAt: at(8, 1, 9) }),
      person('dee', { createdAt: at(8, 1, 9) }), // seen once
      person('eve', { createdAt: at(8, 1, 9) }), // added with Cy: by name
    ]
    const { all } = read(people, [done(at(9, 2), ['dee'])])
    expect(NEVER_SEEN_DAYS).toBe(14)
    expect(neverSeen(all, TODAY).map(s => s.person.id)).toEqual(['cy', 'eve', 'ann'])
    expect(neverSeen(all, TODAY).every(s => s.status === 'never')).toBe(true)
  })

  it('lists two of one name, added together, by id, whichever the store holds first', () => {
    const sams = [person('sam-b', { name: 'Sam', createdAt: at(8, 1, 9) }), person('sam-a', { name: 'Sam', createdAt: at(8, 1, 9) })]
    for (const order of [sams, [...sams].reverse()]) expect(neverSeen(read(order, []).all, TODAY).map(s => s.person.id)).toEqual(['sam-a', 'sam-b'])
  })
})

describe('the month, day by day', () => {
  it('puts each person on a day once, in the order given, on the local calendar', () => {
    const tasks = [done(at(9, 12, 9), ['sam', 'mum']), done(at(9, 12, 19), ['sam']), done(at(9, 5, 23, 50), ['mum']), done(at(9, 6, 0, 10), ['mum'])]
    const { all } = read([person('mum'), person('sam')], tasks)
    const byDay = whoByDay(all)
    expect([...byDay.keys()].sort()).toEqual(['2026-09-05', '2026-09-06', '2026-09-12'])
    expect(byDay.get('2026-09-12')!.map(p => p.id)).toEqual(['mum', 'sam'])
  })

  it('counts a month’s days with someone up to today, agreeing with the tile for this month', () => {
    const { seen, all } = read([person('mum')], [done(at(9, 1), ['mum']), done(at(9, 12), ['mum']), done(at(9, 20), ['mum']), done(at(8, 30), ['mum'])])
    const byDay = whoByDay(all)
    expect(daysInMonth(byDay, 2026, 9, TODAY)).toBe(2)
    expect(daysInMonth(byDay, 2026, 8, TODAY)).toBe(1)
    expect(daysInMonth(byDay, 2026, 10, TODAY)).toBe(0)
    expect(daysInMonth(byDay, 2026, 9, TODAY)).toBe(peopleTiles(all, getTogethers(all, seen), TODAY).thisMonth.days)
  })

  it('names a day’s people as a reader would say them', () => {
    const [mum, dad, sam] = ['mum', 'dad', 'sam'].map(id => person(id))
    expect(namesOf([])).toBe('')
    expect(namesOf([mum])).toBe('Mum')
    expect(namesOf([mum, dad])).toBe('Mum and Dad')
    expect(namesOf([mum, dad, sam])).toBe('Mum, Dad and Sam')
  })
})

describe('each group’s share of the days', () => {
  const people = [person('mum'), person('dad'), person('sam', { group: 'friends' }), person('jo', { group: 'friends' })]
  const tasks = [done(at(9, 12), ['mum', 'sam']), done(at(9, 13), ['dad']), done(at(9, 10), ['jo']), done(at(6, 1), ['sam'])]

  it('counts a day with family and friends for both, so the shares can pass 100%, and leaves out a group with nobody', () => {
    const { seen, all } = read(people, tasks)
    expect(groupShares(all, seen, 'all', NOW)).toEqual({
      days: 4,
      groups: [
        { group: 'family', people: 2, days: 2, share: 0.5 },
        { group: 'friends', people: 2, days: 3, share: 0.75 },
      ],
    })
  })

  it('counts in its window, and keeps a group with someone in it at nothing', () => {
    const { seen, all } = read([...people, person('kit', { group: 'other' })], tasks)
    const month = groupShares(all, seen, 30, NOW)
    expect(month.days).toBe(3)
    expect(month.groups.map(g => [g.group, g.days])).toEqual([
      ['family', 2],
      ['friends', 2],
      ['other', 0],
    ])
    expect(groupShares(read(people, []).all, [], 30, NOW).groups.map(g => g.share)).toEqual([0, 0])
  })
})

describe('often together', () => {
  it('pairs two seen on the same day — not only at the same get-together — from their second day, named A–Z', () => {
    const tasks = [done(at(9, 12, 9), ['sam']), done(at(9, 12, 19), ['mum']), done(at(9, 13), ['mum', 'sam']), done(at(9, 1), ['mum', 'jo'])]
    const { all } = read([person('sam'), person('mum'), person('jo')], tasks)
    expect(TOGETHER_MIN_DAYS).toBe(2)
    expect(oftenTogether(all)).toEqual([{ key: 'mum+sam', a: all[1].person, b: all[0].person, days: 2, last: '2026-09-13' }])
  })

  it('gives a tie to the latest, then to the names, and keeps to n', () => {
    // Cy and Dee, and Eve and Fay, both last on the 6th; the four of them share only that day
    const tasks = [
      done(at(9, 1), ['ann', 'bob']),
      done(at(9, 2), ['ann', 'bob']),
      done(at(9, 3), ['cy', 'dee']),
      done(at(9, 6), ['cy', 'dee']),
      done(at(9, 5), ['fay', 'eve']),
      done(at(9, 6, 19), ['fay', 'eve']),
    ]
    const { all } = read(['ann', 'bob', 'cy', 'dee', 'eve', 'fay'].map(id => person(id)), tasks)
    expect(oftenTogether(all).map(p => p.key)).toEqual(['cy+dee', 'eve+fay', 'ann+bob'])
    expect(oftenTogether(all, 1).map(p => p.key)).toEqual(['cy+dee'])
  })

  it('stands pairs named alike in one order, by id, whichever the store holds first', () => {
    const people = [person('sam-b', { name: 'Sam' }), person('ann'), person('sam-a', { name: 'Sam' })]
    const tasks = [done(at(9, 1), ['ann', 'sam-a', 'sam-b']), done(at(9, 2), ['ann', 'sam-a', 'sam-b'])]
    for (const order of [people, [...people].reverse()])
      expect(oftenTogether(read(order, tasks).all).map(p => p.key)).toEqual(['ann+sam-a', 'ann+sam-b', 'sam-a+sam-b'])
  })
})

describe('coming up', () => {
  it('lists the birthdays and anniversaries in the next 30 days, today in and the 31st out, soonest first', () => {
    const people = [
      person('mum', { birthday: '1966-09-26' }), // 12 days
      person('sam', { birthday: '0000-09-14' }), // today, and no year
      person('dad', { anniversary: '1990-10-14' }), // 30 days
      person('jo', { birthday: '1990-10-15' }), // 31 days
    ]
    const { all } = read(people, [])
    expect(COMING_UP_DAYS).toBe(30)
    const soon = comingUp(all, NOW)
    expect(soon.map(o => [o.person.id, o.kind, o.daysUntil])).toEqual([
      ['sam', 'birthday', 0],
      ['mum', 'birthday', 12],
      ['dad', 'anniversary', 30],
    ])
    expect(soon).toEqual(upcomingOccasions(people, 30, NOW))
    expect(comingUp(inChip(all, 'friends'), NOW)).toEqual([])
  })

  it('says what, and when', () => {
    const { all } = read([person('mum', { birthday: '1966-09-26', anniversary: '1990-09-15' }), person('sam', { birthday: '0000-09-14' })], [])
    expect(comingUp(all, NOW).map(o => occasionLine(o, TODAY))).toEqual(['Birthday · today', 'Anniversary · 36 years · tomorrow', 'Birthday · turns 60 · Sat 26 Sep, in 12 days'])
  })
})

describe('the year with people', () => {
  const tasks = [done(at(9, 12, 9), ['mum', 'dad']), done(at(9, 12, 19), ['mum']), done(at(3, 1), ['dad']), done(on(2025, 12, 31), ['mum'])]

  it('is the list’s own table, row for row', () => {
    const { seen, all } = read([person('mum'), person('dad')], tasks)
    const rows = yearWithPeople(all, seen, 2026, NOW)
    expect(rows).toEqual(yearReport(all.map(s => s.person), seen, 2026, NOW).map(r => ({ ...r, key: r.person.id, name: r.person.name })))
    expect(rows.map(r => [r.name, r.total, r.events])).toEqual([
      ['Dad', 2, 2],
      ['Mum', 1, 2],
    ])
  })

  it('counts the days with anyone each month, once a day, and the trend in days', () => {
    const { seen, all } = read([person('mum'), person('dad')], tasks)
    const together = getTogethers(all, seen)
    const year = daysByMonth(together, 2026, NOW)
    expect(year.months).toEqual([0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0])
    // the last 90 days hold 12 September; the 90 before them, nothing (1 March is further back)
    expect(year).toMatchObject({ total: 2, trend: 1 })
    expect(daysByMonth(together, 2025, NOW).total).toBe(1)
    // …and the year's total is its days together
    expect(year.total).toBe(visitDays(together.filter(t => new Date(t.at).getFullYear() === 2026)).length)
  })
})

describe('nothing personal reaches these figures', () => {
  it('reads no journal, habit, routine, review or wardrobe', () => {
    for (const file of ['peoplestats.ts', 'components/PeopleStats.tsx']) {
      const src = source(file)
      expect(src, file).not.toMatch(/from '\.\.?\/(journal|habits|routines|review|wardrobe|dayclose)'/)
      expect(src, file).not.toMatch(/\b(JournalEntry|Habit|Routine|Garment|Wear|Outfit|Review)\b/)
    }
  })
})
