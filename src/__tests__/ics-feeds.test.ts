import { describe, expect, it } from 'vitest'
import { expandEvents, ianaZoneOf, parseICS } from '../../shared/ics.mts'

// Subscribed feeds as Outlook, Google, iCloud and the odd school system
// actually write them. The parser read a Windows zone name ("US Mountain
// Standard Time") as UTC, which put an Outlook event seven hours out in
// Phoenix; read a floating time as UTC; ignored "the second Tuesday" (2TU) and
// "the last Friday" (-1FR), and BYSETPOS; kept only the first of BYMONTHDAY=1,15;
// and ran FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR through the weekends. Each snippet
// here is a real shape, trimmed to what the parser reads.

const cal = (...body: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...body, 'END:VCALENDAR', ''].join('\r\n')
const ev = (...lines: string[]) => ['BEGIN:VEVENT', 'DTSTAMP:20260901T120000Z', ...lines, 'END:VEVENT'].join('\r\n')
const FROM = Date.UTC(2026, 8, 1)
const TO = Date.UTC(2027, 0, 1)
const starts = (text: string, tz?: string, from = FROM, to = TO) => expandEvents(parseICS(text, { tz }), from, to).map(e => e.start)

/** Outlook's VTIMEZONE for Pacific time, as Exchange publishes it. */
const OUTLOOK_PACIFIC = [
  'BEGIN:VTIMEZONE',
  'TZID:Pacific Standard Time',
  'BEGIN:STANDARD',
  'DTSTART:16010101T020000',
  'TZOFFSETFROM:-0700',
  'TZOFFSETTO:-0800',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:16010101T020000',
  'TZOFFSETFROM:-0800',
  'TZOFFSETTO:-0700',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
].join('\r\n')

describe('zones as Outlook names them', () => {
  it('reads "US Mountain Standard Time" as Phoenix, not UTC', () => {
    const feed = cal(
      'METHOD:PUBLISH',
      'PRODID:Microsoft Exchange Server 2010',
      'X-WR-CALNAME:Calendar',
      'BEGIN:VTIMEZONE',
      'TZID:US Mountain Standard Time',
      'BEGIN:STANDARD',
      'DTSTART:16010101T000000',
      'TZOFFSETFROM:-0700',
      'TZOFFSETTO:-0700',
      'END:STANDARD',
      'BEGIN:DAYLIGHT',
      'DTSTART:16010101T000000',
      'TZOFFSETFROM:-0700',
      'TZOFFSETTO:-0700',
      'END:DAYLIGHT',
      'END:VTIMEZONE',
      ev(
        'UID:040000008200E00074C5B7101A82E0080000000080C4D3A0E43DDB01000000000000000010000000',
        'SUMMARY:Dentist',
        'DTSTART;TZID=US Mountain Standard Time:20260915T090000',
        'DTEND;TZID=US Mountain Standard Time:20260915T100000',
        'CLASS:PUBLIC',
        'TRANSP:OPAQUE',
        'X-MICROSOFT-CDO-BUSYSTATUS:BUSY',
      ),
    )
    const [dentist] = expandEvents(parseICS(feed), FROM, TO)
    expect(dentist).toMatchObject({ title: 'Dentist', start: '2026-09-15T16:00:00.000Z', end: '2026-09-15T17:00:00.000Z' })
  })

  it('keeps a weekly Pacific meeting at 10:00 across the November change', () => {
    const feed = cal(
      OUTLOOK_PACIFIC,
      ev('UID:standup', 'SUMMARY:Standup', 'DTSTART;TZID=Pacific Standard Time:20261027T100000', 'DTEND;TZID=Pacific Standard Time:20261027T103000', 'RRULE:FREQ=WEEKLY;COUNT=2;BYDAY=TU'),
    )
    expect(starts(feed)).toEqual(['2026-10-27T17:00:00.000Z', '2026-11-03T18:00:00.000Z'])
  })

  it('knows the common Windows names, and old Lightning paths, as IANA zones', () => {
    expect(ianaZoneOf('Pacific Standard Time')).toBe('America/Los_Angeles')
    expect(ianaZoneOf('Mountain Standard Time')).toBe('America/Denver')
    expect(ianaZoneOf('US Mountain Standard Time')).toBe('America/Phoenix')
    expect(ianaZoneOf('Central Standard Time')).toBe('America/Chicago')
    expect(ianaZoneOf('Eastern Standard Time')).toBe('America/New_York')
    expect(ianaZoneOf('GMT Standard Time')).toBe('Europe/London')
    expect(ianaZoneOf('UTC')).toBe('UTC')
    expect(ianaZoneOf('W. Europe Standard Time')).toBe('Europe/Berlin')
    expect(ianaZoneOf('Romance Standard Time')).toBe('Europe/Paris')
    expect(ianaZoneOf('Central Europe Standard Time')).toBe('Europe/Budapest')
    expect(ianaZoneOf('AUS Eastern Standard Time')).toBe('Australia/Sydney')
    expect(ianaZoneOf('"eastern standard time"')).toBe('America/New_York')
    expect(ianaZoneOf('/mozilla.org/20050126_1/America/New_York')).toBe('America/New_York')
    expect(ianaZoneOf('America/Phoenix')).toBe('America/Phoenix')
    expect(ianaZoneOf('Customized Time Zone')).toBeNull()
  })

  it('reads a zone only the feed’s own VTIMEZONE explains, summer and winter', () => {
    const custom = OUTLOOK_PACIFIC.replace('TZID:Pacific Standard Time', 'TZID:Customized Time Zone')
    const feed = cal(
      custom,
      ev('UID:a', 'SUMMARY:Summer', 'DTSTART;TZID=Customized Time Zone:20260715T090000'),
      ev('UID:b', 'SUMMARY:Winter', 'DTSTART;TZID=Customized Time Zone:20261215T090000'),
    )
    expect(starts(feed, undefined, Date.UTC(2026, 0, 1))).toEqual(['2026-07-15T16:00:00.000Z', '2026-12-15T17:00:00.000Z'])
  })

  it('reads a VTIMEZONE that comes after the events using it', () => {
    const custom = OUTLOOK_PACIFIC.replace('TZID:Pacific Standard Time', 'TZID:Customized Time Zone')
    const feed = cal(ev('UID:a', 'SUMMARY:Late zone', 'DTSTART;TZID=Customized Time Zone:20260715T090000'), custom)
    expect(starts(feed, undefined, Date.UTC(2026, 0, 1))).toEqual(['2026-07-15T16:00:00.000Z'])
  })

  it('reads a French Outlook calendar and an Australian one in their own zones', () => {
    const feed = cal(
      ev('UID:paris', 'SUMMARY:Réunion', 'DTSTART;TZID=Romance Standard Time:20260916T193000'),
      ev('UID:sydney', 'SUMMARY:Call', 'DTSTART;TZID=AUS Eastern Standard Time:20260917T080000'),
    )
    expect(starts(feed)).toEqual(['2026-09-16T17:30:00.000Z', '2026-09-16T22:00:00.000Z'])
  })
})

