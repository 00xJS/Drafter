// @vitest-environment happy-dom
import { act, fireEvent, render, screen, within } from './dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlannerCtx } from '../components/planner/ctx'
import { InsightsScreen } from '../components/planner/InsightsScreen'
import { PeopleStats, SCREEN_VIEWS, StatsLens } from '../components/planner/lazy'
import { INSIGHTS_PERIOD_KEY } from '../components/planner/routes'
import { useNavigation } from '../components/planner/useNavigation'
import { NO_PERSON_FILTER } from '../people'
import { NO_PLACE_FILTER } from '../places'
import type { Garment, Habit, JournalEntry, Person, Task, Wear } from '../types'

// Insights → Stats as it is drawn and pressed: the Highlights, their
// Week · Month · Year, the one view a household of two gets and the line that
// says what counts whose, and an area's figures pushed over them and back —
// with the real navigation, and the lens's real chunks, warmed first as a
// finger on the tab warms them.

const STAMP = '2026-01-01T00:00:00.000Z'
const JOE = 'joe-0000-4000-8000-00000000000a'
const MARIA = 'maria-00-4000-8000-00000000000b'
const noop = () => {}

const person = (id: string, name: string): Person => ({ kind: 'person', id, name, color: '#f472b6', group: 'friends', createdAt: STAMP, updatedAt: STAMP })
const done = (id: string, day: string, over: Partial<Task> = {}): Task => ({
  kind: 'task',
  id,
  title: id,
  description: '',
  status: 'done',
  priority: 'normal',
  tags: [],
  completedAt: new Date(`${day}T12:00:00`).toISOString(),
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
})
const entry = (day: string, ownerId: string): JournalEntry => ({ kind: 'journal', id: `journal~${day}~${ownerId}`, date: day, body: 'words', ownerId, createdAt: STAMP, updatedAt: STAMP })

/** Joe's week (Sunday 20 to today, Thursday 24 September) and Maria's beside it. */
const TASKS: Task[] = [
  done('bins', '2026-09-22', { ownerId: JOE }),
  done('gate', '2026-09-22', { ownerId: JOE }),
  done('bank', '2026-09-21', { ownerId: JOE }),
  done('ink', '2026-09-15', { ownerId: JOE }),
  // Joe saw Tio Marco; Maria saw Ana and Rosa
  done('saw-marco', '2026-09-21', { tags: ['visit'], peopleIds: ['marco'], ownerId: JOE }),
  done('saw-ana', '2026-09-22', { tags: ['visit'], peopleIds: ['ana', 'rosa'], ownerId: MARIA }),
  // Maria's own chore
  done('insurance', '2026-09-23', { ownerId: MARIA }),
]
const PEOPLE = [person('marco', 'Tio Marco'), person('ana', 'Ana'), person('rosa', 'Rosa')]
const THIS_WEEK = ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24']
// Joe's journal, and a run of Maria's the device should never hold, and never counts if it does
const JOURNAL = [entry('2026-09-23', JOE), ...['2026-09-19', ...THIS_WEEK].map(d => entry(d, MARIA))]
// …and her habit and her clothes, kept every day this week: hers alone, as her journal is
const HABITS: Habit[] = [{ kind: 'habit', id: 'walk', name: 'Walk', done: THIS_WEEK, ownerId: MARIA, createdAt: STAMP, updatedAt: STAMP }]
const GARMENTS: Garment[] = [{ kind: 'garment', id: 'dress', name: 'Red dress', type: 'top', ownerId: MARIA, createdAt: STAMP, updatedAt: STAMP }]
const WEARS: Wear[] = THIS_WEEK.map(d => ({ kind: 'wear', id: `wear~${d}~maria`, date: d, garmentIds: ['dress'], ownerId: MARIA, createdAt: STAMP, updatedAt: STAMP }))

/** What Joe's device holds in a household of two: the household's records, and his own. */
const HOUSEHOLD = {
  tasks: TASKS,
  people: PEOPLE,
  places: [],
  events: [],
  meals: [],
  recipes: [],
  groceries: [],
  journal: JOURNAL,
  habits: HABITS,
  garments: GARMENTS,
  outfits: [],
  wears: WEARS,
  projects: [],
  reviews: [],
}
/** …and on his own: his records alone. */
const ALONE = { ...HOUSEHOLD, tasks: TASKS.filter(t => t.ownerId === JOE), journal: JOURNAL.filter(e => e.ownerId === JOE), habits: [], garments: [], wears: [] }

