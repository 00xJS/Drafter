import type { CalendarEvent, Meal, MealSlot, Recipe, Task } from './types'
import { QUICK_PICK_META, mealIsShared, mealLabel, mealsForSlot } from './kitchen'
import { eventDayKeys } from './calendarstate'
import { shiftDayKey } from './journal'
import { dateKey } from './utils'
import { dueDayKey, hasDueTime } from '../shared/due.mts'
import { OPEN } from '../shared/today.mts'
import { weekDayKeys } from '../shared/weeks.mts'

// What Home's top section says about the week and the rest of the day: the
// strip's seven days, tonight's dinner and what is up next. Worked out here,
// from the lists Home already holds, so the cards only draw.

/** One day of Home's week strip: how many of each thing are on it. */
export interface StripDay {
  key: string
  /** Tasks due that day that are open or done: a day's work, finished or not. */
  tasks: number
  /** Meals planned that day that this member can see, a slot counted once however many plans answer it. */
  meals: number
  /** Events on it, work days aside: those are a property of the day, as on the Calendar. */
  events: number
}

/** The week `todayKey` falls in, Sunday first as the app's weeks are, and what is on each day. */
export function weekStrip(todayKey: string, tasks: readonly Task[], meals: readonly Meal[], events: readonly CalendarEvent[]): StripDay[] {
  const days = new Map(weekDayKeys(todayKey).map(key => [key, { key, tasks: 0, meals: 0, events: 0 }]))
  for (const t of tasks) {
    if (!t || t.deletedAt || !t.dueAt || !(OPEN.includes(t.status) || t.status === 'done')) continue
    const day = days.get(dueDayKey(t.dueAt) ?? '')
    if (day) day.tasks++
  }
  const slots = new Map<string, Set<MealSlot>>()
  for (const m of meals) {
    if (!m || m.deletedAt || !days.has(m.date)) continue
    slots.set(m.date, (slots.get(m.date) ?? new Set<MealSlot>()).add(m.slot))
  }
  for (const [key, set] of slots) days.get(key)!.meals = set.size
  for (const ev of events) {
    if (!ev || ev.work) continue
    for (const key of ev.allDay ? eventDayKeys(ev) : [dateKey(ev.start)]) {
      const day = days.get(key)
      if (day) day.events++
    }
  }
  return [...days.values()]
}

/** "2 tasks due, dinner planned, 1 event": a day of the strip, said aloud. */
export function stripDayWords(d: StripDay): string {
  const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
  const parts = [d.tasks ? `${n(d.tasks, 'task')} due` : '', d.meals ? `${n(d.meals, 'meal')} planned` : '', d.events ? n(d.events, 'event') : ''].filter(Boolean)
  return parts.length ? parts.join(', ') : 'nothing on'
}

/** Tonight's dinner as Home's tile shows it: the plan answering the slot, and its recipe. */
export interface Tonight {
  meal: Meal
  /** What it is, as every meal is named (mealLabel): the dish or the place, and its sides. */
  label: string
  recipe?: Recipe
  /** The plan is this member's own row; otherwise someone else in the household planned it. */
  mine: boolean
  /** The glyph beside it: the recipe's own, a takeaway's, a quick pick's. */
  mark: string
}

/**
 * Tonight's dinner, as This week's strip reads a night: this member's own
 * plan, else one someone shared with the household, else the first plan
 * anyone else made that can be seen. Null with nothing planned.
 */
export function tonight(meals: readonly Meal[], recipes: readonly Recipe[], todayKey: string, myId?: string | null): Tonight | null {
  const { mine, theirs } = mealsForSlot(meals, todayKey, 'dinner', myId)
  const meal = mine ?? theirs.find(mealIsShared) ?? theirs[0]
  if (!meal) return null
  const recipe = meal.recipeId && !meal.out && !meal.quick ? recipes.find(r => r.id === meal.recipeId && !r.deletedAt) : undefined
  const mark = meal.quick ? QUICK_PICK_META[meal.quick].emoji : meal.out ? '🥡' : recipe?.emoji?.trim() || '🍽️'
  return { meal, label: mealLabel(meal), recipe, mine: meal === mine, mark }
}

/** What is up next: a timed event or task, when it starts, and whether that is tomorrow. */
export type UpNext = { title: string; at: string; tomorrow: boolean } & ({ kind: 'event'; event: CalendarEvent } | { kind: 'task'; task: Task })

/**
 * The next timed thing today — an event of yours or on a calendar you follow,
 * or an open task with a time that is not someone else's to do — or, once
 * today has nothing left, tomorrow's first. Only what starts after `now`:
 * what has begun is not up next. Null when neither day has anything timed.
 * A household member's own entries are theirs, as the briefing's work tile
 * treats them; a work day is the day's, not an event.
 */
export function upNext(o: { events: readonly CalendarEvent[]; tasks: readonly Task[]; now: Date; todayKey: string; myId?: string | null }): UpNext | null {
  const nowMs = o.now.getTime()
  const tomorrow = shiftDayKey(o.todayKey, 1)
  const days = new Set([o.todayKey, tomorrow])
  const found: { next: UpNext; ms: number }[] = []
  for (const ev of o.events) {
    if (!ev || ev.allDay || ev.work) continue
    if (ev.ownerId && o.myId && ev.ownerId !== o.myId) continue
    const ms = Date.parse(ev.start)
    const day = Number.isFinite(ms) ? dateKey(ev.start) : ''
    if (!(ms > nowMs) || !days.has(day)) continue
    found.push({ ms, next: { kind: 'event', event: ev, title: ev.title?.trim() || 'Untitled event', at: ev.start, tomorrow: day === tomorrow } })
  }
  for (const t of o.tasks) {
    if (!t || t.deletedAt || !OPEN.includes(t.status) || !t.dueAt || !hasDueTime(t.dueAt)) continue
    if (t.assigneeId && o.myId && t.assigneeId !== o.myId) continue
    const ms = Date.parse(t.dueAt)
    const day = dueDayKey(t.dueAt) ?? ''
    if (!(ms > nowMs) || !days.has(day)) continue
    found.push({ ms, next: { kind: 'task', task: t, title: t.title?.trim() || 'Untitled', at: t.dueAt, tomorrow: day === tomorrow } })
  }
  // the earliest; an event before a task at the same minute, as the calendar lists a day
  found.sort((a, b) => a.ms - b.ms || (a.next.kind === b.next.kind ? 0 : a.next.kind === 'event' ? -1 : 1))
  return found[0]?.next ?? null
}
