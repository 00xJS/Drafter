import { afterEach, describe, expect, it, vi } from 'vitest'

// The iPhone widget draws a snapshot the web view writes (src/widgetbridge.ts),
// and Siri's "Add to Drafter" leaves captures for the app to save. The widget
// must say what Today says — the same focus, the same Today and Overdue, the
// same dinner — show only counts while the lock-screen privacy switch is on,
// and never carry the journal. A capture must become exactly the record the
// palette's Capture or Kitchen's add box would have made.

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web', isPluginAvailable: () => false },
  registerPlugin: () => ({}),
}))

import { buildCapturedTask, quickCaptureFields } from '../capture'
import { dueSections } from '../components/Today'
import { addGroceryItem, buildGroceryList, groceryId, mealLabel, mealsForWeek } from '../kitchen'
import { weekRange } from '../review'
import { inInbox } from '../taskutils'
import type { CalendarEntry, GroceryList, Item, JournalEntry, Meal, Note, Person, Recipe, Task } from '../types'
import { focusTasks } from '../../shared/today.mjs'
import {
  CAPTURES_QUEUED,
  WIDGET_DEBOUNCE_MS,
  WIDGET_ITEMS,
  WIDGET_STALE_MS,
  buildWidgetSnapshot,
  captureRecords,
  createWidgetBridge,
  emptyWidgetSnapshot,
  parseCaptures,
  type SiriCapture,
  type WidgetBridgePlugin,
  type WidgetSnapshot,
  type WidgetSources,
  type WidgetStore,
} from '../widgetbridge'

afterEach(() => {
  vi.useRealTimers()
})

const STAMP = '2026-09-01T00:00:00.000Z'
const ME = 'me'
const THEM = 'them'
/** Tuesday 22 September 2026, 10:00 on this machine's clock. */
const NOW = new Date(2026, 8, 22, 10)
const at = (d: number, h = 0, m = 0) => new Date(2026, 8, d, h, m).toISOString()

function task(id: string, over: Partial<Task> = {}): Task {
  return { kind: 'task', id, title: id, description: '', status: 'todo', priority: 'normal', tags: [], createdAt: STAMP, updatedAt: STAMP, ...over }
}

function block(taskId: string, start: string, end: string): CalendarEntry {
  return { kind: 'event', id: `block-${taskId}`, title: taskId, start, end, allDay: false, taskId, createdAt: STAMP, updatedAt: STAMP }
}

function meal(date: string, slot: Meal['slot'], title: string, over: Partial<Meal> = {}): Meal {
  return { kind: 'meal', id: `meal~${date}~${slot}~${ME}`, date, slot, title, createdAt: STAMP, updatedAt: STAMP, ownerId: ME, ...over }
}

function recipe(id: string, name: string, ingredients: string[]): Recipe {
  return { kind: 'recipe', id, name, ingredients: ingredients.map((n, i) => ({ id: `${id}-${i}`, name: n })), tags: [], createdAt: STAMP, updatedAt: STAMP }
}

const tasks: Task[] = [
  // my focus: a block this morning, one due at 3pm, one done, and one both in focus and due
  task('Plan the garden', { focusOn: '2026-09-22', focusBy: ME }),
  task('Call the plumber', { focusOn: '2026-09-22', focusBy: ME, dueAt: at(22, 15) }),
  task('Already done', { focusOn: '2026-09-22', focusBy: ME, status: 'done' }),
  task('Pay the water bill', { focusOn: '2026-09-22', focusBy: ME, dueAt: at(22) }),
  // the other member's focus is theirs alone
  task('Their pick', { focusOn: '2026-09-22', focusBy: THEM }),
  // due today, not in focus
  task('Bins out', { dueAt: at(22) }),
  task('Pick up parcel', { dueAt: at(22, 17, 30), priority: 'high' }),
  task('', { id: 'untitled', description: 'Ring the dentist about the crown', dueAt: at(22, 12) }),
  // overdue: open and blocked count, done and deleted do not
  task('Renew passport', { dueAt: at(20, 9) }),
  task('Fix the gate', { dueAt: at(19), status: 'blocked' }),
  task('Old and done', { dueAt: at(18), status: 'done', completedAt: at(18, 10) }),
  task('Deleted today', { dueAt: at(22), deletedAt: at(21) }),
  task('Someday', { dueAt: at(22), status: 'wishlist' }),
  // tomorrow
  task('Dentist', { dueAt: at(23, 9) }),
  task('Undated'),
]

