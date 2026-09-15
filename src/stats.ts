import { DAY_MS } from '../shared/journal.mjs'
import { distinctDays } from '../shared/stats.mjs'
import { dateKey } from './utils'

// The counting every Stats view shares: pure, no DOM, worked out once per
// screen and handed to the kit that draws it (src/components/stats). The
// day-key rules an assistant counts by too — a window, the distinct days, a
// streak, the top few — live in shared/stats.mjs and are re-exported here
// under the same names; what reads this device's own calendar — a year's
// months, the trend, a month's grid — is the app's alone.

export { daysBetween, dayStreaks, daysWithin, distinctDays, inWindow, topN } from '../shared/stats.mjs'
export type { RankBy, Streaks } from '../shared/stats.mjs'

// ---- windows ---------------------------------------------------------------------

/** A ranked chart's window: the last 30 days, the last 12 months or all time, counted in day keys (inWindow). */
export type DayWindow = 30 | 365 | 'all'

/** The windows a ranked chart switches between, in the words on its switch. */
export const DAY_WINDOWS: readonly { key: DayWindow; label: string }[] = [
  { key: 30, label: '30 days' },
  { key: 365, label: '12 months' },
  { key: 'all', label: 'All' },
]

// ---- counting what happened at an instant ----------------------------------------

/** Something that happened at an instant: a visit, an outing, a day filed at its midday. */
export interface Dated {
  at: string
}

/** What a bucket of them counts as: every one by default, or the days among them (countDays). */
export type Counter = (items: Dated[]) => number

const every: Counter = items => items.length

/** The distinct days among these on this device's calendar (distinctDays): three events on one Saturday count once. */
export const countDays: Counter = items => distinctDays(items, dateKey).length

// ---- a year by month, and the trend ----------------------------------------------

/** The months as a chart's ticks and a table's heads, January first. */
export const MONTHS: readonly string[] = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Each month of `year`, January first, on this device's calendar: what `count` makes of the items that fell in it. */
export function monthBuckets(items: readonly Dated[], year: number, count: Counter = every): number[] {
  const byMonth = Array.from({ length: 12 }, (): Dated[] => [])
  for (const v of items) {
    const d = new Date(v.at)
    if (d.getFullYear() === year) byMonth[d.getMonth()].push(v)
  }
  return byMonth.map(count)
}

/** How far back a trend looks: the last 90 days, against the 90 before them. */
export const TREND_DAYS = 90

/**
 * A trend: what `count` makes of the last `days` days, less what it makes of
 * the `days` before them — positive when more lately, negative when drifting.
 * Each window is counted on its own: a day with events either side of the line
 * lands in both, which adds one to each side and leaves the difference alone.
 */
export function recentTrend(items: readonly Dated[], now: Date = new Date(), count: Counter = every, days = TREND_DAYS): number {
  const nowMs = now.getTime()
  const age = (v: Dated) => nowMs - Date.parse(v.at)
  const recent = items.filter(v => age(v) < days * DAY_MS)
  const before = items.filter(v => age(v) >= days * DAY_MS && age(v) < 2 * days * DAY_MS)
  return count(recent) - count(before)
}

/**
 * One row of a year table: a count for each month of `year` (monthBuckets), the
 * year's total, and the trend (recentTrend). `count` says what one of them is:
 * People counts the days among the visits (countDays), Places every outing (the
 * default), and the wardrobe the days logged, each filed at its midday.
 */
export function monthsAndTrend(items: readonly Dated[], year: number, now: Date = new Date(), count: Counter = every): { months: number[]; total: number; trend: number } {
  const months = monthBuckets(items, year, count)
  return { months, total: months.reduce((a, b) => a + b, 0), trend: recentTrend(items, now, count) }
}

// ---- a month as a grid -----------------------------------------------------------

/**
 * A month as whole Sunday-to-Saturday weeks, the Calendar's grid: each day's
 * key, and null for the padding around the month. `month` runs 1–12. UTC maths
 * on the keys, so no zone moves a day into another column.
 */
export function monthGrid(year: number, month: number): (string | null)[] {
  const pad = (n: number) => String(n).padStart(2, '0')
  const lead = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  const length = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const cells: (string | null)[] = Array.from({ length: lead }, () => null)
  for (let d = 1; d <= length; d++) cells.push(`${year}-${pad(month)}-${pad(d)}`)
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

/** A "YYYY-MM" month moved by `delta` months: a month calendar's ‹ and ›. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
