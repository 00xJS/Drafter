import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { googleEntryBody, googlePullRows } from '../../netlify/functions/lib/google.mjs'
import { graphEntryBody, graphEntryChange, mirroredTaskIds, outlookMissing, pullEntryChanges } from '../../netlify/functions/lib/microsoft.mjs'
import {
  type EntryChange,
  type MirrorLedger,
  type PassTarget,
  type PullOutcome,
  believedLive,
  entryPullWrites,
  mirrorPass,
  mirrorStamp,
  outlookDeletions,
  seedLedger,
} from '../calendars'
import type { CalendarEntry, Item, Task } from '../types'

// Changes made in Google or Outlook to a mirrored entry never came back, and an
// Outlook-side delete of a mirrored task was ignored (Google's marked it done).
// These pin the way back: what each provider hands the pull, read in Drafter's
// convention so an untouched entry never looks moved; newer-wins against the
// entry's own updatedAt, as task due dates already do; and an Outlook delete
// detected by setting what the calendar holds against what this device put
// there, stamped so a later edit still wins.

const SITE = 'https://drafterz.netlify.app'
const ME = 'me-0001'
const TASK_PROP = 'String {66f5a359-4659-4830-9070-00047ec6ac6e} Name drafterTaskId'
const EVENT_PROP = 'String {66f5a359-4659-4830-9070-00047ec6ac6e} Name drafterEventId'

function entry(over: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    kind: 'event',
    id: 'ev1',
    title: 'Dentist',
    start: '2026-09-10T14:00:00.000Z',
    end: '2026-09-10T15:30:00.000Z',
    allDay: false,
    location: 'High Street',
    notes: 'Bring the form',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-09T12:00:00.000Z',
    ownerId: ME,
    ...over,
  }
}
const allDay = entry({ id: 'ev2', allDay: true, start: '2026-09-12', end: '2026-09-15' })

function task(over: Partial<Task> = {}): Task {
  return {
    kind: 'task',
    id: 't1',
    title: 'Pay rent',
    description: '',
    status: 'todo',
    priority: 'normal',
    dueAt: '2026-09-20T09:00:00.000Z',
    tags: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-10T10:00:00.000Z',
    ownerId: ME,
    ...over,
  }
}

/** Google answers a timed event in the calendar's own zone, not the UTC it was written in. */
const inLondon = (iso: string) => new Date(Date.parse(iso) + 3_600_000).toISOString().replace(/\.\d{3}Z$/, '+01:00')

/** What Google hands back for an event written from googleEntryBody. */
function googleCopy(e: CalendarEntry, updated: string, patch: Record<string, unknown> = {}) {
  const b = googleEntryBody({ ...e }, SITE)
  return {
    id: `g-${e.id}`,
    status: 'confirmed',
    updated,
    summary: b.summary,
    start: b.start.date ? { date: b.start.date } : { dateTime: inLondon(b.start.dateTime!), timeZone: 'Europe/London' },
    end: b.end.date ? { date: b.end.date } : { dateTime: inLondon(b.end.dateTime!), timeZone: 'Europe/London' },
    extendedProperties: b.extendedProperties,
    ...patch,
  }
}

/** What Graph hands back for an event written from graphEntryBody, asked for in UTC. */
function graphCopy(e: CalendarEntry, updated: string, patch: Record<string, unknown> = {}) {
  const b = graphEntryBody({ ...e }, SITE)
  return {
    id: `m-${e.id}`,
    subject: b.subject,
    isAllDay: b.isAllDay,
    isCancelled: false,
    start: { dateTime: `${b.start.dateTime}.0000000`, timeZone: 'UTC' },
    end: { dateTime: `${b.end.dateTime}.0000000`, timeZone: 'UTC' },
    lastModifiedDateTime: updated,
    singleValueExtendedProperties: b.singleValueExtendedProperties,
    ...patch,
  }
}

