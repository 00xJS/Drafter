import { CalendarEntry, Person, Task } from './types'
import { startOfDay } from './taskutils'
import { dateKey } from './utils'
import {
  DEFAULT_CADENCE_DAYS,
  DAY_MS,
  visitsFor as sharedVisitsFor,
  visitDays as sharedVisitDays,
  eventVisits as sharedEventVisits,
  seenTasks as sharedSeenTasks,
  plannedVisit as sharedPlannedVisit,
  plannedGift as sharedPlannedGift,
  seenStatus as sharedSeenStatus,
  upcomingOccasions as sharedOccasions,
} from '../shared/people.mjs'

// "Seeing someone" is a completed task they're attached to: a logged visit,
// a dinner you planned, a task you did together. An event of your own they
// are on counts too once it has happened, read as the visit task it amounts
// to (eventVisits). Everything below derives from those completion dates.
// Each one is an event; "how often" is counted in days seen, because three
// events with the same group on one Saturday are one time you saw them, not
// three.

export interface Visit {
  task: Task
  at: string
}

export type SeenStatus = 'never' | 'overdue' | 'due' | 'ok'

export interface PersonStats {
  person: Person
  visits: Visit[]
  lastSeen?: string
  daysSince?: number
  /** Events (completed tasks with them) in the last 30 / 90 days. */
  count30: number
  count90: number
  /** Days seen in the last 30 / 90 days and all time: several events on one day are one day. */
  days30: number
  days90: number
  daysAll: number
  /** Events all time, to sit beside daysAll. */
  eventsAll: number
  /** Average days between the days you saw them over the last year. */
  avgGapDays?: number
  /** Days seen per week (0..7) over the last 12 weeks, oldest first — for the mini bars. */
  weekly: number[]
  status: SeenStatus
  /** Human explanation of the status. */
  reason: string
  /** Soonest open visit/catch-up task, if one exists. */
  planned?: Task
}

export function visitsFor(personId: string, tasks: Task[]): Visit[] {
  return sharedVisitsFor(personId, tasks) as Visit[]
}

/** The distinct days among these visits, on the viewer's own calendar unless told otherwise. */
export function visitDays(visits: { at: string }[], dayKeyOf: (at: string) => string | null = dateKey): string[] {
  return sharedVisitDays(visits, dayKeyOf)
}

/** "1 day", "3 events". */
export const countOf = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/** "2 days · 3 events", or just "2 days" when no two events shared a day. */
export function seenLabel(days: number, events: number): string {
  return events === days ? countOf(days, 'day') : `${countOf(days, 'day')} · ${countOf(events, 'event')}`
}

/** A YYYY-MM-DD key as a whole day number, so a DST hour never shortens a gap. */
const dayNumber = (key: string) => Math.round(Date.parse(`${key}T00:00:00Z`) / DAY_MS)

/**
 * Your own past events with people on them, as the done visit tasks they
 * amount to. Add them to the tasks a count reads and each counts as a
 * subscribed calendar's event does once Who was there? has logged it. They
 * are read, never saved.
 */
export function eventVisits(entries: CalendarEntry[], now: Date = new Date()): Task[] {
  return sharedEventVisits(entries, now)
}

/**
 * What every "have you seen them" figure reads: the tasks plus those event
 * visits. People, Today, Review, Ask and the week plan all count through it.
 */
export function seenTasks(tasks: Task[], entries: CalendarEntry[] | undefined, now: Date = new Date()): Task[] {
  return sharedSeenTasks(tasks, entries, now)
}

/** Shared last/gap/weekly rollup used by people and places. */
// Widened to anything carrying an instant: a place's outings now include meals
// eaten out, which are not tasks. Only `at` is ever read here.
export function visitSummary(visits: { at: string }[], now: Date = new Date()) {
  const nowMs = now.getTime()
  const lastAt = visits[0]?.at
  const daysSince =
    lastAt !== undefined
      ? Math.floor((startOfDay(now).getTime() - startOfDay(new Date(lastAt)).getTime()) / DAY_MS)
      : undefined
  const count30 = visits.filter(v => nowMs - Date.parse(v.at) < 30 * DAY_MS).length
  const count90 = visits.filter(v => nowMs - Date.parse(v.at) < 90 * DAY_MS).length
  const count365 = visits.filter(v => nowMs - Date.parse(v.at) < 365 * DAY_MS).length

  const yearVisits = visits
    .filter(v => nowMs - Date.parse(v.at) < 365 * DAY_MS)
    .map(v => Date.parse(v.at))
    .sort((a, b) => a - b)
  let avgGapDays: number | undefined
  if (yearVisits.length >= 2) {
    const gaps = yearVisits.slice(1).map((t, i) => t - yearVisits[i])
    avgGapDays = gaps.reduce((s, g) => s + g, 0) / gaps.length / DAY_MS
  }

  const weekStart = startOfDay(now).getTime() - 11 * 7 * DAY_MS
  const weekly = Array.from({ length: 12 }, () => 0)
  for (const v of visits) {
    const idx = Math.floor((Date.parse(v.at) - weekStart) / (7 * DAY_MS))
    if (idx >= 0 && idx < 12) weekly[idx]++
  }

  return { lastAt, daysSince, count30, count90, count365, avgGapDays, weekly }
}

