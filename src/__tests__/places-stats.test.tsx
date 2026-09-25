import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { useState, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlacesStats } from '../components/PlacesStats'
import { CAL_MODE_KEY } from '../components/planner/routes'
import { useNavigation } from '../components/planner/useNavigation'
import { ChartCard, ListCard, MonthCalendar, Podium, RankedBars, StatTile, YearTable } from '../components/stats'
import { graphicInk, readableInk } from '../contrast'
import { NO_PLACE_FILTER, companionsAt, lapsed, placeMatcher, placeStats, placeYearReport, placesWith, type PlaceStats } from '../places'
import {
  companyOnOutings,
  dueBack,
  kindChips,
  mealsOut,
  mostVisited,
  neverBeen,
  notBeenBack,
  outingsByKind,
  outingsByMonth,
  outingsWithin,
  placesByDay,
  placesTiles,
  usualCompany,
} from '../placestats'
import type { DayWindow } from '../stats'
import { PLACE_CATEGORIES, type Meal, type Person, type Place, type Task } from '../types'
import { button, elements, press, propsOf, rendered, settled, type El } from './rendered'

// People → Places → Stats. Every figure it shows is read off the rows' own
// stats (placeStats), so each is held here to the list's own count of the
// same thing — with nothing, with one place, with ties, under each kind chip,
// and whatever tasks the list is handed (nothing narrows them) —
// and then the view is drawn on the server, empty and full. vitest runs in
// node, so a press is a call of the handler the view hands its kit; the kit's
// own drawing is stats-kit.test. Last, the ways in from the shell, and the
// Calendar mode a day opened from here must leave alone.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const html = (node: ReactNode) => renderToStaticMarkup(node as ReactElement).replace(/<!-- -->/g, '')

const STAMP = '2026-01-01T12:00:00.000Z'
/** Monday 14 September 2026, 10am local. */
const NOW = new Date(2026, 8, 14, 10, 0)
const noop = () => {}
/** An instant on the local calendar. */
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString()

const place = (id: string, name: string, over: Partial<Place> = {}): Place => ({ kind: 'place', id, name, color: '#f97316', category: 'restaurant', createdAt: STAMP, updatedAt: STAMP, ...over })
const person = (id: string, name: string, color: string): Person => ({ kind: 'person', id, name, color, group: 'friends', createdAt: STAMP, updatedAt: STAMP })
let seq = 0
/** A done task at a place: one outing, with whoever was there. */
const outing = (placeId: string, when: string, peopleIds: string[] = [], over: Partial<Task> = {}): Task => ({
  kind: 'task',
  id: `t${++seq}`,
  title: 'Out',
  description: '',
  status: 'done',
  priority: 'normal',
  tags: ['visit'],
  placeId,
  completedAt: when,
  createdAt: STAMP,
  updatedAt: STAMP,
  ...(peopleIds.length ? { peopleIds } : {}),
  ...over,
})
/** A meal marked as eaten out at a place. */
const eatOut = (placeId: string, date: string, slot: Meal['slot'] = 'dinner'): Meal => ({ kind: 'meal', id: `meal~${date}~${slot}`, date, slot, out: true, placeId, title: 'Out', createdAt: STAMP, updatedAt: STAMP })

/** Where you meant to go monthly, last there in July: overdue. */
const nopi = place('nopi', 'Nopi', { cadenceDays: 30 })
const park = place('park', 'Hyde Park', { category: 'outdoors', color: '#22c55e' })
const pret = place('pret', 'Pret', { category: 'fastfood', color: '#b91c1c' })
/** Loved through last winter, not since, and in a pale colour. */
const bella = place('bella', 'Bella Italia', { color: '#fef3c7' })
const kafka = place('kafka', 'Kafka', { category: 'cafe', createdAt: '2026-03-01T12:00:00.000Z' })
const oldVic = place('oldvic', 'Old Vic', { category: 'venue', createdAt: '2026-02-01T12:00:00.000Z' })
const PLACES = [nopi, park, pret, bella, kafka, oldVic]

const mum = person('mum', 'Mum', '#f472b6')
const sam = person('sam', 'Sam', '#60a5fa')
const jo = person('jo', 'Jo', '#a78bfa')
const PEOPLE = [mum, sam, jo]

const TASKS: Task[] = [
  outing('nopi', at(2026, 7, 12, 20), ['mum', 'sam']),
  outing('nopi', at(2025, 11, 20, 20), ['mum']),
  outing('park', at(2026, 9, 13, 11), ['sam']),
  outing('park', at(2026, 9, 1, 10), ['sam', 'jo']),
  outing('park', at(2026, 8, 20)),
  outing('park', at(2026, 3, 5)),
  outing('pret', at(2026, 9, 12, 9)),
  outing('bella', at(2025, 1, 10, 19)),
  outing('bella', at(2025, 2, 10, 19)),
  outing('bella', at(2025, 3, 10, 19)),
  // a plan, and one in the Trash: neither is an outing
  outing('kafka', at(2026, 9, 10), ['jo'], { status: 'todo', completedAt: undefined }),
  outing('oldvic', at(2026, 9, 10), [], { deletedAt: STAMP }),
]
/** Saturday's lunch at Pret, eaten out; next Sunday's booking there is still to come. */
const MEALS: Meal[] = [eatOut('pret', '2026-09-12', 'lunch'), eatOut('pret', '2026-09-20')]

/** The list's rows, as Places works them out. */
const rows = (places = PLACES, tasks = TASKS, meals = MEALS): PlaceStats[] => places.map(p => placeStats(p, tasks, PEOPLE, NOW, meals))
const ids = (list: readonly { place: Place }[]) => list.map(r => r.place.id)
const counts = (list: readonly { key: string; count: number }[]) => list.map(r => [r.key, r.count])

