import { describe, expect, it } from 'vitest'
import { validTimeZone, zonedTime } from '../../netlify/functions/lib/timezone.mjs'

// Email-in reads a time the model gave with no offset as wall-clock time in
// the owner's zone, not in the server's, which is UTC on Netlify.
describe('zonedTime', () => {
  const iso = (ms: number) => new Date(ms).toISOString()

  it('reads a wall-clock time, or a bare day at its midnight, in the zone given', () => {
    expect(iso(zonedTime('2026-09-17T15:00', 'Europe/London'))).toBe('2026-09-17T14:00:00.000Z')
    expect(iso(zonedTime('2026-12-17 15:00:30', 'Europe/London'))).toBe('2026-12-17T15:00:30.000Z')
    expect(iso(zonedTime('2026-09-17T15:00:00.000', 'America/New_York'))).toBe('2026-09-17T19:00:00.000Z')
    expect(iso(zonedTime('2026-09-17', 'Asia/Tokyo'))).toBe('2026-09-16T15:00:00.000Z')
  })

  it('settles the hours either side of a DST change', () => {
    // London springs forward at 01:00 GMT on 29 March 2026, and falls back at 01:00 GMT on 25 October
    expect(iso(zonedTime('2026-03-29T00:30', 'Europe/London'))).toBe('2026-03-29T00:30:00.000Z')
    expect(iso(zonedTime('2026-03-29T03:00', 'Europe/London'))).toBe('2026-03-29T02:00:00.000Z')
    expect(iso(zonedTime('2026-10-25T00:30', 'Europe/London'))).toBe('2026-10-24T23:30:00.000Z')
    expect(iso(zonedTime('2026-10-25T03:00', 'Europe/London'))).toBe('2026-10-25T03:00:00.000Z')
  })

  it('files a bare day on that day when a spring-forward skips its midnight', () => {
    // Santiago and Havana spring forward at 00:00, so these days begin at 01:00;
    // the two-pass guess put them at 23:00 the evening before, a timed task on the wrong day
    expect(iso(zonedTime('2026-09-06', 'America/Santiago'))).toBe('2026-09-06T04:00:00.000Z')
    expect(iso(zonedTime('2026-03-08', 'America/Havana'))).toBe('2026-03-08T05:00:00.000Z')
    expect(iso(zonedTime('2026-09-07', 'America/Santiago'))).toBe('2026-09-07T03:00:00.000Z')
  })

  it('moves a time a spring-forward skips on by the gap, and reads a time a fall-back repeats as its first', () => {
    // New York skips 02:00–03:00 on 8 March 2026 and repeats 01:00–02:00 on 1 November
    expect(iso(zonedTime('2026-03-08T02:30', 'America/New_York'))).toBe('2026-03-08T07:30:00.000Z')
    expect(iso(zonedTime('2026-03-29T01:30', 'Europe/London'))).toBe('2026-03-29T01:30:00.000Z')
    expect(iso(zonedTime('2026-09-06T00:30', 'America/Santiago'))).toBe('2026-09-06T04:30:00.000Z')
    expect(iso(zonedTime('2026-11-01T01:30', 'America/New_York'))).toBe('2026-11-01T05:30:00.000Z')
    expect(iso(zonedTime('2026-10-25T01:30', 'Europe/London'))).toBe('2026-10-25T00:30:00.000Z')
  })

  it('reads an unknown zone as UTC, and refuses anything but a wall-clock time', () => {
    expect(iso(zonedTime('2026-09-17T15:00', 'Mars/Olympus_Mons'))).toBe('2026-09-17T15:00:00.000Z')
    expect(iso(zonedTime('2026-09-17T15:00', undefined))).toBe('2026-09-17T15:00:00.000Z')
    for (const bad of ['2026-09-17T15:00:00Z', '2026-09-17T15:00+01:00', 'Thursday 3pm', '2026-11-31', '2026-09-17T25:00', '', null, 42])
      expect(zonedTime(bad, 'Europe/London')).toBeNaN()
  })
})

// The server now adopts the device's time zone when the account has none, so
// it judges "untimed" in the owner's zone rather than UTC. Only a real IANA
// zone may ever be stored.
describe('validTimeZone', () => {
  it('accepts real IANA zones', () => {
    expect(validTimeZone('Europe/London')).toBe('Europe/London')
    expect(validTimeZone('America/Phoenix')).toBe('America/Phoenix')
    expect(validTimeZone('UTC')).toBe('UTC')
  })

  it('refuses anything else rather than storing it', () => {
    expect(validTimeZone('Mars/Olympus_Mons')).toBeNull()
    expect(validTimeZone('')).toBeNull()
    expect(validTimeZone(undefined)).toBeNull()
    expect(validTimeZone(42)).toBeNull()
    expect(validTimeZone('x'.repeat(200))).toBeNull()
  })
})
