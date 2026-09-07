import { OPEN_STATUSES, PRIORITY_META, Project, Task } from './types'
import { fmtDate, fmtTime } from './utils'

export const DAY_MS = 86_400_000

export function startOfDay(d: Date = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Whole days between today and the given date (negative = past). */
export function dayOffset(iso: string, now: Date = new Date()): number {
  const target = startOfDay(new Date(iso)).getTime()
  return Math.round((target - startOfDay(now).getTime()) / DAY_MS)
}

export function isOpen(t: Task): boolean {
  return OPEN_STATUSES.includes(t.status)
}

export type DueTone = 'overdue' | 'today' | 'soon' | 'later' | 'none'

export function dueTone(t: Task, now: Date = new Date()): DueTone {
  if (!t.dueAt || !isOpen(t)) return 'none'
  const due = new Date(t.dueAt).getTime()
  if (due < now.getTime()) return dayOffset(t.dueAt, now) === 0 ? 'today' : 'overdue'
  const off = dayOffset(t.dueAt, now)
  if (off === 0) return 'today'
  if (off <= 7) return 'soon'
  return 'later'
}

const WEEKDAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: 'short' })

/** Compact human due label: "Overdue 2d", "Today 3:00 PM", "Tomorrow", "Fri", "Sep 20". */
export function dueLabel(t: Task, now: Date = new Date()): string {
  if (!t.dueAt) return ''
  const off = dayOffset(t.dueAt, now)
  const hasTime = !/T00:00:00/.test(new Date(t.dueAt).toISOString()) && new Date(t.dueAt).getHours() + new Date(t.dueAt).getMinutes() > 0
  const time = hasTime ? ` ${fmtTime(t.dueAt)}` : ''
  if (isOpen(t) && off < 0) return `Overdue ${-off}d`
  if (off === 0) return `Today${time}`
  if (off === 1) return `Tomorrow${time}`
  if (off > 1 && off <= 6) return `${WEEKDAY_FMT.format(new Date(t.dueAt))}${time}`
  return fmtDate(t.dueAt)
}

/** Sort: overdue/soonest due first, then priority, then most recently updated. */
export function compareTasks(a: Task, b: Task): number {
  const ad = a.dueAt ?? '9999'
  const bd = b.dueAt ?? '9999'
  if (ad !== bd) return ad.localeCompare(bd)
  const pr = PRIORITY_META[b.priority].rank - PRIORITY_META[a.priority].rank
  if (pr !== 0) return pr
  return b.updatedAt.localeCompare(a.updatedAt)
}

export function projectById(projects: Project[]): Map<string, Project> {
  return new Map(projects.map(p => [p.id, p]))
}

export function checklistProgress(t: Task): { done: number; total: number } | null {
  if (!t.checklist || t.checklist.length === 0) return null
  return { done: t.checklist.filter(c => c.done).length, total: t.checklist.length }
}