/** Places → Stats with its chip and find box held, as the People tab holds them, so a chip pressed narrows the next render. */
function Held(props: ComponentProps<typeof PlacesStats>) {
  const [filter, onFilter] = useState(props.filter)
  return PlacesStats({ ...props, filter, onFilter })
}

/** A localStorage holding `init`, as a device that has chosen before; what is saved lands in the map returned. */
function storage(init: Record<string, string>): Map<string, string> {
  const saved = new Map(Object.entries(init))
  vi.stubGlobal('localStorage', { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) })
  return saved
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the tiles', () => {
  it('count the places, this year’s and this month’s outings, what is due back and what is new', () => {
    expect(placesTiles(rows(), NOW)).toEqual({ places: 6, outingsThisYear: 7, outingsThisMonth: 4, beenAWhile: 1, newThisYear: 2 })
  })

  it('sum this year’s and this month’s outings from the year in places itself', () => {
    const report = placeYearReport(PLACES, TASKS, MEALS, 2026, NOW)
    const tiles = placesTiles(rows(), NOW)
    expect(tiles.outingsThisYear).toBe(report.reduce((n, r) => n + r.total, 0))
    expect(tiles.outingsThisMonth).toBe(report.reduce((n, r) => n + r.months[8], 0))
  })

  it('read Been a while by the rhythm you set, as a row’s badge does', () => {
    const stats = rows()
    expect(ids(stats.filter(dueBack))).toEqual(['nopi'])
    expect(stats.find(s => s.place.id === 'nopi')!.status).toBe('overdue')
    // a rhythm with no outing yet is "No outings yet", not due
    expect(rows([nopi], [], []).filter(dueBack)).toEqual([])
  })

  it('are nothing with nothing saved, and one place’s one outing once', () => {
    expect(placesTiles([], NOW)).toEqual({ places: 0, outingsThisYear: 0, outingsThisMonth: 0, beenAWhile: 0, newThisYear: 0 })
    expect(placesTiles(rows([park], [outing('park', at(2026, 9, 2))], []), NOW)).toEqual({ places: 1, outingsThisYear: 1, outingsThisMonth: 1, beenAWhile: 0, newThisYear: 1 })
  })

  it('file a meal on its own date, and count none still to come', () => {
    // New Year’s Eve’s takeaway is last year’s, and so is the place’s first outing
    const stats = rows([pret], [], [eatOut('pret', '2025-12-31'), eatOut('pret', '2026-09-20')])
    expect(placesTiles(stats, NOW)).toMatchObject({ outingsThisYear: 0, newThisYear: 0 })
    expect(placesTiles(rows([pret], [], [eatOut('pret', '2026-01-02')]), NOW)).toMatchObject({ outingsThisYear: 1, newThisYear: 1 })
  })
})

describe('the kind chips', () => {
  it('offer each kind you have places of, in the kinds’ own order, with the list’s counts', () => {
    const chips = kindChips(PLACES)
    expect(Object.fromEntries(chips.map(c => [c.kind, c.count]))).toEqual({ restaurant: 2, outdoors: 1, fastfood: 1, cafe: 1, venue: 1 })
    const order = chips.map(c => PLACE_CATEGORIES.indexOf(c.kind))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    // the list's badge: how many of its rows are of that kind
    for (const c of chips) expect(c.count, c.kind).toBe(rows().filter(s => s.place.category === c.kind).length)
    expect(kindChips([])).toEqual([])
  })

  it('narrow every figure to one kind, as the list’s chips narrowed its tiles and its table', () => {
    for (const { kind } of kindChips(PLACES)) {
      const ofKind = PLACES.filter(placeMatcher(PLACES, { category: kind, q: '' }))
      expect(ofKind.every(p => p.category === kind), kind).toBe(true)
      const report = placeYearReport(ofKind, TASKS, MEALS, 2026, NOW)
      const tiles = placesTiles(rows(ofKind), NOW)
      expect(tiles.places, kind).toBe(ofKind.length)
      expect(tiles.outingsThisYear, kind).toBe(report.reduce((n, r) => n + r.total, 0))
      expect(tiles.outingsThisMonth, kind).toBe(report.reduce((n, r) => n + r.months[8], 0))
      expect(tiles.beenAWhile, kind).toBe(rows().filter(s => s.place.category === kind && dueBack(s)).length)
    }
    expect(PLACES.filter(placeMatcher(PLACES, NO_PLACE_FILTER))).toEqual(PLACES)
  })
})

describe('Most visited and the podium', () => {
  it('rank all time, 12 months and 30 days by the row’s own counts', () => {
    const stats = rows()
    expect(counts(mostVisited(stats, 'all', NOW))).toEqual([
      ['park', 4],
      ['bella', 3],
      ['pret', 2],
      ['nopi', 2],
    ])
    expect(counts(mostVisited(stats, 365, NOW))).toEqual([
      ['park', 4],
      ['pret', 2],
      ['nopi', 2],
    ])
    expect(counts(mostVisited(stats, 30, NOW))).toEqual([
      ['park', 3],
      ['pret', 2],
    ])
    for (const s of stats) {
      // the row's "12mo" and its "all time"
      expect(outingsWithin(s, 365, NOW), s.place.name).toBe(s.count365)
      expect(outingsWithin(s, 'all', NOW), s.place.name).toBe(s.visits.length)
    }
  })

  it('break a tie by the latest outing, then A to Z', () => {
    // Pret and Nopi both have two: Pret's latest is Saturday, Nopi's in July
    expect(mostVisited(rows(), 'all', NOW).filter(r => r.count === 2).map(r => r.key)).toEqual(['pret', 'nopi'])
    const same = at(2026, 9, 1)
    const twins = rows([place('b', 'Bravo'), place('a', 'Alpha')], [outing('b', same), outing('a', same)], [])
    expect(mostVisited(twins, 'all', NOW).map(r => r.name)).toEqual(['Alpha', 'Bravo'])
  })

  it('rank nobody with nothing counted, and one place alone', () => {
    expect(mostVisited([], 'all', NOW)).toEqual([])
    expect(mostVisited(rows([kafka], [], []), 'all', NOW)).toEqual([])
    expect(mostVisited(rows([park], [outing('park', at(2026, 9, 2))], []), 30, NOW).map(r => r.key)).toEqual(['park'])
  })
})

