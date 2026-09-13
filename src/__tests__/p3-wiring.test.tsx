import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanDayApply } from '../components/PlanDaySheet'
import { applyDayPlanWrites, dayPlanToast, mealIdeaToast, shutdownToast, useFocusActions, type PlanPorts } from '../components/planner/useFocusActions'
import { useLifeActions } from '../components/planner/useLifeActions'
import { useTaskActions } from '../components/planner/useTaskActions'
import { dayClosed } from '../dayclose'
import { planDayWrites, type ShutdownResult } from '../focus'
import type { Store } from '../store'
import type { CalendarEntry, GroceryList, Item, Meal, Recipe, Task, TaskStatus } from '../types'
import { dateKey } from '../utils'
import { newerStamp, nextOccurrence } from '../../shared/domain.mjs'
import { plannerSource } from './source'

// The daily routines wired into the shell: what Plan my day and Shut down
// write through the planner's own save paths, and what one Undo puts back.
// The hooks are rendered for real (react-dom/server runs their bodies; no
// effect is needed here) against an in-memory store. The links and Today's
// props that open the sheets are in p3-links.test.tsx.

const TODAY = '2026-09-14' // a Monday
const TOMORROW = '2026-09-15'
const STAMP = '2026-09-01T00:00:00.000Z'
/** A September day in local time. */
const at = (d: number, h = 0, m = 0) => new Date(2026, 8, d, h, m).toISOString()
const task = (id: string, over: Partial<Task> = {}): Task => ({ kind: 'task', id, title: id, description: '', status: 'todo', priority: 'normal', createdAt: STAMP, updatedAt: STAMP, tags: [], ...over })
const recipe = (id: string, name: string, ingredients: string[]): Recipe => ({
  kind: 'recipe',
  id,
  name,
  ingredients: ingredients.map((n, i) => ({ id: `${id}-${i}`, name: n })),
  tags: [],
  createdAt: STAMP,
  updatedAt: STAMP,
})
const soup = recipe('soup', 'Leek soup', ['Leeks', 'Stock'])
const pasta = recipe('pasta', 'Pasta', ['Basil', 'Spaghetti'])

/**
 * The store as a render sees it. Reads come from the last render (`render()`
 * takes a new snapshot, as the re-render after a toast would), so two writes
 * in one tick cannot see each other — exactly the case the meal fold is for.
 * Writes land at once, and setStatus works on the live rows as the sync engine
 * does, spawning a repeat's next copy.
 */
function world(seed: Item[]) {
  let items: Item[] = seed.map(i => ({ ...i }))
  let seen = items
  const live = (kind: Item['kind']) => seen.filter(i => i.kind === kind && !i.deletedAt)
  const put = (item: Item) => {
    items = [...items.filter(i => i.id !== item.id), item]
  }
  const store = {
    loaded: true,
    get allItems() {
      return seen
    },
    get tasks() {
      return live('task') as Task[]
    },
    get events() {
      return live('event') as CalendarEntry[]
    },
    get meals() {
      return live('meal') as Meal[]
    },
    get recipes() {
      return live('recipe') as Recipe[]
    },
    get groceries() {
      return live('grocery') as GroceryList[]
    },
    projects: [],
    people: [],
    places: [],
    journal: [],
    upsert: vi.fn(put),
    remove: vi.fn((id: string) => {
      const cur = items.find(i => i.id === id)
      if (cur) put({ ...cur, deletedAt: new Date().toISOString(), updatedAt: newerStamp(cur.updatedAt) })
    }),
    restore: vi.fn(),
    purge: vi.fn(),
    setStatus: vi.fn((id: string, status: TaskStatus) => {
      const old = items.find((i): i is Task => i.id === id && i.kind === 'task')
      if (!old || old.status === status) return null
      const updated: Task = { ...old, status, updatedAt: newerStamp(old.updatedAt), completedAt: status === 'done' ? new Date().toISOString() : undefined }
      // the copy's id is deterministic (the task and its next date), whatever id function is passed
      const spawned: Task | null = status === 'done' && updated.recurrence ? nextOccurrence(updated, () => '') : null
      const stored: Task = spawned ? { ...updated, recurrence: undefined } : updated
      put(stored)
      if (spawned) put(spawned)
      return { prev: old, next: stored, spawnedId: spawned?.id }
    }),
  }
  return {
    store: store as unknown as Store & typeof store,
    render: () => {
      seen = items
    },
    get: (id: string) => items.find(i => i.id === id),
    all: () => items,
  }
}

