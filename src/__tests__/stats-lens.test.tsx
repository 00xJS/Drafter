import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StatsLens } from '../components/StatsLens'
import { StatsScreen } from '../components/planner/StatsScreen'
import { StatsLens as LensChunk } from '../components/planner/lazy'
import { STATS_AREAS, VIEWS, VIEW_LABELS, VIEW_TO_STATS, statsTabOfView, type StatsTab } from '../components/planner/routes'
import { Highlights } from '../components/insights/Highlights'
import { AreaCard, HeatGrid, RankedBars, Ring, Segmented, StatTile, WindowSwitch, heatDays } from '../components/stats'
import type { DayWindow } from '../stats'
import { KitchenStats, PeopleStats, PlacesStats, WardrobeStats } from '../components/planner/lazy'
import { NO_PERSON_FILTER } from '../people'
import { NO_PLACE_FILTER } from '../places'
import { wardrobeCosts, wearIndex } from '../wardrobe'
import { doneByPriority, doneByTag, doneDays, habitReport, journalReport, moneyReport, taskReport } from '../lensstats'
import { dateKey } from '../utils'
import type { Garment, Habit, JournalEntry, Meal, Person, Place, Task, Wear } from '../types'
import { elements, press, settled, textOf } from './rendered'
import { sheetSource } from './source'

/*
 * The Stats lens: the sixth tab. What it counts (src/lensstats.ts), what it
 * draws, and the two rules that keep it honest —
 *
 *  - it never re-counts an area that counts itself. People, Places, Kitchen and
 *    the Wardrobe each count what their own list's find box and chips leave, so
 *    the lens links to them instead of printing a second, different number;
 *  - it never quotes the journal. The journal segment is counts and moods.
 */

const STAMP = '2026-01-01T00:00:00.000Z'
/** Tuesday 15 September 2026, in the evening. */
const NOW = new Date(2026, 8, 15, 18, 0)

const task = (id: string, over: Partial<Task> = {}): Task => ({
  kind: 'task',
  id,
  title: id,
  description: '',
  status: 'todo',
  priority: 'normal',
  tags: [],
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
})
/** A task finished on a local day, at midday so no zone moves it. */
const done = (id: string, day: string, over: Partial<Task> = {}) => task(id, { status: 'done', completedAt: `${day}T12:00:00`, ...over })
const habit = (id: string, days: string[], over: Partial<Habit> = {}): Habit => ({ kind: 'habit', id, name: id, done: days, createdAt: STAMP, updatedAt: STAMP, ...over })
const entry = (day: string, over: Partial<JournalEntry> = {}): JournalEntry => ({ kind: 'journal', id: `journal~${day}~x`, date: day, body: 'a b c', createdAt: STAMP, updatedAt: STAMP, ...over })
const garment = (id: string, over: Partial<Garment> = {}): Garment => ({ kind: 'garment', id, name: id, type: 'top', createdAt: STAMP, updatedAt: STAMP, ...over })
const wear = (day: string, ids: string[], over: Partial<Wear> = {}): Wear => ({ kind: 'wear', id: `wear~${day}~x`, date: day, garmentIds: ids, createdAt: STAMP, updatedAt: STAMP, ...over })

describe('what the lens counts: finished work', () => {
  const TASKS = [
    done('a', '2026-09-15', { tags: ['home'], priority: 'high' }),
    done('b', '2026-09-15', { tags: ['home', 'money'] }),
    done('c', '2026-09-14', { tags: ['money'], priority: 'urgent' }),
    done('old', '2026-05-01', { tags: ['home'] }),
    task('open1', { dueAt: '2026-09-01T12:00:00' }),
    task('open2', { status: 'doing', dueAt: '2026-06-01T12:00:00' }),
    task('open3', { status: 'wishlist' }),
    task('gone', { status: 'done', completedAt: '2026-09-15T12:00:00', deletedAt: STAMP }),
  ]

  it('counts a finished task in the window it was finished in, never the one it was made in', () => {
    expect(taskReport(TASKS, 30, NOW).done).toBe(3)
    expect(taskReport(TASKS, 'all', NOW).done).toBe(4)
    // a task in Trash is finished by nobody
    expect(doneDays(TASKS)).toEqual(['2026-09-15', '2026-09-14', '2026-05-01'])
  })

  it('counts two tasks on one day as one day, and lets today wait rather than break the run', () => {
    const r = taskReport(TASKS, 30, NOW)
    expect(r.days).toEqual(['2026-09-15', '2026-09-14'])
    expect(r.streaks).toMatchObject({ current: 2, best: 2, today: true })
    // nothing done today: the run still stands, and asks for today
    const yesterdayOnly = taskReport([done('c', '2026-09-14')], 30, NOW)
    expect(yesterdayOnly.streaks).toMatchObject({ current: 1, today: false })
  })

  it('leaves what is open open, whatever window is chosen', () => {
    for (const w of [30, 365, 'all'] as const) {
      const r = taskReport(TASKS, w, NOW)
      // wishlist is not open work: it is a list of maybes
      expect(r.open).toBe(2)
      expect(r.overdue).toBe(2)
      expect(r.byStatus.map(s => [s.key, s.count])).toEqual([
        ['todo', 1],
        ['doing', 1],
      ])
    }
  })

  it('ages an overdue task by how long it has waited, and leaves an empty bucket out', () => {
    const r = taskReport(TASKS, 30, NOW)
    // open1 is a fortnight past its date, open2 three and a half months
    expect(r.aging.map(b => [b.key, b.count])).toEqual([
      ['month', 1],
      ['older', 1],
    ])
    expect(r.aging.find(b => b.key === 'week')).toBeUndefined()
    expect(r.aging.find(b => b.key === 'quarter')).toBeUndefined()
  })

  it('files finished work on the weekday it was finished, Sunday first', () => {
    // 2026-09-15 is a Tuesday, 2026-09-14 a Monday
    expect(taskReport(TASKS, 30, NOW).weekday).toEqual([0, 1, 2, 0, 0, 0, 0])
  })

  it('counts a task once per tag it carried, and not at all without one', () => {
    expect(doneByTag(TASKS, 30, NOW).map(r => [r.key, r.count])).toEqual([
      ['home', 2],
      ['money', 2],
    ])
    expect(doneByTag([done('x', '2026-09-15')], 30, NOW)).toEqual([])
  })

  it('ranks priorities urgent first and leaves out one nobody finished', () => {
    expect(doneByPriority(TASKS, 30, NOW).map(r => [r.key, r.count])).toEqual([
      ['urgent', 1],
      ['high', 1],
      ['normal', 1],
    ])
  })
})

