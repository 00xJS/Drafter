// When a task is due, and when it is overdue: the one rule Home, Tasks, Bills,
// the weekly review (and Sunday's draft of it), every device's reminders and
// the server's "Due now" nudges all go by.
//
// A due date is an instant. One at local midnight is a day with no time: the
// editor writes a date-only task so, and the calendar, the reminders and the
// mirrors all read it so. It is due all day, and overdue once that day is
// over. It is never overdue, or "due now", from 00:00 on its own day, which is
// only when it happens to be stored. One with a time is late once that time
// has gone by (Home's "already past"), and overdue, as any task is, from the
// day after its own. So nothing is overdue anywhere that Home lists under Today.
//
// `tz` is the reader's IANA zone. The app leaves it out and reads the device's
// own; the server, which runs in UTC, passes the zone the account saved.
// Dependency-free ESM, like the rest of shared/.

const formatters = new Map<string, Intl.DateTimeFormat | null>()

/** The wall clock in `tz`, or null for a zone Intl does not know (the device's is read instead). */
function formatterFor(tz: string): Intl.DateTimeFormat | null {
  if (!formatters.has(tz)) {
    let f: Intl.DateTimeFormat | null = null
    try {
      f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    } catch {
      /* a zone Intl does not know */
    }
    formatters.set(tz, f)
  }
  return formatters.get(tz) ?? null
}

const pad = (n: number) => String(n).padStart(2, '0')

/** The calendar day (YYYY-MM-DD) and the hour and minute of an instant, on the wall clock in `tz`. */
function wallClock(ms: number, tz?: string | null): { day: string; hour: number; minute: number } {
  const f = tz ? formatterFor(tz) : null
  if (f) {
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]))
    return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute) }
  }
  const d = new Date(ms)
  return { day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, hour: d.getHours(), minute: d.getMinutes() }
}

const instant = (at: string | number | Date | null | undefined): number =>
  at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at ?? '')

/** The day a task is due, YYYY-MM-DD in `tz`, or null for a due date that is not one. */
export function dueDayKey(dueAt: string | null | undefined, tz?: string | null): string | null {
  const ms = instant(dueAt)
  return Number.isFinite(ms) ? wallClock(ms, tz).day : null
}

/** Whether a due date carries a time of day. One stored at local midnight is a day with no time. */
export function hasDueTime(dueAt: string | null | undefined, tz?: string | null): boolean {
  const ms = instant(dueAt)
  if (!Number.isFinite(ms)) return false
  const { hour, minute } = wallClock(ms, tz)
  return hour + minute > 0
}

/**
 * Overdue: its day is over. The same for a task with a time and one without:
 * a time that has passed today makes a task late, not overdue. A due date
 * that is not one is never overdue.
 */
export function isOverdue(dueAt: string | null | undefined, now: Date | number, tz?: string | null): boolean {
  const due = dueDayKey(dueAt, tz)
  const today = Number.isFinite(instant(now)) ? wallClock(instant(now), tz).day : null
  return !!due && !!today && due < today
}

/** Late: a time of day on it, and that time has gone by, whatever the day. An untimed task is never late, only overdue. */
export function isLate(dueAt: string | null | undefined, now: Date | number, tz?: string | null): boolean {
  const ms = instant(dueAt)
  return Number.isFinite(ms) && ms < instant(now) && hasDueTime(dueAt, tz)
}