/** The shell's task, meal and focus hooks over that store; the calendar's two entry paths stand in for useCalendarSync's. */
function mount(w: ReturnType<typeof world>) {
  const toasts: { msg: string; undo?: () => void }[] = []
  const mirrored: CalendarEntry[] = []
  const showToast = (msg: string, undo?: () => void) => void toasts.push({ msg, undo })
  const out = { toasts, mirrored } as { toasts: typeof toasts; mirrored: CalendarEntry[]; focus: ReturnType<typeof useFocusActions>; task: ReturnType<typeof useTaskActions> }
  function Shell() {
    const { store } = w
    const task = useTaskActions({ store, showToast, setEditor: () => {}, setProjectEditor: () => {}, setNotesProjectId: () => {} })
    const life = useLifeActions({ store, showToast, newTask: () => {} })
    // as useCalendarSync writes them: a saved entry goes out to the mirrors, a removed one goes out as its tombstone
    const cal = {
      mirrorEvent: (e: CalendarEntry) => void mirrored.push(e),
      removeEvent: (id: string) => {
        const gone = store.events.find(e => e.id === id)
        store.remove(id)
        if (gone) mirrored.push({ ...gone, deletedAt: new Date().toISOString() })
      },
    }
    out.task = task
    out.focus = useFocusActions({ store, household: { myId: 'me' }, showToast, ...task, ...cal, ...life })
    return null
  }
  renderToString(<Shell />)
  return out
}

/** The repeat setStatus spawned when `id` was marked done, as the change it returned names it. */
const spawnedFor = (w: ReturnType<typeof world>, id: string): string => {
  const change = w.store.setStatus.mock.results.map(r => r.value as { prev: Task; spawnedId?: string } | null).find(v => v?.prev.id === id)
  if (!change?.spawnedId) throw new Error(`no repeat spawned for ${id}`)
  return change.spawnedId
}

const withoutStamp = (i: Item | undefined) => {
  if (!i) return i
  const { updatedAt: _stamp, ...rest } = i
  return rest
}
const groceryNames = (w: ReturnType<typeof world>) =>
  w
    .all()
    .filter((i): i is GroceryList => i.kind === 'grocery' && !i.deletedAt)
    .flatMap(g => g.items.filter(l => !l.removed).map(l => l.name))
    .sort()