describe('the figures an adversarial review found wrong', () => {
  /*
   * Eight numbers the lens printed that no other surface agreed with. Each was
   * green under the whole suite, because a figure nobody pins is a figure
   * nobody checks. These pin them.
   */

  it('calls a task due TODAY due today, as Home, the digest and get_overview do', () => {
    // an untimed task's 00:00 is a day, not a deadline (dueTone's own words)
    const at10am = new Date(2026, 8, 15, 10, 0)
    const r = taskReport(
      [
        task('untimed-today', { dueAt: '2026-09-15T00:00:00' }),
        task('timed-this-morning', { dueAt: '2026-09-15T09:00:00' }),
        task('tomorrow', { dueAt: '2026-09-16T00:00:00' }),
        task('yesterday', { dueAt: '2026-09-14T09:00:00' }),
      ],
      30,
      at10am,
    )
    // only yesterday's. Flooring milliseconds instead made it 3 of the 4.
    expect(r.overdue).toBe(1)
    expect(r.aging.map(b => [b.key, b.count])).toEqual([['week', 1]])
  })

  it('does not count a logged visit as work finished', () => {
    // shared/review.mts has drawn this line since the review shipped: the Done
    // tile, the weekly sparkline and the review all leave visits out
    const tasks = [done('chore', '2026-09-15', { tags: ['home'] }), done('saw-mum', '2026-09-15', { title: 'Saw Mum', tags: ['visit'], peopleIds: ['mum'] })]
    expect(taskReport(tasks, 30, NOW).done).toBe(1)
    expect(doneDays(tasks)).toEqual(['2026-09-15'])
    expect(doneByTag(tasks, 30, NOW).map(r => r.key)).toEqual(['home'])
    expect(doneByPriority(tasks, 30, NOW).map(r => r.count)).toEqual([1])
  })

  it('rounds the year once, from the real amounts, not by adding up rounded months', () => {
    // Two half-dollars in different months. Each month's own bar rounds to $11
    // — that is what a bar labelled $11 should say — but the YEAR is $21, and
    // adding the rounded months gave $22, a dollar the person never spent.
    const halves = [done('a', '2026-03-01', { title: 'A', actualCost: 10.5 }), done('b', '2026-04-01', { title: 'B', actualCost: 10.5 })]
    const m = moneyReport(halves, 2026, NOW)
    expect(m.spent).toBe(21)
    expect(m.months[2]).toBe(11)
    expect(m.months[3]).toBe(11)
    expect(m.spent).not.toBe(m.months.reduce((a, b) => a + b, 0))
  })

  it('owes a habit nothing before it existed, and walks a whole year of clean days', () => {
    const born = '2026-09-14T12:00:00.000Z'
    const fresh: Habit = { kind: 'habit', id: 'new', name: 'new', done: ['2026-09-15', '2026-09-14'], createdAt: born, updatedAt: born }
    const old = habit('old', ['2026-09-15', '2026-09-14', '2026-09-13', '2026-09-12'])
    // adding a habit yesterday must not wipe the clean days behind it…
    const r = habitReport([old, fresh], 30, NOW)
    expect(r.cleanDays).toContain('2026-09-13')
    expect(r.cleanDays).toContain('2026-09-12')
    // …and the run is walked over a year, not the chosen window, because the
    // grid drawing it is a year wide and a best run must not be cut at its edge
    const longAgo = habit('long', [dateKey(new Date(2026, 2, 1)), dateKey(new Date(2026, 2, 2)), dateKey(new Date(2026, 2, 3))])
    expect(habitReport([longAgo], 30, NOW).cleanDays.length).toBe(3)
    expect(habitReport([longAgo], 30, NOW).streaks.best).toBe(3)
  })
})

