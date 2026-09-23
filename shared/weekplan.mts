// "Plan next week", today's meal ideas and the kitchen's history: the proposals
// behind the week-plan sheet, the Today card, Plan my day, the meal assistant,
// the Sunday digest's line and (later) an MCP read tool. Pure and deterministic
// — the same records on the same day propose the same thing, whatever order
// they arrive in — and nothing here writes. There is no stored plan: a proposal
// is worked out from the data each time, so whatever was accepted drops out of
// the next one by itself. A planned meal fills its slot; a planned visit
// suppresses that person.

import type { CalendarEvent, Item, Meal, MealSlot, Person, Place, PlaceCategory, Priority, Recipe, Task } from '../src/types.ts'
import { isMineTask, isRecord, localDate, localMidnightIso } from './domain.mts'
import { shiftDayKey } from './journal.mts'
import { cookedRecipeIds, mealRecipeIds } from './kitchen.mts'
import { dayKeysIn, plannedVisit, seenStatus, seenTasks } from './people.mts'
import { outingsAt, type Outing } from './places.mts'
import { OPEN, nextUp } from './today.mts'
import { isDayKey, weekDayKeys, weekKeyOf, weekStartKey } from './weeks.mts'

export interface TargetWeek {
  /** The Sunday it starts on. */
  startKey: string
  /** Its seven days, Sunday first. */
  dayKeys: string[]
  weekKey: string
  /** The week before, whose review holds this week's Top 3. */
  prevWeekKey: string
}

export interface DinnerItem {
  key: string
  date: string
  recipeId: string
  title: string
  why: string
  /** Recipe ids for Swap to cycle through: never another night's pick. */
  alternatives: string[]
  /** The event across the dinner hour, when there is one: the row starts unticked. */
  busy: string | null
  /** The week's one never-cooked recipe. */
  isNew: boolean
}

export interface PersonItem {
  key: string
  personId: string
  title: string
  dueDay: string
  why: string
}

export interface ReschedItem {
  key: string
  taskId: string
  title: string
  fromDue: string
  toDay: string
  why: string
}

export interface BillItem {
  key: string
  taskId: string
  title: string
  dueDay: string
  amount: number | null
  autopay: boolean
}

export interface TopItem {
  key: string
  title: string
  taskId: string | null
}

export interface WeekPlan {
  week: TargetWeek
  dinners: DinnerItem[]
  people: PersonItem[]
  overdue: ReschedItem[]
  bills: BillItem[]
  top3: TopItem[]
}

/** What WeekPlanSheet hands back to the planner to apply (one Undo for all of it). */
export interface AcceptedPlan {
  dinners: { date: string; recipeId?: string; title: string; out?: boolean; placeId?: string }[]
  people: { personId: string; dueDay: string; title: string }[]
  resched: { taskId: string; toDay: string }[]
  wishlist: string[]
  top3: string[]
  dismissed: string[]
}

export interface MealIdea {
  /** idea:<day>:<slot>:<kind>:<id> — stable for the day, for dismissing. */
  key: string
  kind: 'recipe' | 'place'
  id: string
  title: string
  /** "Cooked 6× in six months", "Not cooked in 5 weeks", "Haven't been since 3 May". */
  why: string
}

export interface SlotIdeas {
  slot: MealSlot
  /** False when the slot already has a meal (cooked, eaten out, or out with no place): no ideas then. */
  missing: boolean
  ideas: MealIdea[]
}

export interface MealHistory {
  /**
   * Every recipe, by name. `cookCount` is the last six months; `timesCooked` all of them; both count a meal it
   * was a side of. `sideOnly`: on the plan only ever as a side, so never offered as a meal.
   */
  recipes: { id: string; name: string; tags: string[]; cookCount: number; timesCooked: number; lastCooked: string | null; sideOnly: boolean }[]
  /** Every place you eat at, by name. `outings` is the last six months; `visits` all of them; eaten-out meals count. */
  places: { id: string; name: string; category: string; outings: number; visits: number; lastVisit: string | null }[]
}

const DAY_MS = 86_400_000
/** A recipe cooked this recently is not suggested for next week's dinners. */
const COOLDOWN_DAYS = 14
/** How far back "cooked often" counts, for the week plan and today's ideas alike. */
const FAVOURITE_DAYS = 180
const ALTERNATIVES = 3
/** An event across the dinner hour makes a busy night (local time). */
const DINNER_HOURS: [string, string] = ['17:30', '20:00']
/** Anything on in the evening makes it a worse one for a catch-up. */
const EVENING_HOURS: [string, string] = ['17:30', '22:00']
/** Overdue work is spread so that no day ends up with more than this due. */
const MAX_DUE_PER_DAY = 3
/** The digest's rule: someone never seen is only suggested once they have been in the app a month. */
const NEVER_MIN_AGE_DAYS = 30
const PRIORITY_RANK: Partial<Record<Priority, number>> = { urgent: 3, high: 2, normal: 1, low: 0 }
const CATCH_UP_RANK: Readonly<Record<string, number>> = { overdue: 0, due: 1, never: 2 }

