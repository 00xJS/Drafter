// "Now" and "today" for code that runs away from the user's device: the MCP
// tools on Netlify, where the process is in UTC, and on a laptop, where it is
// in the machine's zone. A day key is a calendar day in the clock's zone.
//
// Hosted callers pass the user's user_settings.timezone (or 'UTC'); the local
// stdio server passes nothing and gets the machine's zone.

import { localDate } from './domain.mts'
import { localParts } from './digest.mts'
import { shiftDayKey } from './journal.mts'

export interface Clock {
  /** The IANA zone every day key is in. */
  tz: string
  now(): Date
  /** now() as an ISO string, for record stamps. */
  iso(): string
  /** Today's YYYY-MM-DD in the zone. */
  todayKey(): string
  /** The local day of an instant, or null when it is not a date. */
  dayKeyOf(value: string | number | Date | null | undefined): string | null
  shiftDay(key: string, n: number): string
  /** Epoch ms of the day's first instant in the zone (NaN for a bad key). */
  startOfDayMs(key: string): number
}

/** A real IANA zone name, or null. */
export function validZone(tz: unknown): string | null {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return null
  }
}

export function machineTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>()

/** The wall-clock fields of an instant in `tz`. */
function wallParts(ms: number, tz: string): { y: number; m: number; d: number; h: number; min: number; s: number } {
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

/** The zone's offset from UTC at an instant, in ms (Europe/London in summer: +3 600 000). `tz` must be a zone Intl knows. */
export function offsetMs(ms: number, tz: string): number {
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
export function startOfDayMs(key: string, tz: string): number {
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
export function makeClock(tz?: string | null, nowMs: () => number = () => Date.now()): Clock {
  const zone = validZone(tz) ?? (tz === undefined || tz === null || tz === '' ? machineTimeZone() : 'UTC')
  return {
    tz: zone,
    now: () => new Date(nowMs()),
    iso: () => new Date(nowMs()).toISOString(),
    // a reading of the clock is an instant, so it always falls on a day
    todayKey: () => localParts(new Date(nowMs()), zone).day!,
    dayKeyOf: value => localDate(value instanceof Date ? value.getTime() : value, zone),
    shiftDay: (key, n) => shiftDayKey(key, n),
    startOfDayMs: key => startOfDayMs(key, zone),
  }
}