describe('what the lens counts: money', () => {
  const BILLS: Task[] = [
    done('e1', '2026-03-04', { actualCost: 100, bill: { kind: 'bill', payee: 'Electric' } }),
    done('e2', '2026-04-04', { actualCost: 120, bill: { kind: 'bill', payee: 'Electric' } }),
    done('card', '2026-04-10', { actualCost: 300, bill: { kind: 'card', payee: 'Amex' } }),
    done('odd', '2026-05-02', { title: 'New tyres', actualCost: 450 }),
    done('free', '2026-05-03', { actualCost: 0 }),
    done('lastyear', '2025-04-04', { actualCost: 999, bill: { kind: 'bill', payee: 'Electric' } }),
    task('unpaid', { estimateCost: 70, bill: { kind: 'subscription', payee: 'Internet' } }),
  ]

  it('adds amounts rather than counting rows, in the year they were paid', () => {
    const m = moneyReport(BILLS, 2026, NOW)
    expect(m.spent).toBe(970)
    expect(m.months[2]).toBe(100)
    expect(m.months[3]).toBe(420)
    expect(m.months[4]).toBe(450)
    // last year's is last year's
    expect(moneyReport(BILLS, 2025, NOW).spent).toBe(999)
  })

  it('names who was paid, a task with no bill by its own title, and leaves a zero out', () => {
    expect(moneyReport(BILLS, 2026, NOW).byPayee.map(r => [r.name, r.count])).toEqual([
      ['New tyres', 450],
      ['Amex', 300],
      ['Electric', 220],
    ])
  })

  it('groups only the repeating payments by kind', () => {
    expect(moneyReport(BILLS, 2026, NOW).byKind.map(r => [r.key, r.count])).toEqual([
      ['card', 300],
      ['bill', 220],
    ])
  })

  it('counts as still to pay only a bill somebody is going to pay', () => {
    const m = moneyReport(BILLS, 2026, NOW)
    expect(m.dueNow).toBe(1)
    expect(m.dueNowTotal).toBe(70)
    // `status !== 'done'` also took in these three, and none of them is money owed
    const notOwed = [
      task('cancelled', { status: 'canceled', estimateCost: 500, bill: { kind: 'bill', payee: 'Gone' } }),
      task('maybe', { status: 'wishlist', estimateCost: 500, bill: { kind: 'bill', payee: 'Someday' } }),
      task('binned', { status: 'todo', deletedAt: STAMP, estimateCost: 500, bill: { kind: 'bill', payee: 'Trash' } }),
    ]
    const withNoise = moneyReport([...BILLS, ...notOwed], 2026, NOW)
    expect(withNoise.dueNow).toBe(1)
    expect(withNoise.dueNowTotal).toBe(70)
  })

  it('reads cost per wear from the wardrobe\u2019s own rule, so the two cannot disagree', () => {
    // The lens once counted every LOOK a priced piece was in; the wardrobe
    // counts the DAYS it was worn (wearIndex). Two looks on one day made the
    // lens's figure cheaper than the Wardrobe's for the same clothes, which is
    // the one thing a second copy of a rule always ends up doing.
    const clothes = [garment('tee', { price: 30 }), garment('hat', { price: 10, type: 'accessory' }), garment('free')]
    const worn = [
      wear('2026-09-15', ['tee', 'free']),
      // an evening change: a second look on a day already counted
      { ...wear('2026-09-15', ['tee', 'hat']), id: 'wear~2026-09-15~b' },
      wear('2026-09-14', ['tee', 'hat']),
      // a plan is not a wear until it is confirmed
      wear('2026-09-13', ['tee'], { planned: true }),
    ]
    const ix = wearIndex(worn, '2026-09-15')
    const c = wardrobeCosts(clothes, ix)
    expect(c.spent).toBe(40)
    expect(c.rows).toHaveLength(2)
    // tee on 2 DAYS (not 3 looks) and hat on 2: $40 over 4 day-wears
    expect(c.wears).toBe(4)
    expect(c.perWear).toBeCloseTo(10)
    expect(wardrobeCosts(clothes, wearIndex([], '2026-09-15')).perWear).toBeUndefined()
  })
})

describe('what the lens counts: habits', () => {
  // every day for the four days to 15 Sep, and one gap on the 12th
  const walk = habit('walk', ['2026-09-15', '2026-09-14', '2026-09-13', '2026-09-11'])
  const read = habit('read', ['2026-09-15', '2026-09-14', '2026-09-12'])

  it('counts a day nobody was due as neither kept nor missed', () => {
    // a weekend-only habit is owed nothing on a Tuesday
    const weekend = habit('weekend', [], { days: [0, 6] })
    const r = habitReport([weekend], 30, NOW)
    const row = r.rows.find(x => x.habit.id === 'weekend')
    expect(row?.due).toBeGreaterThan(0)
    expect(row?.due).toBeLessThan(10)
  })

  it('calls a day clean only when everything due that day was kept', () => {
    const r = habitReport([walk, read], 30, NOW)
    expect(r.cleanDays.slice(0, 2)).toEqual(['2026-09-15', '2026-09-14'])
    expect(r.cleanDays).not.toContain('2026-09-13')
    expect(r.cleanDays).not.toContain('2026-09-12')
    expect(r.streaks).toMatchObject({ current: 2, today: true })
  })

  it('leaves an archived habit out: it is history, not something you are keeping', () => {
    expect(habitReport([habit('gone', ['2026-09-15'], { archivedAt: STAMP })], 30, NOW).rows).toEqual([])
    expect(habitReport([habit('binned', ['2026-09-15'], { deletedAt: STAMP })], 30, NOW).rows).toEqual([])
  })

  it('orders the rows by how well they went', () => {
    const r = habitReport([read, walk], 30, NOW)
    expect(r.rows[0].habit.id).toBe('walk')
    expect(r.rows[0].pct).toBeGreaterThanOrEqual(r.rows[1].pct)
  })
})

describe('what the lens counts: the journal', () => {
  const ENTRIES = [entry('2026-09-15', { mood: 5 }), entry('2026-09-14', { mood: 3 }), entry('2026-09-13'), entry('2026-04-02', { mood: 1 }), entry('2026-09-10', { deletedAt: STAMP })]

  it('counts days and moods, and never a word of what was written', () => {
    const r = journalReport(ENTRIES, 30, 2026, NOW)
    expect(r.entries).toBe(3)
    expect(r.mood).toBeCloseTo(4)
    expect(r.moodCounts).toEqual([0, 0, 1, 0, 1])
    expect(r.streaks).toMatchObject({ current: 3, today: true })
    // three words each, three entries in the window
    expect(r.words).toBe(9)
  })

  it('counts a deleted entry nowhere, and the whole year in the months', () => {
    const r = journalReport(ENTRIES, 30, 2026, NOW)
    expect(r.total).toBe(4)
    expect(r.months[3]).toBe(1)
    expect(r.months[8]).toBe(3)
  })

  it('says nothing about mood when no entry carried one', () => {
    expect(journalReport([entry('2026-09-15')], 30, 2026, NOW).mood).toBeNull()
  })
})

