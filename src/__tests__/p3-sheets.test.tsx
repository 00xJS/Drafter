import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BriefingCard } from '../components/BriefingCard'
import { MealIdeasCard, dismissMealIdeas, ideaSlots, mealFromIdea, mealIdeasDismissKey, mealIdeasDismissed } from '../components/MealIdeasCard'
import { PlanDaySheet, blockOptions, blocksOn, planBlocks } from '../components/PlanDaySheet'
import { ShutdownSheet, closeDay, dayClosed, reopenDay, shutdownKey, tonightReason } from '../components/ShutdownSheet'
import { FocusCard, Today, briefingCtaLabel, leaveOutFocus } from '../components/Today'
import { freeSlots } from '../focus'
import { shiftRange, weekRange } from '../review'
import type { CalendarEntry, CalendarEvent, Meal, Place, Recipe, Review, Routine, Task } from '../types'

// The Phase 3 screens, rendered the way the planner will render them: the
// focus card and the strip's action on Today, the meal ideas, and the two
// sheets. vitest runs in node, so these are static renders plus the pure rules
// behind them; the interactions were checked in the browser.

const TODAY = '2026-09-14' // a Monday
const TOMORROW = '2026-09-15'
const STAMP = '2026-09-01T00:00:00.000Z'
/** A September day in local time. */
const at = (d: number, h = 0, m = 0) => new Date(2026, 8, d, h, m).toISOString()
const noop = () => {}
const task = (id: string, over: Partial<Task> = {}): Task => ({ kind: 'task', id, title: id, description: '', status: 'todo', priority: 'normal', createdAt: STAMP, updatedAt: STAMP, tags: [], ...over })

/** Mine: an open focus, a finished one; a household member's pick; one more due today; one overdue. */
const tasks = (): Task[] => [
  task('garage', { title: 'Sort the garage', dueAt: at(14), focusOn: TODAY, focusBy: 'me' }),
  task('bank', { title: 'Call the bank', focusOn: TODAY, focusBy: 'me', status: 'done', completedAt: at(14, 8) }),
  task('peer', { title: 'Peer pick', dueAt: at(14), focusOn: TODAY, focusBy: 'peer' }),
  task('bins', { title: 'Put the bins out', dueAt: at(14) }),
  task('late', { title: 'Renew passport', dueAt: at(10, 9) }),
]
const block: CalendarEntry = { kind: 'event', id: 'ev1', title: 'Sort the garage', start: at(14, 10), end: at(14, 11), allDay: false, taskId: 'garage', createdAt: STAMP, updatedAt: STAMP }

const recipe = (id: string, name: string, emoji?: string): Recipe => ({ kind: 'recipe', id, name, emoji, ingredients: [], tags: [], createdAt: STAMP, updatedAt: STAMP })
const meal = (date: string, slot: Meal['slot'], over: Partial<Meal> = {}): Meal => ({ kind: 'meal', id: `meal~${date}~${slot}`, date, slot, title: 'Meal', createdAt: STAMP, updatedAt: STAMP, ...over })
/** Six things with a history — enough that lunch's four ideas leave some for dinner (an idea is never offered twice in a day). */
const kitchen = () => ({
  recipes: [recipe('pasta', 'Pasta', '🍝'), recipe('soup', 'Soup'), recipe('curry', 'Curry'), recipe('stew', 'Stew'), recipe('risotto', 'Risotto')],
  places: [{ kind: 'place', id: 'pret', name: 'Pret', color: '#fff', category: 'cafe', createdAt: STAMP, updatedAt: STAMP } as Place],
  meals: [
    meal('2026-06-10', 'dinner', { recipeId: 'curry', title: 'Curry' }),
    meal('2026-05-10', 'dinner', { recipeId: 'curry', title: 'Curry' }),
    meal('2026-06-15', 'dinner', { recipeId: 'stew', title: 'Stew' }),
    meal('2026-04-15', 'dinner', { recipeId: 'stew', title: 'Stew' }),
    meal('2026-07-20', 'dinner', { recipeId: 'risotto', title: 'Risotto' }),
    meal('2026-06-20', 'dinner', { recipeId: 'risotto', title: 'Risotto' }),
    meal('2026-08-01', 'dinner', { recipeId: 'pasta', title: 'Pasta' }),
    meal('2026-07-01', 'dinner', { recipeId: 'pasta', title: 'Pasta' }),
    meal('2026-08-03', 'lunch', { recipeId: 'soup', title: 'Soup' }),
    meal('2026-07-03', 'lunch', { recipeId: 'soup', title: 'Soup' }),
    meal('2026-08-20', 'lunch', { out: true, placeId: 'pret', title: 'Pret' }),
    meal('2026-08-10', 'lunch', { out: true, placeId: 'pret', title: 'Pret' }),
  ],
})