const IDEAS_PER_SLOT = 4
/** Today's ideas skip anything had in the last week, and anything already planned for the week ahead. */
const IDEA_COOLDOWN_DAYS = 7
const IDEA_AHEAD_DAYS = 7
/** Places you eat at, whether or not a meal was ever logged there. */
const EATING_PLACES: string[] = ['restaurant', 'fastfood', 'cafe']
/** What suits a slot beyond having been that meal before: recipe tags, and kinds of place. */
const SLOT_TAGS: Partial<Record<string, string[]>> = { breakfast: ['breakfast', 'brunch'], lunch: ['lunch', 'quick', 'easy', 'light', 'salad', 'sandwich', 'soup'], dinner: ['dinner', 'main'] }
const SLOT_PLACES: Partial<Record<string, string[]>> = { breakfast: ['cafe'], lunch: ['cafe', 'fastfood'], dinner: ['restaurant'] }
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
const liveItems = (items: readonly unknown[] | null | undefined): Record<string, unknown>[] =>
  (items ?? []).filter((i): i is Record<string, unknown> => isRecord(i) && !i.deletedAt)

/** The records of one kind among these: a row that says its kind is written with that kind's fields. */
function recordsOf<K extends Item['kind']>(items: readonly unknown[], kind: K): Extract<Item, { kind: K }>[] {
  return items.filter((i): i is Extract<Item, { kind: K }> => isRecord(i) && i.kind === kind)
}

/** What the week plan reads of a calendar event: one of ours, or a subscribed feed's occurrence. */
type Timed = Pick<CalendarEvent, 'id' | 'title' | 'start' | 'end' | 'allDay' | 'work'>

/** 'YYYY-MM-DDTHH:MM' on the wall clock in `tz` — text that sorts in time order. */
function wallClock(iso: string, tz: string | undefined): string | null {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  try {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(new Date(ms))
        .map(x => [x.type, x.value]),
    )
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
  } catch {
    const d = new Date(ms)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
}

/** Timed events overlapping `day` between two wall-clock times. A work day is working hours, not an engagement. */
function overlapping(events: readonly Timed[], day: string, [from, to]: [string, string], tz: string | undefined): Timed[] {
  const a = `${day}T${from}`
  const b = `${day}T${to}`
  return events
    .filter(ev => {
      if (ev.allDay || ev.work) return false
      const s = wallClock(ev.start, tz)
      const e = wallClock(ev.end, tz)
      return !!s && !!e && s < b && e > a
    })
    .sort((x, y) => cmp(x.start, y.start) || cmp(x.title ?? '', y.title ?? '') || cmp(x.id ?? '', y.id ?? ''))
}

// ---- the kitchen's history ----------------------------------------------------

/**
 * The recipe a meal was: its main, never a side. The proposals offer and rank
 * by this — what they propose is a meal, and the rice that went with forty
 * curries is not a dinner.
 */
const asMain = (m: Meal): string[] => (m.out || !m.recipeId ? [] : [m.recipeId])

/** A recipe's history on the meal plan, as recipeHistory reads it. */
interface RecipeStats {
  count: number
  total: number
  last: string
  lastCooked: string
  slots: Set<MealSlot>
}

/**
 * Each recipe's history on the meal plan. Per recipe: `count`, times cooked in
 * the last FAVOURITE_DAYS up to today; `total`, times cooked up to today;
 * `lastCooked`, the latest of those; `slots`, the meals it has been; and
 * `last`, the latest meal with it before `before` — which takes in meals
 * already planned, so a recipe on next Tuesday's menu cools down exactly like
 * one eaten last Tuesday. What counts as cooked is cookedRecipeIds' rule
 * (eaten-out meals are outings, not cooking); `roles` says which of a meal's
 * recipes are read. It is read two ways. With mealRecipeIds, sides included,
 * it is what was had: mealHistory's numbers, the ones the Kitchen shows, and
 * what cools a recipe down and what the proposals' reasons say. With asMain,
 * the default, it is what a recipe has been as a meal, which decides what the
 * proposals offer and in what order.
 */
function recipeHistory(meals: readonly Meal[], todayKey: string, before: string, roles: (m: Meal) => string[] = asMain): Map<string, RecipeStats> {
  const from = shiftDayKey(todayKey, -FAVOURITE_DAYS)
  const out = new Map<string, RecipeStats>()
  for (const m of meals) {
    if (!(m.date < before)) continue
    const cooked = new Set(cookedRecipeIds(m, todayKey))
    for (const id of roles(m)) {
      const s = out.get(id) ?? { count: 0, total: 0, last: '', lastCooked: '', slots: new Set<MealSlot>() }
      if (cooked.has(id)) {
        s.total++
        if (m.date >= from) s.count++
        if (m.date > s.lastCooked) s.lastCooked = m.date
        s.slots.add(m.slot)
      }
      if (m.date > s.last) s.last = m.date
      out.set(id, s)
    }
  }
  return out
}

