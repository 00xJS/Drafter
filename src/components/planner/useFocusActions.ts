import { useRef } from 'react'
import { MEAL_SLOT_META, type CalendarEntry, type Item, type Meal, type MealSlot, type Review, type Task, type TaskStatus } from '../../types'
import type { Store } from '../../store'
import { planDayWrites, restoreSnapshots, shutdownWrites, type DayWrites, type ShutdownResult, type ShutdownWrites, type StatusMove } from '../../focus'
import { closeDay, reopenDay } from '../../dayclose'
import { localDayKey, shiftDayKey } from '../../journal'
import { mealId } from '../../kitchen'
import { uid } from '../../utils'
import { newerStamp } from '../../itemops'
import { rememberWeekPlanDismissed } from '../../weekplanstore'
import { catchUpTask, type AcceptedPlan, type MealIdea, type WeekPlan } from '../../../shared/weekplan.mjs'
import { mealFromIdea } from '../MealIdeasCard'
import type { PlanDayApply } from '../PlanDaySheet'
import type { useToast } from './useToast'

type StatusChange = NonNullable<ReturnType<Store['setStatus']>>

/**
 * What applying a plan writes through: the store, and the shell's own quiet
 * save paths — a status move with its GitHub write-back, the project board,
 * the calendar mirrors, meals with their grocery lists. Undo asks for them
 * again when it runs, renders later, so it sees the records the plan added.
 */
export interface PlanPorts {
  /** The live tasks as they stand now. */
  tasks(): Task[]
  upsert(item: Item): void
  remove(id: string): void
  /** setStatus with the linked issue and the board, and no toast (useTaskActions). */
  applyStatus(id: string, status: TaskStatus): StatusChange | null
  pushToProjectBoard(t: Task): void
  mirrorEvent(e: CalendarEntry): void
  /** Off the calendar and every mirror, and no toast (useCalendarSync). */
  removeEvent(id: string): void
  /** Meals and their week's grocery lists, several at once (useLifeActions). */
  saveMeals(meals: Meal[]): void
  clearMeals(ids: string[]): void
}

/**
 * A plan's task changes: each edited copy upserted — and pushed to its GitHub
 * board when its column or date moved, as a save from the editor is — then the
 * Wishlist and Done moves through setStatus, which spawns a repeating chore's
 * next copy and releases what it blocked. Returns those copies' ids for Undo.
 */
function writeTasks(p: PlanPorts, w: { upserts: Task[]; statuses: StatusMove[] }): string[] {
  const before = new Map(p.tasks().map(t => [t.id, t]))
  for (const t of w.upserts) {
    const was = before.get(t.id)
    p.upsert(t)
    if (!was || was.status !== t.status || was.dueAt !== t.dueAt) p.pushToProjectBoard(t)
  }
  const spawned: string[] = []
  for (const s of w.statuses) {
    const change = p.applyStatus(s.id, s.status)
    if (change?.spawnedId) spawned.push(change.spawnedId)
  }
  return spawned
}

/** Every task the plan touched back as it was — stamped to win over the plan's own write, and back on its board — and no spawned copy left behind. */
function unwriteTasks(p: PlanPorts, snapshots: Task[], spawned: string[]): void {
  for (const t of restoreSnapshots(snapshots, p.tasks())) {
    p.upsert(t)
    p.pushToProjectBoard(t)
  }
  for (const id of spawned) p.remove(id)
}

/**
 * Write Plan my day: the tasks, then each time block saved and mirrored like
 * any entry — not through saveEvents, which announces a run of work days —
 * then the meals picked. Returns the one Undo: the tasks restored, the
 * repeats, new tasks and blocks removed (off the mirrors too), the meals cleared.
 */