const rice = recipe('r-rice', 'Rice', ['rice'])
const curry = recipe('r-curry', 'Chicken curry', ['chicken', 'onion'])
const sources: WidgetSources = {
  tasks,
  entries: [block('Plan the garden', at(22, 9), at(22, 10, 30))],
  meals: [
    meal('2026-09-22', 'dinner', 'Chicken curry', { recipeId: curry.id, sides: [{ recipeId: rice.id, title: 'Rice' }] }),
    meal('2026-09-23', 'lunch', 'Soup'),
  ],
  recipes: [curry, rice],
  myId: ME,
}

describe('the snapshot: the day as Today shows it', () => {
  const snap = buildWidgetSnapshot(sources, { now: NOW, generic: false })
  const [today, tomorrow] = snap.days

  it('lists my open focus first, then the rest due today, and counts what is left', () => {
    expect(today.day).toBe('2026-09-22')
    // focus, in the focus card's order, then Today's section in its own order
    expect(today.items).toEqual([
      { title: 'Plan the garden', time: '9am–10:30am', focus: true },
      { title: 'Call the plumber', time: '3pm', focus: true },
      { title: 'Pay the water bill', focus: true },
    ])
    expect(today.items).toHaveLength(WIDGET_ITEMS)
    expect(today.count).toBe(6)
    expect(today.more).toBe(3)
    expect(today.overdue).toBe(2)
  })

  it('is the focus card and the Today and Overdue sections, by the functions Today calls', () => {
    const focus = focusTasks(tasks, '2026-09-22', ME).filter(t => t.status !== 'done')
    const { overdue, today: due } = dueSections(tasks, NOW)
    const left = [...focus, ...due.filter(t => !focus.includes(t))]
    expect(today.count).toBe(left.length)
    expect(today.overdue).toBe(overdue.length)
    expect(today.items.map(i => i.title)).toEqual(left.slice(0, WIDGET_ITEMS).map(t => t.title || t.description))
    // the other member's pick, a finished focus, a wish and a deleted task are nowhere
    const all = JSON.stringify(snap)
    for (const gone of ['Their pick', 'Already done', 'Someday', 'Deleted today', 'Undated']) expect(all).not.toContain(gone)
  })

  it('names an untitled task the way its row does, and times a due task on its day', () => {
    const wide = buildWidgetSnapshot({ ...sources, tasks: tasks.filter(t => !t.focusOn) }, { now: NOW, generic: false }).days[0]
    expect(wide.items).toEqual([
      { title: 'Bins out', focus: false },
      { title: 'Ring the dentist about the crown', time: '12pm', focus: false },
      { title: 'Pick up parcel', time: '5:30pm', focus: false },
    ])
  })

  it('carries tonight’s dinner by Kitchen’s rule, and a day with only lunch as lunch', () => {
    expect(today.dinner).toEqual({ title: 'Chicken curry with Rice', when: 'Tonight', out: false })
    expect(today.dinner?.title).toBe(mealLabel(sources.meals[0]))
    expect(tomorrow.dinner).toEqual({ title: 'Soup', when: 'Lunch', out: false })
    const out = buildWidgetSnapshot({ ...sources, meals: [meal('2026-09-22', 'dinner', 'Pizza night', { out: true })] }, { now: NOW, generic: false })
    expect(out.days[0].dinner).toEqual({ title: 'Pizza night', when: 'Tonight', out: true })
    expect(out.days[1]).not.toHaveProperty('dinner')
  })

  it('reads tomorrow from its midnight, so what is still open tonight counts as overdue there', () => {
    expect(tomorrow.day).toBe('2026-09-23')
    expect(tomorrow.items).toEqual([{ title: 'Dentist', time: '9am', focus: false }])
    expect(tomorrow.count).toBe(1)
    // the two overdue, plus the five still open that are due today
    expect(tomorrow.overdue).toBe(dueSections(tasks, new Date(2026, 8, 23)).overdue.length)
    expect(tomorrow.overdue).toBe(2 + 5)
  })

  it('goes stale twelve hours after it was written', () => {
    expect(snap.v).toBe(1)
    expect(snap.generatedAt).toBe(NOW.toISOString())
    expect(Date.parse(snap.staleAt) - Date.parse(snap.generatedAt)).toBe(WIDGET_STALE_MS)
    expect(WIDGET_STALE_MS).toBe(12 * 60 * 60 * 1000)
    // after a sign-out there is no day to show at all
    const empty = emptyWidgetSnapshot(NOW)
    expect(empty.days).toEqual([])
    expect(empty.staleAt).toBe(empty.generatedAt)
  })
})

