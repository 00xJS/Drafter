import { Person, Task } from './types'
import { DAY_MS, startOfDay } from './taskutils'

// "Seeing someone" is a completed task they're attached to: a logged visit,
// a dinner you planned, a task you did together. Everything below derives
// from those completion dates.

export interface Visit {
  task: Task
  at: string
}

export type SeenStatus = 'never' | 'overdue' | 'due' | 'ok' | 'often'

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
}

export function visitsFor(personId: string, tasks: Task[]): Visit[] {
  return tasks
    .filter(t => t.status === 'done' && t.completedAt && t.peopleIds?.includes(personId))
    .map(t => ({ task: t, at: t.completedAt! }))
    .sort((a, b) => b.at.localeCompare(a.at))
}

export function personStats(person: Person, tasks: Task[], now: Date = new Date()): PersonStats {
  const visits = visitsFor(person.id, tasks)
  const nowMs = now.getTime()
  const lastSeen = visits[0]?.at
  const daysSince = lastSeen ? Math.floor((nowMs - Date.parse(lastSeen)) / DAY_MS) : undefined
  const count30 = visits.filter(v => nowMs - Date.parse(v.at) < 30 * DAY_MS).length
  const count90 = visits.filter(v => nowMs - Date.parse(v.at) < 90 * DAY_MS).length

  const yearVisits = visits.filter(v => nowMs - Date.parse(v.at) < 365 * DAY_MS).map(v => Date.parse(v.at)).sort((a, b) => a - b)
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

  const cadence = person.cadenceDays
  let status: SeenStatus
  let reason: string
  if (!lastSeen) {
    status = 'never'
    reason = 'No visits logged yet'
  } else if (cadence && daysSince !== undefined && daysSince > cadence * 1.5) {
    status = 'overdue'
    reason = `Last seen ${daysSince} days ago — you aimed for every ${cadence} days`
  } else if (cadence && daysSince !== undefined && daysSince > cadence) {
    status = 'due'
    reason = `It's been ${daysSince} days; you aimed for every ${cadence} days`
  } else if (cadence && count30 >= Math.max(3, Math.ceil((30 / cadence) * 2))) {
    status = 'often'
    reason = `${count30} times in 30 days — about double your usual rhythm`
  } else if (!cadence && count30 >= 6) {
    status = 'often'
    reason = `${count30} times in the last 30 days`
  } else {
    status = 'ok'
    reason = daysSince === 0 ? 'Seen today' : `Last seen ${daysSince} day${daysSince === 1 ? '' : 's'} ago`
  }
  return { person, visits, lastSeen, daysSince, count30, count90, avgGapDays, weekly, status, reason }
}

export const SEEN_META: Record<SeenStatus, { label: string; color: string; bg: string }> = {
  never: { label: 'No visits yet', color: '#9ca3af', bg: 'rgba(148, 163, 184, 0.16)' },
  overdue: { label: 'Overdue', color: '#fda4af', bg: 'rgba(244, 63, 94, 0.2)' },
  due: { label: 'Due a catch-up', color: '#fcd34d', bg: 'rgba(245, 158, 11, 0.18)' },
  ok: { label: 'On track', color: '#86efac', bg: 'rgba(34, 197, 94, 0.18)' },
  often: { label: 'Seeing a lot', color: '#7dd3fc', bg: 'rgba(14, 165, 233, 0.2)' },
}

/** Sort: the people who need attention first, then by how long since. */
export function compareStats(a: PersonStats, b: PersonStats): number {
  const rank: Record<SeenStatus, number> = { overdue: 0, due: 1, never: 2, often: 3, ok: 4 }
  if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status]
  return (b.daysSince ?? 0) - (a.daysSince ?? 0)
}
