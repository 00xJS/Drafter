// The owner's IANA time zone, for server code that has to decide "is this task
// untimed" or "which calendar day is this" without a browser to ask.
import { offsetMs, startOfDayMs } from '../../../shared/clock.mts'
import { settingsGet, settingsSet } from './session.mjs'

const DAY_MS = 86_400_000

/** A real IANA zone name, or null. Intl throws on any zone it does not know. */
export function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return null
  }
}

/**
 * Store the device's zone when the account has none. Without it the server
 * judged "untimed" in UTC, so on an account that never saved push prefs every
 * untimed task reached both calendars as a 00:00 event through British Summer
 * Time. A zone the owner chose is never overwritten, and a failure here never
 * blocks the push it rides along with.
 */
export async function adoptTimeZone(userId, tz) {
  const zone = validTimeZone(tz)
  if (!zone || !userId) return false
  try {
    const settings = await settingsGet(userId)
    if (settings?.timezone) return false
    await settingsSet(userId, { timezone: zone })
    return true
  } catch {
    return false
  }
}

/**
 * The instant a wall-clock time in `tz` names, as epoch ms: 'YYYY-MM-DDTHH:MM'
 * (seconds optional, a space for the T allowed) or a bare day. NaN for
 * anything else, a time with an offset included, and for a day or hour the
 * calendar does not have. The server's own zone is UTC, so a time the owner
 * meant in theirs has to be built from it. An unknown zone reads as UTC.
 *
 * A bare day is the day's first instant there, as the clock builds it: its
 * midnight, or 01:00 where a spring-forward skips midnight (Santiago on
 * 6 September 2026), never 23:00 the evening before. A time a fall-back
 * repeats is its first; a time a spring-forward skips moves on by the gap, as
 * the clocks did, so 02:30 in New York on 8 March 2026 is 03:30.
 */
export function zonedTime(wall, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/i.exec(String(wall ?? '').trim())
  if (!m) return NaN
  const [y, mo, d, h, mi, s] = m.slice(1).map(v => Number(v ?? 0))
  const utc = Date.UTC(y, mo - 1, d, h, mi, s)
  const back = new Date(utc)
  // Date.UTC rolls 30 February into March and 25:00 into tomorrow
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || back.getUTCHours() !== h || back.getUTCMinutes() !== mi) return NaN
  const zone = validTimeZone(tz) ?? 'UTC'
  if (m[4] === undefined) return startOfDayMs(`${m[1]}-${m[2]}-${m[3]}`, zone)
  // The zone's offsets a day either side cover any one change near this time,
  // and each offset that reads back as itself names the time; with none, the
  // time is in a gap and keeps the offset from before it.
  const before = offsetMs(utc - DAY_MS, zone)
  const after = offsetMs(utc + DAY_MS, zone)
  const fits = [before, after].filter(o => offsetMs(utc - o, zone) === o).map(o => utc - o)
  return fits.length ? Math.min(...fits) : utc - before
}
