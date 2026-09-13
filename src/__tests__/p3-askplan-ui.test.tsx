import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WeekPlan } from '../../shared/weekplan.mjs'
import { weekDayKeys } from '../../shared/weeks.mjs'
import type { AskSources } from '../ask'
import { formatMoney } from '../bills'
import { AskSheet, aiFailureKind, askFailure } from '../components/AskSheet'
import { Review, planWeekIsPrimary } from '../components/Review'
import { withAskRow } from '../components/Search'
import { WISHLIST, WeekPlanSheet, acceptedCount, acceptedPlan, initialChoices, readWeekPlanDismissed, rememberWeekPlanDismissed } from '../components/WeekPlanSheet'
import type { JournalEntry, Place, Recipe } from '../types'

// Ask Drafter and Plan next week, whose sheets the shell opens: what each shows
// on first paint, before any effect and with no network, and the pure pieces
// that decide what the planner is handed. Every AI prop is a promise that
// never settles, so nothing here reaches a model.

const never = () => new Promise<never>(() => {})
const noop = () => {}

function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  }
}
afterEach(() => vi.unstubAllGlobals())

const STAMP = '2026-01-01T00:00:00.000Z'
const recipe = (id: string, name: string): Recipe => ({ kind: 'recipe', id, name, ingredients: [], tags: [], createdAt: STAMP, updatedAt: STAMP })
const recipes = [recipe('id-fav', 'Lasagne'), recipe('id-mid', 'Curry'), recipe('id-c', 'Pie'), recipe('id-b', 'Stew')]
const places: Place[] = [{ kind: 'place', id: 'id-cafe', name: 'Café Nero', color: '#fff', category: 'cafe', createdAt: STAMP, updatedAt: STAMP }]

// ---- ask drafter -----------------------------------------------------------------

describe('the palette’s Ask row', () => {
  const create = { kind: 'create' }
  const task = { kind: 'task' }
  const ask = { kind: 'ask' }

  it('ranks first for a question, and otherwise sits just below Create task', () => {
    expect(withAskRow([create, task, task], ask, 'When did I last see Mum')).toEqual([ask, create, task, task])
    expect(withAskRow([create, task], ask, 'bins?')).toEqual([ask, create, task])
    expect(withAskRow([create, task, task], ask, 'milk')).toEqual([create, ask, task, task])
    // an exact title puts Create task last, and Ask after it
    expect(withAskRow([task, create], ask, 'milk')).toEqual([task, create, ask])
  })
})

const at = (m: number, d: number, h = 9) => new Date(2026, m - 1, d, h, 0).toISOString()
const askSources = (): AskSources => ({
  tasks: [{ kind: 'task', id: 'id-visit', title: 'Lunch with Mum', description: '', status: 'done', priority: 'normal', completedAt: at(8, 1, 13), peopleIds: ['id-mum'], tags: ['visit'], createdAt: STAMP, updatedAt: STAMP }],
  projects: [],
  people: [{ kind: 'person', id: 'id-mum', name: 'Mum', color: '#fff', group: 'family', createdAt: STAMP, updatedAt: STAMP }],
  places: [],
  recipes: [],
  meals: [],
  entries: [],
  feedEvents: [],
  journal: [{ kind: 'journal', id: 'journal~2026-09-10~a', date: '2026-09-10', body: 'Felt great after seeing Mum', createdAt: STAMP, updatedAt: STAMP } as JournalEntry],
})

