// The day-key rules every Stats figure counts by, shared by the app, the
// digest and the MCP server. Dependency-free ESM. The app's src/stats.ts
// re-exports each of these under the same name and keeps the calendar months
// and the trend, read on the device's own calendar, to itself.
//
// A day is a YYYY-MM-DD key on the reader's calendar, and a window is counted
// in whole days between keys, never in milliseconds: a day filed at midday
// would otherwise cross a 30-day line during the afternoon, and a list would
// change between the morning and the evening.

/** Whole days from one day key to another: UTC maths on the keys, so no zone or clock change moves it. */
export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

/**
 * Whether a day falls in the `window` days ending on dayKey: 30 is the last
 * 30 days, today included, and 'all' is every day there has been. A day after
 * dayKey is in none, as it has not come yet.
 * @param {number | 'all'} window
 */
export function inWindow(day, dayKey, window) {
  const ago = daysBetween(day, dayKey)
  return ago >= 0 && (window === 'all' || ago < window)
}

/**
 * How many of these days fall in the window (inWindow).
 * @param {number | 'all'} window
 */
export const daysWithin = (days, dayKey, window) => days.filter(d => inWindow(d, dayKey, window)).length

/**
 * The distinct days among these, in their order (newest first for a list
 * that is): three events on one Saturday are one day. `dayKeyOf` turns an
 * instant into YYYY-MM-DD in the reader's zone, so the app passes its local
 * calendar and the server its clock's; one it cannot read is left out.
 */
export function distinctDays(items, dayKeyOf) {
  const seen = new Set()
  const out = []
  for (const v of items ?? []) {
    const key = dayKeyOf(v.at)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/**
 * Days in a row, from day keys in any order, a day listed twice being one
 * day. The current run ends today, or yesterday while today has none yet —
 * a habit's rule: today waits rather than breaks it — and the best is the
 * longest run there has been. A day after today, or one that is not a day,
 * counts in neither.
 */
export function dayStreaks(days, today) {
  // oldest first, so the run left at the end is the one reaching the newest day
  const sorted = [...new Set(days)].filter(d => daysBetween(d, today) >= 0).sort()
  let best = 0
  let run = 0
  let prev = ''
  for (const day of sorted) {
    run = prev && daysBetween(prev, day) === 1 ? run + 1 : 1
    best = Math.max(best, run)
    prev = day
  }
  return { current: prev && daysBetween(prev, today) <= 1 ? run : 0, best }
}

/**
 * The first `n` rows by `count`, most first; a tie goes to `tie` when given
 * (the latest, say), then to the name, A–Z. A row that counts nothing is left
 * out, so a window nobody reached ranks nobody.
 */
export function topN(rows, n, by) {
  return rows
    .filter(r => by.count(r) > 0)
    .sort((a, b) => by.count(b) - by.count(a) || (by.tie ? by.tie(a, b) : 0) || by.name(a).localeCompare(by.name(b)))
    .slice(0, n)
}