describe('a tie never falls to the order the store holds things in', () => {
  it('ranks two places of one name by their ids, whichever is saved first', () => {
    const same = at(2026, 9, 1)
    const two = [place('z', 'Pret'), place('a', 'Pret')]
    const tasks = [outing('z', same), outing('a', same)]
    for (const list of [two, [...two].reverse()]) {
      expect(mostVisited(rows(list, tasks, []), 'all', NOW).map(r => r.key)).toEqual(['a', 'z'])
      expect(usualCompany(rows(list, [outing('z', same, ['sam']), outing('a', same, ['sam'])], [])).map(u => u.place.id)).toEqual(['a', 'z'])
      expect(ids(neverBeen(rows(list, [], [])))).toEqual(['a', 'z'])
      expect(mealsOut(rows(list, [], [eatOut('z', '2026-09-05'), eatOut('a', '2026-09-05')]), 2026).rows.map(r => r.key)).toEqual(['a', 'z'])
    }
  })

  it('ranks two people of one name by their ids', () => {
    const sams = [person('sam-2', 'Sam', '#60a5fa'), person('sam-1', 'Sam', '#f472b6')]
    const tasks = [outing('park', at(2026, 9, 2), ['sam-2', 'sam-1'])]
    for (const list of [sams, [...sams].reverse()]) expect(companyOnOutings(rows([park], tasks, []), list, 'all', NOW).map(r => r.key)).toEqual(['sam-1', 'sam-2'])
  })

  it('puts a day’s lunch out before its dinner out, and two outings at one instant A to Z', () => {
    // every meal files at midday: the slot settles it
    const lunchAt = place('b', 'Bravo')
    const dinnerAt = place('a', 'Alpha')
    const meals = [eatOut('a', '2026-09-05', 'dinner'), eatOut('b', '2026-09-05', 'lunch')]
    for (const list of [
      [lunchAt, dinnerAt],
      [dinnerAt, lunchAt],
    ])
      expect(placesByDay(rows(list, [], meals)).get('2026-09-05')!.map(p => p.id)).toEqual(['b', 'a'])
    const same = at(2026, 9, 6, 18)
    expect(placesByDay(rows([place('b', 'Bravo'), place('a', 'Alpha')], [outing('b', same), outing('a', same)], [])).get('2026-09-06')!.map(p => p.name)).toEqual(['Alpha', 'Bravo'])
  })
})

describe('Not been back and Never been', () => {
  it('list where you went and are past the rhythm, the one you set or your usual one, longest since first', () => {
    const back = notBeenBack(rows())
    expect(ids(back)).toEqual(['bella', 'nopi'])
    // with no rhythm set, it is Where should we go?'s drifted-from
    expect(ids(back.filter(s => s.status === 'none'))).toEqual(ids(lapsed(PLACES, TASKS, PEOPLE, NOW, MEALS)))
    // with one, the Been a while tile's
    expect(ids(back.filter(s => s.status !== 'none'))).toEqual(ids(rows().filter(dueBack)))
  })

  it('keep off a place whose own rhythm is on track, however long the gap', () => {
    const yearly = place('y', 'Yearly', { cadenceDays: 365 })
    const tasks = [outing('y', at(2025, 11, 1)), outing('y', at(2025, 12, 1)), outing('y', at(2026, 1, 1))]
    const [s] = rows([yearly], tasks, [])
    expect(s.status).toBe('ok')
    expect(notBeenBack([s])).toEqual([])
    // the same outings, with no rhythm set, have drifted
    expect(ids(notBeenBack(rows([{ ...yearly, cadenceDays: undefined }], tasks, [])))).toEqual(['y'])
  })

  it('list places saved and never been to, the one waiting longest first, then A to Z', () => {
    expect(ids(neverBeen(rows()))).toEqual(['oldvic', 'kafka'])
    // a plan there, or an outing in the Trash, is not an outing
    expect(rows().find(s => s.place.id === 'kafka')!.visits).toEqual([])
    expect(neverBeen(rows([place('b', 'Bravo'), place('a', 'Alpha')], [], [])).map(s => s.place.name)).toEqual(['Alpha', 'Bravo'])
  })

  it('are empty with nothing saved', () => {
    expect(notBeenBack([])).toEqual([])
    expect(neverBeen([])).toEqual([])
  })
})

describe('by the calendar', () => {
  it('adds the year in places up into its months, total and trend', () => {
    const report = placeYearReport(PLACES, TASKS, MEALS, 2026, NOW)
    const year = outingsByMonth(rows(), 2026, NOW)
    expect(year.months).toEqual([0, 0, 1, 0, 0, 0, 1, 1, 4, 0, 0, 0])
    expect(year.months).toEqual(report.reduce((sum, r) => sum.map((n, i) => n + r.months[i]), Array<number>(12).fill(0)))
    expect(year.total).toBe(7)
    // the last 90 days' six outings against none in the 90 before, as the rows' trends add up
    expect(year.trend).toBe(6)
    expect(year.trend).toBe(report.reduce((n, r) => n + r.trend, 0))
    // Bella's three and Nopi in November
    expect(outingsByMonth(rows(), 2025, NOW).total).toBe(4)
    expect(outingsByMonth([], 2026, NOW)).toEqual({ months: Array(12).fill(0), total: 0, trend: 0 })
  })

  it('puts each day’s places on the local calendar, each once, in the order you went', () => {
    const days = placesByDay(rows())
    // breakfast at Pret and lunch there: two outings, one place
    expect(days.get('2026-09-12')!.map(p => p.id)).toEqual(['pret'])
    expect(days.get('2026-09-13')!.map(p => p.id)).toEqual(['park'])
    // next Sunday's booking is still to come
    expect(days.get('2026-09-20')).toBeUndefined()
    const busy = rows([pret, park], [outing('park', at(2026, 9, 5, 15)), outing('pret', at(2026, 9, 5, 9)), outing('park', at(2026, 9, 5, 8))], [])
    expect(placesByDay(busy).get('2026-09-05')!.map(p => p.id)).toEqual(['park', 'pret'])
    expect(placesByDay([]).size).toBe(0)
  })
})