describe('Google: what moved in the Drafter calendar', () => {
  it('splits task moves from entry edits, and ignores anything not ours', () => {
    const rows = googlePullRows([
      { id: 'a', status: 'confirmed', updated: '2026-09-10T12:00:00.000Z', start: { date: '2026-09-20' }, extendedProperties: { private: { drafter: '1', taskId: 't1' } } },
      googleCopy(entry(), '2026-09-10T12:00:00.000Z'),
      { id: 'z', status: 'confirmed', updated: '2026-09-10T12:00:00.000Z', summary: 'Someone else', start: { dateTime: '2026-09-10T10:00:00Z' } },
    ])
    expect(rows.changes).toEqual([{ taskId: 't1', deleted: false, start: '2026-09-20', allDay: true, updated: '2026-09-10T12:00:00.000Z' }])
    expect(rows.entries.map(e => e.eventId)).toEqual(['ev1'])
  })

  it('reads an entry back in Drafter’s convention, whatever zone Google answers in', () => {
    const [timed] = googlePullRows([googleCopy(entry(), '2026-09-10T12:00:00.000Z')]).entries
    expect(timed).toMatchObject({ start: '2026-09-10T14:00:00.000Z', end: '2026-09-10T15:30:00.000Z', allDay: false, title: 'Dentist', deleted: false })
    const [day] = googlePullRows([googleCopy(allDay, '2026-09-10T12:00:00.000Z')]).entries
    expect(day).toMatchObject({ start: '2026-09-12', end: '2026-09-15', allDay: true })
  })

  it('an echo of Drafter’s own write changes nothing, so a pull after a push cannot bounce', () => {
    const e = entry()
    const { entries } = googlePullRows([googleCopy(e, '2026-09-10T12:00:00.000Z'), googleCopy(allDay, '2026-09-10T12:00:00.000Z')])
    expect(entryPullWrites([e, allDay], entries)).toEqual([])
  })

  it('an entry moved in Google comes back, keeping Drafter’s notes and place', () => {
    const e = entry()
    const moved = googleCopy(e, '2026-09-10T12:00:00.000Z', { start: { dateTime: '2026-09-10T17:00:00+01:00' }, end: { dateTime: '2026-09-10T18:30:00+01:00' } })
    const [row] = entryPullWrites([e], googlePullRows([moved]).entries)
    expect(row).toMatchObject({ id: 'ev1', start: '2026-09-10T16:00:00.000Z', end: '2026-09-10T17:30:00.000Z', title: 'Dentist', location: 'High Street', notes: 'Bring the form' })
    expect(row.updatedAt > e.updatedAt).toBe(true)
  })
})

describe('Outlook: what moved in the Drafter calendar', () => {
  it('reads Graph’s seven-digit UTC times and its all-day midnights', () => {
    expect(graphEntryChange(graphCopy(entry(), '2026-09-10T12:00:00.1234567Z'))).toMatchObject({
      eventId: 'ev1',
      start: '2026-09-10T14:00:00.000Z',
      end: '2026-09-10T15:30:00.000Z',
      allDay: false,
      updated: '2026-09-10T12:00:00.1234567Z',
    })
    expect(graphEntryChange(graphCopy(allDay, '2026-09-10T12:00:00Z'))).toMatchObject({ start: '2026-09-12', end: '2026-09-15', allDay: true })
  })

  it('never reads a mirrored task as an entry', () => {
    expect(graphEntryChange({ id: 'x', subject: 'Pay rent', singleValueExtendedProperties: [{ id: TASK_PROP, value: 't1' }] })).toBeNull()
  })

  it('an echo changes nothing; a rename made in Outlook comes back', () => {
    const e = entry()
    expect(entryPullWrites([e], [graphEntryChange(graphCopy(e, '2026-09-10T12:00:00Z'))!])).toEqual([])
    const [row] = entryPullWrites([e], [graphEntryChange(graphCopy(e, '2026-09-10T12:00:00Z', { subject: 'Dentist (moved to Thursday)' }))!])
    expect(row.title).toBe('Dentist (moved to Thursday)')
  })
})

describe('entryPullWrites: the newer edit wins, as it does for task due dates', () => {
  const change = (over: Partial<EntryChange> = {}): EntryChange => ({
    eventId: 'ev1',
    deleted: false,
    title: 'Dentist',
    start: '2026-09-11T09:00:00.000Z',
    end: '2026-09-11T10:00:00.000Z',
    allDay: false,
    updated: '2026-09-10T12:00:00.000Z',
    ...over,
  })

  it('ignores a provider change older than Drafter’s own last edit', () => {
    expect(entryPullWrites([entry({ updatedAt: '2026-09-10T13:00:00.000Z' })], [change()])).toEqual([])
  })

  it('never deletes because the provider did, and never brings a deleted entry back', () => {
    expect(entryPullWrites([entry()], [change({ deleted: true })])).toEqual([])
    expect(entryPullWrites([entry({ deletedAt: '2026-09-09T13:00:00.000Z' })], [change()])).toEqual([])
    expect(entryPullWrites([], [change()])).toEqual([])
  })

  it('keeps an untitled entry untitled: "Untitled event" is only the provider’s placeholder', () => {
    const e = entry({ title: '' })
    expect(entryPullWrites([e], [change({ title: 'Untitled event', start: e.start, end: e.end })])).toEqual([])
  })

  it('ignores a range that makes no sense', () => {
    expect(entryPullWrites([entry()], [change({ end: '2026-09-11T08:00:00.000Z' })])).toEqual([])
    expect(entryPullWrites([entry()], [change({ allDay: true, start: '2026-9-11', end: '2026-09-12' })])).toEqual([])
    expect(entryPullWrites([entry()], [change({ start: null })])).toEqual([])
  })

  it('takes the newest word when one page carries two for the same entry', () => {
    const [row] = entryPullWrites([entry()], [change({ start: '2026-09-11T11:00:00.000Z', end: '2026-09-11T12:00:00.000Z', updated: '2026-09-10T14:00:00.000Z' }), change()])
    expect(row.start).toBe('2026-09-11T11:00:00.000Z')
  })

  it('brings back a switch to all day', () => {
    const [row] = entryPullWrites([entry()], [change({ allDay: true, start: '2026-09-11', end: '2026-09-12' })])
    expect(row).toMatchObject({ allDay: true, start: '2026-09-11', end: '2026-09-12' })
  })
})

