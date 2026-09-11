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
