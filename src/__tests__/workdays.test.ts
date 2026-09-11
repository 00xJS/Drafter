import { describe, expect, it } from 'vitest'
import { expandWorkDays } from '../calendars'
import { sanitizeEvent } from '../schema'
import { googleEntryBody } from '../../netlify/functions/lib/google.mjs'
import { graphEntryBody } from '../../netlify/functions/lib/microsoft.mjs'
import { buildICS } from '../../shared/ics.mjs'

// A work day is a calendar entry with a place (home or office) whose start and
// end are the working hours. These pin the three things that make it useful:
// a repeat lays out the right days, the record survives a sync, and it never
// shows up as busy time on anyone's calendar.

describe('expandWorkDays: a weekly pattern becomes concrete days', () => {
  it('lays a Monday and Friday pattern over two weeks, in local time', () => {
    // 2026-09-07 is a Monday
    const days = expandWorkDays('2026-09-07', [1, 5], 2, '09:00', '17:30')
    expect(days.map(d => d.day)).toEqual(['2026-09-07', '2026-09-11', '2026-09-14', '2026-09-18'])
    const start = new Date(days[0].start)
    const end = new Date(days[0].end)
    expect([start.getHours(), start.getMinutes()]).toEqual([9, 0])
    expect([end.getHours(), end.getMinutes()]).toEqual([17, 30])
  })

  it('counts from the chosen day, not from the start of its week', () => {
    // 2026-09-09 is a Wednesday, so that week's Monday is before it and left out
    const days = expandWorkDays('2026-09-09', [1, 3], 1, '09:00', '17:00')
    expect(days.map(d => d.day)).toEqual(['2026-09-09', '2026-09-14'])
  })

  it('returns nothing for hours that end before they start, or input it cannot read', () => {
    expect(expandWorkDays('2026-09-07', [1], 1, '17:00', '09:00')).toEqual([])
    expect(expandWorkDays('not-a-day', [1], 1, '09:00', '17:00')).toEqual([])
    expect(expandWorkDays('2026-09-07', [1], 1, 'nine', '17:00')).toEqual([])
  })

  it('caps a runaway repeat at a year rather than minting thousands of rows', () => {
    const days = expandWorkDays('2026-09-07', [1, 2, 3, 4, 5], 500, '09:00', '17:00')
    expect(days).toHaveLength(52 * 5)
  })
})

describe('a work day survives the round trip through the sanitizer', () => {
  const base = {
    kind: 'event',
    id: 'w1',
    title: 'Working from home',
    start: '2026-09-07T08:00:00.000Z',
    end: '2026-09-07T16:30:00.000Z',
    allDay: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }

  it('keeps home and office', () => {
    expect(sanitizeEvent({ ...base, work: 'home' })!.work).toBe('home')
    expect(sanitizeEvent({ ...base, work: 'office' })!.work).toBe('office')
  })

  it('drops anything else rather than inventing a work day', () => {
    expect(sanitizeEvent({ ...base, work: 'beach' })!.work).toBeUndefined()
    expect(sanitizeEvent(base)!.work).toBeUndefined()
  })
})

describe('a work day is available time on every calendar, never busy', () => {
  const day = { id: 'w1', title: 'Working from home', start: '2026-09-07T08:00:00.000Z', end: '2026-09-07T16:30:00.000Z', allDay: false }

  it('is free time in Google', () => {
    expect(googleEntryBody({ ...day, work: 'home' }, '').transparency).toBe('transparent')
    expect(googleEntryBody({ ...day, work: 'office' }, '').transparency).toBe('transparent')
  })

  it('is "working elsewhere" at home and free at the office in Outlook', () => {
    expect(graphEntryBody({ ...day, work: 'home' }, '').showAs).toBe('workingElsewhere')
    expect(graphEntryBody({ ...day, work: 'office' }, '').showAs).toBe('free')
  })

  it('leaves an ordinary event busy on both', () => {
    expect(googleEntryBody(day, '').transparency).toBe('opaque')
    expect(graphEntryBody(day, '').showAs).toBe('busy')
  })

  it('is TRANSP:TRANSPARENT in the feed, while an ordinary event stays busy', () => {
    const ics = buildICS('f', [
      { uid: 'w@x', title: 'Working from home', start: Date.parse(day.start), end: Date.parse(day.end), allDay: false, transparent: true },
      { uid: 'e@x', title: 'Dentist', start: Date.parse(day.start), end: Date.parse(day.end), allDay: false },
    ])
    const [workBlock, eventBlock] = ics.split('BEGIN:VEVENT').slice(1)
    expect(workBlock).toContain('TRANSP:TRANSPARENT')
    expect(eventBlock).not.toContain('TRANSP')
  })
})
