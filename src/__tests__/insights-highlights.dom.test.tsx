// @vitest-environment happy-dom
import { act, fireEvent, render, screen, within } from './dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlannerCtx } from '../components/planner/ctx'
import { InsightsScreen } from '../components/planner/InsightsScreen'
import { PeopleStats, StatsLens } from '../components/planner/lazy'
import { INSIGHTS_PERIOD_KEY, INSIGHTS_WHOSE_KEY } from '../components/planner/routes'
import { useNavigation } from '../components/planner/useNavigation'
import { NO_PERSON_FILTER } from '../people'
import { NO_PLACE_FILTER } from '../places'
import type { JournalEntry, Person, Task } from '../types'

// Insights → Stats as it is drawn and pressed: the Highlights, their
// Week · Month · Year, Mine · Both of us and what it labels, and an area's
// figures pushed over them and back — with the real navigation, and the
// lens's real chunks, warmed first as a finger on the tab warms them.

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
// Joe's journal, and a run of Maria's the device should never hold, and never counts if it does
const JOURNAL = [entry('2026-09-23', JOE), ...['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'].map(d => entry(d, MARIA))]

const store = {
  tasks: TASKS,
  people: PEOPLE,
  places: [],
  events: [],
  meals: [],
  recipes: [],
  groceries: [],
  journal: JOURNAL,
  habits: [],
  garments: [],
  outfits: [],
  wears: [],
  projects: [],
  reviews: [],
}

/** The shell as far as Insights goes: the real navigation, the lists' own filters, and the household. */
function Shell({ inHousehold }: { inHousehold: boolean }) {
  const nav = useNavigation()
  const known: Record<string, unknown> = {
    store,
    household: { info: null, myId: JOE },
    inHousehold,
    peopleFilter: NO_PERSON_FILTER,
    placeFilter: NO_PLACE_FILTER,
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

describe('Mine · Both of us', () => {
  it('is not offered to a household of one', () => {
    render(<Shell inHousehold={false} />)
    expect(screen.queryByRole('group', { name: 'Whose log' })).toBeNull()
    expect(screen.queryByText('Both of us')).toBeNull()
  })

  it('counts your own log under Mine, and never another member’s journal', () => {
    render(<Shell inHousehold />)
    const whose = screen.getByRole('group', { name: 'Whose log' })
    expect(within(whose).getByRole('button', { name: 'Mine' }).getAttribute('aria-pressed')).toBe('true')
    expect(cardNamed(/^You saw Tio Marco this week/)).toBeTruthy()
    expect(cardNamed(/^3 tasks done this week/)).toBeTruthy()
    // one day of Joe's journal, never Maria's run of six
    expect(cardNamed(/^Wrote in the journal on 1 day this week/)).toBeTruthy()
    expect(cards().some(c => /6 days in a row/.test(c.getAttribute('aria-label') ?? ''))).toBe(false)
    expect(screen.queryByText('Both of us', { selector: '.badge' })).toBeNull()
  })

  it('counts every member’s log under Both of us, labels every card it counts that way, and remembers it', () => {
    render(<Shell inHousehold />)
    fireEvent.click(within(screen.getByRole('group', { name: 'Whose log' })).getByRole('button', { name: 'Both of us' }))
    expect(localStorage.getItem(INSIGHTS_WHOSE_KEY)).toBe('both')
    // each card's name says whose it is, as its badge does
    const people = cardNamed(/^Both of us: 3 people seen between you this week/)!
    expect(within(people).getByText('Both of us')).toBeTruthy()
    const tasks = cardNamed(/^Both of us: 4 tasks done this week/)!
    expect(within(tasks).getByText('Both of us')).toBeTruthy()
    // the journal is still yours alone, and says so
    const journal = cardNamed(/^Just you: Wrote in the journal on 1 day this week/)!
    expect(within(journal).getByText('Just you:')).toBeTruthy()
    expect(within(journal).queryByText('Both of us')).toBeNull()
    // …and the page says, in words, whose figures these are
    expect(screen.getByText(/count everyone in the household/)).toBeTruthy()
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

  it('count People by your own visits under Mine, everyone’s under Both of us, and say so', async () => {
    const most = () => within(screen.getByText('Most seen').closest('section')!).queryAllByText(/^(Tio Marco|Ana|Rosa)$/).map(n => n.textContent)
    const first = render(<Shell inHousehold />)
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Every figure, by area' })).getByRole('button', { name: 'People' }))
    await screen.findByText('Most seen')
    expect(most()).toEqual(['Tio Marco'])
    expect(screen.queryByText('Both of us')).toBeNull()
    first.unmount()
    localStorage.setItem(INSIGHTS_WHOSE_KEY, 'both')
    render(<Shell inHousehold />)
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Every figure, by area' })).getByRole('button', { name: 'People' }))
    await screen.findByText('Most seen')
    expect(most().sort()).toEqual(['Ana', 'Rosa', 'Tio Marco'])
    expect(screen.getByText('Both of us')).toBeTruthy()
    expect(screen.getByText(/Every member’s log is counted here/)).toBeTruthy()
  })

  it('keep the journal your own under Both of us too, and say so', () => {
    localStorage.setItem(INSIGHTS_WHOSE_KEY, 'both')
    render(<Shell inHousehold />)
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Every figure, by area' })).getByRole('button', { name: 'Journal' }))
    expect(screen.getByText('Just you')).toBeTruthy()
    // one entry, Joe's: Maria's six are not counted
    const entries = screen.getByText('Entries').closest('.stat-tile')!
    expect(within(entries as HTMLElement).getByText('1')).toBeTruthy()
  })
})