/**
 * The people half of the rollup, counted in days seen rather than events.
 * Places keep visitSummary: an outing there is what they count.
 */
export function daySummary(visits: { at: string }[], now: Date = new Date()) {
  const nowMs = now.getTime()
  const daysWithin = (days: number) => visitDays(visits.filter(v => nowMs - Date.parse(v.at) < days * DAY_MS))
  const all = visitDays(visits)

  // the whole span over one fewer gaps: a same-day repeat is no longer a 0-day gap
  const year = daysWithin(365).map(dayNumber)
  const avgGapDays = year.length >= 2 ? (Math.max(...year) - Math.min(...year)) / (year.length - 1) : undefined

  // twelve 7-day buckets, the last one ending today
  const first = dayNumber(dateKey(now)) - 12 * 7 + 1
  const weekly = Array.from({ length: 12 }, () => 0)
  for (const key of all) {
    const idx = Math.floor((dayNumber(key) - first) / 7)
    if (idx >= 0 && idx < 12) weekly[idx]++
  }

  return { days30: daysWithin(30).length, days90: daysWithin(90).length, daysAll: all.length, avgGapDays, weekly }
}

export function personStats(person: Person, tasks: Task[], now: Date = new Date()): PersonStats {
  const base = sharedSeenStatus(person, tasks, now)
  const visits = base.visits as Visit[]
  const summary = visitSummary(visits, now)
  const days = daySummary(visits, now)
  const planned = (sharedPlannedVisit(person.id, tasks) as Task | null) ?? undefined

  return {
    person,
    visits,
    lastSeen: base.lastSeen,
    daysSince: base.daysSince,
    count30: summary.count30,
    count90: summary.count90,
    days30: days.days30,
    days90: days.days90,
    daysAll: days.daysAll,
    eventsAll: visits.length,
    avgGapDays: days.avgGapDays,
    weekly: days.weekly,
    status: base.status as SeenStatus,
    reason: base.reason,
    planned,
  }
}

export function plannedGift(personId: string, kind: 'birthday' | 'anniversary', at: Date, tasks: Task[]): Task | null {
  return sharedPlannedGift(personId, kind, at, tasks) as Task | null
}

/** Used when someone has no declared rhythm, so drift is still visible. */
export { DEFAULT_CADENCE_DAYS }

export const SEEN_META: Record<SeenStatus, { label: string; color: string; bg: string }> = {
  never: { label: 'No visits yet', color: '#9ca3af', bg: 'rgba(148, 163, 184, 0.16)' },
  overdue: { label: 'Overdue', color: '#fda4af', bg: 'rgba(244, 63, 94, 0.2)' },
  due: { label: 'Due a catch-up', color: '#fcd34d', bg: 'rgba(245, 158, 11, 0.18)' },
  ok: { label: 'On track', color: '#86efac', bg: 'rgba(34, 197, 94, 0.18)' },
}

/** Sort: the people who need attention first, then by how long since. Planned catch-ups sort below true drift. */
export function compareStats(a: PersonStats, b: PersonStats): number {
  const aPlanned = a.planned ? 1 : 0
  const bPlanned = b.planned ? 1 : 0
  if (aPlanned !== bPlanned) return aPlanned - bPlanned
  const rank: Record<SeenStatus, number> = { overdue: 0, due: 1, never: 2, ok: 3 }
  if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status]
  return (b.daysSince ?? 0) - (a.daysSince ?? 0)
}

export interface Occasion {
  person: Person
  kind: 'birthday' | 'anniversary'
  /** Next occurrence as a local Date. */
  at: Date
  daysUntil: number
  /** Age or years, when the stored date has a real year. */
  years?: number
}

/** Birthdays and anniversaries coming up within `days` (today included). */
export function upcomingOccasions(people: Person[], days = 14, now: Date = new Date()): Occasion[] {
  return sharedOccasions(people, days, now) as Occasion[]
}

export interface YearRow {
  person: Person
  /** Days seen per month, Jan..Dec of the given year. */
  months: number[]
  /** Days seen in the year. */
  total: number
  /** Events in the year, however many shared a day. */
  events: number
  /** Positive = seeing more lately, negative = drifting (days seen in the last 90 days vs the 90 before). */
  trend: number
}

export function yearReport(people: Person[], tasks: Task[], year: number, now: Date = new Date()): YearRow[] {
  const nowMs = now.getTime()
  return people
    .map(person => {
      const visits = visitsFor(person.id, tasks)
      const inYear = visits.filter(v => new Date(v.at).getFullYear() === year)
      const months = Array.from({ length: 12 }, () => 0)
      for (const key of visitDays(inYear)) months[Number(key.slice(5, 7)) - 1]++
      // a day with events either side of the 90-day line lands in both windows,
      // which adds one to each side and leaves the difference alone
      const recent = visitDays(visits.filter(v => nowMs - Date.parse(v.at) < 90 * DAY_MS)).length
      const before = visitDays(
        visits.filter(v => {
          const age = nowMs - Date.parse(v.at)
          return age >= 90 * DAY_MS && age < 180 * DAY_MS
        }),
      ).length
      return { person, months, total: months.reduce((a, b) => a + b, 0), events: inYear.length, trend: recent - before }
    })
    .sort((a, b) => b.total - a.total || b.events - a.events)
}
