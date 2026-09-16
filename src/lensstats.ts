import { isBill, withPaidDefault } from './bills'
import { habitsConsistency, isDueOn, streakOf } from './habits'
import { journalDays, weekdayOf } from './journal'
import { countDays, dayStreaks, monthBuckets, monthsAndTrend, recentTrend, topN, type DayWindow, type Dated, type Streaks } from './stats'
import { BILL_KIND_META, PRIORITY_META, STATUS_META, type Habit, type JournalEntry, type Priority, type Task, type TaskStatus } from './types'
import { dateKey } from './utils'
import { inWindow } from '../shared/stats.mjs'

/*
 * The Stats lens, counted. Pure, no DOM, worked out once per render and handed
 * to the kit that draws it (src/components/stats).
 *
 * The four areas here — tasks, money, habits, the journal — are the ones with
 * nowhere else to be counted, so these are their only figures rather than a
 * second copy of someone else's. What People, Places, Kitchen and the Wardrobe
 * already count stays theirs: the lens draws THEIR components, from their
 * chunks, so nothing here re-counts them and nothing sends you to another tab.
 *
 * Every window is counted in day keys on this device's calendar (inWindow), as
 * every other Stats view is, so a figure here and the same figure there can
 * never disagree by an afternoon.
 */

/** A done task, as the dated mark a chart counts: filed at the moment it was finished. */
function doneMarks(tasks: readonly Task[]): Dated[] {
  return tasks.filter(t => !t.deletedAt && t.status === 'done' && t.completedAt).map(t => ({ at: t.completedAt as string }))
}

/** The day keys something was finished on, newest first: two tasks on one Saturday are one day. */
export function doneDays(tasks: readonly Task[]): string[] {
  const days = [...new Set(doneMarks(tasks).map(m => dateKey(new Date(m.at))))]
  return days.sort().reverse()
}

// ---- tasks -----------------------------------------------------------------------

/** How long an overdue task has been waiting, as the buckets the chart shows. */
const AGE_BUCKETS: readonly { key: string; label: string; upTo: number }[] = [
  { key: 'week', label: 'Under a week', upTo: 7 },
  { key: 'month', label: '1–4 weeks', upTo: 28 },
  { key: 'quarter', label: '1–3 months', upTo: 90 },
  { key: 'older', label: 'Over 3 months', upTo: Infinity },
]

export interface TaskReport {
  /** Finished inside the window. */
  done: number
  /** To do, doing or blocked, right now — a window never narrows what is still open. */
  open: number
  overdue: number
  /** Days with something finished, and the run reaching today (today waits rather than breaks it). */
  streaks: Streaks & { today: boolean }
  /** Every day something was finished, newest first. */
  days: string[]
  /** Sunday first: what share of finished work landed on each weekday, inside the window. */
  weekday: number[]
  /** Open work by status, most first. */
  byStatus: { key: TaskStatus; name: string; count: number }[]
  /** Open work by how long it has been overdue; a bucket nobody is in is left out. */
  aging: { key: string; name: string; count: number }[]
}

const OPEN_STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'blocked']
const isOpen = (t: Task) => !t.deletedAt && OPEN_STATUSES.includes(t.status)

/** How many whole days `iso` is before `now`; negative when it is still to come. */
const daysLate = (iso: string, now: Date): number => Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000)

/** The Tasks segment's figures, at `now`, counting what happened inside `window`. */
export function taskReport(tasks: readonly Task[], window: DayWindow, now: Date = new Date()): TaskReport {
  const today = dateKey(now)
  const days = doneDays(tasks)
  const inside = days.filter(d => inWindow(d, today, window))
  const marks = doneMarks(tasks).filter(m => inWindow(dateKey(new Date(m.at)), today, window))
  const weekday = Array.from({ length: 7 }, () => 0)
  for (const m of marks) weekday[weekdayOf(dateKey(new Date(m.at)))]++
  const open = tasks.filter(isOpen)
  const overdue = open.filter(t => t.dueAt && daysLate(t.dueAt, now) >= 0)
  const byStatus = OPEN_STATUSES.map(key => ({ key, name: STATUS_META[key].label, count: open.filter(t => t.status === key).length })).filter(r => r.count > 0)
  const aging = AGE_BUCKETS.map(b => ({ key: b.key, name: b.label, count: 0 }))
  for (const t of overdue) {
    const late = daysLate(t.dueAt as string, now)
    const i = AGE_BUCKETS.findIndex(b => late < b.upTo)
    aging[i < 0 ? AGE_BUCKETS.length - 1 : i].count++
  }
  return {
    done: marks.length,
    open: open.length,
    overdue: overdue.length,
    streaks: { ...dayStreaks(days, today), today: days[0] === today },
    days: inside,
    weekday,
    byStatus,
    aging: aging.filter(r => r.count > 0),
  }
}

