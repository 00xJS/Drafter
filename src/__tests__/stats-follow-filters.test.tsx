import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { useState, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup, renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { People } from '../components/People'
import { PeopleStats } from '../components/PeopleStats'
import { Places } from '../components/Places'
import { PlacesStats } from '../components/PlacesStats'
import type { PlannerCtx } from '../components/planner/ctx'
import type { Store } from '../store'
import * as lazy from '../components/planner/lazy'
import { PeopleScreen } from '../components/planner/PeopleScreen'
import { useListFilters } from '../components/planner/useListFilters'
import { useNavigation } from '../components/planner/useNavigation'
import { ChartCard, ListCard, MonthBars, MonthCalendar, Narrowed, Podium, RankedBars, StatTile, Stepper, StreakTiles, YearTable } from '../components/stats'
import { NO_PERSON_FILTER, findsPerson, personMatcher, type PersonFilter } from '../people'
import { NO_PLACE_FILTER, kindOn, placeMatcher, type PlaceFilter } from '../places'
import type { CalendarEntry, Meal, Person, Place, Task } from '../types'
import { elements, press, propsOf, settled, typeInto, type El } from './rendered'
import { plannerSource, sheetSource } from './source'

// People and Places: what the list's find box and chip hold narrows its
// Stats too. The People tab holds both for the visit, so Stats counts only
// the rows the list shows — every figure the same as Stats over just those
// people or places, a year stepped back to included — says so in a line
// under its chips with Show all, and keeps them through List → Stats → List
// and through a row opened on Stats, while a card opened from search that
// they would hide still clears them before the list draws it. vitest runs in
// node, so the tab is called inside a server render over the shell's own
// navigation, as people-stats-view.test.tsx walks the shell.

const NOW = new Date(2026, 8, 14, 12, 0) // Monday 14 September 2026, local noon
const STAMP = '2026-01-01T00:00:00.000Z'
const at = (m: number, d: number, h = 12) => new Date(2026, m - 1, d, h).toISOString()
const noop = () => {}
const html = (node: ReactNode) => renderToStaticMarkup(node as ReactElement).replace(/<!-- -->/g, '')
const source = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

const person = (id: string, name: string, over: Partial<Person> = {}): Person => ({ kind: 'person', id, name, color: '#3b82f6', group: 'family', createdAt: STAMP, updatedAt: STAMP, ...over })
// A–Z, as the store keeps them
const PEOPLE = [
  person('ben', 'Ben', { group: 'friends', cadenceDays: 30 }),
  person('dad', 'Dad', { color: '#10b981' }),
  // found by her notes, never her name
  person('gran', 'Gran', { cadenceDays: 14, notes: 'Mum’s mum' }),
  person('jo', 'Jo', { group: 'friends', color: '#ef4444' }),
  person('kit', 'Kit', { group: 'other', createdAt: at(8, 25, 9) }),
  person('mum', 'Mum', { color: '#fbbf24', cadenceDays: 14, birthday: '1966-09-26' }),
  person('sam', 'Sam', { group: 'friends', color: '#8b5cf6', birthday: '0000-09-14' }),
]
let seq = 0
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
const TASKS = [
  // Saturday's dinner: under “m” it is Mum and Sam's, and Dad and Jo are not counted on it
  done(at(9, 12, 13), ['mum', 'dad', 'sam', 'jo']),
  done(at(9, 12, 20), ['sam']),
  done(at(9, 13), ['mum', 'dad']),
  // Dad alone: under “m”, not a day with anyone
  done(at(9, 11), ['dad']),
  done(at(9, 10), ['jo', 'ben']),
  done(at(8, 1), ['mum', 'dad', 'gran', 'ben']),
  done(at(7, 5), ['sam']),
  done(at(3, 2), ['jo', 'sam']),
]
/** Wednesday's lunch with Sam and Jo, on your own calendar. */
const ENTRIES: CalendarEntry[] = [{ kind: 'event', id: 'lunch', title: 'Lunch', start: at(9, 9, 13), end: at(9, 9, 14), allDay: false, peopleIds: ['sam', 'jo'], createdAt: STAMP, updatedAt: STAMP }]

const place = (id: string, name: string, over: Partial<Place> = {}): Place => ({ kind: 'place', id, name, color: '#f97316', category: 'restaurant', createdAt: STAMP, updatedAt: STAMP, ...over })
const PLACES = [
  place('nopi', 'Nopi', { cadenceDays: 30 }),
  place('park', 'Hyde Park', { category: 'outdoors', color: '#22c55e' }),
  // found by its notes
  place('pret', 'Pret', { category: 'fastfood', color: '#b91c1c', notes: 'By the park gates' }),
  place('bella', 'Bella Italia', { color: '#fef3c7' }),
  // found by its address, and never been
  place('kafka', 'Kafka', { category: 'cafe', address: '1 Park Lane', createdAt: '2026-03-01T12:00:00.000Z' }),
  place('oldvic', 'Old Vic', { category: 'venue', createdAt: '2026-02-01T12:00:00.000Z' }),
]
/** A done task at a place: one outing, with whoever was there. */
const outing = (placeId: string, when: string, peopleIds: string[] = []): Task => done(when, peopleIds, { title: 'Out', placeId })
const OUTINGS = [
  outing('nopi', at(7, 12, 20), ['mum', 'sam']),
  outing('park', at(9, 13, 11), ['sam']),
  outing('park', at(9, 1, 10), ['sam', 'jo']),
  outing('park', at(8, 20)),
  outing('pret', at(9, 12, 9)),
  outing('bella', at(3, 10, 19), ['mum']),
  outing('bella', at(4, 10, 19), ['mum']),
]
const eatOut = (placeId: string, date: string): Meal => ({ kind: 'meal', id: `meal~${date}~dinner`, date, slot: 'dinner', out: true, placeId, title: 'Out', createdAt: STAMP, updatedAt: STAMP })
const MEALS = [eatOut('pret', '2026-09-05'), eatOut('nopi', '2026-09-06')]

/**
 * Last year's, handed in only where ‹ year › steps back to 2025, so every
 * figure above stays this year's: Mum alone in March, Sam and Jo in June, Jo
 * and Ben in November; dinner at Nopi in May, Hyde Park with Sam in August,
 * Bella Italia in December.
 */
const in2025 = (m: number, d: number, h = 12) => new Date(2025, m - 1, d, h).toISOString()
const VISITS_2025 = [done(in2025(3, 15), ['mum']), done(in2025(6, 7), ['sam', 'jo']), done(in2025(11, 22), ['jo', 'ben'])]
const OUTINGS_2025 = [outing('nopi', in2025(5, 16, 20), ['mum']), outing('park', in2025(8, 3, 11), ['sam']), outing('bella', in2025(12, 20, 19))]

type PeopleStatsProps = ComponentProps<typeof PeopleStats>
type PlacesStatsProps = ComponentProps<typeof PlacesStats>
const peopleStats = (filter: PersonFilter, over: Partial<PeopleStatsProps> = {}): PeopleStatsProps => ({
  people: PEOPLE,
  tasks: TASKS,
  entries: ENTRIES,
  filter,
  onFilter: noop,
  onSaw: noop,
  onOpenPerson: noop,
  onOpenDay: noop,
  now: NOW,
  ...over,
})
const placesStats = (filter: PlaceFilter, over: Partial<PlacesStatsProps> = {}): PlacesStatsProps => ({
  places: PLACES,
  people: PEOPLE,
  tasks: OUTINGS,
  meals: MEALS,
  filter,
  onFilter: noop,
  onOpenPlace: noop,
  onPlan: noop,
  onOpenPerson: noop,
  onOpenDay: noop,
  now: NOW,
  ...over,
})
const peopleList = (filter: PersonFilter, onFilter: (f: PersonFilter) => void = noop): ComponentProps<typeof People> => ({
  people: PEOPLE,
  tasks: TASKS,
  entries: ENTRIES,
  filter,
  onFilter,
  onSave: noop,
  onDelete: noop,
  onLogVisit: noop,
  onPlan: noop,
  onOpenTask: noop,
})
const placesList = (filter: PlaceFilter, onFilter: (f: PlaceFilter) => void = noop): ComponentProps<typeof Places> => ({
  places: PLACES,
  people: PEOPLE,
  tasks: OUTINGS,
  meals: MEALS,
  filter,
  onFilter,
  onSave: noop,
  onDelete: noop,
  onLogOuting: noop,
  onPlan: noop,
  onOpenTask: noop,
})

/** People → Stats with its chip and find box held, as the People tab holds them, so what is pressed narrows the next render. */
function HeldPeople(props: PeopleStatsProps) {
  const [filter, onFilter] = useState(props.filter)
  return PeopleStats({ ...props, filter, onFilter })
}
/** …and Places → Stats. */
function HeldPlaces(props: PlacesStatsProps) {
  const [filter, onFilter] = useState(props.filter)
  return PlacesStats({ ...props, filter, onFilter })
}

/** Every day of August and September 2026, the month the calendars open on and the one before. */
const DAYS = [...Array.from({ length: 31 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`), ...Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`)]

/**
 * Every figure a Stats view hands the kit, read off its tree: each tile, the
 * streak, the podium, each ranked card in all three windows, each list, the
 * month's days, the year by month and its table, and whom Groups compares.
 * What names them — the chips, the line at the head, a tile's words, a card's
 * title — is left out, so two views counting the same rows compare equal.
 * `skip` leaves out ranked cards by title.
 */
function figures(tree: ReactNode, skip: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const keyOf = (i: any): string => i.key ?? [i.place?.id, i.person?.id, i.kind].filter(Boolean).join(' ')
  for (const e of elements(tree)) {
    const p = e.props as Record<string, any>
    if (e.type === StatTile) out[`tile ${p.label}`] = p.value
    else if (e.type === StreakTiles) out.streak = [p.current, p.best, p.today]
    else if (e.type === Podium) out.podium = p.top.map(keyOf)
    else if (e.type === RankedBars && !skip.includes(p.title)) out[`bars ${p.title}`] = ([30, 365, 'all'] as const).map(span => p.rank(span).map((r: any) => [r.key, r.count]))
    else if (e.type === ListCard) out[`list ${p.title}`] = [p.sub, p.items.map(keyOf)]
    else if (e.type === MonthCalendar)
      out.month = [
        p.sub(2026, 9),
        p.sub(2026, 8),
        DAYS.map(k => {
          const day = p.day(k)
          return [k, day.what, day.className]
        }),
      ]
    else if (e.type === MonthBars) out.monthBars = [p.months, p.total, p.trend]
    else if (e.type === YearTable) out.year = p.rows.map((r: any) => [r.key, r.total, r.months.join(' ')])
    else if (typeof e.type === 'function' && e.type.name === 'GroupsCard') out.groups = p.shown.map((s: any) => s.person.id)
  }
  return out
}

beforeEach(() => {
  // the lists read the clock; Stats is handed it
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the lists’ own rule, which their Stats count by', () => {
  it('finds a person by name or notes, whatever the case or the spaces around it, in the group whose chip is on', () => {
    const on = (f: PersonFilter) => PEOPLE.filter(personMatcher(f)).map(p => p.id)
    expect(on(NO_PERSON_FILTER)).toEqual(PEOPLE.map(p => p.id))
    expect(on({ group: 'all', q: ' M ' })).toEqual(['gran', 'mum', 'sam'])
    expect(on({ group: 'family', q: '' })).toEqual(['dad', 'gran', 'mum'])
    expect(on({ group: 'friends', q: 'm' })).toEqual(['sam'])
    expect(findsPerson(PEOPLE[2], 'mum')).toBe(true)
    expect(findsPerson(PEOPLE[2], '')).toBe(true)
  })

  it('finds a place by its name, another name, its address or its notes, of the kind whose chip is on', () => {
    const on = (f: PlaceFilter) => PLACES.filter(placeMatcher(PLACES, f)).map(p => p.id)
    expect(on({ category: 'all', q: 'PARK' })).toEqual(['park', 'pret', 'kafka'])
    expect(on({ category: 'restaurant', q: '' })).toEqual(['nopi', 'bella'])
    expect(on({ category: 'restaurant', q: 'nop' })).toEqual(['nopi'])
    // a kind whose last place has gone is All, as its chip has gone with it
    expect(kindOn(PLACES, 'bar')).toBe('all')
    expect(on({ category: 'bar', q: '' })).toEqual(PLACES.map(p => p.id))
  })
})

const PEOPLE_FILTERS: [string, PersonFilter][] = [
  ['a find', { group: 'all', q: ' M ' }],
  ['a chip', { group: 'family', q: '' }],
  ['a chip and a find', { group: 'friends', q: 'm' }],
]

describe('People → Stats counts only whom the list shows', () => {
  for (const [what, filter] of PEOPLE_FILTERS)
    it(`with ${what} on, draws every figure as Stats over just those people draws it`, () => {
      const kept = PEOPLE.filter(personMatcher(filter))
      expect(kept.length).toBeGreaterThan(0)
      expect(kept.length).toBeLessThan(PEOPLE.length)
      const narrowed = figures(settled(PeopleStats, peopleStats(filter)))
      expect(narrowed).toEqual(figures(settled(PeopleStats, peopleStats(NO_PERSON_FILTER, { people: kept }))))
      // …which are not everyone's: the find and the chip bite
      expect(narrowed).not.toEqual(figures(settled(PeopleStats, peopleStats(NO_PERSON_FILTER))))
    })

  it('counts on a visit only the people the find leaves, and no day with only the others', () => {
    const out = figures(settled(PeopleStats, peopleStats({ group: 'all', q: 'm' })))
    // Gran, Mum and Sam: Saturday's dinner is two of them, Dad's Friday and Jo and Ben's Thursday none
    expect(out['tile People seen']).toBe('9')
    expect(out['tile Occasions']).toBe('7')
    expect(out['tile Days together']).toBe('6')
    expect(out.groups).toEqual(['gran', 'mum', 'sam'])
    expect((out.month as unknown[])[0]).toBe('Each day’s people · 3 days with someone')
  })

  it('counts exactly the rows the list shows under the same find and chip, each 30-day bar its row’s own figure', () => {
    for (const [what, filter] of PEOPLE_FILTERS) {
      const rows = html(<People {...peopleList(filter)} />)
      const ids = [...rows.matchAll(/<li id="person-([^"]+)"/g)].map(m => m[1])
      expect([...ids].sort(), what).toEqual(PEOPLE.filter(personMatcher(filter)).map(p => p.id).sort())
      const tree = settled(PeopleStats, peopleStats(filter))
      const out = figures(tree)
      expect(out['tile People'], what).toBe(String(ids.length))
      expect((out.year as string[][]).map(r => r[0]).sort(), what).toEqual([...ids].sort())
      const rank = elements(tree).find(e => e.type === RankedBars && e.props.title === 'Most seen')!.props.rank as (w: 30) => { key: string; count: number }[]
      for (const id of ids) {
        const days30 = rows.match(new RegExp(`id="person-${id}"[\\s\\S]*?title="Last 30 days: [^"]*"><strong>(\\d+)</strong>`))![1]
        expect(String(rank(30).find(r => r.key === id)?.count ?? 0), `${what}: ${id}`).toBe(days30)
      }
    }
  })
})

const PLACE_FILTERS: [string, PlaceFilter][] = [
  ['a find', { category: 'all', q: 'PARK' }],
  ['a chip', { category: 'restaurant', q: '' }],
  ['a chip and a find', { category: 'restaurant', q: 'nop' }],
]

describe('Places → Stats counts only the places the list shows', () => {
  for (const [what, filter] of PLACE_FILTERS)
    it(`with ${what} on, draws every figure as Stats over just those places draws it`, () => {
      const kept = PLACES.filter(placeMatcher(PLACES, filter))
      expect(kept.length).toBeGreaterThan(0)
      expect(kept.length).toBeLessThan(PLACES.length)
      // By kind compares the kinds, so under a kind's chip it is not drawn at all
      const skip = filter.category === 'all' ? [] : ['By kind']
      const narrowed = figures(settled(PlacesStats, placesStats(filter)), skip)
      expect(narrowed).toEqual(figures(settled(PlacesStats, placesStats(NO_PLACE_FILTER, { places: kept })), skip))
      expect(narrowed).not.toEqual(figures(settled(PlacesStats, placesStats(NO_PLACE_FILTER)), skip))
    })

  it('counts company and meals out only at the places the find leaves', () => {
    const out = figures(settled(PlacesStats, placesStats({ category: 'all', q: 'park' })))
    // Mum went to Nopi and Bella, neither of them found by “park”
    expect(out['bars Who you go with']).toEqual([[['sam', 2], ['jo', 1]], [['sam', 2], ['jo', 1]], [['sam', 2], ['jo', 1]]])
    expect(out['list Meals out']).toEqual(['1 meal eaten out at your places in 2026, of 5 outings · each on its own date once it has come, as the Outings tile counts them', ['pret']])
    expect(out['list Never been']).toEqual(['Saved, with no outing yet', ['kafka']])
  })

  it('counts exactly the rows the list shows under the same find and chip, each 12-month bar its row’s own figure', () => {
    for (const [what, filter] of PLACE_FILTERS) {
      const rows = html(<Places {...placesList(filter)} />)
      const ids = [...rows.matchAll(/<li id="place-([^"]+)"/g)].map(m => m[1])
      expect([...ids].sort(), what).toEqual(PLACES.filter(placeMatcher(PLACES, filter)).map(p => p.id).sort())
      const tree = settled(PlacesStats, placesStats(filter))
      const out = figures(tree)
      expect(out['tile Places'], what).toBe(String(ids.length))
      expect((out.year as string[][]).map(r => r[0]).sort(), what).toEqual([...ids].sort())
      const rank = elements(tree).find(e => e.type === RankedBars && e.props.title === 'Most visited')!.props.rank as (w: 365) => { key: string; count: number }[]
      for (const id of ids) {
        const count365 = rows.match(new RegExp(`id="place-${id}"[\\s\\S]*?title="Outings in the last 12 months"><strong>(\\d+)</strong>`))![1]
        expect(String(rank(365).find(r => r.key === id)?.count ?? 0), `${what}: ${id}`).toBe(count365)
      }
    }
  })
})

/** What the ‹ year › at the head of a Stats view's year card was handed. */
function yearStepper(tree: ReactNode) {
  const card = elements(tree).find(e => e.type === ChartCard && (e.props.aside as El | undefined)?.type === Stepper && (e.props.aside as El).props.unit === 'year')
  if (!card) throw new Error('no year card')
  return (card.props.aside as El).props as { label: string; canNext?: boolean; onStep(delta: -1 | 1): void }
}
/** A Stats view after its ‹ year › is pressed, once for each step, in one go. */
function stepped<P>(View: (props: P) => ReactNode, props: P, ...steps: (-1 | 1)[]): ReactNode {
  return settled(View, props, tree => {
    const { onStep } = yearStepper(tree)
    for (const d of steps) onStep(d)
  })
}

describe('‹ year › steps the narrowed Stats back through the same rows', () => {
  it('counts only whom People’s find and chip leave in a past year too, and stops again at this year', () => {
    const filter: PersonFilter = { group: 'friends', q: 'm' }
    const tasks = [...TASKS, ...VISITS_2025]
    const kept = PEOPLE.filter(personMatcher(filter))
    const back = stepped(PeopleStats, peopleStats(filter, { tasks }), -1)
    expect(yearStepper(back)).toMatchObject({ label: '2025', canNext: true })
    // every figure, 2025's month bars and table among them, as Stats over just Sam draws it
    const out = figures(back)
    expect(out).toEqual(figures(stepped(PeopleStats, peopleStats(NO_PERSON_FILTER, { people: kept, tasks }), -1)))
    // Sam's June: Mum's March and Jo and Ben's November are not his
    expect((out.monthBars as unknown[]).slice(0, 2)).toEqual([[0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0], '1 day with someone in 2025'])
    expect(out.year).toEqual([['sam', 1, '0 0 0 0 0 1 0 0 0 0 0 0']])
    // …while everyone's 2025 counts all three
    expect((figures(stepped(PeopleStats, peopleStats(NO_PERSON_FILTER, { tasks }), -1)).monthBars as unknown[])[1]).toBe('3 days with someone in 2025')
    // on twice: this year again, never next year, drawn as it first was
    const again = stepped(PeopleStats, peopleStats(filter, { tasks }), -1, 1, 1)
    expect(yearStepper(again)).toMatchObject({ label: '2026', canNext: false })
    expect(figures(again)).toEqual(figures(settled(PeopleStats, peopleStats(filter, { tasks }))))
  })

  it('counts only the places Places’ chip leaves in a past year too, and stops again at this year', () => {
    const filter: PlaceFilter = { category: 'restaurant', q: '' }
    const tasks = [...OUTINGS, ...OUTINGS_2025]
    const kept = PLACES.filter(placeMatcher(PLACES, filter))
    const back = stepped(PlacesStats, placesStats(filter, { tasks }), -1)
    expect(yearStepper(back)).toMatchObject({ label: '2025', canNext: true })
    // By kind compares the kinds, so under a kind's chip it is not drawn at all
    const out = figures(back, ['By kind'])
    expect(out).toEqual(figures(stepped(PlacesStats, placesStats(NO_PLACE_FILTER, { places: kept, tasks }), -1), ['By kind']))
    // Nopi's May and Bella Italia's December: Hyde Park's August is not a restaurant's
    expect((out.monthBars as unknown[]).slice(0, 2)).toEqual([[0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1], '2 outings in 2025'])
    expect(out.year).toEqual([['bella', 1, '0 0 0 0 0 0 0 0 0 0 0 1'], ['nopi', 1, '0 0 0 0 1 0 0 0 0 0 0 0']])
    expect((figures(stepped(PlacesStats, placesStats(NO_PLACE_FILTER, { tasks }), -1)).monthBars as unknown[])[1]).toBe('3 outings in 2025')
    const again = stepped(PlacesStats, placesStats(filter, { tasks }), -1, 1, 1)
    expect(yearStepper(again)).toMatchObject({ label: '2026', canNext: false })
    expect(figures(again)).toEqual(figures(settled(PlacesStats, placesStats(filter, { tasks }))))
  })
})

describe('the line under People → Stats’ chips', () => {
  it('names the chip and the find with how many of everyone it counts, heading the figures', () => {
    const out = html(<PeopleStats {...peopleStats({ group: 'friends', q: ' m ' })} />)
    expect(out).toContain('<p class="stats-narrowed"><span>Stats for 1 of 7 people · Friends · matching “m”</span> <button type="button" class="btn subtle">Show all</button></p>')
    // under the chips, so one pressed never moves as the line comes and goes, and over the tiles
    expect(out.indexOf('class="stats-narrowed"')).toBeGreaterThan(out.indexOf('aria-label="Which people"'))
    expect(out.indexOf('class="stats-narrowed"')).toBeLessThan(out.indexOf('class="kpi-row'))
    // the People tile says whom it counts
    expect(out).toContain('<div class="stat-label">People</div><div class="stat-value">1</div><div class="stat-sub">in Friends, matching “m”</div>')
    expect(html(<PeopleStats {...peopleStats({ group: 'all', q: 'm' })} />)).toContain('<span>Stats for 3 of 7 people · matching “m”</span>')
    expect(html(<PeopleStats {...peopleStats({ group: 'family', q: '' })} />)).toContain('<span>Stats for 3 of 7 people · Family</span>')
  })

  it('is not there with nothing narrowing, spaces alone included', () => {
    for (const filter of [NO_PERSON_FILTER, { group: 'all' as const, q: '   ' }]) {
      const out = html(<PeopleStats {...peopleStats(filter)} />)
      expect(out).not.toContain('stats-narrowed')
      expect(out).not.toContain('Show all')
      expect(out).toContain('<div class="stat-sub">on your list</div>')
    }
  })

  it('clears the find and the chip together from Show all, and then counts everyone', () => {
    const onFilter = vi.fn()
    propsOf(settled(PeopleStats, peopleStats({ group: 'friends', q: 'm' }, { onFilter })), Narrowed).onShowAll()
    expect(onFilter).toHaveBeenCalledWith(NO_PERSON_FILTER)
    const after = html(settled(HeldPeople, peopleStats({ group: 'friends', q: 'm' }), tree => propsOf(tree, Narrowed).onShowAll()))
    expect(after).not.toContain('stats-narrowed')
    expect(after).toContain('<div class="stat-label">People</div><div class="stat-value">7</div><div class="stat-sub">on your list</div>')
  })

  it('sets the list’s own chip from its chips, keeping what is typed', () => {
    const onFilter = vi.fn()
    press(settled(PeopleStats, peopleStats({ group: 'friends', q: 'm' }, { onFilter })), 'Family 3')
    expect(onFilter).toHaveBeenCalledWith({ group: 'family', q: 'm' })
  })

  it('says so when nobody matches, with Show all, and draws no figures', () => {
    const out = html(<PeopleStats {...peopleStats({ group: 'friends', q: 'zz' })} />)
    expect(out).toContain('<p class="empty"><span>Nobody matches “zz” in Friends.</span> <button type="button" class="btn subtle">Show all</button></p>')
    expect(out).not.toContain('kpi-row')
    expect(out).not.toContain('stats-narrowed')
    // the chips stay, to pick another
    expect(out).toContain('aria-label="Which people"')
    expect(html(<PeopleStats {...peopleStats({ group: 'all', q: 'zz' })} />)).toContain('<p class="empty"><span>Nobody matches “zz”.</span>')
  })
})

describe('the line under Places → Stats’ chips', () => {
  it('names the chip and the find with how many of every place it counts, heading the figures', () => {
    const out = html(<PlacesStats {...placesStats({ category: 'restaurant', q: 'nop' })} />)
    expect(out).toContain('<p class="stats-narrowed"><span>Stats for 1 of 6 places · Restaurant · matching “nop”</span> <button type="button" class="btn subtle">Show all</button></p>')
    expect(out.indexOf('class="stats-narrowed"')).toBeGreaterThan(out.indexOf('aria-label="Kind of place"'))
    expect(out.indexOf('class="stats-narrowed"')).toBeLessThan(out.indexOf('class="kpi-row'))
    expect(out).toContain('<div class="stat-label">Places</div><div class="stat-value">1</div><div class="stat-sub">saved, restaurant only, matching “nop”</div>')
    const found = html(<PlacesStats {...placesStats({ category: 'all', q: 'park' })} />)
    expect(found).toContain('<span>Stats for 3 of 6 places · matching “park”</span>')
    expect(found).toContain('<div class="stat-sub">saved, matching “park”</div>')
  })

  it('is not there with nothing narrowing, nor for a kind whose last place has gone', () => {
    for (const filter of [NO_PLACE_FILTER, { category: 'bar' as const, q: ' ' }]) {
      const out = html(<PlacesStats {...placesStats(filter)} />)
      expect(out).not.toContain('stats-narrowed')
      expect(out).toContain('<div class="stat-label">Places</div><div class="stat-value">6</div><div class="stat-sub">saved, every kind</div>')
      expect(out).toContain('<button type="button" aria-pressed="true" class="seg on">All <span class="board-count">6</span></button>')
    }
  })

  it('clears the find and the chip together from Show all, and then counts every place', () => {
    const onFilter = vi.fn()
    propsOf(settled(PlacesStats, placesStats({ category: 'restaurant', q: 'nop' }, { onFilter })), Narrowed).onShowAll()
    expect(onFilter).toHaveBeenCalledWith(NO_PLACE_FILTER)
    const after = html(settled(HeldPlaces, placesStats({ category: 'restaurant', q: 'nop' }), tree => propsOf(tree, Narrowed).onShowAll()))
    expect(after).not.toContain('stats-narrowed')
    expect(after).toContain('<div class="stat-label">Places</div><div class="stat-value">6</div>')
  })

  it('sets the list’s own chip from its chips, keeping what is typed', () => {
    const onFilter = vi.fn()
    press(settled(PlacesStats, placesStats({ category: 'restaurant', q: 'park' }, { onFilter })), 'Outdoors 1')
    expect(onFilter).toHaveBeenCalledWith({ category: 'outdoors', q: 'park' })
  })

  it('says so when nothing matches, with Show all, and draws no figures', () => {
    const out = html(<PlacesStats {...placesStats({ category: 'restaurant', q: 'zz' })} />)
    expect(out).toContain('<p class="empty"><span>Nothing matches “zz” in Restaurant.</span> <button type="button" class="btn subtle">Show all</button></p>')
    expect(out).not.toContain('kpi-row')
    expect(out).toContain('aria-label="Kind of place"')
    expect(html(<PlacesStats {...placesStats({ category: 'all', q: 'zz' })} />)).toContain('<p class="empty"><span>Nothing matches “zz”.</span>')
  })
})

describe('Show all from a keyboard', () => {
  it('goes on to the chip that is on now, All, rather than the top of the page; a tap moves nothing', () => {
    const onShowAll = vi.fn()
    const focused: string[] = []
    const chip = { focus: () => void focused.push('All') }
    const view = { querySelector: (selector: string) => (selector === '[aria-pressed="true"]' ? chip : null) }
    const shown = { closest: (selector: string) => (selector === 'p' ? { parentElement: view } : null) }
    vi.stubGlobal('window', { setTimeout: (run: () => void) => run() })
    const tap = (held: boolean) => {
      vi.stubGlobal('document', { activeElement: held ? shown : null })
      const line = elements(Narrowed({ words: 'Stats for 1 of 6 places · Restaurant', onShowAll }))
      ;(line.find(e => e.type === 'button')!.props.onClick as (e: { currentTarget: unknown }) => void)({ currentTarget: shown })
    }
    tap(false)
    expect(focused).toEqual([])
    tap(true)
    expect(focused).toEqual(['All'])
    expect(onShowAll).toHaveBeenCalledTimes(2)
  })
})

describe('the lists set what the tab holds', () => {
  it('from People’s find box and chips, each keeping the other', () => {
    const onFilter = vi.fn()
    const list = settled(People, peopleList({ group: 'friends', q: '' }, onFilter))
    typeInto(list, p => p.placeholder === 'Find a person…', 'sa')
    press(list, 'Family 3')
    expect(onFilter.mock.calls).toEqual([[{ group: 'friends', q: 'sa' }], [{ group: 'family', q: '' }]])
  })

  it('from Places’ find box and chips, each keeping the other', () => {
    const onFilter = vi.fn()
    const list = settled(Places, placesList({ category: 'restaurant', q: '' }, onFilter))
    typeInto(list, p => p.placeholder === 'Find a place…', 'park')
    press(list, 'Outdoors 1')
    expect(onFilter.mock.calls).toEqual([[{ category: 'restaurant', q: 'park' }], [{ category: 'outdoors', q: '' }]])
  })
})

type Nav = ReturnType<typeof useNavigation>
const STORE = { people: PEOPLE, places: PLACES, tasks: TASKS, meals: MEALS, events: ENTRIES, journal: [], upsert: noop, remove: noop, restore: noop }
/** The shell's context as the People tab reads it: the real navigation over the records above, with nothing else doing anything. */
const ctx = (nav: Nav, filters: ReturnType<typeof useListFilters>) =>
  ({
    ...nav,
    ...filters,
    store: STORE,
    showToast: noop,
    openTask: noop,
    newTask: noop,
    logOuting: noop,
    logVisit: noop,
    sawThem: noop,
    planAt: noop,
    planWith: noop,
    setEventEditor: noop,
    inHousehold: false,
    mineOnly: false,
    // whose log the rows count (v3.24): the tab hands it to all four views
    household: { info: null, myId: null, refresh: noop, error: undefined },
    // the lazy views, as the shell hands them to its screens
    views: lazy.SCREEN_VIEWS,
  }) as unknown as PlannerCtx
/** What the tab hands the lazy view of this type, or undefined when it draws none. */
const handed = (tree: ReactNode, type: unknown) => elements(tree).find(e => e.type === type)?.props as Record<string, any> | undefined

/**
 * The People tab in a shell of its own, over the real navigation and a
 * storage that keeps nothing. Each step runs on a render and the next render
 * shows where it left the tab, as people-stats-view.test.tsx's journey does.
 * A card opened is weighed against the filter as it arrives, which costs one
 * render more, so it is always the last step. Returns every tree the tab drew, and what the
 * render React kept put on the page: what the view it drew was handed.
 */
function onTheTab(steps: ((tree: ReactNode, nav: Nav) => void)[]) {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: noop })
  const trees: ReactNode[] = []
  function Shell() {
    const nav = useNavigation()
    // the two filters live on the shell now, not on the tab: the Stats lens
    // draws these same two Stats in its own tab, and one figure must not read
    // two ways on one device
    const filters = useListFilters({ store: STORE as unknown as Store, personOpenId: nav.personOpenId, placeOpenId: nav.placeOpenId })
    const [, tick] = useState(0)
    const tree = PeopleScreen({ p: ctx(nav, filters) })
    trees.push(tree)
    const step = steps[trees.length - 1]
    if (step) {
      step(tree, nav)
      tick(n => n + 1)
    }
    const view = handed(tree, lazy.People) ?? handed(tree, lazy.PeopleStats) ?? handed(tree, lazy.Places) ?? handed(tree, lazy.PlacesStats)
    return <output>{JSON.stringify({ filter: view?.filter, open: view?.openId ?? null })}</output>
  }
  const page = renderToString(<Shell />).replace(/&quot;/g, '"')
  return { trees, page }
}