/** Nothing with it in the last `days`, and nothing planned with it since. */
const cooledDown = (s: RecipeStats | undefined, todayKey: string, days: number): boolean => !s || s.last < shiftDayKey(todayKey, -days)

/** Every day you went to a place — task outings and meals eaten there, newest first — and the meals it has been. */
function placeHistory(p: Place, tasks: readonly Task[], meals: readonly Meal[], now: Date, tz: string | undefined): { days: string[]; slots: Set<MealSlot>; eatenOut: number } {
  // an eaten-out meal on a past day is an outing: the rule the Places tab counts by
  const outings = outingsAt(p.id, tasks, meals, now)
  const eaten = outings.filter((o): o is Extract<Outing, { kind: 'meal' }> => o.kind === 'meal')
  const days = outings
    .map(o => (o.kind === 'meal' ? o.meal.date : localDate(o.at, tz)))
    .filter((d): d is string => !!d)
    .sort()
    .reverse()
  return { days, slots: new Set(eaten.map(o => o.meal.slot)), eatenOut: eaten.length }
}

/** Somewhere you eat: a restaurant, fast food or a café — or anywhere a meal was eaten out. */
const isEatingPlace = (p: Place, h: { eatenOut: number }): boolean => EATING_PLACES.includes(p.category) || h.eatenOut > 0

/**
 * What the kitchen knows as of `dayKey`, for anything that shows or sends how
 * often something was cooked or eaten — the Kitchen's last cooked, list_recipes,
 * the meal assistant's options: every recipe with how often it was cooked (in
 * six months and in all, as a main or a side) and when last, whether it has
 * only ever been a side, and every place you eat at with its outings (in six
 * months and in all) and when last. Names and tags only: never notes. Sorted by
 * name.
 */
export function mealHistory(items: readonly unknown[], o: { dayKey: string; now?: Date; tz?: string }): MealHistory
export function mealHistory(items: readonly unknown[], { dayKey, now = new Date(), tz }: { dayKey?: string; now?: Date; tz?: string } = {}): MealHistory {
  if (dayKey === undefined || !isDayKey(dayKey)) return { recipes: [], places: [] }
  const live = liveItems(items)
  const ofKind = <K extends Item['kind']>(kind: K) => recordsOf(live, kind)
  const meals = ofKind('meal')
  const tasks = ofKind('task')
  const favouriteFrom = shiftDayKey(dayKey, -FAVOURITE_DAYS)
  const cooked = recipeHistory(meals, dayKey, shiftDayKey(dayKey, 1), mealRecipeIds)
  // on the plan, but never as the main: a side dish, not something to offer as a meal
  const onPlan = new Set(meals.flatMap(mealRecipeIds))
  const asMainEver = new Set(meals.flatMap(asMain))
  const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => cmp(a.name, b.name) || cmp(a.id, b.id)
  const recipes = ofKind('recipe')
    .map(r => {
      const s = cooked.get(r.id)
      return {
        id: r.id,
        name: r.name ?? '',
        tags: [...(r.tags ?? [])],
        cookCount: s?.count ?? 0,
        timesCooked: s?.total ?? 0,
        lastCooked: s?.lastCooked || null,
        sideOnly: onPlan.has(r.id) && !asMainEver.has(r.id),
      }
    })
    .sort(byName)
  const places = ofKind('place')
    .flatMap(p => {
      const h = placeHistory(p, tasks, meals, now, tz)
      if (!isEatingPlace(p, h)) return []
      return [{ id: p.id, name: p.name ?? '', category: p.category, outings: h.days.filter(d => d >= favouriteFrom).length, visits: h.days.length, lastVisit: h.days[0] ?? null }]
    })
    .sort(byName)
  return { recipes, places }
}

// ---- the week ----------------------------------------------------------------

/**
 * The Sunday-start week a plan is for: on Sunday the week beginning today, on
 * any other day the one beginning next Sunday. `prevWeekKey` is the week before
 * it, whose review holds its Top 3 ("Top 3 for next week"). Null for a bad key.
 */
export function targetWeek(todayKey: string): TargetWeek | null {
  const start = weekStartKey(todayKey)
  if (!start) return null
  const startKey = start === todayKey ? todayKey : shiftDayKey(start, 7)
  // a Sunday, and the one before it: real days, so each has a week
  return { startKey, dayKeys: weekDayKeys(startKey), weekKey: weekKeyOf(startKey)!, prevWeekKey: weekKeyOf(shiftDayKey(startKey, -7))! }
}

