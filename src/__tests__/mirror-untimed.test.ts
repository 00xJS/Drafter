import { describe, expect, it } from 'vitest'
import { feedFor } from '../../netlify/functions/lib/feedrows.mjs'
import { googleTaskBody } from '../../netlify/functions/lib/google.mjs'
import { graphTaskBody } from '../../netlify/functions/lib/microsoft.mjs'
import { dueDayKey, hasDueTime } from '../../shared/due.mts'

// A task with no time of day is stored at local midnight, and every screen
// reads it by one rule (shared/due.mts). The Google and Outlook copies and the
// subscribed feed each had a near-identical rule of their own, which counted
// the seconds too: a task at 00:00:30 was "no time" on Home and a 00:00 event
// in both calendars. They now ask the same rule, in the owner's zone.

const task = (dueAt: string) => ({
  kind: 'task',
  id: 'bins',
  title: 'Bins out',
  description: '',
  status: 'todo',
  priority: 'normal',
  tags: [],
  dueAt,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
})

const CASES: [string, string][] = [
  ['2026-09-15T07:00:00.000Z', 'America/Phoenix'], // midnight in Phoenix: a day
  ['2026-09-15T07:00:30.000Z', 'America/Phoenix'], // …and thirty seconds: still a day, as Home reads it
  ['2026-09-15T16:00:00.000Z', 'America/Phoenix'], // 9 am there
  ['2026-09-14T23:00:00.000Z', 'Europe/London'], // midnight in a British summer, the day before in UTC
  ['2026-09-15T00:00:00.000Z', 'UTC'],
  ['2026-09-15T00:01:00.000Z', 'UTC'],
]

describe('the calendar copies read "no time of day" by the app’s one rule', () => {
  it.each(CASES)('%s in %s', (dueAt, tz) => {
    const timed = hasDueTime(dueAt, tz)
    const day = dueDayKey(dueAt, tz)
    const google = googleTaskBody(task(dueAt), undefined, '', tz) as { start: { date?: string; dateTime?: string } }
    const graph = graphTaskBody(task(dueAt), undefined, '', tz) as { isAllDay: boolean; start: { dateTime: string } }
    const [feed] = feedFor([task(dueAt)], '', tz, 'me') as { allDay: boolean; date?: string }[]
    expect(!!google.start.dateTime).toBe(timed)
    expect(graph.isAllDay).toBe(!timed)
    expect(feed.allDay).toBe(!timed)
    if (!timed) {
      expect(google.start.date).toBe(day)
      expect(graph.start.dateTime).toBe(`${day}T00:00:00`)
      expect(feed.date).toBe(day)
    }
  })

  it('a task stored at midnight and a few seconds is all-day in both calendars and the feed', () => {
    const dueAt = '2026-09-15T07:00:30.000Z'
    expect(googleTaskBody(task(dueAt), undefined, '', 'America/Phoenix').start).toEqual({ date: '2026-09-15' })
    expect(graphTaskBody(task(dueAt), undefined, '', 'America/Phoenix').isAllDay).toBe(true)
    expect(feedFor([task(dueAt)], '', 'America/Phoenix', 'me')[0]).toMatchObject({ allDay: true, date: '2026-09-15' })
  })
})
