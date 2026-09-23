import { OPEN_STATUSES, PRIORITY_META, Project, Task } from './types'
import { fmtDate, fmtTime, uid } from './utils'
import { hasDueTime, isLate, isOverdue } from '../shared/due.mts'

// The midnight rule lives in shared/due.mts, where the digest reads it too
export { hasDueTime, isOverdue }

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

/**
 * Today's Inbox: a to-do with no date, whichever project it is filed under.
 * There is one ongoing project and nothing on screen shows or sets it, so the
 * Inbox goes by what you can see and change — a date, or another status, is
 * what takes a task out. The palette's capture toast asks the same question.
 * Today also moves one left untouched too long on to Going stale, so no to-do
 * is listed twice; a fresh capture is never stale, so the toast needs no clock.
 */
export function inInbox(t: Task): boolean {
  return t.status === 'todo' && !t.dueAt
}

export type DueTone = 'overdue' | 'late' | 'today' | 'soon' | 'later' | 'none'

export function dueTone(t: Task, now: Date = new Date()): DueTone {
  if (!t.dueAt || !isOpen(t)) return 'none'
  if (isOverdue(t.dueAt, now)) return 'overdue'
  const off = dayOffset(t.dueAt, now)
  // "late" means a time that has passed. An untimed task is due all day, so it
  // stays "today" until midnight and is overdue from then — its 00:00 stamp is
  // a day, not a deadline, and must not read as late from the moment you wake.
  if (off === 0) return isLate(t.dueAt, now) ? 'late' : 'today'
  if (off <= 7) return 'soon'
  return 'later'
}

const WEEKDAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: 'short' })

/** Compact human due label: "Overdue 2d", "Was 3:00 PM", "Today 3:00 PM", "Tomorrow", "Fri". */
export function dueLabel(t: Task, now: Date = new Date()): string {
  if (!t.dueAt) return ''
  const off = dayOffset(t.dueAt, now)
  const dueDate = new Date(t.dueAt)
  const hasTime = hasDueTime(t.dueAt)
  const time = hasTime ? ` ${fmtTime(t.dueAt)}` : ''
  if (isOpen(t) && off < 0) return `Overdue ${-off}d`
  // same rule as dueTone: only a time can already have passed today
  if (isOpen(t) && off === 0 && isLate(t.dueAt, now)) return `Was${time}`
  if (off === 0) return `Today${time}`
  if (off === 1) return `Tomorrow${time}`
  if (off > 1 && off <= 6) return `${WEEKDAY_FMT.format(dueDate)}${time}`
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

/** Fresh copy of a task for Duplicate — new id/timestamps, no comments/completion. */
export function duplicateTask(source: Task): Task {
  const now = new Date().toISOString()
  const status = source.status === 'done' || source.status === 'canceled' ? 'todo' : source.status
  return {
    kind: 'task',
    id: uid(),
    title: source.title,
    description: source.description,
    status,
    priority: source.priority,
    projectId: source.projectId,
    dueAt: source.dueAt,
    createdAt: now,
    updatedAt: now,
    tags: [...source.tags],
    notes: source.notes,
    link: source.link,
    githubUrl: source.githubUrl,
    checklist: source.checklist?.map(c => ({ id: uid(), text: c.text, done: false })),
    mediaIds: source.mediaIds ? [...source.mediaIds] : undefined,
    recurrence: source.recurrence ? { ...source.recurrence } : undefined,
    peopleIds: source.peopleIds ? [...source.peopleIds] : undefined,
    placeId: source.placeId,
    attachments: source.attachments?.map(a => ({ ...a })),
    estimateCost: source.estimateCost,
    blockedBy: source.blockedBy ? [...source.blockedBy] : undefined,
    assigneeId: source.assigneeId,
    // A copy of a private task is private. This list is written out field by
    // field, so a field left off it is a field the copy does not have — and an
    // absent `shared` on a task means the HOUSEHOLD'S (v3.19). One press of
    // Duplicate would have handed the other member the title, the description,
    // the checklist, the attachments and the photos of something its owner had
    // withheld, with nothing on screen saying the copy was public.
    shared: source.shared,
    ownerId: source.ownerId,
  }
}