/** `s` is the recipe's history, which a recipe that is not new always has. */
function dinnerWhy(s: RecipeStats | undefined, isNew: boolean, todayKey: string): string {
  if (isNew) return 'Something new: saved, never cooked'
  const ago = daysBetween(s!.lastCooked, todayKey)
  return s!.count > 0 ? `Cooked ${s!.count}× in six months · last ${ago} days ago` : `Last cooked ${ago} days ago`
}

/**
 * A recipe for each empty night: the ones cooked most as a meal in six months
 * first (and, among those, the longest since it was had at all), never one had
 * in the last fortnight or already planned that week — as the main or a side —
 * and never twice. One never-cooked recipe a week is offered as something new,
 * on a quiet night — the weekend if one is free. The favourites go to quiet
 * nights; a busy night takes what is left and says why.
 */
function proposeDinners({
  days,
  todayKey,
  startKey,
  meals,
  recipes,
  busy,
  skip,
}: {
  days: string[]
  todayKey: string
  startKey: string
  meals: Meal[]
  recipes: Recipe[]
  busy: Map<string, string | null>
  skip: Set<string>
}): DinnerItem[] {
  const filled = new Set(meals.filter(m => m.slot === 'dinner').map(m => m.date))
  const nights = days.filter(d => !filled.has(d) && !skip.has(`dinner:${d}`))
  if (nights.length === 0 || recipes.length === 0) return []
  const inWeek = new Set(days)
  // a side counts here too: the week already has it, and a recipe that has been a side is not "never cooked"
  const plannedThisWeek = new Set(meals.filter(m => inWeek.has(m.date)).flatMap(mealRecipeIds))
  const everCooked = new Set(meals.flatMap(mealRecipeIds))
  // the week being planned, and anything after it, is not history. What is
  // offered, and in what order, goes by the meals a recipe was the main of; a
  // side is still something had, so it cools a recipe down and the reason
  // counts it, in the Kitchen's own numbers
  const mains = recipeHistory(meals, todayKey, startKey)
  const had = recipeHistory(meals, todayKey, startKey, mealRecipeIds)
  const byName = (a: Recipe, b: Recipe) => cmp(a.name ?? '', b.name ?? '') || cmp(a.id, b.id)
  // each of the pool has been a main, so it has both histories
  const pool = recipes
    .filter(r => (mains.get(r.id)?.total ?? 0) > 0 && !plannedThisWeek.has(r.id) && cooledDown(had.get(r.id), todayKey, COOLDOWN_DAYS))
    .sort((a, b) => mains.get(b.id)!.count - mains.get(a.id)!.count || cmp(had.get(a.id)!.lastCooked, had.get(b.id)!.lastCooked) || byName(a, b))
  // the newest saved recipe never cooked: most likely the one you meant to try
  const fresh = recipes.filter(r => !everCooked.has(r.id)).sort((a, b) => cmp(b.createdAt ?? '', a.createdAt ?? '') || byName(a, b))[0] ?? null

  const quiet = nights.filter(d => !busy.get(d))
  const assigned = new Map<string, Recipe>()
  const used = new Set<string>()
  const newNight = fresh ? ([days[6], days[0]].find(d => quiet.includes(d)) ?? quiet[0]) : undefined
  if (fresh && newNight) {
    assigned.set(newNight, fresh)
    used.add(fresh.id)
  }
  let next = 0
  for (const d of [...quiet, ...nights.filter(n => busy.get(n))]) {
    if (assigned.has(d)) continue
    if (next >= pool.length) break
    assigned.set(d, pool[next])
    used.add(pool[next].id)
    next++
  }
  const spare = pool.filter(r => !used.has(r.id))

  const out: DinnerItem[] = []
  for (const d of nights) {
    const r = assigned.get(d)
    if (!r) continue
    // each night's Swap cycles a different few of the spares where there are enough
    const offset = out.length * ALTERNATIVES
    const alternatives = Array.from({ length: Math.min(ALTERNATIVES, spare.length) }, (_, j) => spare[(offset + j) % spare.length].id)
    const isNew = r === fresh
    out.push({ key: `dinner:${d}`, date: d, recipeId: r.id, title: r.name, why: dinnerWhy(had.get(r.id), isNew, todayKey), alternatives, busy: busy.get(d) ?? null, isNew })
  }
  return out
}

/**
 * Anyone due or overdue a catch-up with no visit already planned, plus people
 * never seen who have been in the app a month (the digest's rule). Most overdue
 * first. Each goes on the Saturday while it is free, then on the quietest
 * evening, earliest first. `seen` is what the People page counts (seenTasks):
 * the tasks plus your own past events with people on them; a plan is a task.
 */
