import { CalendarEntry, Person, Place, Project, Task } from './types'
import { DAY_MS, isOverdue, startOfDay } from './taskutils'
import { seenTasks, visitDays } from './people'
import { outingsAt } from './places'
import { dateKey } from './utils'
import { weekKeyOf } from '../shared/weeks.mts'
import { nextUp } from '../shared/today.mts'
import { inRange as sharedInRange, isVisit, peopleSeen as sharedPeopleSeen, reviewLists } from '../shared/review.mts'

export type Period = 'week' | 'month'

export interface Range {
  period: Period
  /** Stable id, e.g. 2026-W37 or 2026-09. */
  key: string
  start: Date
  /** Exclusive. */
  end: Date
  label: string
}

/** Monday-start ISO-ish week containing `d` (we use Sunday-start weeks in the UI, so weeks run Sun→Sat). */
export function weekRange(d: Date): Range {
  const s = startOfDay(d)
  s.setDate(s.getDate() - s.getDay())
  const e = new Date(s)
  e.setDate(e.getDate() + 7)
  // calendar arithmetic on the date, never on milliseconds: a DST hour used to
  // shift the week number in years that start on a Sunday
  const key = weekKeyOf(dateKey(s)) ?? `${s.getFullYear()}-W00`
  const fmt = (x: Date) => x.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const last = new Date(e.getTime() - DAY_MS)
  return { period: 'week', key, start: s, end: e, label: `${fmt(s)} – ${fmt(last)}` }
}

export function monthRange(d: Date): Range {
  const s = new Date(d.getFullYear(), d.getMonth(), 1)
  const e = new Date(d.getFullYear(), d.getMonth() + 1, 1)
  return {
    period: 'month',
    key: `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}`,
    start: s,
    end: e,
    label: s.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
  }
}

export function rangeFor(period: Period, d: Date): Range {
  return period === 'week' ? weekRange(d) : monthRange(d)
}

/** On Sunday (or before a full day of the week has passed), review last week. */
export function defaultReviewAnchor(now = new Date()): Date {
  const range = weekRange(now)
  if (now.getDay() === 0 || now.getTime() - range.start.getTime() < DAY_MS) {
    return new Date(range.start.getTime() - DAY_MS)
  }
  return now
}

export function shiftRange(r: Range, delta: number): Range {
  if (r.period === 'week') return weekRange(new Date(r.start.getTime() + delta * 7 * DAY_MS + DAY_MS))
  return monthRange(new Date(r.start.getFullYear(), r.start.getMonth() + delta, 1))
}

export interface ReviewData {
  range: Range
  done: Task[]
  /** Logged visits in the range — real, but not work finished. */
  visitsDone: Task[]
  /** Open tasks due inside the range whose day is over (shared/due.mts): a task due today has not slipped yet. */
  slipped: Task[]
  created: Task[]
  /** Open and due inside the following period. */
  upcoming: Task[]
  /** Open and overdue now, whenever they were due: Home's Overdue, and what the bulk buttons move. */
  overdueNow: Task[]
  /** Events in the range, per person, and the days they fell on: three on one Saturday are one day. */
  people: { person: Person; visits: Task[]; days: number }[]
  /** The days you saw anyone in the range, and the events on them, each counted once however many people were there. */
  seen: { days: number; events: number }
  /** Outings in the range, per place. */
  places: { place: Place; visits: Task[] }[]
  /** Per-project done/open counts for the range. */
  projects: { project: Project; done: number; open: number }[]
  /** Projects with nothing touched during the range. */
  stalled: Project[]
  costs: { estimate: number; actual: number }
  doneByDay: number[]
}

export { isVisit }

const inRange = (iso: string | undefined, r: Range) => sharedInRange(iso, r.start, r.end)