describe('floating times', () => {
  const floating = cal(ev('UID:school', 'SUMMARY:Parents’ evening', 'DTSTART:20260915T090000', 'DTEND:20260915T100000'))

  it('are read on the reader’s wall clock', () => {
    expect(starts(floating, 'America/Phoenix')).toEqual(['2026-09-15T16:00:00.000Z'])
    expect(starts(floating, 'America/New_York')).toEqual(['2026-09-15T13:00:00.000Z'])
  })

  it('in the calendar’s own zone when it names one, whoever reads it', () => {
    const london = floating.replace('VERSION:2.0', 'VERSION:2.0\r\nX-WR-TIMEZONE:Europe/London')
    expect(starts(london, 'America/Phoenix')).toEqual(['2026-09-15T08:00:00.000Z'])
  })

  it('and as UTC only with no zone to go by at all', () => {
    expect(starts(floating)).toEqual(['2026-09-15T09:00:00.000Z'])
  })

  it('an unknown TZID with no VTIMEZONE falls to the reader’s zone, not UTC', () => {
    const odd = cal(ev('UID:x', 'SUMMARY:Club', 'DTSTART;TZID=Somewhere Else:20260915T090000'))
    expect(starts(odd, 'America/Phoenix')).toEqual(['2026-09-15T16:00:00.000Z'])
  })
})