function proposePeople({
  days,
  people,
  tasks,
  seen,
  now,
  tz,
  eveningLoad,
  dueCount,
  skip,
}: {
  days: string[]
  people: Person[]
  tasks: Task[]
  seen: Task[]
  now: Date
  /** The account's zone, so "days since" counts its calendar days, not the server's. */
  tz?: string
  eveningLoad: Map<string, number>
  dueCount: Map<string | null, number>
  skip: Set<string>
}): PersonItem[] {
  const nowMs = now.getTime()
  const due: { p: Person; s: { status: string; daysSince?: number; reason: string } }[] = []
  for (const p of people) {
    if (skip.has(`person:${p.id}`) || plannedVisit(p.id, tasks)) continue
    const s = seenStatus(p, seen, now, dayKeysIn(tz))
    if (!(s.status in CATCH_UP_RANK)) continue
    if (s.status === 'never') {
      const created = Date.parse(p.createdAt ?? '')
      if (!Number.isFinite(created) || nowMs - created < NEVER_MIN_AGE_DAYS * DAY_MS) continue
    }
    due.push({ p, s })
  }
  due.sort(
    (a, b) =>
      CATCH_UP_RANK[a.s.status] - CATCH_UP_RANK[b.s.status] || (b.s.daysSince ?? 0) - (a.s.daysSince ?? 0) || cmp(a.p.name ?? '', b.p.name ?? '') || cmp(a.p.id, b.p.id),
  )
  // every day of the week has its count
  const booked = new Map(days.map(d => [d, eveningLoad.get(d) ?? 0]))
  const saturday = days[6]
  return due.map(({ p, s }) => {
    const dueDay = booked.get(saturday) === 0 ? saturday : days.reduce((best, d) => (booked.get(d)! < booked.get(best)! ? d : best), days[0])
    booked.set(dueDay, booked.get(dueDay)! + 1)
    dueCount.set(dueDay, (dueCount.get(dueDay) ?? 0) + 1)
    return { key: `person:${p.id}`, personId: p.id, title: `Catch up with ${p.name}`, dueDay, why: s.reason }
  })
}

/**
 * Your overdue work, spread over the week: urgent and high first, then the
 * longest overdue, each to the least loaded day — and no day past three due,
 * counting what is already due there. What does not fit is left where it is.
 */
function proposeResched({
  days,
  todayKey,
  tasks,
  userId,
  dueCount,
  dayOf,
  skip,
}: {
  days: string[]
  todayKey: string
  tasks: Task[]
  userId: string | null
  dueCount: Map<string | null, number>
  dayOf: (iso: string) => string | null
  skip: Set<string>
}): ReschedItem[] {
  const overdue = tasks
    // a bill falls due on its own day: it is a heads-up, never something to move
    .filter((t): t is Task & { dueAt: string } => OPEN.includes(t.status) && !!t.dueAt && !t.bill && isMineTask(t, userId) && !skip.has(`resched:${t.id}`))
    .map(t => ({ t, day: dayOf(t.dueAt) }))
    .filter((x): x is { t: Task & { dueAt: string }; day: string } => !!x.day && x.day < todayKey)
    .sort((a, b) => (PRIORITY_RANK[b.t.priority] ?? 1) - (PRIORITY_RANK[a.t.priority] ?? 1) || cmp(a.day, b.day) || cmp(a.t.dueAt, b.t.dueAt) || cmp(a.t.id, b.t.id))
  const out: ReschedItem[] = []
  // every day of the week has its count
  for (const { t, day } of overdue) {
    const room = days.filter(d => dueCount.get(d)! < MAX_DUE_PER_DAY)
    if (room.length === 0) break
    const toDay = room.reduce((best, d) => (dueCount.get(d)! < dueCount.get(best)! ? d : best))
    dueCount.set(toDay, dueCount.get(toDay)! + 1)
    const late = daysBetween(day, todayKey)
    const urgent = t.priority === 'urgent' || t.priority === 'high' ? ` · ${t.priority}` : ''
    out.push({ key: `resched:${t.id}`, taskId: t.id, title: t.title || 'Untitled task', fromDue: t.dueAt, toDay, why: `Overdue ${late} day${late === 1 ? '' : 's'}${urgent}` })
  }
  return out
}

/**
 * The week ahead, proposed from the records: dinners for the empty nights,
 * catch-ups, overdue work to spread, bills falling due, and a Top 3 while last
 * week's review has none. `items` is every record the reader can see, of any
 * kind; `events` adds occurrences from subscribed calendars (the app has them,
 * the digest does not). Rows whose key is in `dismissed` are left out. Null for
 * a bad `todayKey`.
 */
