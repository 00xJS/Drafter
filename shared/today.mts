// Due-day bucketing, today's focus and "next up": the rules Today, the digest
// and the planner's sheets share.

import type { Priority, Project, Task } from '../src/types.ts'

export const OPEN: string[] = ['todo', 'doing', 'blocked']
export const DAY_MS = 86_400_000

/**
 * Split open tasks into overdue / dueToday / dueSoon using local day keys.
 * `dayKey(iso)` returns YYYY-MM-DD in the viewer's timezone (or null if bad).
 * `today` is today's YYYY-MM-DD in that same zone.
 */
export function bucketByDue(
  tasks: readonly Task[],
  { today, dayKey }: { today: string; dayKey: (iso: string) => string | null },
): { open: Task[]; overdue: Task[]; dueToday: Task[]; dueSoon: Task[] } {
  const open = (tasks ?? []).filter(t => OPEN.includes(t.status) && !t.deletedAt)
  const overdue: Task[] = []
  const dueToday: Task[] = []
  const dueSoon: Task[] = []
  for (const t of open) {
    if (!t.dueAt) continue
    const key = dayKey(t.dueAt)
    if (!key) continue
    if (key < today) overdue.push(t)
    else if (key === today) dueToday.push(t)
    else dueSoon.push(t)
  }
  return { open, overdue, dueToday, dueSoon }
}

/**
 * Whether a task is in `userId`'s focus on `dayKey`. `focusOn` is the local day
 * it was chosen for — past values are history, never cleared — and `focusBy`
 * who chose it. A missing `focusBy` (local mode, or a pick made before
 * accounts) or an unknown user counts as anyone's; a household member's picks
 * are theirs alone and never land in your focus.
 */
export function isFocusFor(task: { focusOn?: string; focusBy?: string } | null | undefined, dayKey: string, userId?: string | null): boolean {
  if (!task || !dayKey || task.focusOn !== dayKey) return false
  return !task.focusBy || !userId || task.focusBy === userId
}

/** The day's focus: open tasks first, then the finished ones — which is what reads as "2 of 3 done". */
export function focusTasks<T extends { status: string; focusOn?: string; focusBy?: string; deletedAt?: string }>(tasks: readonly T[], dayKey: string, userId?: string | null): T[] {
  const live = (tasks ?? []).filter(t => t && !t.deletedAt && isFocusFor(t, dayKey, userId))
  return [...live.filter(t => OPEN.includes(t.status)), ...live.filter(t => t.status === 'done')]
}

/** A task created this recently is almost certainly what you are looking at the screen for. */
const JUST_ADDED_MS = 10 * 60_000
const PRIORITY_POINTS: Partial<Record<Priority, number>> = { urgent: 3, high: 2, normal: 1, low: 0 }

/**
 * Today's "Next up" ranking (src/review.ts re-exports it). It lives here
 * so the week plan's Top 3, in the app and in the Sunday digest, ranks exactly
 * as Today does. `exclude` leaves tasks out without changing how the rest
 * score: today's focus has a card of its own and is not listed twice.
 */
export function nextUp<T extends Task>(
  tasks: readonly T[],
  _projects: readonly Pick<Project, 'id' | 'status'>[],
  limit = 6,
  now: Date = new Date(),
  pinnedTitles: readonly string[] = [],
  exclude: ReadonlySet<string> = new Set(),
): { task: T; reason: string; score: number }[] {
  const nowMs = now.getTime()
  const open = (tasks ?? []).filter(t => OPEN.includes(t.status) && !exclude.has(t.id))
  // a project touched recently is one you are actually in the middle of
  const pinSet = new Set((pinnedTitles ?? []).map(t => t.trim().toLowerCase()).filter(Boolean))

  const scored = open.map(t => {
    let score = 0
    let reason = ''
    const due = t.dueAt ? Date.parse(t.dueAt) : NaN
    const days = Number.isFinite(due) ? Math.round((due - nowMs) / DAY_MS) : null

    if (pinSet.has((t.title || '').trim().toLowerCase())) {
      return { task: t, reason: 'your top 3', score: 3000 }
    }

    // Ranking otherwise rewards age, so a brand-new task sorts to the BOTTOM and
    // vanishes behind the cut — you save something and the page looks unchanged.
    const age = nowMs - Date.parse(t.createdAt)
    if (Number.isFinite(age) && age >= 0 && age < JUST_ADDED_MS) {
      return { task: t, reason: 'just added', score: 2000 - age / 1000 }
    }

    if (days !== null && days < 0) {
      score += 1000 - Math.min(days * -1, 60)
      reason = `overdue ${-days}d`
    } else if (Number.isFinite(due) && due < nowMs && days === 0) {
      // same calendar day, time already past — between overdue and due-today
      const hoursAgo = Math.max(1, Math.round((nowMs - due) / 3_600_000))
      score += 950
      reason = `due ${hoursAgo}h ago`
    } else if (days !== null && days <= 1) {
      score += 900
      reason = days === 0 ? 'due today' : 'due tomorrow'
    } else if (days !== null && days <= 7) {
      score += 700 - days * 10
      reason = `due in ${days}d`
    } else if (t.status === 'doing') {
      score += 600
      reason = 'in progress'
    } else if (days !== null) {
      score += 200 - Math.min(days, 90)
      reason = `due in ${days}d`
    } else {
      // undated: the backlog this list exists to surface, longest untouched
      // first. A project no longer lifts a task: with one home project every
      // task sat in a "moving" project, so it ranked and read the same for all.
      const idleDays = Math.floor((nowMs - Date.parse(t.updatedAt)) / DAY_MS)
      score += 300 + Math.min(idleDays, 60)
      reason = idleDays > 21 ? `untouched ${idleDays}d` : 'no date yet'
    }

    if (t.status === 'blocked') {
      score -= 250
      reason = 'blocked'
    }
    // a row an agent wrote without a priority reads as normal, as the app's sanitizer would make it
    score += (PRIORITY_POINTS[t.priority] ?? 1) * 40
    return { task: t, reason, score }
  })

  scored.sort((a, b) => b.score - a.score || (a.task.dueAt ?? '9').localeCompare(b.task.dueAt ?? '9'))
  return scored.slice(0, limit)
}
