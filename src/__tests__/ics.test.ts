import { describe, expect, it } from 'vitest'
import { buildICS, expandEvents, parseICS } from '../../shared/ics.mjs'

const wrap = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Family\r\n${body}\r\nEND:VCALENDAR\r\n`
const from = Date.UTC(2026, 8, 1)
const to = Date.UTC(2026, 11, 31)

describe('parseICS', () => {
  it('reads name, unfolds lines and unescapes text', () => {
    const p = parseICS(wrap('BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Dinner\\, with\r\n  friends\r\nDTSTART:20260910T180000Z\r\nEND:VEVENT'))
    expect(p.calendarName).toBe('Family')
    expect(p.events[0].summary).toBe('Dinner, with friends')
    expect(p.events[0].start).toEqual({ allDay: false, ms: Date.UTC(2026, 8, 10, 18) })
  })

  it('converts TZID wall-clock times to UTC', () => {
    const p = parseICS(wrap('BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Call\r\nDTSTART;TZID=America/New_York:20260710T090000\r\nEND:VEVENT'))
    expect(p.events[0].start.ms).toBe(Date.UTC(2026, 6, 10, 13)) // EDT = UTC-4
  })
})

describe('expandEvents', () => {
  it('expands a yearly birthday as an all-day date', () => {
    const p = parseICS(wrap('BEGIN:VEVENT\r\nUID:bday\r\nSUMMARY:Mum\r\nDTSTART;VALUE=DATE:19600914\r\nRRULE:FREQ=YEARLY\r\nEND:VEVENT'))
    const inst = expandEvents(p, from, to)
    expect(inst).toHaveLength(1)
    expect(inst[0]).toMatchObject({ title: 'Mum', start: '2026-09-14', end: '2026-09-15', allDay: true })
  })

  it('expands weekly BYDAY, honours EXDATE and COUNT', () => {
    const p = parseICS(
      wrap('BEGIN:VEVENT\r\nUID:yoga\r\nSUMMARY:Yoga\r\nDTSTART:20260901T170000Z\r\nDTEND:20260901T180000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=TU,TH;COUNT=5\r\nEXDATE:20260908T170000Z\r\nEND:VEVENT'),
    )
    const inst = expandEvents(p, from, to)
    expect(inst.map(i => i.start.slice(0, 10))).toEqual(['2026-09-01', '2026-09-03', '2026-09-10', '2026-09-15'])
    expect(inst[0].end).toBe('2026-09-01T18:00:00.000Z')
  })

  it('applies a detached override (RECURRENCE-ID) instead of the generated instance', () => {
    const p = parseICS(
      wrap(
        'BEGIN:VEVENT\r\nUID:standup\r\nSUMMARY:Standup\r\nDTSTART:20260907T090000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT\r\n' +
          'BEGIN:VEVENT\r\nUID:standup\r\nRECURRENCE-ID:20260908T090000Z\r\nSUMMARY:Standup (moved)\r\nDTSTART:20260908T140000Z\r\nEND:VEVENT',
      ),
    )
    const inst = expandEvents(p, from, to)
    expect(inst.map(i => `${i.title}@${i.start}`)).toEqual([
      'Standup@2026-09-07T09:00:00.000Z',
      'Standup (moved)@2026-09-08T14:00:00.000Z',
      'Standup@2026-09-09T09:00:00.000Z',
    ])
  })

  it('handles monthly on the 31st by clamping and skips cancelled events', () => {
    const p = parseICS(
      wrap('BEGIN:VEVENT\r\nUID:rent\r\nSUMMARY:Rent\r\nDTSTART;VALUE=DATE:20260831\r\nRRULE:FREQ=MONTHLY;COUNT=3\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Gone\r\nSTATUS:CANCELLED\r\nDTSTART;VALUE=DATE:20260905\r\nEND:VEVENT'),
    )
    expect(expandEvents(p, from, to).map(i => i.start)).toEqual(['2026-09-30', '2026-10-31'])
  })
})

describe('buildICS', () => {
  it('emits timed and all-day events with escaping and folding', () => {
    const ics = buildICS('Drafter', [
      { uid: 't1', title: 'Fix, the; tap', start: Date.UTC(2026, 8, 10, 9), allDay: false, description: 'line1\nline2' },
      { uid: 'm1', title: 'Cabinets in', start: Date.UTC(2026, 9, 20), allDay: true },
    ])
    expect(ics).toContain('SUMMARY:Fix\\, the; tap')
    expect(ics).toContain('DTSTART:20260910T090000Z')
    expect(ics).toContain('DTEND:20260910T100000Z')
    expect(ics).toContain('DTSTART;VALUE=DATE:20261020')
    expect(ics).toContain('DTEND;VALUE=DATE:20261021')
    expect(ics).toContain('DESCRIPTION:line1\\nline2')
    // round trip
    const back = expandEvents(parseICS(ics), from, to)
    expect(back.map(e => e.title)).toEqual(['Fix, the; tap', 'Cabinets in'])
  })
})

describe('DST wall-clock recurrence', () => {
  it('keeps Europe/London weekly 18:00 across the autumn change', () => {
    // 2026-10-18 is BST (UTC+1); 2026-10-25 is GMT (UTC+0)
    const ics = wrap(
      'BEGIN:VEVENT\r\nUID:dinner\r\nSUMMARY:Sunday dinner\r\nDTSTART;TZID=Europe/London:20261018T180000\r\nRRULE:FREQ=WEEKLY;BYDAY=SU;COUNT=3\r\nEND:VEVENT',
    )
    const out = expandEvents(parseICS(ics), Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 15))
    expect(out).toHaveLength(3)
    // wall 18:00 BST → 17:00Z; wall 18:00 GMT → 18:00Z
    expect(out[0].start).toBe('2026-10-18T17:00:00.000Z')
    expect(out[1].start).toBe('2026-10-25T18:00:00.000Z')
    expect(out[2].start).toBe('2026-11-01T18:00:00.000Z')
  })
})

describe('resource bounds against a hostile feed', () => {
  it('caps BYDAY repetition instead of multiplying it', () => {
    const byday = Array.from({ length: 20000 }, () => 'MO').join(',')
    const ics = wrap(`BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:x\r\nDTSTART:20260101T090000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=${byday}\r\nEND:VEVENT`)
    const started = 0
    const out = expandEvents(parseICS(ics), Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1))
    expect(started).toBe(0)
    // one weekday, ~52 weeks — not 20000x that
    expect(out.length).toBeLessThan(120)
  })

  it('caps the total instances one feed can produce', () => {
    const events = Array.from(
      { length: 3000 },
      (_, i) => `BEGIN:VEVENT\r\nUID:e${i}\r\nSUMMARY:e\r\nDTSTART:20260101T090000Z\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT`,
    ).join('\r\n')
    const out = expandEvents(parseICS(wrap(events)), Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1))
    expect(out.length).toBeLessThanOrEqual(20000)
  })
})