/** `entries` are your own calendar entries: one that has happened with people on it counts as seeing them. */
export function buildReview(range: Range, tasks: Task[], projects: Project[], people: Person[], now = new Date(), places: Place[] = [], entries: CalendarEntry[] = [], myId?: string | null): ReviewData {
  const next = shiftRange(range, 1)
  const open = tasks.filter(t => t.status === 'todo' || t.status === 'doing' || t.status === 'blocked')
  // done, slipped and people seen are the lists Sunday's automatic draft reads
  // too (shared/review.mts), so the draft names what this page shows
  const { done, visitsDone, slipped } = reviewLists(tasks, range, now)
  const created = tasks.filter(t => inRange(t.createdAt, range) && !t.tags.includes('visit'))
  const upcoming = open.filter(t => inRange(t.dueAt, next)).sort((a, b) => a.dueAt!.localeCompare(b.dueAt!))
  // the rule Home's Overdue goes by: a task due today, untimed or with its time
  // gone by, is today's still, and Push all to Monday must not sweep it up
  const overdueNow = open.filter(t => isOverdue(t.dueAt, now)).sort((a, b) => a.dueAt!.localeCompare(b.dueAt!))
  // as on the People page: your own past events count, read as the visits they
  // amount to. Only names and titles are shown here, so none is ever opened as a task.
  // `myId` is what keeps the recap yours: a fortnight in which the other member
  // saw their mother twice used to read here as though you had (v3.24).
  const peopleSeen = sharedPeopleSeen(people, seenTasks(tasks, entries, now, myId), range, dateKey)
  const seenEvents = new Map<string, { at: string }>()
  for (const p of peopleSeen) for (const t of p.visits) seenEvents.set(t.id, { at: t.completedAt! })
  const seen = { days: visitDays([...seenEvents.values()]).length, events: seenEvents.size }
  const placesWent = places
    // task outings only: this row lists the visits you logged, and a takeaway
    // has no task to open. Eating out is counted on the place's own card.
    .map(p => ({ place: p, visits: outingsAt(p.id, tasks, [], now, myId).flatMap(v => (v.kind === 'task' && inRange(v.at, range) ? [v.task] : [])) }))
    .filter(x => x.visits.length > 0)
    .sort((a, b) => b.visits.length - a.visits.length)
  const projectRows = projects
    .filter(p => p.status !== 'archived')
    .map(project => ({
      project,
      done: done.filter(t => t.projectId === project.id).length,
      open: open.filter(t => t.projectId === project.id).length,
    }))
    .filter(r => r.done > 0 || r.open > 0)
    .sort((a, b) => b.done - a.done)
  const touched = new Set<string>()
  for (const t of tasks) if (t.projectId && inRange(t.updatedAt, range)) touched.add(t.projectId)
  const stalled = projects.filter(p => p.status === 'active' && !touched.has(p.id) && !inRange(p.updatedAt, range) && Date.parse(p.createdAt) < range.start.getTime())
  const costs = {
    estimate: done.reduce((s, t) => s + (t.estimateCost ?? 0), 0),
    actual: done.reduce((s, t) => s + (t.actualCost ?? 0), 0),
  }
  const days = Math.round((range.end.getTime() - range.start.getTime()) / DAY_MS)
  const doneByDay = Array.from({ length: days }, () => 0)
  for (const t of done) {
    const i = Math.floor((Date.parse(t.completedAt!) - range.start.getTime()) / DAY_MS)
    if (i >= 0 && i < days) doneByDay[i]++
  }
  return { range, done, visitsDone, slipped, created, upcoming, overdueNow, people: peopleSeen, seen, places: placesWent, projects: projectRows, stalled, costs, doneByDay }
}

/** Done-per-week for the last n weeks (oldest first), for the Today sparkline. */
export function doneByWeek(tasks: Task[], weeks = 12, now = new Date()): number[] {
  const thisWeek = weekRange(now)
  const out = Array.from({ length: weeks }, () => 0)
  const firstStart = thisWeek.start.getTime() - (weeks - 1) * 7 * DAY_MS
  for (const t of tasks) {
    if (t.status !== 'done' || !t.completedAt || isVisit(t)) continue
    const i = Math.floor((Date.parse(t.completedAt) - firstStart) / (7 * DAY_MS))
    if (i >= 0 && i < weeks) out[i]++
  }
  return out
}

/**
 * The single most useful list on Today: what to do next, drawn from ALL open
 * work. Previously Today derived every section from tasks that had a due date,
 * so anything filed into a project without one was invisible for a fortnight —
 * and dating every home task is exactly the discipline this app exists to
 * replace. Ranking is deliberate and explainable, never a black box.
 */
export interface NextUp {
  task: Task
  /** Why it is here, shown to the user. */
  reason: string
  score: number
}

// Ranked in shared/today.mts, so the week plan's Top 3 — in the app and in the
// Sunday digest — ranks exactly as this list does. `exclude` leaves tasks out
// without changing how the rest score: today's focus has its own card.
export { nextUp }