/** localStorage as a Map, for the device-only "Day closed" note. */
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 14, 9, 0))
  memoryStorage()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Plan my day, applied (B2)', () => {
  const seed = (): Item[] => [
    task('late', { title: 'Renew passport', dueAt: at(10, 9) }),
    task('chore', { title: 'Water the plants', dueAt: at(12, 9), recurrence: { freq: 'weekly' } }),
    task('wish', { title: 'Someday', dueAt: at(11, 9) }),
    task('pick', { title: 'Sort the garage' }),
    task('old', { title: 'Old focus', focusOn: TODAY, focusBy: 'me' }),
    soup,
    pasta,
  ]
  const plan: PlanDayApply = {
    moves: [
      { id: 'late', to: 'today' },
      { id: 'chore', to: 'done' },
      { id: 'wish', to: 'wishlist' },
    ],
    focusIds: ['pick', 'fresh'],
    newTasks: [{ id: 'fresh', title: 'Call the plumber' }],
    blocks: [
      { taskId: 'pick', title: 'Sort the garage', start: at(14, 10), end: at(14, 11) },
      { taskId: 'fresh', title: 'Call the plumber', start: at(14, 11, 30), end: at(14, 12) },
    ],
    meals: [
      { dayKey: TODAY, slot: 'lunch', idea: { key: 'l', kind: 'recipe', id: 'soup', title: 'Leek soup', why: '' } },
      { dayKey: TODAY, slot: 'dinner', idea: { key: 'd', kind: 'recipe', id: 'pasta', title: 'Pasta', why: '' } },
    ],
  }
  const t = (w: ReturnType<typeof world>, id: string) => w.get(id) as Task

  it('writes the whole plan through the shell’s paths, and says so in one toast', () => {
    const w = world(seed())
    const m = mount(w)
    m.focus.applyDayPlan(plan)

    expect(m.toasts.map(x => x.msg)).toEqual(['Today’s focus set · 2 blocks added · lunch & dinner planned'])
    expect(dateKey(t(w, 'late').dueAt!)).toBe(TODAY)
    // Wishlist and Done go through setStatus, which spawns the chore's next copy
    expect(w.store.setStatus.mock.calls.map(c => c.slice(0, 2))).toEqual([
      ['chore', 'done'],
      ['wish', 'wishlist'],
    ])
    expect(t(w, 'chore').status).toBe('done')
    expect(w.get(spawnedFor(w, 'chore'))).toMatchObject({ kind: 'task', status: 'todo', title: 'Water the plants' })
    expect(t(w, 'wish').status).toBe('wishlist')
    expect(t(w, 'pick')).toMatchObject({ focusOn: TODAY, focusBy: 'me' })
    expect(t(w, 'fresh')).toMatchObject({ title: 'Call the plumber', focusOn: TODAY, focusBy: 'me', status: 'todo' })
    // a pick you took off today's list loses its focus
    expect(t(w, 'old').focusOn).toBeUndefined()

    // each block saved, carrying its task, and sent to the mirrors
    const blocks = w.all().filter((i): i is CalendarEntry => i.kind === 'event')
    expect(blocks.map(b => b.taskId).sort()).toEqual(['fresh', 'pick'])
    expect(m.mirrored.map(e => e.id).sort()).toEqual(blocks.map(b => b.id).sort())

    // both meals, and one list holding both — the dinner's rebuild did not drop the lunch's lines
    expect(w.get(`meal~${TODAY}~lunch`)).toMatchObject({ recipeId: 'soup', title: 'Leek soup' })
    expect(w.get(`meal~${TODAY}~dinner`)).toMatchObject({ recipeId: 'pasta', title: 'Pasta' })
    expect(groceryNames(w)).toEqual(['Basil', 'Leeks', 'Spaghetti', 'Stock'])
  })

  it('one Undo, a render later, puts every record back and takes every new one away — off the mirrors too', () => {
    const w = world(seed())
    const m = mount(w)
    m.focus.applyDayPlan(plan)
    const blocks = w.all().filter((i): i is CalendarEntry => i.kind === 'event')
    const planned = t(w, 'pick').updatedAt
    w.render()
    m.toasts[0].undo!()

    for (const was of seed()) expect(withoutStamp(w.get(was.id)), was.id).toEqual(withoutStamp(was))
    // restored with a stamp that beats the plan's own write
    expect(t(w, 'pick').updatedAt > planned).toBe(true)
    for (const id of [spawnedFor(w, 'chore'), 'fresh', ...blocks.map(b => b.id), `meal~${TODAY}~lunch`, `meal~${TODAY}~dinner`]) expect(w.get(id)?.deletedAt, id).toBeTruthy()
    expect(
      m.mirrored
        .filter(e => e.deletedAt)
        .map(e => e.taskId)
        .sort(),
    ).toEqual(['fresh', 'pick'])
    // and the list is rebuilt without either meal
    expect(groceryNames(w)).toEqual([])
    expect(m.toasts).toHaveLength(1)
  })
})