// ---- the view ---------------------------------------------------------------------

const html = (node: ReactNode) => renderToStaticMarkup(node as ReactElement).replace(/<!-- -->/g, '')

/** What the four in-area Stats are handed. Inert here: these tests are about the lens, not about those views. */
const AREAS = {
  peopleFilter: NO_PERSON_FILTER,
  onPeopleFilter: () => {},
  placeFilter: NO_PLACE_FILTER,
  onPlaceFilter: () => {},
  mineOnCalendar: false,
  onOpenPerson: () => {},
  onOpenPlace: () => {},
  onOpenDay: () => {},
  onSaw: () => {},
  onPlanAt: () => {},
  onOpenRecipe: () => {},
  onGoMealDay: () => {},
  onOpenPiece: () => {},
  onRetirePiece: () => {},
  onSaveOutfit: () => {},
  onGoWearDay: () => {},
  byId: new Map<string, Garment>(),
  wearIx: wearIndex([], '2026-09-15'),
}

const LENS_PROPS = {
  tab: 'highlights' as StatsTab,
  onOpen: () => {},
  tasks: [done('a', '2026-09-15', { tags: ['home'] }), task('open', { dueAt: '2026-09-01T12:00:00' })],
  people: [],
  places: [],
  events: [],
  meals: [],
  recipes: [],
  groceries: [],
  journal: [entry('2026-09-15', { mood: 4 })],
  habits: [habit('walk', ['2026-09-15'])],
  garments: [garment('tee', { price: 30 })],
  outfits: [],
  wears: [wear('2026-09-15', ['tee'])],
  onTasks: () => {},
  areas: AREAS,
  now: NOW,
}

/** Every page Insights → Stats can show: the Highlights, each area's figures, and the year. */
const PAGES: StatsTab[] = ['highlights', ...STATS_AREAS.map(a => a.key), 'year']

