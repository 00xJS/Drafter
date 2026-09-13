import { CalendarEntry, Person, Task } from './types'
import { startOfDay } from './taskutils'
import {
  DEFAULT_CADENCE_DAYS,
  DAY_MS,
  visitsFor as sharedVisitsFor,
  eventVisits as sharedEventVisits,
  plannedVisit as sharedPlannedVisit,
  plannedGift as sharedPlannedGift,
  seenStatus as sharedSeenStatus,
  upcomingOccasions as sharedOccasions,
} from '../shared/people.mjs'

// "Seeing someone" is a completed task they're attached to: a logged visit,
// a dinner you planned, a task you did together. An event of your own they
// are on counts too once it has happened, read as the visit task it amounts
// to (eventVisits). Everything below derives from those completion dates.

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
  count30: number
  count90: number
  /** Average days between visits over the last year. */
  avgGapDays?: number
  /** Visits per week over the last 12 weeks, oldest first — for the mini bars. */
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

/**
 * Your own past events with people on them, as the done visit tasks they
 * amount to. Add them to the tasks a count reads and each counts as a
 * subscribed calendar's event does once Who was there? has logged it. They
 * are read, never saved.
 */
export function eventVisits(entries: CalendarEntry[], now: Date = new Date()): Task[] {
  return sharedEventVisits(entries, now)
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

export function personStats(person: Person, tasks: Task[], now: Date = new Date()): PersonStats {
  const base = sharedSeenStatus(person, tasks, now)
  const visits = base.visits as Visit[]
  const summary = visitSummary(visits, now)
  const planned = (sharedPlannedVisit(person.id, tasks) as Task | null) ?? undefined

  return {
    person,
    visits,
    lastSeen: base.lastSeen,
    daysSince: base.daysSince,
    count30: summary.count30,
    count90: summary.count90,
    avgGapDays: summary.avgGapDays,
    weekly: summary.weekly,
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
  /** Visits per month, Jan..Dec of the given year. */
  months: number[]
  total: number
  /** Positive = seeing more lately, negative = drifting (last 90 days vs the 90 before). */
  trend: number
}

export function yearReport(people: Person[], tasks: Task[], year: number, now: Date = new Date()): YearRow[] {
  const nowMs = now.getTime()
  return people
    .map(person => {
      const visits = visitsFor(person.id, tasks)
      const months = Array.from({ length: 12 }, () => 0)
      for (const v of visits) {
        const d = new Date(v.at)
        if (d.getFullYear() === year) months[d.getMonth()]++
      }
      const recent = visits.filter(v => nowMs - Date.parse(v.at) < 90 * DAY_MS).length
      const before = visits.filter(v => {
        const age = nowMs - Date.parse(v.at)
        return age >= 90 * DAY_MS && age < 180 * DAY_MS
      }).length
      return { person, months, total: months.reduce((a, b) => a + b, 0), trend: recent - before }
    })
    .sort((a, b) => b.total - a.total)
}