/** localStorage as a Map, for the device-only notes (Day closed, Not today). */
function memoryStorage(): Map<string, string> {
  const m = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    get length() {
      return m.size
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  })
  return m
}

/** The slice of `html` from `marker` to the end of the section it opens. */
function sectionAt(html: string, marker: string): string {
  const from = html.indexOf(marker)
  if (from < 0) return ''
  return html.slice(from, html.indexOf('</section>', from))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 14, 9, 0))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the strip’s action (B5)', () => {
  it('plans the morning, shuts down the evening once a focus is set (or late), and says when the day is closed', () => {
    expect(briefingCtaLabel({ hour: 9, hasFocus: false, closed: false })).toBe('Plan my day')
    expect(briefingCtaLabel({ hour: 16, hasFocus: true, closed: false })).toBe('Plan my day')
    expect(briefingCtaLabel({ hour: 17, hasFocus: true, closed: false })).toBe('Shut down')
    expect(briefingCtaLabel({ hour: 18, hasFocus: false, closed: false })).toBe('Plan my day')
    expect(briefingCtaLabel({ hour: 20, hasFocus: false, closed: false })).toBe('Shut down')
    expect(briefingCtaLabel({ hour: 9, hasFocus: true, closed: true })).toBe('Day closed')
  })

  it('is the first tile, a real button, and never in the header', () => {
    const html = renderToStaticMarkup(<BriefingCard events={[]} habits={[]} dinner={null} now={new Date(2026, 8, 14, 9)} cta={{ label: 'Plan my day', onClick: noop }} />)
    const tiles = html.indexOf('<ul class="briefing-tiles">')
    expect(html.slice(tiles)).toMatch(/^<ul class="briefing-tiles"><li class="briefing-tile briefing-cta"><button type="button" class="briefing-cta-btn">/)
    expect(html.slice(tiles)).toContain('Plan my day')
    expect(html.slice(0, tiles)).not.toContain('Plan my day')
  })

  it('is a statement, not a button, without onClick; and no tiles at all without it on an empty day', () => {
    const closed = renderToStaticMarkup(<BriefingCard events={[]} habits={[]} dinner={null} now={new Date()} cta={{ label: 'Day closed' }} />)
    expect(closed).toContain('<li class="briefing-tile briefing-cta closed"><span class="briefing-cta-btn">')
    expect(closed).not.toContain('<button type="button" class="briefing-cta-btn"')
    expect(renderToStaticMarkup(<BriefingCard events={[]} habits={[]} dinner={null} now={new Date()} />)).not.toContain('briefing-tiles')
  })
})