/** Finished work by tag inside the window, most first; a task with no tag is not a row. */
export function doneByTag(tasks: readonly Task[], window: DayWindow, now: Date = new Date(), n = 10): { key: string; name: string; count: number }[] {
  const today = dateKey(now)
  const counts = new Map<string, number>()
  for (const t of tasks) {
    if (t.deletedAt || t.status !== 'done' || !t.completedAt) continue
    if (!inWindow(dateKey(new Date(t.completedAt)), today, window)) continue
    for (const tag of new Set(t.tags ?? [])) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  const rows = [...counts].map(([key, count]) => ({ key, name: key, count }))
  return topN(rows, n, { count: r => r.count, name: r => r.name })
}

/** Finished work by the priority it carried, urgent first; a priority nobody finished is left out. */
export function doneByPriority(tasks: readonly Task[], window: DayWindow, now: Date = new Date()): { key: Priority; name: string; count: number }[] {
  const today = dateKey(now)
  const order: Priority[] = ['urgent', 'high', 'normal', 'low']
  return order
    .map(key => ({
      key,
      name: PRIORITY_META[key].label,
      count: tasks.filter(t => !t.deletedAt && t.status === 'done' && t.completedAt && t.priority === key && inWindow(dateKey(new Date(t.completedAt)), today, window)).length,
    }))
    .filter(r => r.count > 0)
}

/** A year of finished work by month, with the year's total and the 90-day trend. */
export const doneMonths = (tasks: readonly Task[], year: number, now: Date = new Date()) => monthsAndTrend(doneMarks(tasks), year, now)

// ---- money -----------------------------------------------------------------------

export interface MoneyReport {
  /** What was actually paid in the year, in whole units of the account's currency. */
  spent: number
  /** Each month of the year, January first. */
  months: number[]
  /** What the same window a year's-worth-ago came to — the trend badge's difference. */
  trend: number
  /** Everything paid, by who was paid, most first. */
  byPayee: { key: string; name: string; count: number }[]
  /** The repeating payments, by what kind of payment they are. */
  byKind: { key: string; name: string; count: number }[]
  /** Bills with an amount that are still to be paid. */
  dueNow: number
  dueNowTotal: number
}

/** A payment, as the dated mark a chart counts: what a task actually cost, filed when it was finished. */
function paidMarks(tasks: readonly Task[]): (Dated & { amount: number; payee: string })[] {
  const out: (Dated & { amount: number; payee: string })[] = []
  for (const raw of tasks) {
    if (raw.deletedAt || raw.status !== 'done' || !raw.completedAt) continue
    const t = raw.bill ? withPaidDefault(raw) : raw
    const amount = t.actualCost
    if (amount === undefined || !Number.isFinite(amount) || amount <= 0) continue
    out.push({ at: t.completedAt as string, amount, payee: t.bill?.payee?.trim() || t.title || 'Untitled' })
  }
  return out
}

/** A money total is a sum, not a count, so the month buckets add amounts rather than rows. */
const sumIn = (marks: readonly (Dated & { amount: number })[], year: number): number[] => {
  const months = Array.from({ length: 12 }, () => 0)
  for (const m of marks) {
    const d = new Date(m.at)
    if (d.getFullYear() === year) months[d.getMonth()] += m.amount
  }
  return months.map(n => Math.round(n))
}

/** The Money segment's figures for `year`, at `now`. */
export function moneyReport(tasks: readonly Task[], year: number, now: Date = new Date(), n = 10): MoneyReport {
  const marks = paidMarks(tasks)
  const months = sumIn(marks, year)
  const byPayeeCounts = new Map<string, number>()
  for (const m of marks) if (new Date(m.at).getFullYear() === year) byPayeeCounts.set(m.payee, (byPayeeCounts.get(m.payee) ?? 0) + m.amount)
  const byPayee = topN(
    [...byPayeeCounts].map(([key, total]) => ({ key, name: key, count: Math.round(total) })),
    n,
    { count: r => r.count, name: r => r.name },
  )
  const kinds = new Map<string, { name: string; count: number }>()
  for (const raw of tasks) {
    if (!isBill(raw)) continue
    const t = withPaidDefault(raw)
    if (t.status !== 'done' || !t.completedAt || new Date(t.completedAt).getFullYear() !== year) continue
    const amount = t.actualCost
    if (amount === undefined || !Number.isFinite(amount) || amount <= 0) continue
    const key = raw.bill.kind
    const row = kinds.get(key) ?? { name: BILL_KIND_META[key].label, count: 0 }
    row.count += amount
    kinds.set(key, row)
  }
  // open work only: `status !== 'done'` also took in a bill you cancelled and
  // one still on the Wishlist, and neither is money you owe
  const outstanding = tasks.filter(t => isBill(t) && isOpen(t)).map(withPaidDefault)
  return {
    spent: months.reduce((a, b) => a + b, 0),
    months,
    trend: Math.round(recentTrend(marks, now, items => (items as (Dated & { amount: number })[]).reduce((a, b) => a + b.amount, 0))),
    byPayee,
    byKind: topN(
      [...kinds].map(([key, r]) => ({ key, name: r.name, count: Math.round(r.count) })),
      6,
      { count: r => r.count, name: r => r.name },
    ),
    dueNow: outstanding.length,
    dueNowTotal: Math.round(outstanding.reduce((a, t) => a + (t.estimateCost ?? 0), 0)),
  }
}

/* A bill kind's word is BILL_KIND_META's, the one the editor shows. It was a
   hand-written table here, which is a second spelling waiting to drift.
   The wardrobe's cost per wear is not here either: wardrobeCosts in
   src/wardrobe.ts is the rule the piece sheet and the Wardrobe's own Stats
   read, and it counts a piece's DISTINCT DAYS worn. A copy here counted every
   look instead, so two looks on one day made the lens's figure cheaper than
   the wardrobe's for the same clothes. One rule, one number. */

// ---- habits ----------------------------------------------------------------------

export interface HabitRow {
  habit: Habit
  /** Days kept and days due inside the window, and the run reaching today. */
  done: number
  due: number
  streak: number
  /** 0–100, rounded; 0 when nothing was due. */
  pct: number
}

export interface HabitReport {
  rows: HabitRow[]
  done: number
  due: number
  pct: number
  /** Every day on which everything due was kept, newest first, and the run of them. */
  cleanDays: string[]
  streaks: Streaks & { today: boolean }
}

/** How many days back a window looks; 'all' is a year, which is as far as the grid draws. */
const windowDays = (window: DayWindow): number => (window === 'all' ? 365 : window)

/** The Habits segment's figures over the window ending at `now`. Archived habits are history and are left out. */
export function habitReport(habits: readonly Habit[], window: DayWindow, now: Date = new Date()): HabitReport {
  const live = habits.filter(h => !h.deletedAt && !h.archivedAt)
  const span = windowDays(window)
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (span - 1))
  // habitsConsistency takes an EXCLUSIVE end, so tomorrow closes today
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const roll = habitsConsistency([...live], start, end, now)
  const rows: HabitRow[] = roll.rows.map(r => ({
    habit: r.habit,
    done: r.done,
    due: r.due,
    streak: streakOf(r.habit, now),
    pct: r.due > 0 ? Math.round((r.done / r.due) * 100) : 0,
  }))
  const cleanDays: string[] = []
  const d = new Date(start)
  while (d.getTime() <= now.getTime()) {
    const key = dateKey(d)
    const due = live.filter(h => isDueOn(h, d))
    if (due.length > 0 && due.every(h => h.done.includes(key))) cleanDays.push(key)
    d.setDate(d.getDate() + 1)
  }
  cleanDays.reverse()
  const today = dateKey(now)
  return {
    rows: [...rows].sort((a, b) => b.pct - a.pct || a.habit.name.localeCompare(b.habit.name)),
    done: roll.done,
    due: roll.due,
    pct: roll.pct,
    cleanDays,
    streaks: { ...dayStreaks(cleanDays, today), today: cleanDays[0] === today },
  }
}

