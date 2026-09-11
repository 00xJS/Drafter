// The date maths behind the Calendar's Month and Week views: which days a grid
// shows, and what lands on each of them. Kept out of the component so the
// bucketing and the week ranges can be tested without a DOM.
import { eventDayKeys } from './calendars'
import { CalendarEvent, MEAL_SLOTS, Meal, Milestone, Person, Project, Task } from './types'
import { dateKey } from './utils'

/** A dated project moment: the project's own target, or one of its milestones. */
export interface ProjectMark {
  project: Project
  kind: 'target' | 'milestone'
  milestone?: Milestone
  label: string
  done: boolean
}

/** A birthday or anniversary falling on a given day, with the age if we know the year. */
export interface DayOccasion {
  person: Person
  kind: 'birthday' | 'anniversary'
  years?: number
}

/** An occasion before it is pinned to a year: the stored year is kept to work out the age. */
export type OccasionSeed = DayOccasion & { year?: number }

/** Everything that can sit on a day, in one list the views can render in order. */
export type DayItem =
  | { kind: 'occasion'; id: string; occasion: DayOccasion }
  | { kind: 'meal'; id: string; meal: Meal }
  | { kind: 'event'; id: string; event: CalendarEvent }
  | { kind: 'task'; id: string; task: Task; at?: string }
  | { kind: 'mark'; id: string; mark: ProjectMark }

export interface DaySources {
  tasks: Map<string, Task[]>
  events: Map<string, CalendarEvent[]>
  marks: Map<string, ProjectMark[]>
  /** Keyed MM-DD: birthdays and anniversaries repeat every year. */
  occasions: Map<string, OccasionSeed[]>
  meals?: Map<string, Meal[]>
}

/** The Sunday that starts the week containing `d`. */
export function startOfWeek(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay())
}

/** Sunday → Saturday of the week containing `d`. */
export function weekDays(d: Date): Date[] {
  const start = startOfWeek(d)
  return Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
}

/** "Sep 7 – 13, 2026", widening to months and years only when the week crosses one. */
export function weekLabel(d: Date, locale?: string | string[]): string {
  const days = weekDays(d)
  const first = days[0]
  const last = days[6]
  const sameYear = first.getFullYear() === last.getFullYear()
  const sameMonth = sameYear && first.getMonth() === last.getMonth()
  const monthDay = { month: 'short', day: 'numeric' } as const
  if (!sameYear) {
    return `${first.toLocaleDateString(locale, { ...monthDay, year: 'numeric' })} – ${last.toLocaleDateString(locale, { ...monthDay, year: 'numeric' })}`
  }
  const to = sameMonth ? last.toLocaleDateString(locale, { day: 'numeric' }) : last.toLocaleDateString(locale, monthDay)
  return `${first.toLocaleDateString(locale, monthDay)} – ${to}, ${last.getFullYear()}`
}

/** The whole-weeks grid for a month: leading and trailing days included. */
export function monthCells(monthStart: Date): Date[] {
  const year = monthStart.getFullYear()
  const month = monthStart.getMonth()
  const offset = new Date(year, month, 1).getDay() // Sunday-start week
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const total = Math.ceil((offset + daysInMonth) / 7) * 7
  return Array.from({ length: total }, (_, i) => new Date(year, month, 1 - offset + i))
}

/** The day a task shows on: its due date, or the day it was completed. */
export function taskDayIso(t: Task): string | undefined {
  if (t.status === 'canceled') return undefined
  if (t.status === 'done') return t.completedAt ?? t.dueAt
  return t.dueAt
}

/** True when a datetime carries a real time of day rather than midnight. */
export function hasClock(iso: string): boolean {
  const d = new Date(iso)
  return d.getHours() + d.getMinutes() > 0
}

export function tasksByDay(tasks: Task[]): Map<string, Task[]> {
  const map = new Map<string, Task[]>()
  for (const t of tasks) {
    const iso = taskDayIso(t)
    if (!iso) continue
    const k = dateKey(iso)
    const arr = map.get(k) ?? []
    arr.push(t)
    map.set(k, arr)
  }
  for (const arr of map.values()) arr.sort((a, b) => (taskDayIso(a) ?? '').localeCompare(taskDayIso(b) ?? ''))
  return map
}

export function eventsByDay(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>()
  for (const ev of events) {
    for (const k of eventDayKeys(ev)) {
      const arr = map.get(k) ?? []
      arr.push(ev)
      map.set(k, arr)
    }
  }
  for (const arr of map.values()) arr.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start))
  return map
}