describe('today’s focus on Today (B4)', () => {
  it('finds each task’s block: its earliest timed entry today that names it', () => {
    const entries: CalendarEntry[] = [
      { ...block, id: 'later', start: at(14, 15), end: at(14, 16) },
      block,
      { ...block, id: 'gone', start: at(14, 8), end: at(14, 9), deletedAt: at(13) },
      { ...block, id: 'all-day', allDay: true, start: TODAY, end: TOMORROW },
      { ...block, id: 'tomorrow', start: at(15, 8), end: at(15, 9) },
      { ...block, id: 'plain', taskId: undefined, start: at(14, 7), end: at(14, 8) },
    ]
    const found = blocksOn(entries, TODAY)
    expect([...found.keys()]).toEqual(['garage'])
    expect(found.get('garage')?.id).toBe('ev1')
  })

  it('leaves focus out of a section, counts what left, and drops a section left empty', () => {
    const [garage, , , bins] = tasks()
    const out = leaveOutFocus(
      [
        { key: 'today', tasks: [garage, bins] },
        { key: 'doing', tasks: [garage] },
        { key: 'week', tasks: [bins] },
      ],
      new Set(['garage']),
    )
    expect(out.map(s => [s.key, s.tasks.map(t => t.id), s.inFocus])).toEqual([
      ['today', ['bins'], 1],
      ['week', ['bins'], 0],
    ])
  })

  it('reads "N of M done" with each block’s time, and is not drawn when empty', () => {
    const [garage, bank] = tasks()
    const card = (ts: Task[]) =>
      renderToStaticMarkup(<FocusCard tasks={ts} blocks={blocksOn([block], TODAY)} onOpen={noop} onStatus={noop} onDefer={noop} onEdit={noop} />)
    const html = card([garage, bank])
    expect(html).toContain('1 of 2 done')
    expect(html).toContain('10am–11am')
    expect(html).toContain('>Edit</button>')
    expect(card([bank])).toContain('All done')
    expect(card([bank, { ...bank, id: 'b2' }, { ...bank, id: 'b3' }])).toContain('All three done')
    expect(card([])).toBe('')
  })

  const review: Review = {
    kind: 'review',
    id: 'r1',
    period: 'week',
    key: shiftRange(weekRange(new Date(2026, 8, 14, 9)), -1).key,
    top: ['Sort the garage', 'Paint the fence'],
    createdAt: STAMP,
    updatedAt: STAMP,
  }

  function renderToday(over: Partial<ComponentProps<typeof Today>> = {}) {
    // the journal card asks the viewport how wide it is; a static render has none
    if (typeof window === 'undefined') vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) })
    const ts = tasks()
    const props: ComponentProps<typeof Today> = {
      tasks: ts,
      allTasks: ts,
      people: [],
      places: [],
      reviews: [review],
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
      myId: 'me',
      entries: [block],
      onPlanDay: noop,
      onShutDown: noop,
      ...over,
    }
    return renderToStaticMarkup(<Today {...props} />)
  }

  it('puts the focus card directly under the briefing strip, with only your picks', () => {
    const html = renderToday()
    const strip = html.indexOf('class="chart-card briefing"')
    const focus = html.indexOf('id="today-focus"')
    expect(strip).toBeGreaterThan(-1)
    expect(focus).toBeGreaterThan(strip)
    expect(html.indexOf('class="kpi-row"')).toBeGreaterThan(focus)
    const card = sectionAt(html, 'id="today-focus"')
    expect(card).toContain('Sort the garage')
    expect(card).toContain('Call the bank')
    expect(card).toContain('1 of 2 done')
    expect(card).toContain('10am–11am')
    // a household member's pick is theirs, not yours
    expect(card).not.toContain('Peer pick')
  })

  it('lists a focus task nowhere else, says so, and still counts it', () => {
    const html = renderToday()
    const due = sectionAt(html, 'id="today-today"')
    expect(due).toContain('Put the bins out')
    expect(due).toContain('Peer pick')
    expect(due).not.toContain('Sort the garage')
    expect(due).toContain('+ 1 in today’s focus')
    const next = sectionAt(html, 'class="chart-card next-up"')
    expect(next).not.toContain('Sort the garage')
    expect(next).toContain('in today’s focus')
    // the tile counts the day, focus and all
    expect(html).toMatch(/Due today<\/div><div class="stat-value">3</)
  })

  it('keeps the week’s 3 lines, badging the one whose task is in today’s focus', () => {
    const top = sectionAt(html(), 'class="chart-card week-top3"')
    expect(top).toContain('Paint the fence')
    expect(top.match(/Today’s focus/g)).toHaveLength(1)
    function html() {
      return renderToday()
    }
  })

  it('offers Plan my day in the morning, Shut down in the evening, and Day closed after it', () => {
    expect(sectionAt(renderToday(), 'class="chart-card briefing"')).toContain('Plan my day')
    vi.setSystemTime(new Date(2026, 8, 14, 18, 0))
    expect(sectionAt(renderToday(), 'class="chart-card briefing"')).toContain('Shut down')
    memoryStorage()
    closeDay(TODAY)
    expect(sectionAt(renderToday(), 'class="chart-card briefing"')).toContain('Day closed')
  })

  it('reads as before until the planner passes the new props', () => {
    const html = renderToday({ myId: undefined, entries: undefined, onPlanDay: undefined, onShutDown: undefined })
    expect(html).not.toContain('briefing-cta')
    expect(sectionAt(html, 'id="today-focus"')).not.toContain('>Edit</button>')
    expect(html).not.toContain('meal-ideas')
  })

  it('shows lunch and dinner ideas only with somewhere to send a pick', () => {
    const k = kitchen()
    expect(renderToday({ ...k, places: k.places, onPlanMeal: noop })).toContain('class="chart-card meal-ideas"')
    expect(renderToday({ ...k, places: k.places })).not.toContain('meal-ideas')
  })
})