describe('By kind', () => {
  it('shares a window’s outings between the kinds, most first, and adds up to Most visited', () => {
    const all = outingsByKind(rows(), 'all', NOW)
    expect(counts(all)).toEqual([
      ['restaurant', 5],
      ['outdoors', 4],
      ['fastfood', 2],
    ])
    expect(all.map(r => r.share)).toEqual([5 / 11, 4 / 11, 2 / 11])
    expect(all[0]).toMatchObject({ name: 'Restaurant', emoji: '🍽️' })
    expect(all.reduce((n, r) => n + r.count, 0)).toBe(mostVisited(rows(), 'all', NOW).reduce((n, r) => n + r.count, 0))
    expect(counts(outingsByKind(rows(), 30, NOW))).toEqual([
      ['outdoors', 3],
      ['fastfood', 2],
    ])
  })

  it('keeps the kinds’ own order for a tie, and shares nothing without outings', () => {
    const tie = rows([park, nopi], [outing('park', at(2026, 9, 2)), outing('nopi', at(2026, 9, 3))], [])
    expect(outingsByKind(tie, 'all', NOW).map(r => r.key)).toEqual(['restaurant', 'outdoors'])
    expect(outingsByKind([], 'all', NOW)).toEqual([])
    expect(outingsByKind(rows([kafka], [], []), 'all', NOW)).toEqual([])
  })
})

describe('Who you go with', () => {
  it('counts each outing someone was on once, as the With row and their "where we go" do', () => {
    const stats = rows()
    const company = companyOnOutings(stats, PEOPLE, 'all', NOW)
    expect(counts(company)).toEqual([
      ['sam', 3],
      ['mum', 2],
      ['jo', 1],
    ])
    for (const p of PEOPLE) expect(company.find(r => r.key === p.id)?.count ?? 0, p.name).toBe(placesWith(p.id, PLACES, TASKS).reduce((n, r) => n + r.count, 0))
    expect(counts(companyOnOutings(stats, PEOPLE, 30, NOW))).toEqual([
      ['sam', 2],
      ['jo', 1],
    ])
  })

  it('breaks a tie A to Z, and names nobody for a meal, which records no company', () => {
    const tie = rows([park], [outing('park', at(2026, 9, 2), ['sam', 'mum'])], [])
    expect(companyOnOutings(tie, PEOPLE, 'all', NOW).map(r => r.name)).toEqual(['Mum', 'Sam'])
    expect(companyOnOutings([], PEOPLE, 'all', NOW)).toEqual([])
    expect(companyOnOutings(rows([pret], [], [eatOut('pret', '2026-09-12')]), PEOPLE, 'all', NOW)).toEqual([])
  })

  it('pairs each top place with the first of its row’s Usually with, leaving out where you go alone', () => {
    const usual = usualCompany(rows())
    expect(usual.map(u => [u.place.id, u.person.id, u.count])).toEqual([
      ['park', 'sam', 2],
      ['nopi', 'mum', 2],
    ])
    for (const u of usual) expect(companionsAt(u.place.id, PEOPLE, TASKS)[0]).toEqual({ person: u.person, count: u.count })
    expect(usualCompany([])).toEqual([])
  })
})

describe('Meals out', () => {
  it('counts this year’s meals eaten out as the Outings tile does: on their own date, none still to come', () => {
    expect(mealsOut(rows(), 2026)).toEqual({ rows: [{ key: 'pret', name: 'Pret', count: 1, place: pret, last: '2026-09-12' }], total: 1 })
    const two = rows([pret, nopi], [], [eatOut('pret', '2025-12-31'), eatOut('pret', '2026-01-02'), eatOut('nopi', '2026-02-03')])
    expect(mealsOut(two, 2025)).toMatchObject({ total: 1, rows: [{ key: 'pret', last: '2025-12-31' }] })
    // one each this year, the later first; every one of them on the Outings tile
    expect(mealsOut(two, 2026).rows.map(r => r.key)).toEqual(['nopi', 'pret'])
    expect(mealsOut(two, 2026).total).toBe(placesTiles(two, NOW).outingsThisYear)
    expect(mealsOut([], 2026)).toEqual({ rows: [], total: 0 })
  })
})

