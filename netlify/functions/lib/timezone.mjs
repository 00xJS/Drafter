// The owner's IANA time zone, for server code that has to decide "is this task
// untimed" or "which calendar day is this" without a browser to ask.
import { settingsGet, settingsSet } from './session.mjs'

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

/** How far `tz` is ahead of UTC at an instant, in ms (Europe/London in summer: +3 600 000). */
function offsetAt(ms, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms))
      .map(x => [x.type, x.value]),
  )
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second)) - Math.floor(ms / 1000) * 1000
}

/**
 * The instant a wall-clock time in `tz` names, as epoch ms: 'YYYY-MM-DDTHH:MM'
 * (seconds optional, a space for the T allowed) or a bare day, read as its
 * midnight. NaN for anything else, a time with an offset included, and for a
 * day or hour that does not exist. The server's own zone is UTC, so a time the
 * owner meant in theirs has to be built from it. An unknown zone reads as UTC;
 * the second pass settles a time just after a DST change.
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
  const guess = utc - offsetAt(utc, zone)
  return utc - offsetAt(guess, zone)
}