export function applyDayPlanWrites(ports: () => PlanPorts, w: DayWrites, meals: Meal[]): () => void {
  const p = ports()
  const spawned = writeTasks(p, w)
  for (const e of w.events) {
    p.upsert(e)
    p.mirrorEvent(e)
  }
  if (meals.length) p.saveMeals(meals)
  return () => {
    const q = ports()
    unwriteTasks(q, w.snapshots, spawned)
    for (const id of w.createdIds) q.remove(id)
    for (const e of w.events) q.removeEvent(e.id)
    if (meals.length) q.clearMeals(meals.map(m => m.id))
  }
}

/** Write Shut down and mark `day` closed on this device. Returns the one Undo, which reopens it. */
export function applyShutdownWrites(ports: () => PlanPorts, w: ShutdownWrites, day: string): () => void {
  const spawned = writeTasks(ports(), w)
  closeDay(day)
  return () => {
    unwriteTasks(ports(), w.snapshots, spawned)
    reopenDay(day)
  }
}

/** What accepting Plan next week writes. */
export interface WeekWrites {
  /** The dinners, each on a night nothing was planned into meanwhile. */
  meals: Meal[]
  /** The catch-ups, as new visit tasks. */
  created: Task[]
  /** Overdue tasks moved to a day of the week. */
  upserts: Task[]
  /** Overdue tasks sent back to the wishlist. */
  statuses: StatusMove[]
  /** Every task moved, as it was, for Undo. */
  snapshots: Task[]
  /** The Top 3 in last week's review, and that review as it was (null when the plan makes it). */
  review: { next: Review; prev: Review | null } | null
}

/**
 * Plan next week, accepted, as writes: the dinners on nights still empty (a
 * night planned meanwhile — another device, the calendar — is left alone), the
 * catch-ups as visit tasks, overdue work moved to its day keeping its time of
 * day (or back to the wishlist), and the Top 3 into last week's review, which
 * Today reads as this week's 3. Pure: the ids and the clock come in.
 */
export function weekPlanWrites(
  s: { tasks: Task[]; items: readonly Item[]; reviews: Review[] },
  plan: WeekPlan,
  a: AcceptedPlan,
  o: { myId: string | null; now: Date; newId(): string },
): WeekWrites {
  const stamp = o.now.toISOString()
  const meals: Meal[] = []
  for (const d of a.dinners) {
    const id = mealId(d.date, 'dinner')
    const slot = s.items.find((i): i is Meal => i.kind === 'meal' && i.id === id)
    if (slot && !slot.deletedAt) continue
    meals.push({
      kind: 'meal',
      id,
      date: d.date,
      slot: 'dinner',
      title: d.title,
      ...(d.recipeId ? { recipeId: d.recipeId } : {}),
      ...(d.out ? { out: true } : {}),
      ...(d.placeId ? { placeId: d.placeId } : {}),
      createdAt: stamp,
      // a tombstone in the slot must lose to the new plan
      updatedAt: slot ? newerStamp(slot.updatedAt) : stamp,
    })
  }
  const created = a.people.map(p => catchUpTask(p, { id: o.newId(), now: o.now }))
  const byId = new Map(s.tasks.map(t => [t.id, t]))
  const upserts: Task[] = []
  const statuses: StatusMove[] = []
  const snapshots: Task[] = []
  for (const m of a.resched) {
    const t = byId.get(m.taskId)
    if (!t || t.status === 'done' || t.status === 'canceled') continue
    const [y, mo, day] = m.toDay.split('-').map(Number)
    const old = t.dueAt ? new Date(t.dueAt) : null
    const at = new Date(y, mo - 1, day, old?.getHours() ?? 9, old?.getMinutes() ?? 0)
    snapshots.push(t)
    upserts.push({ ...t, status: t.status === 'wishlist' ? 'todo' : t.status, dueAt: at.toISOString(), updatedAt: newerStamp(t.updatedAt) })
  }
  for (const id of a.wishlist) {
    const t = byId.get(id)
    if (!t || t.status === 'done' || t.status === 'canceled' || t.status === 'wishlist') continue
    snapshots.push(t)
    statuses.push({ id, status: 'wishlist' })
  }
  let review: WeekWrites['review'] = null
  const top = a.top3.map(x => x.trim()).filter(Boolean)
  if (top.length) {
    const key = plan.week.prevWeekKey
    // your own review only: a household member's is theirs
    const prev = s.reviews.find(r => r.period === 'week' && r.key === key && !r.deletedAt && (!o.myId || r.ownerId == null || r.ownerId === o.myId)) ?? null
    review = {
      prev,
      next: prev ? { ...prev, top, updatedAt: newerStamp(prev.updatedAt) } : { kind: 'review', id: o.newId(), period: 'week', key, top, createdAt: stamp, updatedAt: stamp },
    }
  }
  return { meals, created, upserts, statuses, snapshots, review }
}

