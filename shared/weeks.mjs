// Sunday-start week keys on YYYY-MM-DD strings, shared by the app, the MCP
// server and the digest. Calendar arithmetic only (UTC on the date parts), so a
// key never depends on the zone or on daylight saving: the previous
// millisecond-based version could hand two consecutive summer weeks the same
// key in a year that starts on a Sunday.

export const DAY_MS = 86_400_000

function parts(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''))
  return m ? [Number(m[1]), Number(m[2]) - 1, Number(m[3])] : null
}

function keyOf(utcMs) {
  return new Date(utcMs).toISOString().slice(0, 10)
}

/** True for a real calendar day in YYYY-MM-DD form: 2026-02-30 is not one. */
export function isDayKey(key) {
  const p = parts(key)
  if (!p) return false
  const d = new Date(Date.UTC(p[0], p[1], p[2]))
  return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] && d.getUTCDate() === p[2]
}

/** The Sunday on or before this day. */
export function weekStartKey(dateKey) {
  const p = parts(dateKey)
  if (!p) return null
  const ms = Date.UTC(p[0], p[1], p[2])
  return keyOf(ms - new Date(ms).getUTCDay() * DAY_MS)
}

/** `2026-W37`: the week number counts Sundays from 1 January of the week's start year. */
export function weekKeyOf(dateKey) {
  const start = weekStartKey(dateKey)
  const p = start ? parts(start) : null
  if (!p) return null
  const jan1 = Date.UTC(p[0], 0, 1)
  const week = Math.floor((Date.UTC(p[0], p[1], p[2]) - jan1) / (7 * DAY_MS)) + 1
  return `${p[0]}-W${String(week).padStart(2, '0')}`
}

/** The seven day keys of the week containing `dateKey`, Sunday first. */
export function weekDayKeys(dateKey) {
  const start = weekStartKey(dateKey)
  const p = start ? parts(start) : null
  if (!p) return []
  const ms = Date.UTC(p[0], p[1], p[2])
  return Array.from({ length: 7 }, (_, i) => keyOf(ms + i * DAY_MS))
}
