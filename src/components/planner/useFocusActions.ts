import { useRef } from 'react'
import { MEAL_SLOT_META, type CalendarEntry, type Item, type Meal, type MealSlot, type Task, type TaskStatus } from '../../types'
import type { Store } from '../../store'
import { planDayWrites, restoreSnapshots, shutdownWrites, type DayWrites, type ShutdownResult, type ShutdownWrites, type StatusMove } from '../../focus'
import { closeDay, reopenDay } from '../../dayclose'
import { localDayKey, shiftDayKey } from '../../journal'
import { mealId } from '../../kitchen'
import { uid } from '../../utils'
import type { MealIdea } from '../../../shared/weekplan.mjs'
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

  /** Defer from the focus card: the same move, toast and Undo as any defer, and the same write takes the task out of today's focus. */
  const deferFromFocus = (id: string, day: Date) => deps.defer(id, day, { focusOn: undefined, focusBy: undefined })

  /** One of Today's lunch and dinner ideas, planned as the Kitchen plans a meal; Undo clears the slot again. */
  const planMealIdea = (dayKey: string, slot: MealSlot, idea: MealIdea) => {
    const m = mealFromIdea(dayKey, slot, idea, slotRecord(dayKey, slot))
    deps.saveMeals([m])
    showToast(mealIdeaToast(m), () => latest.current.clearMeals([m.id]))
  }

  return { applyDayPlan, applyShutdown, deferFromFocus, planMealIdea }
}
