import { describe, expect, it } from 'vitest'
import { makeClock, machineTimeZone, startOfDayMs } from '../../shared/clock.mjs'

// The hosted MCP endpoint runs in UTC; the user does not. "Today", a due day
// and the start of a day are all in the user's zone, across DST changes and
// near midnight.

const at = (iso: string) => () => Date.parse(iso)
const H = 3_600_000

describe('makeClock', () => {
  it('takes today from the zone, not the process', () => {
    expect(makeClock('Europe/London', at('2026-06-30T23:30:00.000Z')).todayKey()).toBe('2026-07-01') // BST
    expect(makeClock('Europe/London', at('2026-01-31T23:30:00.000Z')).todayKey()).toBe('2026-01-31') // GMT
    expect(makeClock('UTC', at('2026-06-30T23:30:00.000Z')).todayKey()).toBe('2026-06-30')
  })

  it('near midnight in Los Angeles, the day turns at 07:00 UTC in summer', () => {
    expect(makeClock('America/Los_Angeles', at('2026-09-12T06:59:59.000Z')).todayKey()).toBe('2026-09-11')
    expect(makeClock('America/Los_Angeles', at('2026-09-12T07:00:00.000Z')).todayKey()).toBe('2026-09-12')
    const la = makeClock('America/Los_Angeles')
    expect(la.dayKeyOf('2026-09-12T06:30:00.000Z')).toBe('2026-09-11')
    expect(la.dayKeyOf(Date.parse('2026-09-12T07:30:00.000Z'))).toBe('2026-09-12')
    expect(la.dayKeyOf(new Date('2026-12-01T07:30:00.000Z'))).toBe('2026-11-30') // PST: the turn is at 08:00 UTC
    expect(la.dayKeyOf('not a date')).toBeNull()
    expect(new Date(la.startOfDayMs('2026-09-12')).toISOString()).toBe('2026-09-12T07:00:00.000Z')
  })

  it('Europe/London DST days are 23 and 25 hours long, each starting at local midnight', () => {
    const london = makeClock('Europe/London')
    expect(new Date(london.startOfDayMs('2026-03-29')).toISOString()).toBe('2026-03-29T00:00:00.000Z')
    expect(london.startOfDayMs('2026-03-30') - london.startOfDayMs('2026-03-29')).toBe(23 * H)
    expect(new Date(london.startOfDayMs('2026-10-25')).toISOString()).toBe('2026-10-24T23:00:00.000Z')
    expect(london.startOfDayMs('2026-10-26') - london.startOfDayMs('2026-10-25')).toBe(25 * H)
    // the hour that repeats and the hour that never happens stay on their own days
    expect(london.dayKeyOf('2026-10-25T00:30:00.000Z')).toBe('2026-10-25')
    expect(london.dayKeyOf('2026-03-29T00:30:00.000Z')).toBe('2026-03-29')
  })

  it('Los Angeles DST days too', () => {
    const la = makeClock('America/Los_Angeles')
    expect(new Date(la.startOfDayMs('2026-03-08')).toISOString()).toBe('2026-03-08T08:00:00.000Z')
    expect(la.startOfDayMs('2026-03-09') - la.startOfDayMs('2026-03-08')).toBe(23 * H)
    expect(la.startOfDayMs('2026-11-02') - la.startOfDayMs('2026-11-01')).toBe(25 * H)
  })

  it('a zone east of UTC starts its day the evening before in UTC', () => {
    expect(new Date(startOfDayMs('2026-09-12', 'Pacific/Auckland')).toISOString()).toBe('2026-09-11T12:00:00.000Z')
    expect(startOfDayMs('2026-09-12', 'Pacific/Auckland') < startOfDayMs('2026-09-12', 'UTC')).toBe(true)
  })

  it('shifts day keys by the calendar, across months and years', () => {
    const c = makeClock('UTC')
    expect(c.shiftDay('2026-12-31', 1)).toBe('2027-01-01')
    expect(c.shiftDay('2026-03-01', -1)).toBe('2026-02-28')
    expect(c.shiftDay('2026-03-29', 7)).toBe('2026-04-05')
    expect(Number.isNaN(c.startOfDayMs('29/03/2026'))).toBe(true)
  })

  it('an unknown zone is UTC, an unset one is the machine\'s', () => {
    expect(makeClock('Mars/Olympus_Mons').tz).toBe('UTC')
    expect(makeClock(undefined).tz).toBe(machineTimeZone())
    expect(makeClock(null).tz).toBe(machineTimeZone())
  })

  it('stamps come from the same now', () => {
    const c = makeClock('UTC', at('2026-09-12T10:00:00.000Z'))
    expect(c.iso()).toBe('2026-09-12T10:00:00.000Z')
    expect(c.now().getTime()).toBe(Date.parse('2026-09-12T10:00:00.000Z'))
  })
})