describe('AskSheet', () => {
  const now = new Date(2026, 8, 12, 10, 0)
  const sheet = (question: string) =>
    renderToStaticMarkup(<AskSheet initialQuestion={question} sources={askSources()} tz="Europe/London" now={now} onOpen={noop} onClose={noop} ask={never} />)

  it('lists the sources on first paint, before any answer, with the journal left out by default', () => {
    const html = sheet('When did I last see Mum?')
    expect(html).toContain('role="dialog"')
    expect(html).toContain('✨ Ask Drafter')
    expect(html).toContain('Sources')
    expect(html).toContain('Lunch with Mum')
    expect(html).toContain('Reading your planner…')
    expect(html).toContain('aria-pressed="false"')
    expect(html).not.toContain('Journal, 2026-09-10')
  })

  it('searches the journal once its chip is on, and remembers that', () => {
    vi.stubGlobal('localStorage', fakeStorage({ 'drafter:ask-journal': '1' }))
    const html = sheet('When did I last see Mum?')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('Journal, 2026-09-10')
  })

  it('says how to search the journal when the question is about it and the chip is off', () => {
    expect(sheet('How did I feel last week?')).toContain('Turn on Journal to search your entries.')
  })

  it('makes no call when nothing matches, and opens empty from the palette command', () => {
    expect(sheet('Where is the moon?')).toContain('Nothing in your planner matches that.')
    const empty = sheet('')
    expect(empty).not.toContain('Sources')
    expect(empty).toContain('When did I last see Mum? What did we eat last week?')
  })

  it('words a failed answer: busy, not here at all, or worth another try', () => {
    expect(askFailure('Too many AI requests from this account — try again in 1 min.')).toEqual({ text: 'Drafter’s assistant is busy — try again in a minute.', retry: true })
    expect(askFailure('AI is not configured on this site: set NVIDIA_API_KEY (or ANTHROPIC_API_KEY) in the host environment.').retry).toBe(false)
    expect(aiFailureKind('The server is unreachable from here — this runs on the hosted site (or via `netlify dev` locally).')).toBe('unavailable')
    expect(askFailure('The model returned malformed JSON — try again.')).toEqual({ text: 'Couldn’t write an answer: The model returned malformed JSON — try again.', retry: true })
  })
})

// ---- plan next week --------------------------------------------------------------

const plan: WeekPlan = {
  week: { startKey: '2026-09-20', dayKeys: weekDayKeys('2026-09-20'), weekKey: '2026-W38', prevWeekKey: '2026-W37' },
  dinners: [
    { key: 'dinner:2026-09-20', date: '2026-09-20', recipeId: 'id-fav', title: 'Lasagne', why: 'Cooked 3× in six months · last 27 days ago', alternatives: ['id-c', 'id-b'], busy: null, isNew: false },
    { key: 'dinner:2026-09-23', date: '2026-09-23', recipeId: 'id-mid', title: 'Curry', why: 'Cooked 2× in six months · last 46 days ago', alternatives: ['id-c', 'id-b'], busy: 'Parents’ evening', isNew: false },
  ],
  people: [{ key: 'person:id-mum', personId: 'id-mum', title: 'Catch up with Mum', dueDay: '2026-09-26', why: 'Overdue: last seen 46 days ago' }],
  overdue: [
    { key: 'resched:id-t1', taskId: 'id-t1', title: 'Fix the fence', fromDue: '2026-09-10T09:00:00.000Z', toDay: '2026-09-21', why: 'Overdue 6 days · urgent' },
    { key: 'resched:id-t2', taskId: 'id-t2', title: 'Clear the gutters', fromDue: '2026-09-01T09:00:00.000Z', toDay: '2026-09-22', why: 'Overdue 15 days' },
  ],
  bills: [{ key: 'bill:id-b1', taskId: 'id-b1', title: 'Council tax', dueDay: '2026-09-24', amount: 145, autopay: true }],
  top3: [
    { key: 'top:0', title: 'Paint the shed', taskId: 'id-t3' },
    { key: 'top:1', title: 'Book the MOT', taskId: 'id-t4' },
  ],
}