/** The shell as far as Insights goes: the real navigation, the lists' own filters, and the household. */
function Shell({ inHousehold }: { inHousehold: boolean }) {
  const nav = useNavigation()
  const known: Record<string, unknown> = {
    store: inHousehold ? HOUSEHOLD : ALONE,
    household: { info: null, myId: JOE },
    inHousehold,
    peopleFilter: NO_PERSON_FILTER,
    placeFilter: NO_PLACE_FILTER,
    // the lazy views, as the shell hands them to its screens
    views: SCREEN_VIEWS,
    ...nav,
  }
  const p = new Proxy(known, { get: (t, k: string) => (k in t ? t[k] : noop) }) as unknown as PlannerCtx
  return <InsightsScreen p={p} />
}

beforeAll(async () => {
  // a finger on the tab warms the lens and the areas it draws (lazy.ts); here, before anything is drawn
  await StatsLens.preload()
  await PeopleStats.preload()
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 24, 18, 0))
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
})

afterEach(() => {
  vi.useRealTimers()
})

const cards = () => within(screen.getByRole('list', { name: /^Highlights/ })).getAllByRole('button')
const cardNamed = (words: RegExp) => cards().find(c => words.test(c.getAttribute('aria-label') ?? ''))

describe('the Highlights', () => {
  it('open Insights → Stats: the period, a chip for every area, and the cards, most interesting first', () => {
    render(<Shell inHousehold={false} />)
    expect(within(screen.getByRole('group', { name: 'Period' })).getByRole('button', { name: 'Week' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('heading', { name: 'This week' })).toBeTruthy()
    const chips = within(screen.getByRole('navigation', { name: 'Every figure, by area' })).getAllByRole('button')
    expect(chips.map(c => c.textContent)).toEqual(['Tasks', 'Money', 'People', 'Places', 'Kitchen', 'Wardrobe', 'Habits', 'Journal'])
    // Joe's three chores this week, against one on the same days of last week
    expect(cardNamed(/^3 tasks done this week, ↑2 on last week/)).toBeTruthy()
    expect(cardNamed(/^You saw Tio Marco this week/)).toBeTruthy()
    // no card for anything of nothing: no money, no meals, no clothes
    expect(cards().some(c => /Paid|Out |Outfit|Habits/.test(c.getAttribute('aria-label') ?? ''))).toBe(false)
  })

  it('recount by Week · Month · Year, remember the choice, and step back through the months', () => {
    render(<Shell inHousehold={false} />)
    fireEvent.click(within(screen.getByRole('group', { name: 'Period' })).getByRole('button', { name: 'Month' }))
    expect(screen.getByRole('heading', { name: 'This month' })).toBeTruthy()
    expect(cardNamed(/^4 tasks done this month/)).toBeTruthy()
    expect(localStorage.getItem(INSIGHTS_PERIOD_KEY)).toBe('month')
    // a month gone by is counted whole, and the one after it is a step away
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    expect(screen.getByRole('heading', { name: 'August' })).toBeTruthy()
    expect(screen.getByText('Nothing was logged in August.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Next month' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    expect(screen.getByRole('heading', { name: 'This month' })).toBeTruthy()
    // no month still to come is offered
    expect((screen.getByRole('button', { name: 'Next month' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(screen.getByRole('group', { name: 'Period' })).getByRole('button', { name: 'Year' }))
    expect(screen.getByRole('heading', { name: 'This year' })).toBeTruthy()
    expect(cardNamed(/^4 tasks done this year/)).toBeTruthy()
  })
})

/** The line a household is told what counts whose by. */
const SCOPE_LINE = 'Tasks, money and meals count the household; people, places, your journal, habits and clothes are yours.'
const labels = () => cards().map(c => c.getAttribute('aria-label') ?? '')

describe('one view, with no switch', () => {
  it('says nothing about whose on its own, as everything counted is yours', () => {
    render(<Shell inHousehold={false} />)
    expect(screen.queryByRole('group', { name: 'Whose log' })).toBeNull()
    expect(screen.queryByText(SCOPE_LINE)).toBeNull()
    expect(screen.queryByText(/Both of us|Just you/)).toBeNull()
  })

  it('counts Maria’s shared tasks in a household of two, but never her visits, journal, habits or clothes, and draws no switch', () => {
    render(<Shell inHousehold />)
    // no switch, and nothing to choose between
    expect(screen.queryByRole('group', { name: 'Whose log' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Mine' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Both of us' })).toBeNull()
    expect(screen.getAllByRole('group').map(g => g.getAttribute('aria-label'))).toEqual(['Period'])
    // Joe's three chores and Maria's insurance: the household's work, against one last week
    expect(cardNamed(/^4 tasks done this week, ↑3 on last week · Tuesday was the busiest day\. Open Tasks$/)).toBeTruthy()
    // …something done three days running between them: the household's run, not Joe's
    expect(cardNamed(/^Something done 3 days in a row · the household’s longest yet/)).toBeTruthy()
    expect(labels().some(l => /your longest yet|your best is/.test(l))).toBe(false)
    // whom Joe saw: Tio Marco, never Maria's Ana and Rosa
    expect(cardNamed(/^You saw Tio Marco this week/)).toBeTruthy()
    expect(labels().some(l => /Ana|Rosa|people/.test(l))).toBe(false)
    // one day of Joe's journal, never Maria's run of six; none of her habit or her clothes
    expect(cardNamed(/^Wrote in the journal on 1 day this week/)).toBeTruthy()
    expect(labels().some(l => /Journal \d+ days in a row|Habits|Outfit|Red dress/.test(l))).toBe(false)
    // no card says whose it is: the one line under the period does, in a field's hint
    expect(labels().some(l => /^(Both of us|Just you)/.test(l))).toBe(false)
    expect(screen.queryByText(/Both of us|Just you/)).toBeNull()
    const line = screen.getByText(SCOPE_LINE)
    expect(line.className).toBe('field-hint insights-scope')
    expect(line.querySelector('.badge')).toBeNull()
  })

  it('pays no heed to the choice the old switch left on a device', () => {
    localStorage.setItem('drafter:insights-whose', 'both')
    render(<Shell inHousehold />)
    expect(screen.queryByRole('group', { name: 'Whose log' })).toBeNull()
    expect(cardNamed(/^You saw Tio Marco this week/)).toBeTruthy()
    expect(cardNamed(/^4 tasks done this week/)).toBeTruthy()
  })
})

describe('an area’s figures, pushed over the Highlights', () => {
  it('open from a chip, with ‹ Back, and Back comes back to the Highlights', async () => {
    render(<Shell inHousehold={false} />)
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Every figure, by area' })).getByRole('button', { name: 'People' }))
    // a page of its own: its title and Back, and no segments over it
    expect(await screen.findByRole('heading', { name: 'People', level: 2 })).toBeTruthy()
    expect(screen.queryByRole('tablist', { name: 'Insights view' })).toBeNull()
    expect(screen.getByText('Most seen')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('tablist', { name: 'Insights view' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Period' })).toBeTruthy()
  })

  it('open from a card, at the area the card is about', () => {
    render(<Shell inHousehold={false} />)
    act(() => cardNamed(/^3 tasks done this week/)!.click())
    expect(screen.getByRole('heading', { name: 'Tasks', level: 2 })).toBeTruthy()
    expect(screen.getByText('Finished')).toBeTruthy()
  })

  it('count People by your own visits in a household too, so a person’s figures match Keep → People', async () => {
    const most = () => within(screen.getByText('Most seen').closest('section')!).queryAllByText(/^(Tio Marco|Ana|Rosa)$/).map(n => n.textContent)
    render(<Shell inHousehold />)
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Every figure, by area' })).getByRole('button', { name: 'People' }))
    await screen.findByText('Most seen')
    expect(most()).toEqual(['Tio Marco'])
    expect(screen.queryByText(/Both of us|Just you/)).toBeNull()
  })

  it('count Tasks as the household’s, with no badge on the page', () => {
    render(<Shell inHousehold />)
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Every figure, by area' })).getByRole('button', { name: 'Tasks' }))
    // the last 30 days: Joe's four chores and Maria's insurance
    const finished = screen.getByText('Finished').closest('.stat-tile')!
    expect(within(finished as HTMLElement).getByText('5')).toBeTruthy()
    expect(screen.queryByText(/Both of us|Just you/)).toBeNull()
  })

  it('keep the journal your own, and say nothing about it', () => {
    render(<Shell inHousehold />)
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Every figure, by area' })).getByRole('button', { name: 'Journal' }))
    expect(screen.queryByText(/Both of us|Just you/)).toBeNull()
    // one entry, Joe's: Maria's six are not counted
    const entries = screen.getByText('Entries').closest('.stat-tile')!
    expect(within(entries as HTMLElement).getByText('1')).toBeTruthy()
  })
})