describe('recurrence rules as personal calendars write them', () => {
  const allDay = (uid: string, start: string, rrule: string, extra: string[] = []) => cal(ev(`UID:${uid}`, `SUMMARY:${uid}`, `DTSTART;VALUE=DATE:${start}`, `RRULE:${rrule}`, ...extra))
  const days = (text: string, tz?: string) => starts(text, tz)

  it('the second Tuesday of the month (BYDAY=2TU)', () => {
    expect(days(allDay('book-club', '20260908', 'FREQ=MONTHLY;BYDAY=2TU'))).toEqual(['2026-09-08', '2026-10-13', '2026-11-10', '2026-12-08'])
  })

  it('the last Friday of the month (BYDAY=-1FR)', () => {
    expect(days(allDay('quiz', '20260925', 'FREQ=MONTHLY;BYDAY=-1FR'))).toEqual(['2026-09-25', '2026-10-30', '2026-11-27', '2026-12-25'])
  })

  it('the last weekday of the month (BYSETPOS=-1)', () => {
    expect(days(allDay('payday', '20260930', 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'))).toEqual(['2026-09-30', '2026-10-30', '2026-11-30', '2026-12-31'])
  })

  it('the 1st and the 15th, and the last day (BYMONTHDAY=1,15 and -1)', () => {
    expect(days(allDay('bills', '20260901', 'FREQ=MONTHLY;BYMONTHDAY=1,15;COUNT=5'))).toEqual(['2026-09-01', '2026-09-15', '2026-10-01', '2026-10-15', '2026-11-01'])
    expect(days(allDay('rent', '20260930', 'FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=4'))).toEqual(['2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31'])
  })

  it('every weekday (FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR) skips the weekend', () => {
    const feed = cal(ev('UID:walk', 'SUMMARY:School run', 'DTSTART;TZID=America/Phoenix:20260910T074500', 'RRULE:FREQ=DAILY;COUNT=5;BYDAY=MO,TU,WE,TH,FR'))
    expect(starts(feed).map(s => s.slice(0, 10))).toEqual(['2026-09-10', '2026-09-11', '2026-09-14', '2026-09-15', '2026-09-16'])
  })

  it('Thanksgiving and Mother’s Day (YEARLY with BYMONTH and an ordinal BYDAY)', () => {
    expect(days(allDay('thanksgiving', '20261126', 'FREQ=YEARLY;BYMONTH=11;BYDAY=4TH'))).toEqual(['2026-11-26'])
    expect(starts(allDay('thanksgiving', '20261126', 'FREQ=YEARLY;BYMONTH=11;BYDAY=4TH'), undefined, FROM, Date.UTC(2028, 0, 1))).toEqual(['2026-11-26', '2027-11-25'])
    expect(starts(allDay('mothers-day', '20260510', 'FREQ=YEARLY;BYMONTH=5;BYDAY=2SU'), undefined, Date.UTC(2026, 0, 1), Date.UTC(2028, 0, 1))).toEqual(['2026-05-10', '2027-05-09'])
  })

  it('a fortnightly rule counts its weeks from WKST, Monday unless it says otherwise', () => {
    const rule = (wkst: string) =>
      cal(ev('UID:swim', 'SUMMARY:Swim', 'DTSTART;TZID=America/Phoenix:20260907T170000', `RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU${wkst};COUNT=4`))
    const daysOf = (text: string) => starts(text).map(s => new Date(s).toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' }))
    // weeks from Monday: the 7th and the 13th, then the 21st and the 27th
    expect(daysOf(rule(''))).toEqual(['2026-09-07', '2026-09-13', '2026-09-21', '2026-09-27'])
    // weeks from Sunday: the 6th is before the start, so the 7th, then the 20th and the 21st
    expect(daysOf(rule(';WKST=SU'))).toEqual(['2026-09-07', '2026-09-20', '2026-09-21', '2026-10-04'])
  })

  it('an UNTIL written as a date keeps that day’s occurrence of a timed event', () => {
    const feed = cal(ev('UID:class', 'SUMMARY:Pottery', 'DTSTART;TZID=America/Phoenix:20260901T180000', 'RRULE:FREQ=WEEKLY;UNTIL=20260922'))
    expect(starts(feed)).toEqual(['2026-09-02T01:00:00.000Z', '2026-09-09T01:00:00.000Z', '2026-09-16T01:00:00.000Z', '2026-09-23T01:00:00.000Z'])
  })

  it('an EXDATE written as a date on a timed event leaves out that day’s occurrence', () => {
    const feed = cal(ev('UID:yoga', 'SUMMARY:Yoga', 'DTSTART;TZID=Europe/London:20260901T180000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'EXDATE;VALUE=DATE:20260908'))
    expect(starts(feed)).toEqual(['2026-09-01T17:00:00.000Z', '2026-09-15T17:00:00.000Z'])
  })

  it('an EXDATE with no zone on a zoned event is read in the event’s zone', () => {
    const feed = cal(ev('UID:yoga', 'SUMMARY:Yoga', 'DTSTART;TZID=Europe/London:20260901T180000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'EXDATE:20260908T180000'))
    expect(starts(feed)).toEqual(['2026-09-01T17:00:00.000Z', '2026-09-15T17:00:00.000Z'])
  })

  it('a daily rule begun years ago still reaches the window', () => {
    const feed = cal(ev('UID:pills', 'SUMMARY:Vitamins', 'DTSTART;VALUE=DATE:20090101', 'RRULE:FREQ=DAILY'))
    const got = starts(feed, undefined, Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 4))
    expect(got).toEqual(['2026-09-01', '2026-09-02', '2026-09-03'])
  })

  it('a monthly rule on the 31st keeps its old behaviour, the last day of a shorter month', () => {
    expect(days(allDay('rent31', '20260831', 'FREQ=MONTHLY;COUNT=4'))).toEqual(['2026-09-30', '2026-10-31', '2026-11-30'])
  })

  it('stays within bounds on a hostile rule', () => {
    const ordinals = Array.from({ length: 5000 }, (_, i) => `${(i % 53) + 1}MO`).join(',')
    const feed = cal(ev('UID:x', 'SUMMARY:x', 'DTSTART;VALUE=DATE:20260101', `RRULE:FREQ=YEARLY;BYDAY=${ordinals};BYSETPOS=${Array.from({ length: 900 }, (_, i) => i + 1).join(',')}`))
    const started = Date.now()
    const out = expandEvents(parseICS(feed), Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1))
    expect(Date.now() - started).toBeLessThan(2000)
    // every Monday of 2026 at most, once each
    expect(out.length).toBeLessThanOrEqual(53)
    expect(new Set(out.map(e => e.start)).size).toBe(out.length)
  })
})