describe('an Outlook delete reads like a Google one', () => {
  const NOW = Date.parse('2026-09-12T12:00:00.000Z')
  const HOUR = 3_600_000
  const confirmedAt = (t: Task, ms: number) => `${mirrorStamp(t.updatedAt)}.${Math.floor(ms / 1000).toString(36)}`

  it('only judges tasks this device put there and has not touched since', () => {
    const live = task({ id: 'live' })
    const edited = task({ id: 'edited' })
    const recent = task({ id: 'recent' })
    const done = task({ id: 'done', status: 'done' })
    const undated = task({ id: 'undated', dueAt: undefined })
    const theirs = task({ id: 'theirs', ownerId: 'partner-0002' })
    const ledger: MirrorLedger = {
      v: 1,
      seen: {
        live: confirmedAt(live, NOW - HOUR),
        edited: confirmedAt({ ...edited, updatedAt: '2026-09-01T00:00:00.000Z' }, NOW - HOUR),
        recent: confirmedAt(recent, NOW - 5 * 60_000),
        done: confirmedAt(done, NOW - HOUR),
        undated: confirmedAt(undated, NOW - HOUR),
        theirs: confirmedAt(theirs, NOW - HOUR),
      },
    }
    expect(believedLive([live, edited, recent, done, undated, theirs, entry()], ledger, ME, NOW)).toEqual(['live'])
  })

  it('stamps the delete a second after this device confirmed the task, so a later edit still wins', () => {
    const t = task()
    const ledger: MirrorLedger = { v: 1, seen: { t1: confirmedAt(t, Date.parse('2026-09-10T11:00:00.000Z')) } }
    const deletions = outlookDeletions(ledger, ['t1', 'never-confirmed'])
    expect(deletions).toEqual([{ taskId: 't1', deleted: true, start: null, allDay: false, updated: '2026-09-10T11:00:01.000Z' }])
    // Planner's own rule (applyMirrorChanges) acts only on a change newer than the task
    expect(deletions[0].updated > t.updatedAt).toBe(true)
    expect(deletions[0].updated > '2026-09-10T11:30:00.000Z').toBe(false)
  })

  it('works for tasks the old cursor had already mirrored, too', () => {
    const t = task()
    const ledger = seedLedger([t], ME, '2026-09-11T00:00:00.000Z')
    expect(believedLive([t], ledger, ME, NOW)).toEqual(['t1'])
    expect(outlookDeletions(ledger, ['t1'])[0].updated > t.updatedAt).toBe(true)
  })

  it('reports what is missing, and trusts no mass disappearance', () => {
    expect(outlookMissing(['a', 'b', 'c'], new Set(['a', 'c']))).toEqual({ missing: ['b'], suspicious: false, absent: ['b'] })
    const live = Array.from({ length: 10 }, (_, i) => `t${i}`)
    expect(outlookMissing(live, new Set(['t0']))).toEqual({ missing: [], suspicious: true, absent: live.slice(1) })
    expect(outlookMissing([], [])).toEqual({ missing: [], suspicious: false, absent: [] })
  })
})

