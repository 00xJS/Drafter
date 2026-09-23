// Who each task and meal is about, filed once per list: the index the visit
// and outing rules read (visitsFor and plannedVisit in people.mts, outingsAt
// in places.mts). Dependency-free ESM, shared by the app, the digest and the
// MCP server.
//
// Each of those rules walked the whole list for the one person or place it
// was asked about. Home asks about every person and every place whenever a
// task changes — a tick, a defer, a sync round — and People, Places, the meal
// pickers and Stats do the same, so fifty people and thirty places walked a
// list of a few thousand tasks eighty-odd times for one change. Now the first
// question about a list files it by person and by place in one pass, and
// every later question about the same list reads its entry: one walk per
// change, however many people and places are asked about.
//
// The lists are read as the values they are everywhere else — the store's,
// seenTasks', a request's rows — and never edited in place: a list that
// changes is a new list, and a new list is filed afresh. One grown or shrunk
// in place is filed again too; one edited in place without changing length
// would not be, which nothing here does.
//
// What files a record is each rule's own test, kept here so the index and the
// rule cannot drift apart. Ordering, the viewer (ownVisit) and the time of day
// stay in the rules: they are asked per question, and cheap on one entry.

import type { Meal, Task } from '../src/types.ts'

/** The statuses a plan is still open in. */
const OPEN: readonly unknown[] = ['todo', 'doing', 'blocked']

/** A done task with its completion time: what visitsFor counts, with whoever is on it. */
export const doneWithTime = (t: Task): t is Task & { completedAt: string } => t.status === 'done' && !!t.completedAt

/** An open task tagged as a visit: what plannedVisit looks for, for whoever is on it. */
export const openVisitPlan = (t: Task): boolean => OPEN.includes(t.status) && (t.tags ?? []).includes('visit')

/** A done task out of Trash with its completion time: an outing at its place, for outingsAt. */
export const doneOuting = (t: Task | null | undefined): t is Task & { completedAt: string } => !!t && !t.deletedAt && t.status === 'done' && !!t.completedAt

/** A meal out of Trash, eaten out, with its day: an outing at its place, for outingsAt, once that day has come. */
export const mealOut = (m: Meal | null | undefined): m is Meal => !!m && !m.deletedAt && m.out === true && !!m.date

/** A list's tasks, filed. Each entry keeps the list's own order. */
export interface TaskIndex {
  /** doneWithTime, by each person on it. */
  visits: ReadonlyMap<unknown, readonly (Task & { completedAt: string })[]>
  /** openVisitPlan, by each person on it. */
  plans: ReadonlyMap<unknown, readonly Task[]>
  /** doneOuting, by its place. */
  outings: ReadonlyMap<unknown, readonly (Task & { completedAt: string })[]>
}

const NOTHING: TaskIndex = { visits: new Map(), plans: new Map(), outings: new Map() }
const NO_MEALS: ReadonlyMap<unknown, readonly Meal[]> = new Map()

/** A list's index, with the length it had when it was filed. */
const taskIndexes = new WeakMap<readonly unknown[], { length: number; index: TaskIndex | null }>()
const mealIndexes = new WeakMap<readonly unknown[], { length: number; index: ReadonlyMap<unknown, readonly Meal[]> }>()

function push<T>(map: Map<unknown, T[]>, key: unknown, value: T): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/**
 * Filed once under each person on it. The rules ask `includes`, which finds
 * a person once however often they are listed, and matches as a Map's keys
 * do (NaN finds NaN), so the Set and the Map give the same answer.
 */
function fileUnderEach<T>(map: Map<unknown, T[]>, ids: readonly unknown[] | null | undefined, value: T): void {
  if (!ids) return
  if (ids.length === 1) push(map, ids[0], value)
  else for (const id of new Set(ids)) push(map, id, value)
}

/**
 * A place's key, or none: a rule matches a place with ===, which a Map key
 * does too except for NaN, which === never matches.
 */
const placeKey = (id: unknown): boolean => id === id

/**
 * The tasks filed by person and by place, in one pass; null for a list the
 * rules would read differently from an index. That is a list with a missing
 * row (visitsFor fails on one) or with people or tags that are not lists
 * (`includes` on a string finds any part of it): rows the app's sanitizers
 * never keep, which the rules then read the slow way, exactly as before.
 */
function fileTasks(tasks: readonly Task[]): TaskIndex | null {
  const visits = new Map<unknown, (Task & { completedAt: string })[]>()
  const plans = new Map<unknown, Task[]>()
  const outings = new Map<unknown, (Task & { completedAt: string })[]>()
  for (const t of tasks) {
    if (t === null || t === undefined) return null
    const people = t.peopleIds
    if (people != null && !Array.isArray(people)) return null
    if (t.tags != null && !Array.isArray(t.tags)) return null
    if (doneWithTime(t)) fileUnderEach(visits, people, t)
    if (openVisitPlan(t)) fileUnderEach(plans, people, t)
    if (doneOuting(t) && placeKey(t.placeId)) push(outings, t.placeId, t)
  }
  return { visits, plans, outings }
}

/**
 * The index of this list of tasks: filed on the first question about it, and
 * read by every later one. Null when the rules must read the list themselves
 * (fileTasks says when), and for anything that is not a list at all.
 */
export function taskIndex(tasks: readonly Task[] | null | undefined): TaskIndex | null {
  if (!Array.isArray(tasks)) return tasks == null ? NOTHING : null
  if (tasks.length === 0) return NOTHING
  const known = taskIndexes.get(tasks)
  if (known && known.length === tasks.length) return known.index
  const index = fileTasks(tasks)
  taskIndexes.set(tasks, { length: tasks.length, index })
  return index
}

/**
 * The meals eaten out (mealOut) in this list, by their place, each in the
 * list's order: filed once per list, as taskIndex is. Null for anything that
 * is not a list, which the rule then reads itself.
 */
export function mealOutings(meals: readonly Meal[] | null | undefined): ReadonlyMap<unknown, readonly Meal[]> | null {
  if (!Array.isArray(meals)) return meals == null ? NO_MEALS : null
  if (meals.length === 0) return NO_MEALS
  const known = mealIndexes.get(meals)
  if (known && known.length === meals.length) return known.index
  const index = new Map<unknown, Meal[]>()
  for (const m of meals) if (mealOut(m) && placeKey(m.placeId)) push(index, m.placeId, m)
  mealIndexes.set(meals, { length: meals.length, index })
  return index
}