describe('the snapshot with details hidden on the lock screen', () => {
  const generic = buildWidgetSnapshot(sources, { now: NOW, generic: true })

  it('carries the counts and nothing that names a task or a meal', () => {
    expect(generic.generic).toBe(true)
    expect(generic.days.map(d => [d.count, d.overdue, d.items.length, d.more])).toEqual([
      [6, 2, 0, 6],
      [1, 7, 0, 1],
    ])
    for (const d of generic.days) expect(d).not.toHaveProperty('dinner')
    const json = JSON.stringify(generic)
    for (const t of tasks) if (t.title) expect(json).not.toContain(t.title)
    for (const words of ['Chicken', 'Rice', 'Soup', 'Ring the dentist', '"time"', '"dinner"']) expect(json).not.toContain(words)
  })
})

describe('Siri’s captures', () => {
  const said = new Date(2026, 8, 21, 20) // Monday evening; the app opens on Tuesday
  const people: Person[] = [{ kind: 'person', id: 'p1', name: 'Mum', color: '#f00', group: 'family', createdAt: STAMP, updatedAt: STAMP }]
  const base = { myId: ME, tasks: [] as Task[], people, groceries: [] as GroceryList[], meals: [] as Meal[], recipes: [] as Recipe[], now: NOW }
  let n = 0
  const newId = () => `new-${++n}`

  it('reads only what this build understands', () => {
    expect(parseCaptures(null)).toEqual([])
    expect(
      parseCaptures([
        { id: 'a', kind: 'task', text: '  Call Mum  ', at: said.toISOString() },
        { id: 'b', kind: 'note', text: 'no such kind', at: '' },
        { id: 'c', kind: 'grocery', text: '   ' },
        'milk',
        { kind: 'grocery', text: 'Milk' },
      ]),
    ).toEqual([
      { id: 'a', kind: 'task', text: 'Call Mum', at: said.toISOString() },
      { id: '', kind: 'grocery', text: 'Milk', at: '' },
    ])
  })

  it('makes a task exactly as the palette’s Capture does, read as of when it was said', () => {
    const id = '0F8FAD5B-D9CB-469F-A165-70867728950E'
    const capture: SiriCapture = { id, kind: 'task', text: 'Call the plumber tomorrow at 3pm', at: said.toISOString() }
    const [record] = captureRecords([capture], { ...base, newId })
    expect(record).toEqual(buildCapturedTask(quickCaptureFields(capture.text, said), { people }, { id: id.toLowerCase(), now: said }))
    // "tomorrow" is the day after Monday, not after the Tuesday the app opened on
    expect((record as Task).dueAt).toBe(at(22, 15))
    expect((record as Task).createdAt).toBe(said.toISOString())
  })

  it('lands an undated one in the Inbox, and saves a capture it has already saved only once', () => {
    const id = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
    const [stamps] = captureRecords([{ id, kind: 'task', text: 'Buy stamps', at: said.toISOString() }], { ...base, newId })
    expect(stamps).toMatchObject({ kind: 'task', id, title: 'Buy stamps', status: 'todo' })
    expect(inInbox(stamps as Task)).toBe(true)
    // seen again (a drain that ran twice): already a task, so nothing new
    expect(captureRecords([{ id, kind: 'task', text: 'Buy stamps', at: said.toISOString() }], { ...base, tasks: [stamps as Task], newId })).toEqual([])
    // no id, or one that is not a UUID: a fresh one
    const [fresh] = captureRecords([{ id: '../evil', kind: 'task', text: 'Water plants', at: 'not a date' }], { ...base, newId: () => 'fresh-id' })
    expect(fresh).toMatchObject({ id: 'fresh-id', title: 'Water plants', createdAt: NOW.toISOString() })
  })

  it('adds groceries to this week’s list as Kitchen’s add box does, building the list from the week’s meals when there is none', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const week = weekRange(NOW)
    const meals = [meal('2026-09-24', 'dinner', 'Chicken curry', { recipeId: curry.id })]
    const ctx = { ...base, meals, recipes: [curry], newId: () => 'line-1' }
    const [list] = captureRecords([{ id: 'x', kind: 'grocery', text: 'Milk', at: said.toISOString() }], ctx) as GroceryList[]

    // the Kitchen tab's addManual, step for step, on the same inputs
    const built = buildGroceryList(week.key, mealsForWeek(meals, week.start), [curry], null, undefined, ME)
    const kitchen = { ...built, id: built.id ?? groceryId(week.key, ME), weekKey: week.key, items: addGroceryItem(built.items, { name: 'Milk' }, () => 'line-1').items }
    expect(list).toEqual({ ...kitchen, updatedAt: list.updatedAt })
    expect(list.id).toBe(groceryId(week.key, ME))
    expect(list.items.map(i => [i.name, i.state, !!i.manual])).toEqual([
      ['chicken', 'need', false],
      ['onion', 'need', false],
      ['Milk', 'need', true],
    ])
  })

  it('writes to my list only, never twice for one name, and a line taken off comes back', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const week = weekRange(NOW)
    const mine: GroceryList = {
      kind: 'grocery',
      id: groceryId(week.key, ME),
      weekKey: week.key,
      ownerId: ME,
      items: [{ id: 'g1', name: 'Milk', state: 'done', recipeIds: [], manual: true, removed: true, removedRecipeIds: [] }],
      createdAt: STAMP,
      updatedAt: at(21, 9),
    }
    const theirs: GroceryList = { ...mine, id: groceryId(week.key, THEM), ownerId: THEM, items: [] }
    let ids = 0
    const records = captureRecords(
      [
        { id: '1', kind: 'grocery', text: 'milk', at: said.toISOString() },
        { id: '2', kind: 'grocery', text: 'Eggs', at: said.toISOString() },
        { id: '3', kind: 'grocery', text: 'eggs', at: said.toISOString() },
      ],
      { ...base, groceries: [theirs, mine], newId: () => `g-new-${++ids}` },
    )
    expect(records).toHaveLength(1)
    const [list] = records as GroceryList[]
    expect(list.id).toBe(mine.id)
    expect(list.items.map(i => [i.name, i.state, !!i.removed])).toEqual([
      ['Milk', 'need', false],
      ['Eggs', 'need', false],
    ])
    expect(Date.parse(list.updatedAt)).toBeGreaterThan(Date.parse(mine.updatedAt))
  })
})