describe('the week plan’s choices', () => {
  it('ticks every row as proposed except a busy night, and hands that back as the AcceptedPlan', () => {
    const c = initialChoices(plan)
    expect(c.dinners['dinner:2026-09-23'].on).toBe(false)
    const a = acceptedPlan(plan, c)
    expect(a).toEqual({
      dinners: [{ date: '2026-09-20', recipeId: 'id-fav', title: 'Lasagne' }],
      people: [{ personId: 'id-mum', dueDay: '2026-09-26', title: 'Catch up with Mum' }],
      resched: [
        { taskId: 'id-t1', toDay: '2026-09-21' },
        { taskId: 'id-t2', toDay: '2026-09-22' },
      ],
      wishlist: [],
      top3: ['Paint the shed', 'Book the MOT'],
      // a busy night left unticked was never said no to
      dismissed: [],
    })
    expect(acceptedCount(a)).toBe(6)
  })

  it('carries each change, and dismisses only the rows said no to', () => {
    const c = initialChoices(plan)
    c.dinners['dinner:2026-09-20'].on = false
    c.dinners['dinner:2026-09-23'] = { on: true, alt: 0, pick: { out: true, placeId: 'id-cafe', title: 'Café Nero' } }
    c.people['person:id-mum'] = { on: true, day: '2026-09-20', title: '  Walk with Mum  ' }
    c.overdue['resched:id-t1'].to = '2026-09-25'
    c.overdue['resched:id-t2'].to = WISHLIST
    c.top3['top:1'] = false
    expect(acceptedPlan(plan, c)).toEqual({
      dinners: [{ date: '2026-09-23', out: true, placeId: 'id-cafe', title: 'Café Nero' }],
      people: [{ personId: 'id-mum', dueDay: '2026-09-20', title: 'Walk with Mum' }],
      resched: [{ taskId: 'id-t1', toDay: '2026-09-25' }],
      wishlist: ['id-t2'],
      top3: ['Paint the shed'],
      dismissed: ['dinner:2026-09-20', 'top:1'],
    })
    c.people['person:id-mum'].on = false
    c.overdue['resched:id-t1'].on = false
    expect(acceptedPlan(plan, c).dismissed).toEqual(['dinner:2026-09-20', 'person:id-mum', 'resched:id-t1', 'top:1'])
  })

  it('remembers a week’s dismissed rows by adding to them', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    rememberWeekPlanDismissed('2026-W38', ['dinner:2026-09-20', 'top:1'])
    rememberWeekPlanDismissed('2026-W38', ['top:1', 'person:id-mum'])
    expect(readWeekPlanDismissed('2026-W38')).toEqual(['dinner:2026-09-20', 'top:1', 'person:id-mum'])
    expect(readWeekPlanDismissed('2026-W39')).toEqual([])
  })
})

describe('WeekPlanSheet', () => {
  const sheet = (p: WeekPlan) =>
    renderToStaticMarkup(<WeekPlanSheet plan={p} recipes={recipes} places={places} people={[]} meals={[]} tasks={[]} onCreatePlace={() => places[0]} onApply={noop} onClose={noop} polish={never} />)

  it('groups the rows with a checkbox each, bills read-only, and counts what Add would add', () => {
    const html = sheet(plan)
    expect(html).toContain('role="dialog"')
    for (const h of ['Dinners', 'Catch-ups', 'Overdue', 'Bills due', 'Top 3']) expect(html).toContain(`>${h}</h3>`)
    expect(html).toContain('Busy: Parents’ evening')
    expect(html).toContain('Council tax')
    expect(html).toContain(formatMoney(145))
    // two dinners, a catch-up, two overdue, two Top 3 — and no box on the bill
    expect(html.match(/type="checkbox"/g)).toHaveLength(7)
    expect(html.match(/type="checkbox"[^>]*checked=""/g)).toHaveLength(6)
    expect(html).toContain('Back to wishlist')
    expect(html).toContain('✨ Polish with the assistant')
    expect(html).toContain('Add 6 to next week')
  })

  it('says so when there is nothing to plan', () => {
    const html = sheet({ ...plan, dinners: [], people: [], overdue: [], bills: [], top3: [] })
    expect(html).toContain('Nothing to plan')
    expect(html).not.toContain('to next week</button>')
  })
})

describe('Review', () => {
  const props = {
    tasks: [],
    projects: [],
    projectMap: new Map(),
    people: [],
    reviews: [],
    journal: [],
    places: [],
    habits: [],
    onSaveReview: noop,
    onOpen: noop,
    onStatus: noop,
    onReschedule: noop,
    onOpenProject: noop,
    onNew: noop,
  }

  it('has "Plan next week" in the toolbar when the planner can open it, primary Friday to Sunday', () => {
    expect(renderToStaticMarkup(<Review {...props} onPlanWeek={noop} />)).toContain('Plan next week')
    expect(renderToStaticMarkup(<Review {...props} />)).not.toContain('Plan next week')
    // Friday 11 to Thursday 17 September 2026
    expect([11, 12, 13, 14, 15, 16, 17].map(d => planWeekIsPrimary(new Date(2026, 8, d)))).toEqual([true, true, true, false, false, false, false])
  })
})