describe('the People tab holds them for the visit', () => {
  it('keeps what People’s find box and chip hold through List → Stats → List, and over to Places and back', () => {
    const friendsSa: PersonFilter = { group: 'friends', q: 'sa' }
    const { trees } = onTheTab([
      tree => handed(tree, lazy.People)!.onFilter(friendsSa),
      (_, nav) => nav.setInnerView('people', 'stats'),
      (_, nav) => nav.setInnerView('people', 'list'),
      (_, nav) => nav.setKeepTab('places'),
      (_, nav) => nav.setKeepTab('people'),
    ])
    expect(trees).toHaveLength(6)
    expect(handed(trees[0], lazy.People)!.filter).toEqual(NO_PERSON_FILTER)
    expect(handed(trees[1], lazy.People)!.filter).toEqual(friendsSa)
    expect(handed(trees[2], lazy.PeopleStats)!.filter).toEqual(friendsSa)
    expect(handed(trees[3], lazy.People)!.filter).toEqual(friendsSa)
    // each segment its own
    expect(handed(trees[4], lazy.Places)!.filter).toEqual(NO_PLACE_FILTER)
    expect(handed(trees[5], lazy.People)!.filter).toEqual(friendsSa)
    // the list and its Stats are handed the one setter, so a chip on either is the other's
    expect(handed(trees[2], lazy.PeopleStats)!.onFilter).toBe(handed(trees[3], lazy.People)!.onFilter)
  })

  it('keeps what Places’ find box and chip hold through List → Stats → List', () => {
    const restaurantsNop: PlaceFilter = { category: 'restaurant', q: 'nop' }
    const { trees } = onTheTab([
      (_, nav) => nav.setKeepTab('places'),
      tree => handed(tree, lazy.Places)!.onFilter(restaurantsNop),
      (_, nav) => nav.setInnerView('places', 'stats'),
      (_, nav) => nav.setInnerView('places', 'list'),
    ])
    expect(handed(trees[2], lazy.Places)!.filter).toEqual(restaurantsNop)
    expect(handed(trees[3], lazy.PlacesStats)!.filter).toEqual(restaurantsNop)
    expect(handed(trees[4], lazy.Places)!.filter).toEqual(restaurantsNop)
  })

  it('clears People’s when search opens a card from Stats, before the list draws it', () => {
    const { trees, page } = onTheTab([
      tree => handed(tree, lazy.People)!.onFilter({ group: 'friends', q: 'sa' }),
      (_, nav) => nav.setInnerView('people', 'stats'),
      // a search result: Mum, whom Friends and “sa” would hide
      (_, nav) => nav.openPerson('mum'),
    ])
    expect(handed(trees[trees.length - 1], lazy.People)).toMatchObject({ filter: NO_PERSON_FILTER, openId: 'mum' })
    // the first paint: the card open, and nothing hiding it
    expect(page).toBe('<output>{"filter":{"group":"all","q":""},"open":"mum"}</output>')
  })

  it('clears Places’ when a link opens a row, and leaves People’s as it was', () => {
    const friends: PersonFilter = { group: 'friends', q: '' }
    const { trees, page } = onTheTab([
      tree => handed(tree, lazy.People)!.onFilter(friends),
      (_, nav) => nav.setKeepTab('places'),
      tree => handed(tree, lazy.Places)!.onFilter({ category: 'outdoors', q: 'park' }),
      (_, nav) => nav.openPlace('bella'),
    ])
    expect(handed(trees[trees.length - 1], lazy.Places)).toMatchObject({ filter: NO_PLACE_FILTER, openId: 'bella' })
    expect(page).toBe('<output>{"filter":{"category":"all","q":""},"open":"bella"}</output>')
    // back on People, its chip is still on
    const back = onTheTab([
      tree => handed(tree, lazy.People)!.onFilter(friends),
      (_, nav) => nav.openPlace('bella'),
      (_, nav) => nav.setKeepTab('people'),
    ])
    expect(handed(back.trees[back.trees.length - 1], lazy.People)!.filter).toEqual(friends)
  })

  it('keeps People’s when a row on Stats opens a card, as every row there is one the list shows', () => {
    const friendsSa: PersonFilter = { group: 'friends', q: 'sa' }
    const { trees, page } = onTheTab([
      tree => handed(tree, lazy.People)!.onFilter(friendsSa),
      (_, nav) => nav.setInnerView('people', 'stats'),
      // Sam from the podium, a bar or a list: Friends and “sa” leave him
      tree => handed(tree, lazy.PeopleStats)!.onOpenPerson(PEOPLE.find(x => x.id === 'sam')),
    ])
    expect(handed(trees[trees.length - 1], lazy.People)).toMatchObject({ filter: friendsSa, openId: 'sam' })
    // the first paint: the card open, under the find and the chip as they were
    expect(page).toBe('<output>{"filter":{"group":"friends","q":"sa"},"open":"sam"}</output>')
  })

  it('keeps Places’ when a row on Stats opens it', () => {
    const restaurantsNop: PlaceFilter = { category: 'restaurant', q: 'nop' }
    const { trees, page } = onTheTab([
      (_, nav) => nav.setKeepTab('places'),
      tree => handed(tree, lazy.Places)!.onFilter(restaurantsNop),
      (_, nav) => nav.setInnerView('places', 'stats'),
      // Nopi from the podium: the one place Restaurant and “nop” leave
      tree => handed(tree, lazy.PlacesStats)!.onOpenPlace(PLACES.find(x => x.id === 'nopi')),
    ])
    expect(handed(trees[trees.length - 1], lazy.Places)).toMatchObject({ filter: restaurantsNop, openId: 'nopi' })
    expect(page).toBe('<output>{"filter":{"category":"restaurant","q":"nop"},"open":"nopi"}</output>')
  })

  it('clears them for a card not in the store yet, so nothing hides it when it lands', () => {
    const { trees } = onTheTab([tree => handed(tree, lazy.People)!.onFilter({ group: 'friends', q: 'sa' }), (_, nav) => nav.openPerson('new')])
    expect(handed(trees[trees.length - 1], lazy.People)).toMatchObject({ filter: NO_PERSON_FILTER, openId: 'new' })
  })

  it('saves nothing, and drops them with the page: they are a visit, never a preference', () => {
    // They moved off PeopleScreen on 2026-09-15, when the Stats lens began
    // drawing these same two Stats in its own tab: one pair on the shell, so a
    // chip pressed on the List, on the segment's Stats or on the lens's is
    // pressed on all three, and no figure can read two ways at once.
    //
    // ONE THING CHANGED WITH THE MOVE, on purpose: they used to clear when you
    // left the People tab, because the tab's own useState went with it. On the
    // shell they last the page. That is what sharing them costs, and it is the
    // right way round — a chip is lit on screen with a "Show all" beside it,
    // so nothing is hidden by state you cannot see, and coming back to the
    // figures you were reading is what you wanted. Still saved nowhere: a
    // reload starts over.
    const held = source('components/planner/useListFilters.ts')
    expect(held).not.toMatch(/localStorage|sessionStorage/)
    expect(held).toContain('useState<PersonFilter>(NO_PERSON_FILTER)')
    expect(held).toContain('useState<PlaceFilter>(NO_PLACE_FILTER)')
    // the tab reads them rather than holding them, and holds none of its own
    const screen = source('components/planner/PeopleScreen.tsx')
    expect(screen).not.toMatch(/useState/)
    expect(screen).toContain('const { peopleFilter, setPeopleFilter, placeFilter, setPlaceFilter } = p')
    expect(plannerSource()).toContain("{view === 'keep' && <KeepScreen p={p} />}")
    // …and the shell builds them once, for every tab that draws a filtered figure
    expect(plannerSource()).toContain('const listFilters = useListFilters({ store, personOpenId: nav.personOpenId, placeOpenId: nav.placeOpenId })')
  })
})