// ---- the bridge: when the snapshot is written, and where captures go ---------

function fakeStore(over: Partial<WidgetStore> & { journal?: JournalEntry[]; notes?: Note[] } = {}) {
  const saved: Item[] = []
  const store: WidgetStore & { journal: JournalEntry[]; notes: Note[] } = {
    loaded: true,
    myId: ME,
    tasks: [...tasks],
    events: sources.entries,
    meals: sources.meals,
    recipes: sources.recipes,
    people: [],
    groceries: [],
    journal: [],
    notes: [],
    upsert: (item: Item) => {
      saved.push(item)
      if (item.kind === 'task') store.tasks = [...store.tasks.filter(t => t.id !== item.id), item]
      if (item.kind === 'grocery') store.groceries = [...store.groceries.filter(g => g.id !== item.id), item]
    },
    ...over,
  }
  return { store, saved }
}

function fakePlugin(captures: unknown[] = []) {
  const written: WidgetSnapshot[] = []
  const queue = [...captures]
  const plugin: WidgetBridgePlugin & { drains: number; listeners: Map<string, () => void>; queue: unknown[] } = {
    drains: 0,
    listeners: new Map(),
    queue,
    addListener: vi.fn(async (event: string, listener: () => void) => {
      plugin.listeners.set(event, listener)
      return { remove: async () => void plugin.listeners.delete(event) }
    }),
    setSnapshot: vi.fn(async ({ json }: { json: string }) => {
      written.push(JSON.parse(json) as WidgetSnapshot)
    }),
    drainCaptures: vi.fn(async () => {
      plugin.drains++
      return { captures: queue.splice(0) }
    }),
  }
  return { plugin, written }
}