describe('nothing narrows the list or its Stats: places are the household’s', () => {
  // my partner's walk in the park and my dinner at Nopi, both done
  const theirs = outing('park', at(2026, 9, 5), [], { ownerId: 'partner', assigneeId: 'partner' })
  const mine = outing('nopi', at(2026, 9, 6), [], { ownerId: 'me' })
  /** What Mine / Everyone used to hide (v3.19 removed it): kept as a second set of rows to agree with. */
  const narrowed = (ts: Task[]) => ts.filter(t => (t.assigneeId ? t.assigneeId === 'me' : t.ownerId === 'me' || !t.ownerId))

  it('hands Stats the records the list is handed, every task among them', () => {
    const screen = read('../components/planner/PeopleScreen.tsx')
    const from = screen.indexOf('<PlacesStats')
    const stats = screen.slice(from, screen.indexOf('/>', from))
    for (const prop of ['places={store.places}', 'people={store.people}', 'tasks={store.tasks}', 'meals={store.meals}']) expect(stats).toContain(prop)
    expect(screen).not.toContain('filteredTasks')
    // and there is no narrowing left to say anything about
    expect(stats).not.toContain('mineOnCalendar')
    expect(screen).not.toContain('mineOnly')
  })

  it('counts a household member’s outing beside yours, as the rows do', () => {
    const stats = rows([park, nopi], [theirs, mine], [])
    expect(placesTiles(stats, NOW).outingsThisMonth).toBe(2)
    expect(stats.map(s => s.visits.length)).toEqual([1, 1])
  })

  it('agrees with the rows whichever tasks it is handed', () => {
    for (const tasks of [[theirs, mine, ...TASKS], narrowed([theirs, mine, ...TASKS])]) {
      const stats = rows(PLACES, tasks)
      const report = placeYearReport(PLACES, tasks, MEALS, 2026, NOW)
      expect(placesTiles(stats, NOW).outingsThisYear).toBe(report.reduce((n, r) => n + r.total, 0))
      for (const r of mostVisited(stats, 365, NOW)) expect(r.count).toBe(stats.find(s => s.place.id === r.key)!.count365)
    }
    expect(placesTiles(rows(PLACES, narrowed([theirs, mine]), []), NOW).outingsThisMonth).toBe(1)
  })
})