// ---- journal ---------------------------------------------------------------------

export interface JournalReport {
  entries: number
  days: string[]
  streaks: Streaks & { today: boolean }
  /** The average mood of the entries that carry one, or null when none does. */
  mood: number | null
  /** How many entries carry each mood, 1 (rough) to 5 (great). */
  moodCounts: number[]
  /** Each month of the year: days written. */
  months: number[]
  total: number
  trend: number
  /** Words written inside the window. */
  words: number
}

/** A journal entry as a dated mark, filed at its day's midday so no zone moves it. */
const journalMarks = (entries: readonly JournalEntry[]): Dated[] => journalDays([...entries] as JournalEntry[]).map(day => ({ at: `${day}T12:00:00` }))

/** The Journal segment's figures for `year`, counting the window at `now`. Nothing written is ever quoted here. */
export function journalReport(entries: readonly JournalEntry[], window: DayWindow, year: number, now: Date = new Date()): JournalReport {
  const today = dateKey(now)
  const live = entries.filter(e => !e.deletedAt)
  const days = journalDays([...live] as JournalEntry[])
  const span = windowDays(window)
  const inside = live.filter(e => inWindow(e.date, today, window))
  const moods = inside.map(e => e.mood).filter((m): m is NonNullable<JournalEntry['mood']> => !!m)
  const moodCounts = Array.from({ length: 5 }, (_, i) => moods.filter(m => m === i + 1).length)
  const marks = journalMarks(live)
  const months = monthBuckets(marks, year, countDays)
  return {
    entries: inside.length,
    days: days.filter(d => inWindow(d, today, window)),
    streaks: { ...dayStreaks(days, today), today: days.includes(today) },
    mood: moods.length > 0 ? moods.reduce((a, b) => a + b, 0) / moods.length : null,
    moodCounts,
    months,
    total: months.reduce((a, b) => a + b, 0),
    trend: recentTrend(marks, now, countDays, Math.min(span, 90)),
    words: inside.reduce((a, e) => a + (e.body.trim() ? e.body.trim().split(/\s+/).length : 0), 0),
  }
}