describe('the lens drawn', () => {
  it('draws every page on the server, with nothing to count and with something', () => {
    const empty = { ...LENS_PROPS, tasks: [], journal: [], habits: [], garments: [], wears: [] }
    for (const tab of PAGES) {
      expect(() => html(<StatsLens {...LENS_PROPS} tab={tab} />), tab).not.toThrow()
      expect(() => html(<StatsLens {...empty} tab={tab} />), tab).not.toThrow()
    }
  })

  it('opens on the Highlights, with a chip for every area and the year one tap away', () => {
    const went: string[] = []
    const tree = into(settled(StatsLens, { ...LENS_PROPS, onOpen: (t: string) => went.push(t) }), 'Highlights')
    // no nine-segment track any more: the period and a chip per area
    const chips = elements(tree).filter(e => e.type === 'button' && String(e.props.className).includes('area-chip'))
    expect(chips.map(c => textOf(c.props.children))).toEqual(['Tasks', 'Money', 'People', 'Places', 'Kitchen', 'Wardrobe', 'Habits', 'Journal'])
    for (const chip of chips) (chip.props.onClick as () => void)()
    // one chip per area, in the order shared/insights.mts ranks a tie by, and not one of them is a jump to another tab
    expect(went).toEqual(STATS_AREAS.map(a => a.key))
    const year = elements(tree).find(e => e.type === AreaCard && e.props.name === 'This year')!
    ;(year.props.onOpen as () => void)()
    expect(went.at(-1)).toBe('year')
    // the period is a track of three, and the only one
    const tracks = elements(tree).filter(e => e.type === Segmented)
    expect(tracks.map(t => t.props.label)).toEqual(['Period'])
    expect((tracks[0].props.items as { key: string }[]).map(i => i.key)).toEqual(['week', 'month', 'year'])
  })

  it('offers no switch of whose log, in a household or alone, and hands the Highlights the viewer', () => {
    const highlights = (over: Record<string, unknown>) => elements(settled(StatsLens, { ...LENS_PROPS, myId: 'me', ...over })).find(e => e.type === Highlights)!.props as { household: boolean; input: Record<string, unknown> }
    expect(highlights({ household: true })).toMatchObject({ household: true, input: { myId: 'me' } })
    expect(highlights({ household: false })).toMatchObject({ household: false, input: { myId: 'me' } })
    // one view: there is no whose log to hand down
    expect(highlights({ household: true }).input).not.toHaveProperty('whose')
    const tracks = (over: Record<string, unknown>) => elements(into(settled(StatsLens, { ...LENS_PROPS, myId: 'me', ...over }), 'Highlights')).filter(e => e.type === Segmented).map(t => t.props.label)
    expect(tracks({ household: true })).toEqual(['Period'])
    expect(tracks({ household: false })).toEqual(['Period'])
  })

  it('says what counts whose in one quiet line, only in a household, and wears no badge on any page', () => {
    const line = /Tasks, money and meals count the household; people, places, your journal, habits and clothes are yours\./
    const household = html(<StatsLens {...LENS_PROPS} myId="me" household />)
    expect(household).toMatch(line)
    // the look of a field's hint: no badge, and nothing louder
    expect(household).toContain('<p class="field-hint insights-scope">')
    expect(html(<StatsLens {...LENS_PROPS} myId="me" household={false} />)).not.toMatch(line)
    for (const tab of PAGES) {
      const out = html(<StatsLens {...LENS_PROPS} tab={tab} myId="me" household />)
      expect(out, tab).not.toMatch(/Both of us|Just you|whose-badge|whose-note/)
    }
  })

  it('says the household finished the household’s work, in a household, and you alone', () => {
    const tasks = html(<StatsLens {...LENS_PROPS} tab="tasks" myId="me" household />)
    expect(tasks).toContain('What the household finished in 2026')
    expect(tasks).toContain('Every day the household finished something')
    expect(tasks).toContain('Finished work, as it was marked when it was ticked')
    expect(tasks).not.toMatch(/you finished|you ticked/)
    expect(html(<StatsLens {...LENS_PROPS} tab="year" myId="me" household />)).toContain('Every day the household finished something. A column is a week')
    // alone, it is yours
    const alone = html(<StatsLens {...LENS_PROPS} tab="tasks" myId="me" household={false} />)
    expect(alone).toContain('What you finished in 2026')
    expect(alone).toContain('Every day you finished something')
    expect(alone).toContain('Finished work, as it was marked when you ticked it')
    expect(html(<StatsLens {...LENS_PROPS} tab="year" myId="me" />)).toContain('Every day you finished something. A column is a week')
  })

  it('never leaves the tab: every card on the year opens a page of this one', () => {
    const went: string[] = []
    const tree = into(settled(StatsLens, { ...LENS_PROPS, tab: 'year' as const, onOpen: (t: string) => went.push(t) }), 'YearLens')
    const cards = elements(tree).filter(e => e.type === AreaCard)
    expect(cards.map(c => c.props.name)).toEqual(['Tasks', 'Money', 'People', 'Places', 'Kitchen', 'Wardrobe', 'Habits', 'Journal'])
    for (const card of cards) (card.props.onOpen as () => void)()
    // one card per area, in the chips' own order, and not one of them is a jump to another tab
    expect(went).toEqual(STATS_AREAS.map(a => a.key))
  })

  it('draws each area\u2019s own Stats component in the tab, rather than a second version of it', () => {
    const drawn: [StatsTab, unknown, string | null][] = [
      ['people', PeopleStats, 'AreaPeople'],
      ['places', PlacesStats, 'AreaPlaces'],
      ['kitchen', KitchenStats, null],
      ['wardrobe', WardrobeStats, null],
    ]
    for (const [tab, Component, wrapper] of drawn) {
      const tree = settled(StatsLens, { ...LENS_PROPS, tab })
      expect(
        elements(wrapper ? into(tree, wrapper) : tree).some(e => e.type === Component),
        tab,
      ).toBe(true)
    }
  })

  it('hands People and Places the lists\u2019 own find box and chips, so one figure cannot read two ways', () => {
    const filter = { group: 'family' as const, q: 'mu' }
    const tree = into(settled(StatsLens, { ...LENS_PROPS, tab: 'people' as const, areas: { ...AREAS, peopleFilter: filter } }), 'AreaPeople')
    const view = elements(tree).find(e => e.type === PeopleStats)!
    expect(view.props.filter).toBe(filter)
    expect(view.props.onFilter).toBe(AREAS.onPeopleFilter)
    // …and the unnarrowed task list, as the People tab's own Stats are given
    expect(view.props.tasks).toBe(LENS_PROPS.tasks)
  })

  it('hands People and Places whose log it is, so a housemate’s visits are never counted as yours', () => {
    for (const [tab, Component, wrapper] of [['people', PeopleStats, 'AreaPeople'], ['places', PlacesStats, 'AreaPlaces']] as const) {
      const view = (over: Record<string, unknown>) => elements(into(settled(StatsLens, { ...LENS_PROPS, tab, myId: 'me', ...over }), wrapper)).find(e => e.type === Component)!
      expect(view({}).props.myId, tab).toBe('me')
      // in a household too: who you saw and where you went are your own log,
      // so a person's page here is the same as Keep → People's
      expect(view({ household: true }).props.myId, tab).toBe('me')
    }
  })

  it('counts a day you saw someone, not a day you finished a chore', () => {
    // seenTasks is a HAYSTACK — every task, plus past events with people on
    // them — which People narrows per person. Mapping it raw made "Days seen"
    // equal the Finished tile's day count, and counted tasks in Trash too.
    const props = {
      ...LENS_PROPS,
      people: [{ kind: 'person', id: 'mum', name: 'Mum', color: '#f472b6', group: 'family', createdAt: STAMP, updatedAt: STAMP } as Person],
      // (the screen hands over store.tasks, which already drops tombstones)
      tasks: [done('bins', '2026-09-15', { title: 'Take the bins out' }), done('lunch', '2026-09-13', { title: 'Lunch with Mum', peopleIds: ['mum'] })],
    }
    const tree = into(settled(StatsLens, { ...props, tab: 'year' as const }), 'YearLens')
    const tile = elements(tree).find(e => e.type === StatTile && e.props.label === 'Days seen')!
    // one day: the lunch. Not the bins, and not the one in Trash.
    expect(tile.props.value).toBe('1')
    const card = elements(tree).filter(e => e.type === AreaCard).find(c => c.props.name === 'People')!
    expect(card.props.value).toBe('1 day')
  })

  it('counts a place you have been to by the app\u2019s one rule, meals eaten out included', () => {
    const places: Place[] = [
      { kind: 'place' as const, id: 'cafe', name: 'Caf\u00e9', color: '#a3e635', category: 'cafe' as const, createdAt: STAMP, updatedAt: STAMP },
      { kind: 'place' as const, id: 'bar', name: 'Bar', color: '#38bdf8', category: 'bar' as const, createdAt: STAMP, updatedAt: STAMP },
      { kind: 'place' as const, id: 'gone', name: 'Gone', color: '#f87171', category: 'bar' as const, createdAt: STAMP, updatedAt: STAMP, deletedAt: STAMP },
    ]
    const props = {
      ...LENS_PROPS,
      places,
      // a done task at the caf\u00e9, a meal eaten out at the bar, and a done task
      // at a place since deleted
      tasks: [done('coffee', '2026-09-15', { placeId: 'cafe' }), done('old', '2026-09-10', { placeId: 'gone' })],
      meals: [{ kind: 'meal', id: 'm1', date: '2026-09-12', slot: 'dinner', title: 'Bar', out: true, placeId: 'bar', createdAt: STAMP } as Meal],
    }
    const tree = into(settled(StatsLens, { ...props, tab: 'year' as const }), 'YearLens')
    const card = elements(tree).filter(e => e.type === AreaCard).find(c => c.props.name === 'Places')!
    // the caf\u00e9 and the bar. The meal counts (outingsAt says so); the deleted
    // place does not, or the ring would read more than its own total.
    expect(card.props.value).toBe('2 places')
    // the ring is handed to the card as `aside`, so it is not in its children
    const ring = elements(card.props.aside as ReactNode).find(e => e.type === Ring)!
    expect([ring.props.value, ring.props.of]).toEqual([2, 2])
  })

  it('counts the places YOU have been to, as Places \u2192 Stats does: the other member going is not you going', () => {
    const cafe = { kind: 'place' as const, id: 'cafe', name: 'Caf\u00e9', color: '#a3e635', category: 'cafe' as const, createdAt: STAMP, updatedAt: STAMP }
    const props = { ...LENS_PROPS, places: [cafe], tasks: [done('hers', '2026-09-15', { placeId: 'cafe', ownerId: 'maria' })] }
    const visited = (myId: string, over: Record<string, unknown> = {}) =>
      elements(into(settled(StatsLens, { ...props, tab: 'year' as const, myId, ...over }), 'YearLens')).filter(e => e.type === AreaCard).find(c => c.props.name === 'Places')!.props.value
    expect(visited('maria')).toBe('1 place')
    expect(visited('joe')).toBe('0 places')
    // in a household as well: her outing is hers
    expect(visited('joe', { household: true })).toBe('0 places')
  })

  it('finishes the heading\u2019s sentence on every window, including All', () => {
    // the headings read "The last {spanWords}", and 'All' lowercased gave the
    // non-phrase "The last all"
    const heads = (w: DayWindow) => {
      const tree = settled(StatsLens, { ...LENS_PROPS, tab: 'year' as const }, t => {
        const sw = elements(t).find(e => e.type === WindowSwitch)!
        ;(sw.props.onChange as (x: DayWindow) => void)(w)
      })
      return elements(into(tree, 'YearLens'))
        .filter(e => e.type === 'h2')
        .map(h => textOf(h.props.children))
    }
    expect(heads(30)).toContain('The last 30 days')
    expect(heads(365)).toContain('The last 12 months')
    expect(heads('all')).toContain('The last all time')
    expect(heads('all')).not.toContain('The last all')
  })

  it('never puts a word of the journal on the page', () => {
    const secret = 'the thing I only wrote down'
    const props = { ...LENS_PROPS, tab: 'journal' as const, journal: [entry('2026-09-15', { mood: 4, body: secret })] }
    const out = html(<StatsLens {...props} />)
    expect(out).not.toContain(secret)
    expect(out).toContain('nothing you wrote is shown here')
  })

  it('shows the window switch only where it governs something', () => {
    const windowed = (tab: StatsTab) => elements(settled(StatsLens, { ...LENS_PROPS, tab })).some(e => e.type === WindowSwitch)
    // the lens's own counting reads it…
    for (const tab of ['year', 'tasks', 'habits', 'journal'] as StatsTab[]) expect(windowed(tab), tab).toBe(true)
    // …Money is counted by a year on its own stepper, the four area views
    // bring their own switches inside their cards, and the Highlights have
    // their Week · Month · Year, so a page-level one there would sit doing nothing
    for (const tab of ['highlights', 'money', 'people', 'places', 'kitchen', 'wardrobe'] as StatsTab[]) expect(windowed(tab), tab).toBe(false)
  })

  it('asks the page one question at a time: a ranked card in the lens follows the window rather than keeping its own', () => {
    const tree = into(settled(StatsLens, { ...LENS_PROPS, tab: 'tasks' as const }), 'TasksLens')
    const ranked = elements(tree).filter(e => e.type === RankedBars)
    expect(ranked).toHaveLength(2)
    for (const card of ranked) expect(card.props.window).toBe(30)
    // …and an area's own Stats keeps its switch: the prop is absent there
    expect(readSource('components/kitchen/KitchenStats.tsx')).not.toContain('window={')
  })

  it('counts by one window across a page, held by the lens rather than by any one card', () => {
    // the window lives on the lens, not inside a page's section, and every
    // part of the page reads that one
    const src = readSource('components/StatsLens.tsx')
    expect(src).toMatch(/const \[span, setSpan\] = useState<DayWindow>\(tab === 'year' \? 365 : 30\)/)
    expect(src.indexOf('const [span')).toBeLessThan(src.indexOf('function YearLens'))
  })
})