describe('lunch & dinner ideas (B4)', () => {
  it('suggests lunch until 2pm and dinner until 8pm', () => {
    expect(ideaSlots(9)).toEqual(['lunch', 'dinner'])
    expect(ideaSlots(13)).toEqual(['lunch', 'dinner'])
    expect(ideaSlots(14)).toEqual(['dinner'])
    expect(ideaSlots(20)).toEqual([])
  })

  it('plans an idea as the Kitchen would: a recipe to cook, or a place eaten out at', () => {
    const now = new Date(2026, 8, 14, 9)
    expect(mealFromIdea(TODAY, 'dinner', { key: 'k', kind: 'recipe', id: 'pasta', title: 'Pasta', why: '' }, undefined, now)).toEqual({
      kind: 'meal',
      id: `meal~${TODAY}~dinner`,
      date: TODAY,
      slot: 'dinner',
      recipeId: 'pasta',
      title: 'Pasta',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    })
    const out = mealFromIdea(TODAY, 'lunch', { key: 'k', kind: 'place', id: 'pret', title: 'Pret', why: '' }, undefined, now)
    expect(out).toMatchObject({ id: `meal~${TODAY}~lunch`, out: true, placeId: 'pret', title: 'Pret' })
    expect(out).not.toHaveProperty('recipeId')
    // over the slot's tombstone, stamped newer so it wins the merge
    const tomb = meal(TODAY, 'lunch', { updatedAt: '2026-09-14T12:00:00.000Z', deletedAt: '2026-09-14T12:00:00.000Z' })
    expect(mealFromIdea(TODAY, 'lunch', { key: 'k', kind: 'recipe', id: 'soup', title: 'Soup', why: '' }, tomb, now).updatedAt > tomb.updatedAt).toBe(true)
  })

  it('remembers "Not today" for the day, on this device, and forgets older days', () => {
    const store = memoryStorage()
    store.set(mealIdeasDismissKey('2026-09-13'), '1')
    expect(mealIdeasDismissed(TODAY)).toBe(false)
    dismissMealIdeas(TODAY)
    expect(mealIdeasDismissed(TODAY)).toBe(true)
    expect([...store.keys()]).toEqual([mealIdeasDismissKey(TODAY)])
  })

  const card = (over: Partial<ComponentProps<typeof MealIdeasCard>> = {}) =>
    renderToStaticMarkup(<MealIdeasCard dayKey={TODAY} now={new Date(2026, 8, 14, 9)} tasks={[]} onPlan={noop} {...kitchen()} {...over} />)

  it('offers ideas for each empty slot, each with why it is there', () => {
    const html = card()
    expect(html).toContain('Lunch &amp; dinner ideas')
    for (const s of ['Pasta', 'Soup', 'Pret', 'Not today']) expect(html).toContain(s)
    expect(html).toMatch(/Cooked 2× in six months|Been 2× in six months/)
    expect(html).toContain('🍝')
  })

  it('drops lunch in the afternoon, everything in the evening, a planned slot, and a dismissed day', () => {
    const afternoon = card({ now: new Date(2026, 8, 14, 15) })
    expect(afternoon).toContain('Dinner ideas')
    expect(afternoon).not.toContain('Lunch')
    expect(card({ now: new Date(2026, 8, 14, 20, 30) })).toBe('')
    const k = kitchen()
    expect(card({ meals: [...k.meals, meal(TODAY, 'lunch', { title: 'Sandwich' }), meal(TODAY, 'dinner', { out: true, title: 'Eating out' })] })).toBe('')
    memoryStorage()
    dismissMealIdeas(TODAY)
    expect(card()).toBe('')
  })
})