describe('what a plan writes through (the pure half)', () => {
  it('pushes a task to its GitHub board only when its column or date moved, and every restored task on Undo', () => {
    const tasks = [task('dated', { dueAt: at(10, 9) }), task('focused')]
    const w = planDayWrites(tasks, { moves: [{ id: 'dated', to: 'tomorrow' }], focusIds: ['focused'], blocks: [] }, { today: TODAY, myId: 'me', now: new Date(2026, 8, 14, 9), newId: () => 'x' })
    const log: string[] = []
    const ports: PlanPorts = {
      tasks: () => tasks,
      upsert: i => void log.push(`upsert ${i.id}`),
      remove: id => void log.push(`remove ${id}`),
      applyStatus: (id, s) => {
        log.push(`status ${id} ${s}`)
        return null
      },
      pushToProjectBoard: x => void log.push(`board ${x.id}`),
      mirrorEvent: e => void log.push(`mirror ${e.id}`),
      removeEvent: id => void log.push(`unmirror ${id}`),
      saveMeals: ms => void log.push(`meals ${ms.length}`),
      clearMeals: ids => void log.push(`clear ${ids.length}`),
    }
    const undo = applyDayPlanWrites(() => ports, w, [])
    // a focus is not on the board: only the date move is pushed
    expect(log).toEqual(['upsert dated', 'board dated', 'upsert focused'])
    log.length = 0
    undo()
    expect(log).toEqual(['upsert dated', 'board dated', 'upsert focused', 'board focused'])
  })

  it('says what happened in one line', () => {
    const block = { kind: 'event', id: 'b', title: 'b', start: at(14, 10), end: at(14, 11), allDay: false, createdAt: STAMP, updatedAt: STAMP } as CalendarEntry
    expect(dayPlanToast({ events: [] }, [])).toBe('Today’s focus set')
    expect(dayPlanToast({ events: [block] }, [])).toBe('Today’s focus set · 1 block added')
    expect(dayPlanToast({ events: [block, block] }, [{ slot: 'dinner' }])).toBe('Today’s focus set · 2 blocks added · dinner planned')
    expect(shutdownToast({ moves: [], tomorrowFocusIds: [] })).toBe('Day closed')
    expect(shutdownToast({ moves: [{ id: 'a', to: 'done' }], tomorrowFocusIds: ['b'] })).toBe('Day closed · 1 moved · tomorrow’s focus set')
    expect(mealIdeaToast({ slot: 'lunch', title: 'Pret' })).toBe('Planned “Pret” for lunch')
  })
})

describe('Shut down, applied (B3)', () => {
  const seed = (): Item[] => [
    task('f1', { title: 'Sort the garage', focusOn: TODAY, focusBy: 'me', dueAt: at(14) }),
    task('d1', { title: 'Put the bins out', dueAt: at(14, 9), recurrence: { freq: 'weekly' } }),
    task('t2', { title: 'Book the MOT' }),
  ]
  const r: ShutdownResult = {
    moves: [
      { id: 'f1', to: 'tomorrow' },
      { id: 'd1', to: 'done' },
    ],
    tomorrowFocusIds: ['f1', 't2'],
  }

  it('moves the leftovers, sets tomorrow’s focus and closes the day; Undo reopens it and puts it all back', () => {
    const w = world(seed())
    const m = mount(w)
    m.focus.applyShutdown(r)

    expect(m.toasts.map(x => x.msg)).toEqual(['Day closed · 2 moved · tomorrow’s focus set'])
    expect(dayClosed(TODAY)).toBe(true)
    const f1 = w.get('f1') as Task
    expect(dateKey(f1.dueAt!)).toBe(TOMORROW)
    expect(f1).toMatchObject({ focusOn: TOMORROW, focusBy: 'me' })
    expect(w.get('t2')).toMatchObject({ focusOn: TOMORROW })
    expect(w.get('d1')).toMatchObject({ status: 'done' })
    expect(w.get(spawnedFor(w, 'd1'))).toMatchObject({ status: 'todo' })

    w.render()
    m.toasts[0].undo!()
    for (const was of seed()) expect(withoutStamp(w.get(was.id)), was.id).toEqual(withoutStamp(was))
    expect(w.get(spawnedFor(w, 'd1'))?.deletedAt).toBeTruthy()
    expect(dayClosed(TODAY)).toBe(false)
  })
})