describe('the kit the lens introduced', () => {
  it('lays a year of days out in whole Sunday-aligned weeks, ending on the week today is in', () => {
    const days = heatDays(NOW, 53)
    expect(days).toHaveLength(53 * 7)
    // 2026-09-15 is a Tuesday, so its week began on Sunday the 13th
    expect(days[days.length - 7]).toBe('2026-09-13')
    expect(days).toContain('2026-09-15')
    // …and the week runs past today rather than stopping mid-column
    expect(days[days.length - 1]).toBe('2026-09-19')
  })

  it('draws a day still to come as neither empty nor lit', () => {
    const out = html(<HeatGrid counts={new Map([['2026-09-15', 2]])} end={NOW} weeks={2} label="Days" />)
    expect(out).toContain('heat-cell ahead')
    expect(out).toContain('heat-cell today')
    // the lit day carries its count in words for a pointer
    expect(out).toContain('2026-09-15: 2 days')
  })

  it('draws a ring as an arc of its share, and no arc at all for nothing', () => {
    expect(html(<Ring value={3} of={4} label="75%" />)).toContain('ring-arc')
    expect(html(<Ring value={0} of={4} label="0%" />)).not.toContain('ring-arc')
    // a share is never over the whole, however the caller counted
    expect(html(<Ring value={9} of={4} label="all" />)).toContain('aria-label="9 of 4"')
  })

  it('moves the segmented thumb by index rather than repainting a button', () => {
    const out = html(<Segmented items={[{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }]} value="b" onChange={() => {}} label="Which" />)
    expect(out).toContain('seg-thumb')
    expect(out).toContain('--seg-n:3')
    expect(out).toContain('--seg-i:1')
  })

  it('sends a press to the choice it names', () => {
    const chosen: string[] = []
    const tree = settled(Segmented, { items: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], value: 'a', onChange: (k: string) => chosen.push(k), label: 'Which' })
    press(tree, 'B')
    expect(chosen).toEqual(['b'])
  })
})