/** Project target dates and dated milestones, bucketed by day. Archived projects stay out. */
export function marksByDay(projects: Project[]): Map<string, ProjectMark[]> {
  const map = new Map<string, ProjectMark[]>()
  const add = (iso: string, mark: ProjectMark) => {
    const k = dateKey(iso)
    const arr = map.get(k) ?? []
    arr.push(mark)
    map.set(k, arr)
  }
  for (const project of projects) {
    if (project.status === 'archived') continue
    if (project.targetAt) add(project.targetAt, { project, kind: 'target', label: `${project.name} target`, done: project.status === 'done' })
    for (const milestone of project.milestones ?? []) {
      if (milestone.dueAt) add(milestone.dueAt, { project, kind: 'milestone', milestone, label: milestone.name, done: !!milestone.done })
    }
  }
  for (const arr of map.values()) arr.sort((a, b) => a.label.localeCompare(b.label))
  return map
}

/** Birthdays and anniversaries keyed MM-DD, so any year's grid can look them up. */
export function occasionsByMonthDay(people: Person[]): Map<string, OccasionSeed[]> {
  const map = new Map<string, OccasionSeed[]>()
  for (const person of people) {
    for (const kind of ['birthday', 'anniversary'] as const) {
      const raw = person[kind]
      const m = raw ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw) : null
      if (!m) continue
      const key = `${m[2]}-${m[3]}`
      const year = Number(m[1])
      const arr = map.get(key) ?? []
      // a year of 0000 means "date only" — no age to show
      arr.push({ person, kind, year: year > 1900 ? year : undefined })
      map.set(key, arr)
    }
  }
  for (const arr of map.values()) arr.sort((a, b) => a.person.name.localeCompare(b.person.name))
  return map
}

function monthDayKey(d: Date): string {
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Occasions falling on one date, with the age reached on that date. */
export function occasionsOn(day: Date, byMonthDay: Map<string, OccasionSeed[]>): DayOccasion[] {
  return (byMonthDay.get(monthDayKey(day)) ?? []).map(o => ({ person: o.person, kind: o.kind, years: o.year ? day.getFullYear() - o.year : undefined }))
}

// all-day things read first, then the day's clock, then the slower project dates
const RANK = { occasion: 0, meal: 1, allDayEvent: 2, event: 3, task: 4, mark: 5 }

function rankOf(item: DayItem): number {
  if (item.kind === 'event') return item.event.allDay ? RANK.allDayEvent : RANK.event
  return RANK[item.kind]
}

function sortKeyOf(item: DayItem): string {
  if (item.kind === 'event') return item.event.allDay ? item.event.title : item.event.start
  if (item.kind === 'task') return item.at && hasClock(item.at) ? item.at : '\uffff' + (item.task.title || '')
  if (item.kind === 'mark') return item.mark.label
  // breakfast, lunch, dinner — the slot's place in the day, not its name's place
  // in the alphabet, which had dinner sitting above lunch in every grid
  if (item.kind === 'meal') return `${MEAL_SLOTS.indexOf(item.meal.slot)}${item.meal.title}`
  return item.occasion.person.name
}

/** Everything on one day, in reading order: occasions, all-day, timed, tasks, project dates. */
export function dayItems(day: Date, src: DaySources): DayItem[] {
  const k = dateKey(day)
  const items: DayItem[] = [
    ...occasionsOn(day, src.occasions).map<DayItem>(o => ({ kind: 'occasion', id: `occ-${o.person.id}-${o.kind}`, occasion: o })),
    ...(src.meals?.get(k) ?? []).map<DayItem>(m => ({ kind: 'meal', id: `meal-${m.id}`, meal: m })),
    ...(src.events.get(k) ?? []).map<DayItem>(ev => ({ kind: 'event', id: `ev-${ev.id}`, event: ev })),
    ...(src.tasks.get(k) ?? []).map<DayItem>(t => ({ kind: 'task', id: `task-${t.id}`, task: t, at: taskDayIso(t) })),
    ...(src.marks.get(k) ?? []).map<DayItem>(m => ({ kind: 'mark', id: `mark-${m.project.id}-${m.milestone?.id ?? 'target'}`, mark: m })),
  ]
  return items.sort((a, b) => rankOf(a) - rankOf(b) || sortKeyOf(a).localeCompare(sortKeyOf(b)))
}

/** "2 events · 1 task" for a day header; "Nothing planned" when the day is empty. */
export function daySummary(items: DayItem[]): string {
  const counts = { event: 0, task: 0, occasion: 0, mark: 0, meal: 0 }
  for (const item of items) counts[item.kind]++
  const parts: string[] = []
  const say = (n: number, one: string, many: string) => parts.push(`${n} ${n === 1 ? one : many}`)
  if (counts.event > 0) say(counts.event, 'event', 'events')
  if (counts.task > 0) say(counts.task, 'task', 'tasks')
  if (counts.meal > 0) say(counts.meal, 'meal', 'meals')
  if (counts.occasion > 0) say(counts.occasion, 'occasion', 'occasions')
  if (counts.mark > 0) say(counts.mark, 'project date', 'project dates')
  return parts.length > 0 ? parts.join(' · ') : 'Nothing planned'
}
