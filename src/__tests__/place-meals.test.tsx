import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDigest } from '../../shared/digest.mjs'
import { Places } from '../components/Places'
import { PlacesStats } from '../components/PlacesStats'
import { Today } from '../components/Today'
import { buildLocalReminders } from '../reminders'
import type { Meal, Place, Task } from '../types'

// A meal eaten out is an outing (outingsAt), so every "been a while" and "how
// often" figure for a place reads it: Today's nudges, the morning digest, the
// phone's own reminders, and the Places tab's tile and year table. vitest runs
// in node, so these are static renders plus the rules behind them; the clicks
// were checked in the browser.

const STAMP = '2026-01-01T00:00:00.000Z'
const NOW = new Date(2026, 8, 13, 9, 0) // Sunday 13 September 2026, 9am local
const DAY_MS = 86_400_000
const noop = () => {}

/** Nopi, where you meant to go once a month. */
const nopi: Place = { kind: 'place', id: 'nopi', name: 'Nopi', color: '#f97316', category: 'restaurant', cadenceDays: 30, createdAt: STAMP, updatedAt: STAMP }
/** The last outing logged there: nine weeks ago, well past 1.5× that rhythm. */
const july: Task = {
  kind: 'task',
  id: 'july',
  title: 'Dinner at Nopi',
  description: '',
  status: 'done',
  priority: 'normal',
  tags: ['visit'],
  placeId: 'nopi',
  completedAt: new Date(NOW.getTime() - 63 * DAY_MS).toISOString(),
  createdAt: STAMP,
  updatedAt: STAMP,
}
/** Last night's takeaway from there, planned in Kitchen as eating out. */
const takeaway: Meal = { kind: 'meal', id: 'meal~2026-09-12~dinner', date: '2026-09-12', slot: 'dinner', out: true, placeId: 'nopi', title: 'Nopi', createdAt: STAMP, updatedAt: STAMP }
/** Next Friday's booking: a plan, not an outing yet. */
const friday: Meal = { ...takeaway, id: 'meal~2026-09-18~dinner', date: '2026-09-18' }
/** Something on the list, or Today is the welcome page. */
const bins: Task = { kind: 'task', id: 'bins', title: 'Put the bins out', description: '', status: 'todo', priority: 'normal', createdAt: STAMP, updatedAt: STAMP, tags: [] }

/** The slice of `html` from `marker` to the end of the section it opens. */
function sectionAt(html: string, marker: string): string {
  const from = html.indexOf(marker)
  if (from < 0) return ''
  return html.slice(from, html.indexOf('</section>', from))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function renderToday(over: Partial<ComponentProps<typeof Today>> = {}) {
  // the journal card asks the viewport how wide it is; a static render has none
  if (typeof window === 'undefined') vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) })
  const props: ComponentProps<typeof Today> = {
    tasks: [bins],
    allTasks: [bins, july],
    people: [],
    places: [nopi],
    reviews: [],
    onPlanWith: noop,
    onWentTo: noop,
    onPlanAt: noop,
    onPlanOccasion: noop,
    onSaw: noop,
    onSaveReview: noop,
    projects: [],
    events: [],
    sourceMap: new Map(),
    onPlan: noop,
    onOpen: noop,
    onStatus: noop,
    onDefer: noop,
    onDeferAll: noop,
    onNew: noop,
    meals: [],
    recipes: [],
    onOpenKitchen: noop,
    onOpenReview: noop,
    onCookRecipe: noop,
    journal: [],
    onSaveJournal: noop,
    onDeleteJournal: noop,
    onOpenJournal: noop,
    habits: [],
    onSaveHabit: noop,
    onDeleteHabit: noop,
    routines: [],
    onSaveRoutine: noop,
    onDeleteRoutine: noop,
    ...over,
  }
  return renderToStaticMarkup(<Today {...props} />)
}