describe('the Insights tab', () => {
  it('is a view of its own, with its own chunk and its own link names', () => {
    expect(VIEWS).toContain('insights')
    expect(LensChunk.preload).toBeTypeOf('function')
    expect(Object.keys(VIEW_TO_STATS).sort()).toEqual(['stats-habits', 'stats-journal', 'stats-kitchen', 'stats-money', 'stats-people', 'stats-places', 'stats-tasks', 'stats-wardrobe', 'stats-year'])
    expect(statsTabOfView('stats-tasks')).toBe('tasks')
  })

  it('reads every task, not the Mine / Everyone list, as the areas that count themselves do', () => {
    const src = readSource('components/planner/StatsScreen.tsx')
    expect(src).toContain('tasks={store.tasks}')
    expect(src).not.toContain('filteredTasks')
  })

  it('hands the screen the events written here, the same list People count seeing someone by', () => {
    expect(readSource('components/planner/StatsScreen.tsx')).toContain('events={store.events}')
  })

  it('lands the Overdue tile on the task LIST, not on whatever Tasks segment was last chosen', () => {
    // the tile counts overdue tasks; landing on Bills or Notes shows none of them
    const src = readSource('components/planner/StatsScreen.tsx')
    // the comment above the jump says the same thing, so read the code alone
    const jump = src.slice(src.indexOf('onTasks={'), src.indexOf('areas={areas}')).replace(/\/\/[^\n]*/g, '')
    expect(jump).toContain("goTasksTab('list')")
    expect(jump).toContain("setView('tasks')")
    // goTasksTab, not setTasksTab: a jump moves the segment for the visit only
    expect(jump).not.toContain('setTasksTab')
  })

  it('keeps one clock per day rather than a new one per render', () => {
    // `now = new Date()` in the parameter list is a fresh object every render,
    // and it is a dependency of every report in the file; the day's clock is
    // useDayClock's, which moves at midnight (lists-compiled.dom.test.tsx)
    const src = readSource('components/StatsLens.tsx')
    expect(src).not.toMatch(/now = new Date\(\) \} = p/)
    expect(src).toContain('const now = useDayClock(handed)')
  })

  it('stamps the retire Undo newer than the write it undoes, not than the piece', () => {
    // newerStamp is max(now, prev + 1). Undoing from the piece the write was
    // made ON can land on the same millisecond as the write, and a tie loses
    // last-write-wins — the piece would stay retired with nothing to show for
    // the press. Wardrobe.tsx stamps its own Undo the same way.
    const src = readSource('components/planner/StatsScreen.tsx')
    expect(src).toContain('const gone = retired(g, true)')
    expect(src).toContain('updatedAt: newerStamp(gone.updatedAt)')
  })

  it('is mounted by the shell on its own view', () => {
    expect(readSource('components/Planner.tsx')).toContain("{view === 'insights' && <InsightsScreen p={p} />}")
  })

  it('gathers what the areas need and counts nothing itself', () => {
    const src = readSource('components/planner/StatsScreen.tsx')
    // the screen is wiring. It memoizes the two values the wardrobe's figures
    // are read from — Wardrobe.tsx works out the same two for itself — and
    // holds no state of its own: the filters are the shell's, the segment is
    // the navigation's.
    expect(src).not.toMatch(/useState/)
    expect(src).toContain('const byId = useMemo(() => liveById(store.garments)')
    // …and the day key is a dependency of the index, not read inside the
    // factory: store.wears keeps its identity when a sync changes nothing, so
    // an index memoized on the list alone calls yesterday "today" after midnight.
    // It is useDayKey's: a localDayKey() read as the screen renders is one the
    // React Compiler keeps from the first render on, the same yesterday again
    expect(src).toContain('const today = useDayKey()')
    expect(src).not.toMatch(/=\s*localDayKey\(\)/)
    expect(src).toContain('const wearIx = useMemo(() => wearIndex(store.wears, today), [store.wears, today])')
    expect(src).not.toMatch(/\b(taskReport|moneyReport|habitReport|journalReport|kitchenIndex)\b/)
    expect(StatsScreen).toBeTypeOf('function')
  })

  it('draws one view per area, from that area\u2019s own chunk, so nothing ships twice', () => {
    const lazySrc = readSource('components/planner/lazy.ts')
    // the wardrobe's figures get a chunk entry of their own, so the lens does
    // not drag the composer, the clothes grid and the photo pipeline in with them
    expect(lazySrc).toContain("import('../wardrobe/WardrobeStats')")
    // …and a finger on the Insights tab warms every view it can draw: the
    // lens's areas, then the journal's archive and the review
    expect(lazySrc).toMatch(/insights: \[StatsLens\.preload, PeopleStats\.preload, PlacesStats\.preload, KitchenStats\.preload, WardrobeStats\.preload, JournalView\.preload, Review\.preload\]/)
    // the lens reaches them through lazy.ts, never by importing the files
    const lens = readSource('components/StatsLens.tsx')
    expect(lens).toContain("from './planner/lazy'")
    expect(lens).not.toMatch(/from '\.\/(PeopleStats|PlacesStats)'/)
  })
})