export function proposeWeek(
  items: readonly unknown[],
  o: {
    todayKey: string
    tz?: string
    userId?: string | null
    dismissed?: readonly string[]
    now?: Date
    /** Occurrences from subscribed calendars; our own entries come from `items`. */
    events?: readonly CalendarEvent[]
  },
): WeekPlan | null
export function proposeWeek(
  items: readonly unknown[],
  {
    todayKey,
    tz,
    userId = null,
    dismissed = [],
    now = new Date(),
    events = [],
  }: { todayKey?: string; tz?: string; userId?: string | null; dismissed?: readonly string[]; now?: Date; events?: readonly CalendarEvent[] } = {},
): WeekPlan | null {
  if (todayKey === undefined) return null
  const week = targetWeek(todayKey)
  if (!week) return null
  const skip = new Set(dismissed ?? [])
  const live = liveItems(items)
  const ofKind = <K extends Item['kind']>(kind: K) => recordsOf(live, kind)
  const tasks = ofKind('task')
  const meals = ofKind('meal')
  const reviews = ofKind('review')
  const days = week.dayKeys
  const inWeek = new Set<string | null>(days)
  const dayOf = (iso: string): string | null => (typeof iso === 'string' && DAY_KEY_RE.test(iso) ? iso : localDate(iso, tz))
  // our own entries are items already; a feed's copy of one (localId) would count it twice
  const calendar: Timed[] = [...ofKind('event'), ...(events ?? []).filter(ev => ev && !ev.localId)]
  const busy = new Map(
    days.map((d): [string, string | null] => {
      const ev = overlapping(calendar, d, DINNER_HOURS, tz)[0]
      return [d, ev ? ev.title || 'Something on' : null]
    }),
  )
  const eveningLoad = new Map(days.map(d => [d, overlapping(calendar, d, EVENING_HOURS, tz).length]))
  const dueCount = new Map<string | null, number>(days.map(d => [d, 0]))
  for (const t of tasks) {
    if (!OPEN.includes(t.status) || !t.dueAt || !isMineTask(t, userId)) continue
    const d = dayOf(t.dueAt)
    if (dueCount.has(d)) dueCount.set(d, dueCount.get(d)! + 1)
  }

  const dinners = proposeDinners({ days, todayKey, startKey: week.startKey, meals, recipes: ofKind('recipe'), busy, skip })
  // a lunch of your own with Mum on it has seen her, as the People page says —
  // and only your own visits: a housemate seeing her is not you seeing her
  const seen = seenTasks(tasks, ofKind('event'), now, userId)
  const people = proposePeople({ days, people: ofKind('person'), tasks, seen, now, tz, eveningLoad, dueCount, skip })
  const overdue = proposeResched({ days, todayKey, tasks, userId, dueCount, dayOf, skip })

  const bills = tasks
    .filter(
      (t): t is Task & { bill: NonNullable<Task['bill']>; dueAt: string } =>
        !!t.bill && OPEN.includes(t.status) && !!t.dueAt && inWeek.has(dayOf(t.dueAt)) && !skip.has(`bill:${t.id}`),
    )
    .map(t => ({
      key: `bill:${t.id}`,
      taskId: t.id,
      title: t.title || t.bill.payee || 'Bill',
      // a day of the week, as the filter found
      dueDay: dayOf(t.dueAt)!,
      amount: typeof t.estimateCost === 'number' && Number.isFinite(t.estimateCost) ? t.estimateCost : null,
      autopay: !!t.bill.autopay,
    }))
    .sort((a, b) => cmp(a.dueDay, b.dueDay) || cmp(a.title, b.title) || cmp(a.taskId, b.taskId))

  // Only while last week's review — the one Today reads as "This week's 3" and
  // Review writes as "Top 3 for next week" — has none: never over the user's own.
  const review = reviews.find(r => r.period === 'week' && r.key === week.prevWeekKey && (!userId || r.ownerId == null || r.ownerId === userId))
  const hasTop = (review?.top ?? []).some(line => String(line ?? '').trim())
  const dueInWeek = tasks
    .filter(t => OPEN.includes(t.status) && !t.bill && String(t.title ?? '').trim() && isMineTask(t, userId) && t.dueAt && inWeek.has(dayOf(t.dueAt)))
    // Next up keeps ties in the order it was given: sorting first keeps the proposal deterministic
    .sort((a, b) => cmp(a.id, b.id))
  const top3 = hasTop
    ? []
    : nextUp(dueInWeek, ofKind('project'), 3, now)
        .map((n, i) => ({ key: `top:${i}`, title: n.task.title.trim(), taskId: n.task.id }))
        .filter(x => !skip.has(x.key))

  return { week, dinners, people, overdue, bills, top3 }
}