describe('a pull that finds another calendar, or cannot trust what it found', () => {
  let n = 0
  const ids = () => {
    n++
    return { key: `pull-ledger-${n}`, lock: `pull-lock-${n}` }
  }
  const confirmAll = (calendarId: string, sent: string[] = []) => async (records: Record<string, unknown>[]) => {
    sent.push(...records.map(r => String(r.id)))
    return { done: records.map(r => String(r.id)), calendarId }
  }

  it('owes everything again when the pull finds a Drafter calendar other than the one confirmed into', async () => {
    const items: Item[] = [task({ id: `a${n}` }), entry({ id: `b${n}` })]
    let pulled: PullOutcome = {}
    const t: PassTarget = { id: 'google', ...ids(), push: confirmAll('cal-1'), pull: async () => pulled }
    expect((await mirrorPass([t], items, {}, ME, { pull: true })).more).toBe(false)
    // the owner deleted it; the pull's own lookup made a new one
    pulled = { calendarId: 'cal-2' }
    expect((await mirrorPass([t], items, {}, ME, { pull: true })).more).toBe(true)
    const sent: string[] = []
    const next = await mirrorPass([{ ...t, push: confirmAll('cal-2', sent), pull: async () => ({}) }], items, {}, ME, { pull: false })
    expect(sent.sort()).toEqual(items.map(i => i.id).sort())
    expect(next.waiting).toBe(0)
  })

  it('writes back what a scan could not trust as deleted, and only that', async () => {
    const keep = task({ id: `keep${n}` })
    const absent = task({ id: `absent${n}` })
    let pulled: PullOutcome = {}
    const t: PassTarget = { id: 'acct', ...ids(), push: confirmAll('cal-1'), pull: async () => pulled }
    await mirrorPass([t], [keep, absent], {}, ME, { pull: true })
    pulled = { calendarId: 'cal-1', resend: [absent.id] }
    expect((await mirrorPass([t], [keep, absent], {}, ME, { pull: true })).more).toBe(true)
    const sent: string[] = []
    await mirrorPass([{ ...t, push: confirmAll('cal-1', sent), pull: async () => ({}) }], [keep, absent], {}, ME, { pull: false })
    expect(sent).toEqual([absent.id])
  })
})

describe('Graph listings are read to the end', () => {
  beforeEach(() => {
    vi.stubEnv('SUPABASE_URL', 'https://db.example.test')
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
    vi.stubEnv('MICROSOFT_CLIENT_ID', 'ms-client')
    vi.stubEnv('MICROSOFT_CLIENT_SECRET', 'ms-secret')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  /** Supabase holding one connected account, Microsoft's token endpoint, and Graph answering from `pages`. */
  function graphWorld(pages: [prefix: string, body: unknown][]) {
    const asked: string[] = []
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        asked.push(url)
        if (url.startsWith('https://db.example.test/rest/v1/user_settings'))
          return json([{ user_id: 'u-graph', microsoft_accounts: [{ id: 'acct', email: 'me@example.test', name: 'Me', refreshToken: 'r1', drafterCalendarId: 'cal-1' }] }])
        if (url.startsWith('https://login.microsoftonline.com/')) return json({ access_token: 'token', expires_in: 3600, refresh_token: 'r1' })
        for (const [prefix, body] of pages) if (url.startsWith(prefix)) return json(body)
        return json({ error: { message: `unexpected ${url}` } }, 404)
      }),
    )
    return asked
  }

  it('follows every page when listing which tasks the calendar holds', async () => {
    graphWorld([
      [
        'https://graph.microsoft.com/v1.0/me/calendars/cal-1/events',
        { value: [{ id: 'm1', singleValueExtendedProperties: [{ id: TASK_PROP, value: 't1' }] }, { id: 'm2' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/page-2' },
      ],
      ['https://graph.microsoft.com/v1.0/page-2', { value: [{ id: 'm3', singleValueExtendedProperties: [{ id: TASK_PROP, value: 't2' }] }] }],
    ])
    const { ids, complete } = await mirroredTaskIds('u-graph', 'acct', 'cal-1')
    expect([...ids].sort()).toEqual(['t1', 't2'])
    expect(complete).toBe(true)
  })

  it('reads entry edits across pages, and only entries', async () => {
    const e = entry()
    const asked = graphWorld([
      [
        'https://graph.microsoft.com/v1.0/me/calendars/cal-1/events',
        { value: [graphCopy(e, '2026-09-10T12:00:00Z', { subject: 'Dentist, later' }), { id: 'task-copy' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/page-2' },
      ],
      ['https://graph.microsoft.com/v1.0/page-2', { value: [graphCopy(allDay, '2026-09-10T12:00:00Z')] }],
    ])
    const rows = await pullEntryChanges('u-graph', 'acct', 'cal-1', '2026-09-09T00:00:00Z')
    expect(rows.map(r => [r.eventId, r.title])).toEqual([
      ['ev1', 'Dentist, later'],
      ['ev2', 'Dentist'],
    ])
    expect(asked.find(u => u.includes('/events?'))).toContain(encodeURIComponent('lastModifiedDateTime ge 2026-09-09T00:00:00Z'))
    expect(asked.find(u => u.includes('/events?'))).toContain(EVENT_PROP)
  })
})