describe('what the app says about itself names the tab', () => {
  /*
   * The tab list is written out in four places a reader meets before they ever
   * see the app: the landing page, the HTML meta description, the PWA
   * manifest, and the README. Three of them were still saying "five tabs" a
   * day after Stats shipped, and nothing caught it — the tests read routes.ts,
   * and prose is not routes.ts. These read the prose.
   */
  const file = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

  it('says five tabs, and names Insights, wherever it counts them', () => {
    const prose = [
      ['the landing page', readSource('components/Landing.tsx')],
      ['the meta description', file('index.html')],
      ['the PWA manifest', file('vite.config.ts')],
      ['the README', file('README.md')],
    ] as const
    for (const [where, text] of prose) {
      expect(text, where).not.toMatch(/\bsix tabs\b/i)
      expect(text, where).toMatch(/\bInsights\b/)
    }
  })

  it('never lets a tab list in prose omit one of the five', () => {
    // a sentence that names four of the tabs has to name all five
    const named = (text: string) => VIEWS.filter(v => new RegExp(`\\b${VIEW_LABELS[v]}\\b`).test(text))
    for (const [where, text] of [
      ['the landing page', readSource('components/Landing.tsx')],
      ['the meta description', file('index.html')],
      ['the PWA manifest', file('vite.config.ts')],
    ] as const) {
      expect(named(text).sort(), where).toEqual([...VIEWS].sort())
    }
  })
})

describe('the segmented control is the same control everywhere', () => {
  const css = sheetSource().replace(/\/\*[\s\S]*?\*\//g, '')

  it('gives the web the track and thumb the shell already had, not a row of outlined buttons', () => {
    // the track is declared outside any .native scope, so a browser gets it too
    const track = css.match(/\.people-tab-seg \.segmented,\s*\.segmented\.cal-mode,\s*\.segmented\.seg-track \{([^}]*)\}/)
    expect(track, 'no un-scoped track rule for the tab switchers').toBeTruthy()
    expect(track![1]).toMatch(/background: var\(--surface-2\)/)
    expect(track![1]).toMatch(/border-radius: 12px/)
  })

  it('never widens the bare .seg, which every other segmented row in the app shares', () => {
    const bare = css.match(/(?:^|\})\s*\.seg \{([^}]*)\}/)
    expect(bare, 'no bare .seg rule').toBeTruthy()
    expect(bare![1]).not.toMatch(/flex:/)
  })

  it('takes the width it needs on a mouse page and the whole line on a phone', () => {
    expect(css).toMatch(/\.segmented\.seg-track \{[^}]*max-width: 520px/s)
    const phone = css.slice(css.indexOf('@media (max-width: 640px)'))
    expect(phone).toMatch(/\.segmented\.seg-track \{\s*max-width: none;/)
  })

  it('scrolls a track of more choices than fit, instead of wrapping it into three rows', () => {
    // `.segmented` wraps by default, which the filter rows want and a track
    // never does: wrapped, the lens's nine became three rows on a 375pt phone
    const scroll = css.match(/\.segmented\.seg-scroll \{([^}]*)\}/)
    expect(scroll, 'no .segmented.seg-scroll rule').toBeTruthy()
    expect(scroll![1]).toMatch(/flex-wrap: nowrap/)
    expect(scroll![1]).toMatch(/overflow-x: auto/)
    expect(scroll![1]).toMatch(/max-width: none/)
  })

  it('moves the thumb by a transform, so Reduce Motion simply puts it where it belongs', () => {
    const thumb = css.match(/\.seg-thumb \{([^}]*)\}/)
    expect(thumb![1]).toMatch(/transform: translateX\(calc\(var\(--seg-i, 0\) \* 100%\)\)/)
    expect(thumb![1]).toMatch(/transition: transform/)
  })
})

/**
 * The tree of the one component called `name` inside `tree`, with its own hooks
 * run: `elements` lists a component, never calls it, and the lens's segments are
 * components of its own.
 */
function into(tree: ReactNode, name: string): ReactNode {
  const hit = elements(tree).find(e => typeof e.type === 'function' && (e.type as { name?: string }).name === name)
  if (!hit) throw new Error(`no ${name} in the tree`)
  return settled(hit.type as (props: unknown) => ReactNode, hit.props)
}

/** A module's own text: a few rules here are about where a thing is written, not what it renders. */
const cache = new Map<string, string>()
function readSource(rel: string): string {
  const hit = cache.get(rel)
  if (hit !== undefined) return hit
  const text = readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')
  cache.set(rel, text)
  return text
}