describe('Places → Stats, drawn', () => {
  const view = (over: Partial<ComponentProps<typeof PlacesStats>> = {}) =>
    html(<PlacesStats places={PLACES} people={PEOPLE} tasks={TASKS} meals={MEALS} filter={NO_PLACE_FILTER} onFilter={noop} onOpenPlace={noop} onPlan={noop} onOpenPerson={noop} onOpenDay={noop} now={NOW} {...over} />)
  /** The card whose heading is `title`, to the end of its section. */
  const card = (page: string, title: string) => {
    const from = page.indexOf(`<h3>${title}</h3>`)
    return from < 0 ? '' : page.slice(from, page.indexOf('</section>', from))
  }
  const names = (part: string, cls: string) => [...part.matchAll(new RegExp(`class="${cls}">([^<]+)<`, 'g'))].map(m => m[1])

  it('with nothing saved, says what to do and draws no figures', () => {
    const page = view({ places: [] })
    expect(page).toContain('Add the places you go on the List')
    expect(page).not.toContain('kpi-row')
    expect(page).not.toContain('chart-head')
    expect(page).not.toContain('board-count')
  })

  it('with places and no outings, has every card say what it is waiting for', () => {
    const page = view({ tasks: [], meals: [] })
    expect(page).toContain('<div class="stat-label">Places</div><div class="stat-value">6</div>')
    // no tile for a figure of nothing: no outings this year, this month, due back or new
    for (const label of ['Outings this year', 'Outings this month', 'Been a while', 'New this year']) expect(page, label).not.toContain(`<div class="stat-label">${label}</div>`)
    expect(page).toContain('Each day’s places · no outings')
    expect(page).not.toContain('place-dots')
    expect(page).not.toContain('Top three')
    expect(page).toContain('Log an outing, or eat out somewhere you saved, and your most visited show here.')
    expect(page).toContain('Nowhere has gone past its rhythm.')
    expect(page).not.toContain('Usually with')
    expect(page).toContain('Plan a meal in Kitchen as eaten out')
    expect(page).toContain('0 outings in 2026')
    // every place saved is one never been to, with a trip to plan
    expect(names(card(page, 'Never been'), 'stats-list-name')).toHaveLength(6)
    expect(page.match(/>Plan a trip</g)).toHaveLength(6)
  })

  it('heads the figures with the list’s kind chips: All first and on, then each kind you have places of, with its count', () => {
    const page = view()
    expect(page).toContain(
      '<span class="segmented" role="group" aria-label="Kind of place"><button type="button" aria-pressed="true" class="seg on">All <span class="board-count">6</span></button>',
    )
    expect(page).toContain('<button type="button" aria-pressed="false" class="seg">Restaurant <span class="board-count">2</span></button>')
    // a kind with no places has no chip
    expect(page.match(/class="board-count"/g)).toHaveLength(1 + kindChips(PLACES).length)
    expect(page.indexOf('Kind of place')).toBeLessThan(page.indexOf('kpi-row'))
  })

  it('tiles the places, this year’s and this month’s outings, what is due back and what is new', () => {
    const page = view()
    for (const [label, value] of [
      ['Places', '6'],
      ['Outings this year', '7'],
      ['Outings this month', '4'],
      ['Been a while', '1'],
      ['New this year', '2'],
    ])
      expect(page).toContain(`<div class="stat-label">${label}</div><div class="stat-value">${value}</div>`)
    expect(page).toContain('saved, every kind')
    // this month's and this year's outings, each against the same stretch before
    expect(page).toMatch(/<div class="stat-label">Outings this month<\/div><div class="stat-value">4<\/div><div class="stat-trend"><span class="delta-line">/)
    expect(page).toContain('on last month so far')
    expect(page).toContain('on 2025 so far')
  })

  it('draws the month in places: each day’s places named in full, opening the Calendar', () => {
    const page = view()
    expect(page).toContain('<h3>Where you went</h3>')
    expect(page).toContain('Each day’s places · 4 outings on 3 days')
    expect(page).toContain('aria-label="Tue 1 Sep: Hyde Park"')
    expect(page).toContain('aria-label="Sat 12 Sep: Pret"')
    expect(page).toContain('aria-label="Sun 13 Sep: Hyde Park"')
    expect(page).toContain('aria-label="Mon 14 Sep: no outings"')
    expect(page.match(/class="photo-cal-cell has-outing"/g)).toHaveLength(3)
    expect(page).toMatch(/aria-label="Next month" disabled=""/)
    // with no way to the Calendar, the days are only pictures
    expect(view({ onOpenDay: undefined })).not.toContain('<button type="button" class="photo-cal-day"')
  })

  it('says what the month counts, with no caveat: the Calendar it opens holds the same outings', () => {
    // the caveat existed for Mine / Everyone, which is gone (v3.19)
    expect(view()).toContain('Each day’s places · 4 outings on 3 days')
    expect(view()).not.toContain('Mine keeps the Calendar')
  })

  it('shows three of a busy day’s places as emoji, then "+n"', () => {
    const five = ['A', 'B', 'C', 'D', 'E'].map(n => place(n.toLowerCase(), `Place ${n}`))
    const page = view({ places: five, tasks: five.map((p, i) => outing(p.id, at(2026, 9, 10, 8 + i))), meals: [] })
    const from = page.indexOf('aria-label="Thu 10 Sep:')
    const cell = page.slice(from, page.indexOf('</li>', from))
    expect(cell).toContain('aria-label="Thu 10 Sep: Place A, Place B, Place C, Place D and Place E"')
    expect(cell.match(/class="place-mark place-dot"/g)).toHaveLength(3)
    expect(cell).toContain('<span class="place-dots-more">+2</span>')
  })

  it('stands the three most visited of all time on the podium, each emoji on its colour made to read', () => {
    const page = view()
    expect(page).toContain('<h3>Top three</h3>')
    expect([...page.matchAll(/class="podium-piece" aria-label="([^"]+)"/g)].map(m => m[1])).toEqual(['First: Hyde Park, 4 outings', 'Second: Bella Italia, 3 outings', 'Third: Pret, 2 outings'])
    const pale = readableInk('#fef3c7', 'light')
    expect(pale).not.toBe('#fef3c7')
    expect(page).toContain(`<span class="place-mark podium-photo" style="background:${pale}" aria-hidden="true">🍽️</span>`)
  })

  it('opens Most visited, By kind and Who you go with on the last 30 days, as the wardrobe’s bars open', () => {
    const page = view()
    expect(names(card(page, 'Most visited'), 'stats-hbar-name')).toEqual(['Hyde Park', 'Pret'])
    expect(names(card(page, 'Most visited'), 'hbar-value')).toEqual(['3', '2'])
    expect(names(card(page, 'By kind'), 'stats-hbar-name')).toEqual(['Outdoors', 'Fast food'])
    expect(card(page, 'By kind')).toContain('<small class="muted">60%</small>')
    expect(card(page, 'By kind')).toContain('<small class="muted">40%</small>')
    expect(names(card(page, 'Who you go with'), 'stats-hbar-name')).toEqual(['Sam', 'Jo'])
  })

  it('lists where you have not been back and where you have never been, each with a trip to plan', () => {
    const page = view()
    const back = card(page, 'Not been back')
    expect(names(back, 'stats-list-name')).toEqual(['Bella Italia', 'Nopi'])
    // the row's own reason, the rhythm you set included
    expect(back).toContain('you aimed for every 30 days')
    const never = card(page, 'Never been')
    expect(names(never, 'stats-list-name')).toEqual(['Old Vic', 'Kafka'])
    expect(never).toContain('Venue · saved 8 months ago')
    expect(never).toContain('Café · saved 7 months ago')
  })

  it('draws the year by month, its total and its trend, with the year in places under it', () => {
    const page = view()
    const from = page.indexOf('class="chart-card year-report')
    const year = page.slice(from, page.indexOf('</section>', from))
    expect(year).toContain('<h3>The year in places</h3>')
    expect(year).toContain('Outings per month, a meal eaten out there included, two in one day counted as two')
    expect(year).toContain('aria-label="Outings: Jan 0, Feb 0, Mar 1, Apr 0, May 0, Jun 0, Jul 1, Aug 1, Sep 4, Oct 0, Nov 0, Dec 0"')
    expect(year).toContain('7 outings in 2026')
    expect(year).toContain('↑ more lately')
    expect(year).toContain('<div class="table-scroll"><table class="year-table">')
    expect([...year.matchAll(/<th class="num">([A-Z])<\/th>/g)].map(m => m[1]).join('')).toBe('JFMAMJJASOND')
    expect(year).toContain('<th class="num">Outings</th>')
    // a row for every place, as the table under the list had
    expect(year.match(/<tr>/g)).toHaveLength(1 + PLACES.length)
    // a pale place's dot is its colour moved to show on the card, as the wardrobe's table draws a piece's
    const dot = graphicInk('#fef3c7', 'light')
    expect(dot).not.toBe('#fef3c7')
    expect(year).toContain(`<span class="pdot" style="background:${dot}"></span> Bella Italia`)
  })

  it('pairs the top places with their usual company, and counts this year’s meals out', () => {
    const page = view()
    expect(page).toContain('Usually with Sam ×2')
    expect(page).toContain('Usually with Mum ×2')
    expect(page).toContain('1 meal eaten out at your places in 2026, of 7 outings')
    expect(page).toContain('1 meal · last Sat 12 Sep')
  })
})

describe('what a press does', () => {
  const setup = (over: Partial<ComponentProps<typeof PlacesStats>> = {}) => {
    const calls: string[] = []
    const props: ComponentProps<typeof PlacesStats> = {
      places: PLACES,
      people: PEOPLE,
      tasks: TASKS,
      meals: MEALS,
      filter: NO_PLACE_FILTER,
      onFilter: noop,
      now: NOW,
      onOpenPlace: p => void calls.push(`place ${p.id}`),
      onPlan: p => void calls.push(`plan ${p.id}`),
      onOpenPerson: p => void calls.push(`person ${p.id}`),
      onOpenDay: d => void calls.push(`day ${d}`),
      ...over,
    }
    const all = elements(settled(PlacesStats, props))
    const card = (title: string) => all.find(e => (e.type === RankedBars || e.type === ListCard) && e.props.title === title)!
    return { calls, props, all, card }
  }

  it('opens a day on the Calendar, a place on the list with its row open, and a person on People', () => {
    const { calls, props, all, card } = setup()
    expect(all.find(e => e.type === MonthCalendar)!.props.onOpen).toBe(props.onOpenDay)
    ;(all.find(e => e.type === Podium)!.props.onOpen as (r: { place: Place }) => void)({ place: park })
    ;(card('Most visited').props.onOpen as (r: { place: Place }) => void)({ place: pret })
    ;(card('Who you go with').props.onOpen as (r: { person: Person }) => void)({ person: sam })
    expect(calls).toEqual(['place park', 'place pret', 'person sam'])
  })

  it('plans a trip from Not been back and Never been, as a row’s Plan a trip does', () => {
    const { props, card } = setup()
    for (const title of ['Not been back', 'Never been']) {
      const list = card(title)
      const row = (list.props.row as (s: PlaceStats) => El)((list.props.items as PlaceStats[])[0])
      expect(row.props.onPlan, title).toBe(props.onPlan)
      expect(row.props.onOpen, title).toBe(props.onOpenPlace)
    }
  })

  it('ranks every window by the counts the tests above hold to the rows', () => {
    const { card } = setup()
    const rank = (title: string) => card(title).props.rank as (w: DayWindow) => unknown
    for (const span of [30, 365, 'all'] as const) {
      expect(rank('Most visited')(span)).toEqual(mostVisited(rows(), span, NOW))
      expect(rank('By kind')(span)).toEqual(outingsByKind(rows(), span, NOW))
      expect(rank('Who you go with')(span)).toEqual(companyOnOutings(rows(), PEOPLE, span, NOW))
    }
  })

  it('leaves Who you go with to read, not press, without a way to People', () => {
    expect(setup({ onOpenPerson: undefined }).card('Who you go with').props.onOpen).toBeUndefined()
  })

  /** The podium's rows and the year table's, as the view hands them to the kit, whose props are generic. */
  const podiumTop = (t: ReactNode) => elements(t).find(e => e.type === Podium)!.props.top as readonly { key: string }[]
  const tableRows = (t: ReactNode) => elements(t).find(e => e.type === YearTable)!.props.rows as readonly { key: string; total: number }[]

  it('narrows every card under a kind chip to that kind, as the list’s tiles and table were, and keeps By kind to All', () => {
    const { props } = setup()
    const tree = settled(Held, props, t => press(t, 'Restaurant 2'))
    const all = elements(tree)
    const tile = (label: string) => all.find(e => e.type === StatTile && e.props.label === label)?.props.value
    const restaurants = PLACES.filter(p => p.category === 'restaurant')
    const stats = rows(restaurants)
    const report = placeYearReport(restaurants, TASKS, MEALS, 2026, NOW)
    expect(button(tree, 'Restaurant 2').props['aria-pressed']).toBe(true)
    expect(button(tree, 'All 6').props['aria-pressed']).toBe(false)
    expect(tile('Places')).toBe('2')
    // a tile only for something there is, and each the table's own sum
    const shown = (n: number) => (n > 0 ? String(n) : undefined)
    expect(tile('Outings this year')).toBe(shown(report.reduce((n, r) => n + r.total, 0)))
    expect(tile('Outings this month')).toBe(shown(report.reduce((n, r) => n + r.months[8], 0)))
    // a tile only for something there is: none of the restaurants is due back
    const due = stats.filter(dueBack).length
    expect(tile('Been a while')).toBe(due > 0 ? String(due) : undefined)
    expect(tableRows(tree).map(r => r.key)).toEqual(report.map(r => r.place.id))
    expect(podiumTop(tree).map(r => r.key)).toEqual(mostVisited(stats, 'all', NOW, 3).map(r => r.key))
    const items = (title: string) => all.find(e => e.type === ListCard && e.props.title === title)!.props.items as PlaceStats[]
    expect(ids(items('Not been back'))).toEqual(ids(notBeenBack(stats)))
    expect(items('Never been')).toEqual([])
    expect(all.some(e => e.type === RankedBars && e.props.title === 'By kind')).toBe(false)
    expect(all.some(e => e.type === RankedBars && e.props.title === 'Most visited')).toBe(true)
  })

  it('works its figures out once and keeps them through a re-render, such as the year’s ‹', () => {
    const { props } = setup()
    const yearCard = (t: ReactNode) => elements(t).find(e => e.type === ChartCard && e.props.title === 'The year in places')!
    const trees = rendered(PlacesStats, props, t => ((yearCard(t).props.aside as El).props.onStep as (delta: -1 | 1) => void)(-1))
    expect(trees).toHaveLength(2)
    const [first, last] = trees
    expect((yearCard(last).props.aside as El).props.label).toBe('2025')
    // the podium and the lists are the very ones the first render worked out…
    expect(podiumTop(last)).toBe(podiumTop(first))
    const items = (t: ReactNode, title: string) => elements(t).find(e => e.type === ListCard && e.props.title === title)!.props.items
    expect(items(last, 'Not been back')).toBe(items(first, 'Not been back'))
    expect(items(last, 'Never been')).toBe(items(first, 'Never been'))
    // …while the table is 2025's: Bella's three and Nopi in November
    expect(tableRows(last)).not.toBe(tableRows(first))
    expect(tableRows(last).reduce((n, r) => n + r.total, 0)).toBe(4)
  })
})

describe('the shell’s ways into Places → Stats', () => {
  const nav = read('../components/planner/useNavigation.ts')
  const screen = read('../components/planner/PeopleScreen.tsx')
  const calendarScreen = read('../components/planner/CalendarScreen.tsx')
  const calendar = read('../components/Calendar.tsx')
  const lazy = read('../components/planner/lazy.ts')

  it('loads it lazily, with the People tab’s other chunks', () => {
    // from the Stats registry lazy.ts re-exports (lazystats.ts)
    expect(read('../components/planner/lazystats.ts')).toContain("import('../PlacesStats')")
    expect(lazy).toContain("from './lazystats'")
    expect(lazy).toMatch(/keep: \[People\.preload, Places\.preload, PeopleStats\.preload, PlacesStats\.preload, ImHereSheet\.preload/)
    expect(screen).toMatch(/import \{ People, PeopleStats, Places, PlacesStats \} from '\.\/lazy'/)
  })

  it('remembers List · Stats from its switch alone; a tab tap re-reads it, the palette and a link move it for the visit', () => {
    // the three facts the switch is pinned on, not the one line it used to fit on:
    // it carries an `action` now (Places' + Add place), so the JSX is multi-line
    expect(screen).toContain('label="Places list or stats"')
    expect(screen).toContain('value={innerViews.places}')
    expect(screen).toContain("onChange={v => setInnerView('places', v)}")
    expect(nav).toMatch(/const setInnerView = \(tab: PeopleTab, v: InnerView\) => \{\s*goInnerView\(tab, v\)\s*try \{\s*localStorage\.setItem\(INNER_VIEW_KEYS\[tab\], v\)/)
    expect(nav.match(/localStorage\.setItem\(INNER_VIEW_KEYS/g)).toHaveLength(1)
    expect(nav).toMatch(/if \(v === 'keep'\) \{[\s\S]*?goKeepTab\(storedKeepTab\(\)\)[\s\S]*?showInnerViews\(storedInnerViews\(\)\)/)
    expect(nav).toMatch(/const openStats = \(tab: PeopleTab\) => \{\s*goKeepTab\(tab\)\s*goInnerView\(tab, 'stats'\)\s*setView\('keep'\)/)
  })

  it('opens a place’s row on the list, whichever half was showing', () => {
    expect(nav).toMatch(/const openPlace = \(id\?: string\) => \{[^}]*setView\('keep'\)[^}]*if \(id\) goInnerView\('places', 'list'\)\n\s*\}/)
  })

  it('opens a day of the month on the Calendar with its sheet up, without changing Month · Week · Day', () => {
    expect(screen).toContain('onOpenDay={openCalendarDay}')
    expect(nav).toMatch(/const openCalendarDay = \(day: string\) => \{\s*setCalendarOpenDay\(day\)\s*setView\('calendar'\)/)
    expect(calendarScreen).toContain('openDay={calendarOpenDay}')
    expect(calendarScreen).toContain('onOpenDayConsumed={() => setCalendarOpenDay(null)}')
    expect(calendar).toMatch(/setCursor\(day\)\s*if \(view !== 'day'\) setSheetDay\(day\)/)
  })

  it('remembers the Calendar’s mode from its three buttons alone, as the other segments are remembered', () => {
    expect(nav).toMatch(/const setCalMode = \(mode: CalendarMode\) => \{\s*goCalMode\(mode\)\s*try \{\s*localStorage\.setItem\(CAL_MODE_KEY, mode\)/)
    expect(nav.match(/localStorage\.setItem\(CAL_MODE_KEY/g)).toHaveLength(1)
    // no effect saving whatever the mode last became
    expect(nav).not.toMatch(/\}, \[calMode\]\)/)
    expect(nav).toMatch(/if \(v === 'calendar'\) goCalMode\(storedCalMode\(\)\)/)
    expect(calendarScreen.match(/onClick=\{\(\) => setCalMode\('(month|week|day)'\)\}/g)).toHaveLength(3)
  })
})

describe('a day opened from Stats leaves the Calendar’s remembered mode alone', () => {
  type Nav = ReturnType<typeof useNavigation>
  /** Holds the shell's navigation out where a test can reach it. */
  const Hold: (props: { nav: Nav }) => null = () => null
  function NavProbe() {
    const nav = useNavigation()
    return <Hold nav={nav} />
  }
  const navOf = (tree: ReactNode) => propsOf(tree, Hold).nav
  /** The shell's navigation after `act`, on a device whose Calendar was left on `mode`. */
  const after = (mode: string, act: (nav: Nav) => void) => {
    const saved = storage({ [CAL_MODE_KEY]: mode })
    return { nav: navOf(settled(NavProbe, {}, tree => act(navOf(tree)))), saved }
  }

  it('leaves Day as it is, since the day has itself to open', () => {
    const { nav, saved } = after('day', n => n.openCalendarDay('2026-09-12'))
    expect(nav).toMatchObject({ view: 'calendar', calMode: 'day', calendarOpenDay: '2026-09-12' })
    expect(saved.get(CAL_MODE_KEY)).toBe('day')
  })

  it('a saved Timeline from before Day was the third tab opens as the month', () => {
    storage({ [CAL_MODE_KEY]: 'timeline' })
    expect(navOf(settled(NavProbe, {})).calMode).toBe('month')
  })

  it('leaves Week as it is, since the week has days to open too', () => {
    const { nav, saved } = after('week', n => n.openCalendarDay('2026-09-12'))
    expect(nav.calMode).toBe('week')
    expect(saved.get(CAL_MODE_KEY)).toBe('week')
  })

  it('remembers a mode picked on the Calendar’s own buttons', () => {
    const { nav, saved } = after('timeline', n => n.setCalMode('week'))
    expect(nav.calMode).toBe('week')
    expect(saved.get(CAL_MODE_KEY)).toBe('week')
  })
})