/** "4 dinners to fill · 2 catch-ups · 3 bills due", or null when there is nothing to plan. */
export function weekPlanSummary(plan: WeekPlan | null | undefined): string | null {
  if (!plan) return null
  const n = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`
  const parts: string[] = []
  if (plan.dinners.length) parts.push(`${n(plan.dinners.length, 'dinner')} to fill`)
  if (plan.people.length) parts.push(n(plan.people.length, 'catch-up'))
  if (plan.overdue.length) parts.push(`${plan.overdue.length} overdue to move`)
  if (plan.bills.length) parts.push(`${n(plan.bills.length, 'bill')} due`)
  if (plan.top3.length) parts.push('a Top 3 to pick')
  return parts.length ? parts.join(' · ') : null
}

/**
 * The task an accepted catch-up becomes: a visit with them, due all day on its
 * day (local midnight in this runtime's zone), so it reads as a plan on the
 * People card — and, open, suppresses them from the next proposal.
 */
export function catchUpTask(item: Pick<PersonItem, 'personId' | 'title' | 'dueDay'>, { id, now = new Date() }: { id: string; now?: Date }): Task {
  const stamp = now.toISOString()
  return {
    kind: 'task',
    id,
    title: item.title,
    description: '',
    status: 'todo',
    priority: 'normal',
    dueAt: localMidnightIso(item.dueDay) ?? undefined,
    tags: ['visit'],
    peopleIds: [item.personId],
    createdAt: stamp,
    updatedAt: stamp,
  }
}

// ---- today's meal ideas -------------------------------------------------------

/** "4 days", "5 weeks", "3 months". */
function span(days: number): string {
  if (days < 14) return `${days} day${days === 1 ? '' : 's'}`
  if (days < 60) return `${Math.round(days / 7)} weeks`
  return `${Math.round(days / 30)} months`
}

/** "3 May", with the year only when it is not this one. */
function dayMonth(key: string, todayKey: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return `${d} ${MONTH_NAMES[m - 1]}${key.slice(0, 4) === todayKey.slice(0, 4) ? '' : ` ${y}`}`
}

/** Something to eat today: a recipe cooked before as a meal, or a place eaten at. */
type Candidate = {
  id: string
  title: string
  /** Six months' count, and all of them: what "popular" and "old favourite" rank by. */
  count: number
  total: number
  /** When it was last had. */
  last: string
  /** The six months' count its reason says. */
  shownCount: number
  slots: Set<MealSlot>
  tags: string[]
} & ({ kind: 'recipe'; category: null } | { kind: 'place'; category: PlaceCategory })

function ideaWhy(c: Candidate, how: 'popular' | 'longAgo', dayKey: string): string {
  if (how === 'popular') return c.kind === 'recipe' ? `Cooked ${c.shownCount}× in six months` : `Been ${c.shownCount}× in six months`
  return c.kind === 'recipe' ? `Not cooked in ${span(daysBetween(c.last, dayKey))}` : `Haven't been since ${dayMonth(c.last, dayKey)}`
}

/**
 * Ideas for today's empty meals, for the Today card and Plan my day. For each
 * slot with nothing planned — a slot with any meal, cooked, eaten out, or out
 * with no place, is not missing — about four ideas, alternating between what is
 * popular (cooked or eaten at most in six months) and old favourites (had twice
 * or more) not had for longest. Recipes and places you eat at compete alike.
 * A recipe is an idea for what it has been as a meal, but a side had is had:
 * nothing had in the last week or planned for the week ahead, as the main or a
 * side, and the reasons count sides as the Kitchen does. Never the same idea
 * for two slots on one day, and never anything not yet tried as a meal — there
 * is nothing to go on. Lunch leans to cafés, fast food and recipes tagged for it,
 * dinner to restaurants, and whatever has been that meal before suits it; with
 * no such signal the slots are treated alike.
 */
