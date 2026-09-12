// "Now" and "today" for code that runs away from the user's device: the MCP
// tools on Netlify, where the process is in UTC, and on a laptop, where it is
// in the machine's zone. A day key is a calendar day in the clock's zone.
//
// Hosted callers pass the user's user_settings.timezone (or 'UTC'); the local
// stdio server passes nothing and gets the machine's zone.

import { localDate } from './domain.mjs'
import { localParts } from './digest.mjs'
import { shiftDayKey } from './journal.mjs'

/** A real IANA zone name, or null. */
export function validZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return null
  }
}

export function machineTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

const formatters = new Map()

/** The wall-clock fields of an instant in `tz`. */
function wallParts(ms, tz) {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(tz, f)
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]))
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, min: Number(p.minute), s: Number(p.second) }
}

/** The zone's offset from UTC at an instant, in ms (Europe/London in summer: +3 600 000). */
function offsetMs(ms, tz) {
  const w = wallParts(ms, tz)
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(ms / 1000) * 1000
}

/**
 * The first instant of a local day in `tz`. Local midnight is the UTC midnight
 * of the key less the zone's offset there; a second guess with the offset at
 * the first settles a DST change on either side, and a day whose midnight is
 * skipped (a spring-forward at 00:00) starts at the jump, which is the first
 * guess. The earliest guess that falls on the day wins.
 */
export function startOfDayMs(key, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''))
  if (!m) return NaN
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const first = base - offsetMs(base, tz)
  const second = base - offsetMs(first, tz)
  const onDay = [first, second].filter(t => localDate(t, tz) === key)
  return onDay.length ? Math.min(...onDay) : first
}

/**
 * makeClock(tz?, nowMs?) -> { tz, now(), iso(), todayKey(), dayKeyOf(iso), shiftDay(key, n), startOfDayMs(key) }
 * An unset zone is the machine's; a zone Intl does not know is UTC.
 */
export function makeClock(tz, nowMs = () => Date.now()) {
  const zone = validZone(tz) ?? (tz === undefined || tz === null || tz === '' ? machineTimeZone() : 'UTC')
  return {
    tz: zone,
    now: () => new Date(nowMs()),
    iso: () => new Date(nowMs()).toISOString(),
    todayKey: () => localParts(new Date(nowMs()), zone).day,
    dayKeyOf: value => localDate(value instanceof Date ? value.getTime() : value, zone),
    shiftDay: (key, n) => shiftDayKey(key, n),
    startOfDayMs: key => startOfDayMs(key, zone),
  }
}