describe('a takeaway last night means it has not been a while', () => {
  it('Today stops nudging about the place', () => {
    const nudges = (meals: Meal[]) => sectionAt(renderToday({ meals }), 'class="chart-card people-nudges"')
    expect(nudges([])).toContain('Nopi')
    expect(nudges([])).toContain('Been a while')
    expect(nudges([takeaway])).toBe('')
    // next Friday's booking is a plan: until then it has still been a while
    expect(nudges([friday])).toContain('Been a while')
  })

  it('the morning digest leaves it out of "Been a while"', () => {
    const items = [nopi, july]
    expect(buildDigest(items, 'UTC', NOW).placesDue).toEqual(['Nopi (63d)'])
    const after = buildDigest([...items, takeaway], 'UTC', NOW)
    expect(after.placesDue).toEqual([])
    expect(after.lines.some((l: string) => l.startsWith('Been a while'))).toBe(false)
    // a takeaway deleted since never happened
    expect(buildDigest([...items, { ...takeaway, deletedAt: STAMP }], 'UTC', NOW).placesDue).toEqual(['Nopi (63d)'])
  })

  it('the phone schedules no "Been a while" for it', () => {
    expect(buildLocalReminders([july], [], [nopi], [], NOW).map(r => r.url)).toEqual(['/?place=nopi'])
    expect(buildLocalReminders([july], [], [nopi], [takeaway], NOW)).toEqual([])
    expect(buildLocalReminders([july], [], [nopi], [friday], NOW).map(r => r.url)).toEqual(['/?place=nopi'])
  })
})

describe('Places and its Stats count meals eaten out, as its rows do', () => {
  const page = (over: Partial<ComponentProps<typeof Places>> = {}) =>
    renderToStaticMarkup(
      <Places places={[nopi]} people={[]} tasks={[july]} meals={[takeaway]} onSave={noop} onDelete={noop} onLogOuting={noop} onPlan={noop} onOpenTask={noop} {...over} />,
    )
  const stats = (over: Partial<ComponentProps<typeof PlacesStats>> = {}) =>
    renderToStaticMarkup(<PlacesStats places={[nopi]} people={[]} tasks={[july]} meals={[takeaway]} onOpenPlace={noop} onPlan={noop} now={NOW} {...over} />)

  it('Outings this year counts the takeaway beside the logged dinner, and not next Friday', () => {
    // the row counts the last 12 months, as its 12mo figure does; the Stats tile counts the calendar year
    expect(page({ meals: [takeaway, friday] })).toContain('2 times in 12 months · ate here 1 time')
    expect(stats({ meals: [takeaway, friday] })).toMatch(/Outings this year<\/div><div class="stat-value">2</)
    expect(stats({ meals: [] })).toMatch(/Outings this year<\/div><div class="stat-value">1</)
  })

  it('keeps the list to the places: its tiles and the year in places moved to Stats', () => {
    const html = page()
    expect(html).toContain('class="people-list"')
    expect(html).not.toContain('kpi-row')
    expect(html).not.toContain('year-report')
    expect(html).not.toContain('Outings this year')
  })

  it('shows the year in places on Stats, in its own scrolling box, and says what it counts', () => {
    const html = stats()
    const table = sectionAt(html, 'class="chart-card year-report')
    expect(table).toContain('<h3>The year in places</h3>')
    expect(table).toContain('Outings per month, a meal eaten out there included, two in one day counted as two')
    expect(table).toContain('<div class="table-scroll"><table class="year-table">')
    expect(table).toContain('<th>Place</th>')
    expect(table).toContain('<th class="num">Outings</th>')
    // July's dinner and last night's takeaway, one outing each
    expect(table.match(/title="1 outing"/g)).toHaveLength(2)
    expect(table).toContain('<td class="num"><strong>2</strong></td>')
    // both in the last 90 days, none in the 90 before
    expect(table).toContain('↑ more lately')
  })

  it('has nothing to show before any place is saved', () => {
    expect(page({ places: [] })).not.toContain('year-report')
    expect(stats({ places: [] })).not.toContain('year-report')
  })
})