export function mealIdeasFor(
  items: readonly unknown[],
  o: { dayKey: string; slots?: readonly MealSlot[]; now?: Date; dismissed?: readonly string[]; tz?: string },
): SlotIdeas[]
export function mealIdeasFor(
  items: readonly unknown[],
  {
    dayKey,
    slots = ['lunch', 'dinner'],
    now = new Date(),
    dismissed = [],
    tz,
  }: { dayKey?: string; slots?: readonly MealSlot[]; now?: Date; dismissed?: readonly string[]; tz?: string } = {},
): SlotIdeas[] {
  if (dayKey === undefined || !isDayKey(dayKey)) return []
  const live = liveItems(items)
  const ofKind = <K extends Item['kind']>(kind: K) => recordsOf(live, kind)
  const meals = ofKind('meal')
  const tasks = ofKind('task')
  const skip = new Set(dismissed ?? [])
  const ahead = shiftDayKey(dayKey, IDEA_AHEAD_DAYS)
  const coolFrom = shiftDayKey(dayKey, -IDEA_COOLDOWN_DAYS)
  const favouriteFrom = shiftDayKey(dayKey, -FAVOURITE_DAYS)

  // Each candidate: `count` and `total`, what "popular" and "old favourite"
  // rank by; `last`, when it was last had; `shownCount`, the six months' count
  // its reason says.
  const candidates: Candidate[] = []
  // a recipe is offered, and ranked, for the meals it was the main of; a side
  // had cools it down and counts in what the reason says. A meal already on
  // the menu for the week ahead cools a recipe down like one just eaten
  const mains = recipeHistory(meals, dayKey, shiftDayKey(ahead, 1))
  const had = recipeHistory(meals, dayKey, shiftDayKey(ahead, 1), mealRecipeIds)
  for (const r of ofKind('recipe')) {
    const s = mains.get(r.id)
    const h = had.get(r.id)
    if (!s || s.total === 0 || !cooledDown(h, dayKey, IDEA_COOLDOWN_DAYS)) continue
    candidates.push({
      kind: 'recipe',
      id: r.id,
      title: r.name ?? '',
      count: s.count,
      total: s.total,
      // had holds whatever mains does: sides are had too
      last: h!.lastCooked,
      shownCount: h!.count,
      slots: s.slots,
      tags: (r.tags ?? []).map(t => String(t).toLowerCase()),
      category: null,
    })
  }
  for (const p of ofKind('place')) {
    const h = placeHistory(p, tasks, meals, now, tz)
    if (h.days.length === 0 || !isEatingPlace(p, h)) continue
    const plannedSoon = meals.some(m => m.out && m.placeId === p.id && m.date >= dayKey && m.date <= ahead)
    if (plannedSoon || h.days[0] >= coolFrom) continue
    const count = h.days.filter(d => d >= favouriteFrom).length
    candidates.push({ kind: 'place', id: p.id, title: p.name ?? '', count, total: h.days.length, last: h.days[0], shownCount: count, slots: h.slots, tags: [], category: p.category })
  }

  const fits = (c: Candidate, slot: MealSlot) => c.slots.has(slot) || (c.kind === 'recipe' ? c.tags.some(t => (SLOT_TAGS[slot] ?? []).includes(t)) : (SLOT_PLACES[slot] ?? []).includes(c.category))
  const tie = (a: Candidate, b: Candidate) => cmp(a.title, b.title) || cmp(a.kind, b.kind) || cmp(a.id, b.id)
  const planned = new Set(meals.filter(m => m.date === dayKey).map(m => m.slot))
  const used = new Set<string>()
  const rows = slots.map((slot): SlotIdeas => ({ slot, missing: !planned.has(slot), ideas: [] }))

  /**
   * Top a slot up from the candidates still going. `onlyFitting` is the whole
   * point of the two passes below: every slot gets first refusal on what
   * actually suits it, before anything is handed out on suitability alone.
   */
  const fill = (row: SlotIdeas, onlyFitting: boolean) => {
    const { slot } = row
    const keyOf = (c: Candidate) => `idea:${dayKey}:${slot}:${c.kind}:${c.id}`
    const open = candidates.filter(c => !used.has(`${c.kind}:${c.id}`) && !skip.has(keyOf(c)) && (!onlyFitting || fits(c, slot)))
    const suits = (a: Candidate, b: Candidate) => Number(fits(b, slot)) - Number(fits(a, slot))
    const popular = open.filter(c => c.count > 0).sort((a, b) => suits(a, b) || b.count - a.count || tie(a, b))
    const longAgo = open.filter(c => c.total >= 2).sort((a, b) => suits(a, b) || cmp(a.last, b.last) || tie(a, b))
    const lists: [Candidate[], 'popular' | 'longAgo'][] = [
      [popular, 'popular'],
      [longAgo, 'longAgo'],
    ]
    const at = [0, 0]
    const chosen = new Set<Candidate>()
    for (let turn = 0; row.ideas.length < IDEAS_PER_SLOT && (at[0] < popular.length || at[1] < longAgo.length); turn = 1 - turn) {
      const [list, how] = lists[turn]
      while (at[turn] < list.length && chosen.has(list[at[turn]])) at[turn]++
      if (at[turn] >= list.length) continue
      const c = list[at[turn]++]
      chosen.add(c)
      used.add(`${c.kind}:${c.id}`)
      row.ideas.push({ key: keyOf(c), kind: c.kind, id: c.id, title: c.title, why: ideaWhy(c, how, dayKey) })
    }
  }

  // Two passes, because one greedy pass let the first slot empty the board.
  //
  // `suits` only ever REORDERS a slot's list — it does not drop anything — so
  // with the usual shape of a kitchen (dinners, and nothing tagged for lunch)
  // the lunch slot took all three dinner candidates, marked them used, and the
  // Dinner group underneath rendered nothing at all. Now every slot takes what
  // fits it first, and only then do the leftovers go round again.
  for (const row of rows) if (row.missing) fill(row, true)
  for (const row of rows) if (row.missing) fill(row, false)
  return rows
}