describe('the bridge', () => {
  it('writes once the store has been still for two seconds', async () => {
    vi.useFakeTimers()
    const { store } = fakeStore()
    const { plugin, written } = fakePlugin()
    const bridge = createWidgetBridge({ plugin, store: () => store, generic: () => false, now: () => NOW })
    bridge.changed()
    await vi.advanceTimersByTimeAsync(1500)
    bridge.changed()
    await vi.advanceTimersByTimeAsync(WIDGET_DEBOUNCE_MS - 1)
    expect(written).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(written).toHaveLength(1)
    expect(written[0]).toEqual(buildWidgetSnapshot(sources, { now: NOW, generic: false }))
  })

  it('does not write the same day twice, except on the way out', async () => {
    vi.useFakeTimers()
    const { store } = fakeStore()
    const { plugin, written } = fakePlugin()
    const bridge = createWidgetBridge({ plugin, store: () => store, generic: () => false, now: () => NOW })
    bridge.changed()
    await vi.advanceTimersByTimeAsync(WIDGET_DEBOUNCE_MS)
    bridge.changed()
    await vi.advanceTimersByTimeAsync(WIDGET_DEBOUNCE_MS)
    expect(written).toHaveLength(1)
    // pause: written again, which is what keeps it from going stale
    expect(await bridge.flush()).toBe(true)
    expect(written).toHaveLength(2)
    // a flush takes over a debounce that was still waiting
    store.tasks = [...store.tasks, task('New today', { dueAt: at(22, 20) })]
    bridge.changed()
    await bridge.flush()
    await vi.advanceTimersByTimeAsync(WIDGET_DEBOUNCE_MS * 2)
    expect(written).toHaveLength(3)
    expect(written[2].days[0].count).toBe(7)
  })

  it('writes again when the lock-screen switch changes, with counts only', async () => {
    let generic = false
    const { store } = fakeStore()
    const { plugin, written } = fakePlugin()
    const bridge = createWidgetBridge({ plugin, store: () => store, generic: () => generic, now: () => NOW })
    await bridge.flush()
    generic = true
    vi.useFakeTimers()
    bridge.changed()
    await vi.advanceTimersByTimeAsync(WIDGET_DEBOUNCE_MS)
    expect(written.map(s => s.generic)).toEqual([false, true])
    expect(written[1].days[0].items).toEqual([])
  })

  it('never carries the journal, or a note', async () => {
    const secret = 'I told nobody about the letter'
    const { store } = fakeStore({
      journal: [{ kind: 'journal', id: 'j1', date: '2026-09-22', body: secret, createdAt: STAMP, updatedAt: STAMP, ownerId: ME }],
      notes: [{ kind: 'note', id: 'n1', title: secret, body: secret, createdAt: STAMP, updatedAt: STAMP, ownerId: ME }],
    })
    const { plugin } = fakePlugin()
    const bridge = createWidgetBridge({ plugin, store: () => store, generic: () => false, now: () => NOW })
    await bridge.flush()
    const json = vi.mocked(plugin.setSnapshot).mock.calls[0][0].json
    expect(json).toContain('Plan the garden')
    expect(json).not.toContain(secret)
  })

  it('writes nothing and drains nothing until the local copy is in', async () => {
    const { store } = fakeStore({ loaded: false })
    const { plugin, written } = fakePlugin([{ id: 'a', kind: 'task', text: 'Later', at: NOW.toISOString() }])
    const bridge = createWidgetBridge({ plugin, store: () => store, generic: () => false, now: () => NOW })
    expect(await bridge.flush()).toBe(false)
    expect(await bridge.drain()).toBe(0)
    expect(written).toEqual([])
    // the capture is still queued for the drain that comes once it is in
    expect(plugin.drains).toBe(0)
  })

  it('saves Siri’s captures through the store, one batch after another', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const { store, saved } = fakeStore()
    const first = [
      { id: '0f8fad5b-d9cb-469f-a165-70867728950e', kind: 'task', text: 'Book the MOT', at: NOW.toISOString() },
      { id: 'x', kind: 'grocery', text: 'Milk', at: NOW.toISOString() },
    ]
    const { plugin } = fakePlugin(first)
    let ids = 0
    const bridge = createWidgetBridge({ plugin, store: () => store, generic: () => false, now: () => NOW, newId: () => `id-${++ids}` })
    // launch and a resume arriving together: the second batch must see the list the first wrote
    expect(await Promise.all([bridge.drain(), bridge.drain()])).toEqual([2, 0])
    expect(saved.map(r => r.kind)).toEqual(['task', 'grocery'])
    expect(store.tasks.find(t => t.id === first[0].id)?.title).toBe('Book the MOT')

    vi.mocked(plugin.drainCaptures).mockResolvedValueOnce({ captures: [{ id: 'y', kind: 'grocery', text: 'Bread', at: NOW.toISOString() }] })
    expect(await bridge.drain()).toBe(1)
    const lists = saved.filter((r): r is GroceryList => r.kind === 'grocery')
    expect(lists).toHaveLength(2)
    expect(lists[1].id).toBe(lists[0].id)
    expect(lists[1].items.filter(i => i.manual).map(i => i.name)).toEqual(['Milk', 'Bread'])
  })

  it('saves at once what Siri adds while the app is open, and stops listening when told', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const { store, saved } = fakeStore()
    const { plugin } = fakePlugin()
    const bridge = createWidgetBridge({ plugin, store: () => store, generic: () => false, now: () => NOW })
    const stop = await bridge.watchCaptures()
    expect([...plugin.listeners.keys()]).toEqual([CAPTURES_QUEUED])
    // Siri, with Drafter in front: no resume is coming
    plugin.queue.push({ id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', kind: 'task', text: 'Ring the vet', at: NOW.toISOString() })
    plugin.listeners.get(CAPTURES_QUEUED)!()
    await vi.waitFor(() => expect(saved.map(r => (r as Task).title)).toEqual(['Ring the vet']))
    stop()
    await vi.waitFor(() => expect(plugin.listeners.size).toBe(0))
  })

  it('carries on when the bridge fails', async () => {
    const { store, saved } = fakeStore()
    const { plugin } = fakePlugin()
    vi.mocked(plugin.drainCaptures).mockRejectedValueOnce(new Error('no app group'))
    vi.mocked(plugin.setSnapshot).mockRejectedValueOnce(new Error('no app group'))
    const bridge = createWidgetBridge({ plugin, store: () => store, generic: () => false, now: () => NOW })
    expect(await bridge.drain()).toBe(0)
    expect(await bridge.flush()).toBe(false)
    expect(saved).toEqual([])
    // a write that failed is not remembered as written, so the next change still writes
    vi.useFakeTimers()
    bridge.changed()
    await vi.advanceTimersByTimeAsync(WIDGET_DEBOUNCE_MS)
    expect(plugin.setSnapshot).toHaveBeenCalledTimes(2)
  })

  it('blanks the widget on a sign-out, and writes the day again after it', async () => {
    const { store } = fakeStore()
    const { plugin, written } = fakePlugin()
    const bridge = createWidgetBridge({ plugin, store: () => store, generic: () => false, now: () => NOW })
    await bridge.flush()
    expect(await bridge.signedOut()).toBe(true)
    expect(written[1]).toEqual(emptyWidgetSnapshot(NOW))
    vi.useFakeTimers()
    bridge.changed()
    await vi.advanceTimersByTimeAsync(WIDGET_DEBOUNCE_MS)
    expect(written).toHaveLength(3)
    expect(written[2].days).toHaveLength(2)
  })
})