export const weekWritesEmpty = (w: WeekWrites): boolean => !w.meals.length && !w.created.length && !w.upserts.length && !w.statuses.length && !w.review

/**
 * Write Plan next week. Returns the one Undo: the moved tasks back as they
 * were, the catch-ups removed, the dinners cleared with their grocery lists
 * rebuilt, and the review back as it was — or removed, if the plan made it.
 */
export function applyWeekPlanWrites(ports: () => PlanPorts, w: WeekWrites): () => void {
  const p = ports()
  const spawned = writeTasks(p, w)
  for (const t of w.created) p.upsert(t)
  if (w.meals.length) p.saveMeals(w.meals)
  if (w.review) p.upsert(w.review.next)
  return () => {
    const q = ports()
    unwriteTasks(q, w.snapshots, spawned)
    for (const t of w.created) q.remove(t.id)
    if (w.meals.length) q.clearMeals(w.meals.map(m => m.id))
    if (w.review) {
      if (w.review.prev) q.upsert({ ...w.review.prev, updatedAt: newerStamp(w.review.next.updatedAt) })
      else q.remove(w.review.next.id)
    }
  }
}

/** "Next week planned · 4 dinners · 2 catch-ups · 3 moved · Top 3 set" */
export function weekPlanToast(w: WeekWrites): string {
  const n = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`
  const bits = ['Next week planned']
  if (w.meals.length) bits.push(n(w.meals.length, 'dinner'))
  if (w.created.length) bits.push(n(w.created.length, 'catch-up'))
  const moved = w.upserts.length + w.statuses.length
  if (moved) bits.push(`${moved} moved`)
  if (w.review) bits.push('Top 3 set')
  return bits.join(' · ')
}

const slotName = (slot: MealSlot) => MEAL_SLOT_META[slot].label.toLowerCase()

/** "Today’s focus set · 2 blocks added · lunch & dinner planned" */
export function dayPlanToast(w: Pick<DayWrites, 'events'>, meals: Pick<Meal, 'slot'>[]): string {
  const bits = ['Today’s focus set']
  if (w.events.length) bits.push(`${w.events.length} block${w.events.length === 1 ? '' : 's'} added`)
  if (meals.length) bits.push(`${meals.map(m => slotName(m.slot)).join(' & ')} planned`)
  return bits.join(' · ')
}

/** "Day closed · 2 moved · tomorrow’s focus set" */
export function shutdownToast(r: ShutdownResult): string {
  const bits = ['Day closed']
  if (r.moves.length) bits.push(`${r.moves.length} moved`)
  if (r.tomorrowFocusIds.length) bits.push('tomorrow’s focus set')
  return bits.join(' · ')
}

/** "Planned “Pasta” for dinner" */
export const mealIdeaToast = (m: Pick<Meal, 'slot' | 'title'>): string => `Planned “${m.title}” for ${slotName(m.slot)}`

interface Deps {
  store: Store
  household: { myId: string | null }
  showToast: ReturnType<typeof useToast>['showToast']
  applyStatus: PlanPorts['applyStatus']
  pushToProjectBoard: PlanPorts['pushToProjectBoard']
  defer(id: string, day: Date, patch?: Partial<Task>): void
  mirrorEvent: PlanPorts['mirrorEvent']
  removeEvent: PlanPorts['removeEvent']
  saveMeals: PlanPorts['saveMeals']
  clearMeals: PlanPorts['clearMeals']
}

/**
 * The daily routines' writes: Plan my day and Shut down, each applied with one
 * toast and one Undo, and the two single moves on Today's cards — a defer from
 * the focus card and a meal idea planned. Everything goes through the task,
 * calendar and meal paths the rest of the shell uses.
 */
export function useFocusActions(deps: Deps) {
  // An Undo runs renders after its plan, against tasks, blocks and meals the
  // plan itself added: it reads the store and the save paths as they are then
  const latest = useRef(deps)
  latest.current = deps
  const ports = (): PlanPorts => {
    const d = latest.current
    return {
      tasks: () => d.store.tasks,
      upsert: item => d.store.upsert(item),
      remove: id => d.store.remove(id),
      applyStatus: (id, status) => d.applyStatus(id, status),
      pushToProjectBoard: t => d.pushToProjectBoard(t),
      mirrorEvent: e => d.mirrorEvent(e),
      removeEvent: id => d.removeEvent(id),
      saveMeals: ms => d.saveMeals(ms),
      clearMeals: ids => d.clearMeals(ids),
    }
  }
  const { store, household, showToast } = deps

  /** The slot's record as stored, a tombstone included, so a new plan for it is stamped newer and wins the merge. */
  const slotRecord = (dayKey: string, slot: MealSlot) => store.allItems.find((i): i is Meal => i.kind === 'meal' && i.id === mealId(dayKey, slot))

  const applyDayPlan = (r: PlanDayApply) => {
    const now = new Date()
    const w = planDayWrites(store.tasks, r, { today: localDayKey(now), myId: household.myId, now, newId: uid })
    const meals = r.meals.map(c => mealFromIdea(c.dayKey, c.slot, c.idea, slotRecord(c.dayKey, c.slot), now))
    const undo = applyDayPlanWrites(ports, w, meals)
    showToast(dayPlanToast(w, meals), undo)
  }

  const applyShutdown = (r: ShutdownResult) => {
    const now = new Date()
    const today = localDayKey(now)
    const w = shutdownWrites(store.tasks, r, { today, tomorrow: shiftDayKey(today, 1), myId: household.myId, now })
    const undo = applyShutdownWrites(ports, w, today)
    showToast(shutdownToast(r), undo)
  }

  /** Plan next week, accepted: one toast and one Undo for all of it, and the rows said no to remembered for that week. */
  const applyWeekPlan = (plan: WeekPlan, a: AcceptedPlan) => {
    rememberWeekPlanDismissed(plan.week.weekKey, a.dismissed)
    const w = weekPlanWrites({ tasks: store.tasks, items: store.allItems, reviews: store.reviews }, plan, a, { myId: household.myId, now: new Date(), newId: uid })
    if (weekWritesEmpty(w)) {
      showToast('Nothing new to add to next week')
      return
    }
    const undo = applyWeekPlanWrites(ports, w)
    showToast(weekPlanToast(w), undo)
  }

  /** Defer from the focus card: the same move, toast and Undo as any defer, and the same write takes the task out of today's focus. */
  const deferFromFocus = (id: string, day: Date) => deps.defer(id, day, { focusOn: undefined, focusBy: undefined })

  /** One of Today's lunch and dinner ideas, planned as the Kitchen plans a meal; Undo clears the slot again. */
  const planMealIdea = (dayKey: string, slot: MealSlot, idea: MealIdea) => {
    const m = mealFromIdea(dayKey, slot, idea, slotRecord(dayKey, slot))
    deps.saveMeals([m])
    showToast(mealIdeaToast(m), () => latest.current.clearMeals([m.id]))
  }

  return { applyDayPlan, applyShutdown, applyWeekPlan, deferFromFocus, planMealIdea }
}