describe('Plan my day (B2)', () => {
  const ev = (id: string, start: string, end: string): CalendarEvent => ({ id, sourceId: 's', title: id, start, end, allDay: false })
  const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

  it('offers a block where it first fits, then the next places after it', () => {
    const day = freeSlots([], TODAY, new Date(2026, 8, 14, 7))
    expect(blockOptions(day, 60).map(o => `${hm(o.start)}-${hm(o.end)}`)).toEqual(['08:00-09:00', '09:00-10:00', '10:00-11:00'])
    expect(blockOptions(day, 90).map(o => hm(o.start))).toEqual(['08:00', '09:30', '11:00'])
    expect(blockOptions(day, 0)).toEqual([])
    // a gap too short for the block is stepped over
    const busy = freeSlots([ev('m', at(14, 10), at(14, 11))], TODAY, new Date(2026, 8, 14, 9))
    expect(blockOptions(busy, 60).map(o => hm(o.start))).toEqual(['11:30', '12:30', '13:30'])
  })

  it('gives each pick its own time: a later pick works around an earlier one', () => {
    const planned = planBlocks([ev('m', at(14, 10), at(14, 11))], TODAY, new Date(2026, 8, 14, 9), [
      { taskId: 'a', choice: { minutes: 60, option: 0 } },
      { taskId: 'b', choice: { minutes: 30, option: 0 } },
      { taskId: 'c', choice: { minutes: 60, option: 9 } },
      { taskId: 'd', choice: { minutes: 0, option: 0 } },
    ])
    expect(hm(planned.get('a')!.block!.start)).toBe('11:30')
    // 09:00-09:50 was too short for an hour, not for half of one
    expect(hm(planned.get('b')!.block!.start)).toBe('09:00')
    // an option past the end takes the last one offered
    const c = planned.get('c')!
    expect(c.block!.start.getTime()).toBe(c.options[c.options.length - 1].start.getTime())
    expect(c.options.every(o => o.start.getTime() >= planned.get('a')!.block!.end.getTime())).toBe(true)
    expect(planned.get('d')).toEqual({ options: [], block: null })
  })

  const sheet = (over: Partial<ComponentProps<typeof PlanDaySheet>> = {}) =>
    renderToStaticMarkup(
      <PlanDaySheet tasks={tasks()} projects={[]} reviews={[]} events={[]} today={TODAY} now={new Date(2026, 8, 14, 9)} myId="me" onApply={noop} onClose={noop} {...over} />,
    )
  const current = (html: string) => /aria-current="step"><span class="plan-step-n" aria-hidden="true">(\d)<\/span>(\w+)/.exec(html)?.slice(1)

  it('is a named dialog that starts on what is overdue', () => {
    const html = sheet()
    expect(html).toContain('role="dialog"')
    expect(html).toContain('Plan my day')
    expect(current(html)).toEqual(['1', 'Overdue'])
    expect(html).toContain('Renew passport')
    for (const s of ['All → today', 'All → tomorrow', 'Tomorrow', 'Next week', 'Wishlist']) expect(html).toContain(s)
    expect(html).toContain('Next: Focus')
  })

  it('opens on Focus when asked, with your picks on top and the rest grouped below', () => {
    const html = sheet({ initialStep: 'focus' })
    expect(current(html)).toEqual(['2', 'Focus'])
    const picks = html.slice(html.indexOf('<ol class="plan-picks">'), html.indexOf('</ol>', html.indexOf('<ol class="plan-picks">')))
    expect(picks).toContain('Sort the garage')
    expect(picks).not.toContain('Peer pick')
    expect(html).toContain('1 of 3')
    expect(html).toContain('Done already: Call the bank')
    expect(html).toContain('Due today')
    expect(html).toContain('Put the bins out')
    expect(html).toContain('placeholder="+ New task for today"')
  })

  it('falls back to Focus when there is nothing overdue', () => {
    expect(current(sheet({ tasks: tasks().filter(t => t.id !== 'late'), initialStep: 'overdue' }))).toEqual(['1', 'Focus'])
  })

  it('suggests an hour for each pick, or keeps the block it already has', () => {
    const fresh = sheet({ initialStep: 'time', mirroring: true })
    expect(fresh).toContain('Blocks show as busy on your connected calendars.')
    expect(fresh).toMatch(/aria-pressed="true">1 hour</)
    expect(fresh).toContain('9am–10am')
    const kept = sheet({ initialStep: 'time', entries: [block] })
    expect(kept).toMatch(/aria-pressed="true">Keep as is</)
    expect(kept).toContain('Already blocked 10am–11am')
    expect(kept).not.toContain('Blocks show as busy')
  })

  it('adds a Meals step when lunch or dinner is empty', () => {
    const html = sheet({ ...kitchen(), initialStep: 'meals' })
    expect(current(html)).toEqual(['4', 'Meals'])
    for (const s of ['Pasta', 'Soup', 'Pret']) expect(html).toContain(s)
    // no kitchen, no step
    expect(sheet()).not.toContain('>Meals<')
  })
})

