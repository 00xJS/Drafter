// Which week Sunday's automatic review is about, counted in the reader's zone.
//
// The digest used to work this out on the server's own clock — setHours(0) and
// getDay() on "now", which is UTC on Netlify. The morning digest goes out at
// the reader's local hour, and far enough east that hour is still Saturday in
// UTC (8am Sunday in Tokyo is 23:00 Saturday UTC), so "last week" came out one
// week early: the draft was filed under the week before last, where the Week
// segment never looks, and its range covered the wrong seven days. West of UTC
// the arithmetic happened to land on the right week.

import { localParts } from '../../../shared/digest.mjs'
import { weekKeyOf, weekStartKey } from '../../../shared/weeks.mjs'
import { validTimeZone } from './timezone.mjs'

const DAY = 86_400_000

/** How far `tz` is ahead of UTC at an instant, in ms. */
function offsetAt(ms, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms))
      .map(x => [x.type, x.value]),
  )
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(ms / 1000) * 1000
}

/**
 * The instant a calendar day begins in `tz` (YYYY-MM-DD 00:00 there), as epoch
 * ms; NaN for a malformed key. The server's own zone is UTC, so anything that
 * means "the reader's day" has to be built from theirs. An unknown zone reads
 * as UTC. The second pass settles a day that begins just after a DST change.
 */
export function zonedMidnight(dayKey, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey ?? ''))
  if (!m) return NaN
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const zone = validTimeZone(tz) ?? 'UTC'
  const guess = wall - offsetAt(wall, zone)
  return wall - offsetAt(guess, zone)
}

/** A YYYY-MM-DD key moved by whole days. UTC arithmetic: a day key carries no time, so no DST applies. */
export function shiftDayKey(key, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''))
  if (!m) return null
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * DAY).toISOString().slice(0, 10)
}

const label = key => new Date(`${key}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/**
 * The Sunday-start week before the one `now` falls in, for a reader in `tz`:
 * its key (the one src/review.ts weekRange gives that week), a label, its day
 * keys (endKey exclusive) and the instants it starts and ends at in that zone.
 */
export function previousWeekIn(now, tz) {
  const today = localParts(now, tz || 'UTC').day
  const thisWeek = weekStartKey(today)
  const startKey = shiftDayKey(thisWeek, -7)
  return {
    key: weekKeyOf(startKey),
    label: `${label(startKey)} – ${label(shiftDayKey(thisWeek, -1))}`,
    startKey,
    endKey: thisWeek,
    start: new Date(zonedMidnight(startKey, tz)),
    end: new Date(zonedMidnight(thisWeek, tz)),
  }
}