describe('the focus card’s defer and the meal ideas (B4)', () => {
  it('defers from focus in one write that also clears the focus, and Undo restores both', () => {
    const w = world([task('f1', { focusOn: TODAY, focusBy: 'me', dueAt: at(14, 10) })])
    const m = mount(w)
    m.focus.deferFromFocus('f1', new Date(2026, 8, 15))
    const moved = w.get('f1') as Task
    expect(dateKey(moved.dueAt!)).toBe(TOMORROW)
    expect(new Date(moved.dueAt!).getHours()).toBe(10)
    expect(moved.focusOn).toBeUndefined()
    expect(moved.focusBy).toBeUndefined()
    expect(w.store.upsert).toHaveBeenCalledTimes(1)
    expect(m.toasts).toHaveLength(1)
    expect(m.toasts[0].msg).toMatch(/^Moved to /)
    w.render()
    m.toasts[0].undo!()
    expect(w.get('f1')).toMatchObject({ focusOn: TODAY, focusBy: 'me', dueAt: at(14, 10) })
  })

  it('keeps the focus on a defer from anywhere else', () => {
    const w = world([task('f1', { focusOn: TODAY, focusBy: 'me', dueAt: at(14, 10) })])
    mount(w).task.defer('f1', new Date(2026, 8, 15))
    expect(w.get('f1')).toMatchObject({ focusOn: TODAY, focusBy: 'me' })
  })

  it('plans a meal idea over the slot’s tombstone, names it in the toast, and Undo clears it', () => {
    const tomb: Meal = { kind: 'meal', id: `meal~${TODAY}~dinner`, date: TODAY, slot: 'dinner', title: 'Old', createdAt: STAMP, updatedAt: '2026-09-20T00:00:00.000Z', deletedAt: '2026-09-20T00:00:00.000Z' }
    const w = world([pasta, tomb])
    const m = mount(w)
    m.focus.planMealIdea(TODAY, 'dinner', { key: 'k', kind: 'recipe', id: 'pasta', title: 'Pasta', why: 'Cooked 2× in six months' })
    const planned = w.get(tomb.id) as Meal
    expect(planned).toMatchObject({ recipeId: 'pasta', title: 'Pasta', slot: 'dinner', date: TODAY })
    expect(planned.deletedAt).toBeUndefined()
    // stamped newer than the tombstone, so it wins the merge
    expect(planned.updatedAt > tomb.updatedAt).toBe(true)
    expect(m.toasts.map(x => x.msg)).toEqual(['Planned “Pasta” for dinner'])
    expect(groceryNames(w)).toEqual(['Basil', 'Spaghetti'])
    w.render()
    m.toasts[0].undo!()
    expect(w.get(tomb.id)?.deletedAt).toBeTruthy()
    expect(groceryNames(w)).toEqual([])
  })
})

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('the sheets in the shell', () => {
  const overlays = read('../components/planner/Overlays.tsx')

  it('renders each planning sheet from its lazy chunk, in a Layer of its own', () => {
    expect(overlays).toMatch(/import \{[^}]*\bPlanDaySheet\b[^}]*\bShutdownSheet\b[^}]*\} from '\.\/lazy'/)
    expect(overlays).toMatch(/\{sheet\?\.kind === 'day' && \(\s*<Layer name="Plan my day">\s*<PlanDaySheet\b/)
    expect(overlays).toMatch(/\{sheet\?\.kind === 'shutdown' && \(\s*<Layer name="Shut down">\s*<ShutdownSheet\b/)
  })

  it('keeps pull to refresh off while a sheet is open', () => {
    const shell = plannerSource()
    expect(shell).toMatch(/const anyOpen = [^\n]*!!sheet\b/)
    expect(shell).toContain('<PullToRefresh enabled={!anyOpen}')
  })
})