describe('Shut down (B3)', () => {
  it('says the candidates’ reasons from tonight’s side', () => {
    const c = (group: 'carried' | 'dueToday' | 'nextUp', reason: string) => tonightReason({ group, reason, task: task('x') })
    expect(c('carried', 'from yesterday')).toBe('today’s focus')
    expect(c('carried', 'from 2 days ago')).toBe('from yesterday')
    expect(c('carried', 'from 4 days ago')).toBe('from 3 days ago')
    expect(c('dueToday', 'due today')).toBe('due tomorrow')
    expect(c('dueToday', 'moved to today')).toBe('moved to tomorrow')
    expect(c('dueToday', 'due 3pm')).toBe('due 3pm tomorrow')
    expect(c('nextUp', 'due tomorrow')).toBe('due the day after')
    expect(c('nextUp', 'due 9h ago')).toBe('due tomorrow')
    expect(c('nextUp', 'project is moving')).toBe('project is moving')
  })

  it('remembers a closed day on this device only, and Undo reopens it', () => {
    const store = memoryStorage()
    store.set(shutdownKey('2026-09-13'), '1')
    expect(dayClosed(TODAY)).toBe(false)
    closeDay(TODAY)
    expect(dayClosed(TODAY)).toBe(true)
    expect([...store.keys()]).toEqual([shutdownKey(TODAY)])
    reopenDay(TODAY)
    expect(dayClosed(TODAY)).toBe(false)
  })

  const routine = (id: string, name: string, when: Routine['when'], steps: string[]): Routine => ({
    kind: 'routine',
    id,
    name,
    when,
    steps: steps.map((text, i) => ({ id: `${id}-${i}`, text })),
    ticks: [`${TODAY}|${id}-0`],
    createdAt: STAMP,
    updatedAt: STAMP,
  })
  const sheet = (over: Partial<ComponentProps<typeof ShutdownSheet>> = {}) =>
    renderToStaticMarkup(
      <ShutdownSheet
        tasks={tasks()}
        projects={[]}
        reviews={[]}
        routines={[routine('wind', 'Wind down', 'evening', ['Lights low', 'Brush teeth']), routine('am', 'Morning start', 'morning', ['Water'])]}
        journal={[{ kind: 'journal', id: `journal~${TODAY}~x`, date: TODAY, body: 'A good day', mood: 4, createdAt: STAMP, updatedAt: STAMP }]}
        people={[]}
        today={TODAY}
        tomorrow={TOMORROW}
        myId="me"
        onSaveRoutine={noop}
        onSaveJournal={noop}
        onDeleteJournal={noop}
        onApply={noop}
        onClose={noop}
        {...over}
      />,
    )

  it('ticks the evening routine and writes today’s line in the one journal entry', () => {
    const html = sheet()
    expect(html).toContain('role="dialog"')
    expect(html).toContain('Wind down')
    expect(html).toContain('Brush teeth')
    expect(html).toContain('1/2')
    expect(html).not.toContain('Morning start')
    // a label here, never the card's edit button
    expect(html).not.toContain('title="Edit routine"')
    expect(html).toContain('placeholder="One line about today…"')
    expect(html).toContain('A good day')
    expect(html).toContain('aria-checked="true"')
    expect(sheet({ routines: [] })).toContain('No evening routine yet')
  })

  it('lists the leftovers with your unfinished focus kept for tomorrow, and a way to move them all', () => {
    const html = sheet()
    const left = sectionAt(html, 'Left over')
    for (const s of ['Sort the garage', 'Renew passport', 'Put the bins out', 'Peer pick', 'Next week', 'Wishlist']) expect(left).toContain(s)
    expect(left).not.toContain('Call the bank')
    expect(left).toContain('Move all to tomorrow')
    // one keep box, on the one unfinished focus task of yours, and on by default
    expect(left.match(/Keep in tomorrow’s focus/g)).toHaveLength(1)
    expect(left).toMatch(/checked=""\/>Keep in tomorrow’s focus/)
    const tomorrow = sectionAt(html, 'Tomorrow’s focus')
    expect(tomorrow).toContain('1 of 3')
    expect(tomorrow.slice(tomorrow.indexOf('plan-picks'))).toContain('Sort the garage')
    expect(html).toContain('Close the day')
  })
})