describe('the line’s styles', () => {
  const css = sheetSource()
  const found = [...css.matchAll(/\.stats-narrowed[^{]*\{[^}]*\}/g)].map(m => m[0])
  const rules = found.join('\n')
  /** What the line's rule for exactly `selector` sets `prop` to. */
  const set = (selector: string, prop: string) => new RegExp(`[{;\\s]${prop}: ([^;]+);`).exec(found.find(r => r.startsWith(`${selector} {`)) ?? '')?.[1]

  it('wraps at 375pt, breaks a long find anywhere, and keeps Show all whole', () => {
    expect(rules).toMatch(/\.stats-narrowed \{[^}]*flex-wrap: wrap/)
    expect(rules).toMatch(/\.stats-narrowed > span \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere/)
    expect(rules).toMatch(/\.stats-narrowed > \.btn \{[^}]*flex: none/)
  })

  it('marks Show all as the way out, as .mine-note does: the accent’s text at 600, and a hover off the line’s own ground', () => {
    expect(set('.stats-narrowed > .btn', 'color')).toBe('var(--accent-text)')
    expect(set('.stats-narrowed', 'color')).toBe('var(--text-2)')
    expect(set('.stats-narrowed > .btn', 'font-weight')).toBe('600')
    expect(set('.stats-narrowed > .btn:hover', 'background')).toBe('var(--surface)')
    expect(set('.stats-narrowed', 'background')).toBe('var(--surface-2)')
    // .btn.subtle's are just as specific, so these win by coming after them
    expect(css.indexOf('.stats-narrowed > .btn {')).toBeGreaterThan(css.indexOf('.btn.subtle {'))
    expect(css.indexOf('.stats-narrowed > .btn:hover {')).toBeGreaterThan(css.indexOf('.btn.subtle:hover {'))
  })

  it('colours with tokens alone, each defined for light and dark', () => {
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
    const tokens = [...rules.matchAll(/var\((--[\w-]+)\)/g)].map(m => m[1])
    expect(tokens).toEqual(expect.arrayContaining(['--surface-2', '--text-2', '--accent-text', '--surface']))
    const base = source('styles/01-base.css')
    const darkAt = base.indexOf(":root[data-theme='dark'] {")
    const light = base.slice(0, darkAt)
    const dark = base.slice(darkAt, base.indexOf('\n}', darkAt))
    for (const t of new Set(tokens.filter(t => t !== '--radius-sm'))) {
      expect(light, t).toContain(`${t}:`)
      expect(dark, t).toContain(`${t}:`)
    }
  })
})
