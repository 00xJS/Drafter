// Due-day bucketing shared by Today and the digest.

export const OPEN = ['todo', 'doing', 'blocked']
export const DAY_MS = 86_400_000

/**
 * Split open tasks into overdue / dueToday / dueSoon using local day keys.
 * `dayKey(iso)` returns YYYY-MM-DD in the viewer's timezone (or null if bad).
 * `today` is today's YYYY-MM-DD in that same zone.
 */
export function bucketByDue(tasks, { today, dayKey }) {
  const open = (tasks ?? []).filter(t => OPEN.includes(t.status) && !t.deletedAt)
  const overdue = []
  const dueToday = []
  const dueSoon = []
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
