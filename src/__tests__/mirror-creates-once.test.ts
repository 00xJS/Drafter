import { afterEach, describe, expect, it, vi } from 'vitest'
import { base32hex, googleEventId, pushEntry as pushGoogleEntry, pushTask as pushGoogleTask } from '../../netlify/functions/lib/google.mjs'
import { graphTransactionId, pushEntry as pushOutlookEntry, pushTask as pushOutlookTask } from '../../netlify/functions/lib/microsoft.mjs'
import { type Answer, type SeenRequest, world } from './cal-world'

// Two devices could each find no copy of a record in Google or Outlook and
// each create one: the phone and the laptop sweeping the same new entry, or a
// create sent again after its answer was lost. A copy is now created under an
// id Google is given (the record's kind and id in base32hex), or with a
// transactionId Graph dedupes on, so the second create is refused and writes
// over the first. The two calendars below keep their events in memory and
// refuse a repeat the way the real services do.

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const task = (id: string, over: Record<string, unknown> = {}) => ({
  kind: 'task',
  id,
  title: 'Pay rent',
  description: '',
  status: 'todo',
  priority: 'normal',
  tags: [],
  dueAt: '2026-09-20T16:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-10T10:00:00.000Z',
  ...over,
})
const entry = (id: string, over: Record<string, unknown> = {}) => ({
  kind: 'event',
  id,
  title: 'Dentist',
  start: '2026-09-21T14:00:00.000Z',
  end: '2026-09-21T15:00:00.000Z',
  allDay: false,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-10T10:00:00.000Z',
  ...over,
})

type Event = Record<string, unknown> & { id: string; status?: string }

/** Google's events endpoint for one calendar: a client-chosen id is taken once, and a second create with it is a 409. */
function googleCalendar(opts: { afterLookup?: (events: Map<string, Event>) => void } = {}) {
  const events = new Map<string, Event>()
  const creates: Record<string, unknown>[] = []
  let made = 0
  const answer = (req: SeenRequest): Answer => {
    const url = new URL(req.url)
    const m = /\/calendars\/[^/]+\/events(?:\/([^/]+))?$/.exec(url.pathname)
    if (!m) return undefined
    const id = m[1] ? decodeURIComponent(m[1]) : null
    const body = (req.body ?? {}) as Record<string, unknown>
    if (req.method === 'GET' && !id) {
      const [key, value] = String(url.searchParams.get('privateExtendedProperty')).split('=')
      const items = [...events.values()].filter(e => (e.extendedProperties as { private: Record<string, string> }).private[key] === value)
      const answer = { body: { items: url.searchParams.get('showDeleted') === 'true' ? items : items.filter(e => e.status !== 'cancelled') } }
      opts.afterLookup?.(events)
      return answer
    }
    if (req.method === 'POST' && !id) {
      creates.push(body)
      const chosen = typeof body.id === 'string' ? body.id : `google-made-${++made}`
      if (events.has(chosen)) return { status: 409, body: { error: { code: 409, message: 'The requested identifier already exists.' } } }
      events.set(chosen, { ...body, id: chosen, status: 'confirmed', updated: '2026-09-10T10:00:01.000Z' })
      return { body: events.get(chosen) }
    }
    if (req.method === 'PATCH' && id) {
      const had = events.get(id)
      if (!had) return { status: 404, body: { error: { message: 'Not Found' } } }
      events.set(id, { ...had, ...body })
      return { body: events.get(id) }
    }
    return undefined
  }
  return { events, creates, answer }
}

function googleWorld(userId: string, cal: ReturnType<typeof googleCalendar>) {
  const w = world({ googleToken: () => ({ body: { access_token: 'tok', expires_in: 3600 } }), google: cal.answer })
  w.rows.set(userId, { user_id: userId, google_refresh_token: 'grant' })
  return w
}

describe('Google: a copy is created under an id of the record’s own', () => {
  it('base32hex is RFC 4648’s, lower case, and a record’s id is its kind and id in it', () => {
    expect(['f', 'fo', 'foo', 'foob', 'fooba', 'foobar'].map(base32hex)).toEqual(['co', 'cpng', 'cpnmu', 'cpnmuog', 'cpnmuoj1', 'cpnmuoj1e8'])
    const id = googleEventId('task', '0b6c1f9e-7d1a-4c55-9a51-3f0e6f1d2c11')
    expect(id).toMatch(/^[0-9a-v]{5,1024}$/)
    expect(googleEventId('event', '0b6c1f9e-7d1a-4c55-9a51-3f0e6f1d2c11')).not.toBe(id)
    expect(googleEventId('task', 'x'.repeat(700))).toBeNull()
  })

  it('a task’s first copy carries that id', async () => {
    const cal = googleCalendar()
    googleWorld('u-g-once', cal)
    expect(await pushGoogleTask('u-g-once', 'cal-1', task('t-once'), undefined, '', { tz: 'UTC' })).toBe('created')
    expect(cal.creates.map(c => c.id)).toEqual([googleEventId('task', 't-once')])
    expect([...cal.events.keys()]).toEqual([googleEventId('task', 't-once')])
  })

  it('when another device’s create lands between the lookup and this one, the 409 writes over it: one copy, not two', async () => {
    const theirs = googleEventId('task', 't-race')!
    const cal = googleCalendar({
      afterLookup: events => {
        if (!events.has(theirs)) events.set(theirs, { id: theirs, status: 'confirmed', summary: 'Pay rent (their version)', extendedProperties: { private: { drafter: '1', taskId: 't-race' } } })
      },
    })
    googleWorld('u-g-race', cal)
    expect(await pushGoogleTask('u-g-race', 'cal-1', task('t-race', { title: 'Pay the rent' }), undefined, '', { tz: 'UTC' })).toBe('updated')
    expect(cal.events.size).toBe(1)
    expect(cal.events.get(theirs)).toMatchObject({ summary: 'Pay the rent', status: 'confirmed' })
  })

  it('an entry the same way', async () => {
    const theirs = googleEventId('event', 'e-race')!
    const cal = googleCalendar({
      afterLookup: events => {
        if (!events.has(theirs)) events.set(theirs, { id: theirs, status: 'confirmed', summary: 'Dentist', extendedProperties: { private: { drafter: '1', eventId: 'e-race' } } })
      },
    })
    googleWorld('u-g-entry', cal)
    expect(await pushGoogleEntry('u-g-entry', 'cal-1', entry('e-race', { title: 'Dentist, moved' }), '')).toBe('updated')
    expect(cal.events.size).toBe(1)
    expect(cal.events.get(theirs)).toMatchObject({ summary: 'Dentist, moved' })
  })

  it('a task Drafter took off Google and reopened later comes back as the same event, confirmed again', async () => {
    const id = googleEventId('task', 't-back')!
    const cal = googleCalendar()
    // Drafter's own delete left the copy cancelled; the task was reopened after
    cal.events.set(id, { id, status: 'cancelled', updated: '2026-09-05T00:00:00.000Z', extendedProperties: { private: { drafter: '1', taskId: 't-back' } } })
    googleWorld('u-g-back', cal)
    expect(await pushGoogleTask('u-g-back', 'cal-1', task('t-back'), undefined, '', { tz: 'UTC' })).toBe('updated')
    expect(cal.events.size).toBe(1)
    expect(cal.events.get(id)).toMatchObject({ status: 'confirmed', summary: 'Pay rent' })
  })
})

/** Graph's events endpoint for one calendar: a transactionId seen before is a 409. */
function outlookCalendar(opts: { afterLookup?: (cal: { events: Map<string, Event>; used: Set<string> }) => void; forget?: boolean } = {}) {
  const events = new Map<string, Event>()
  const used = new Set<string>()
  const creates: Record<string, unknown>[] = []
  let made = 0
  const propValue = (e: Event) => ((e.singleValueExtendedProperties as { value: string }[] | undefined) ?? [])[0]?.value
  const answer = (req: SeenRequest): Answer => {
    const url = new URL(req.url)
    const m = /\/me\/calendars\/[^/]+\/events(?:\/([^/?]+))?$/.exec(url.pathname)
    if (!m) return undefined
    const id = m[1] ? decodeURIComponent(m[1]) : null
    const body = (req.body ?? {}) as Record<string, unknown>
    if (req.method === 'GET' && !id) {
      const wanted = /ep\/value eq '([^']*)'/.exec(url.searchParams.get('$filter') ?? '')?.[1]
      const value = [...events.values()].filter(e => propValue(e) === wanted).map(e => ({ id: e.id }))
      opts.afterLookup?.({ events, used })
      return { body: { value } }
    }
    if (req.method === 'POST' && !id) {
      creates.push(body)
      const tx = typeof body.transactionId === 'string' ? body.transactionId : null
      if (tx && used.has(tx)) return { status: 409, body: { error: { code: 'ErrorDuplicateTransactionId', message: 'The transaction ID is already in use.' } } }
      if (tx) used.add(tx)
      const made_ = `outlook-${++made}`
      events.set(made_, { ...body, id: made_ })
      return { status: 201, body: events.get(made_) }
    }
    if (req.method === 'PATCH' && id) {
      const had = events.get(id)
      if (!had) return { status: 404, body: { error: { message: 'Not found' } } }
      events.set(id, { ...had, ...body })
      return { body: events.get(id) }
    }
    return undefined
  }
  return { events, used, creates, answer }
}

function outlookWorld(userId: string, cal: ReturnType<typeof outlookCalendar>) {
  const w = world({ msToken: () => ({ body: { access_token: 'tok', expires_in: 3600, refresh_token: 'r1' } }), graph: cal.answer })
  w.rows.set(userId, { user_id: userId, microsoft_accounts: [{ id: 'acct', email: 'me@example.test', refreshToken: 'r1', drafterCalendarId: 'cal-1' }] })
  return w
}

const TASK_PROP = 'String {66f5a359-4659-4830-9070-00047ec6ac6e} Name drafterTaskId'
const EVENT_PROP = 'String {66f5a359-4659-4830-9070-00047ec6ac6e} Name drafterEventId'

describe('Outlook: a copy is created with a transactionId Graph dedupes on', () => {
  it('names the record and the version it writes, in a GUID’s shape', () => {
    const a = graphTransactionId('task', { id: 't1', updatedAt: '2026-09-10T10:00:00.000Z' })
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    // two devices writing the same version send the same one…
    expect(graphTransactionId('task', { id: 't1', updatedAt: '2026-09-10T10:00:00.000Z' })).toBe(a)
    // …and a later version, or the same id as an entry, another
    expect(graphTransactionId('task', { id: 't1', updatedAt: '2026-09-11T10:00:00.000Z' })).not.toBe(a)
    expect(graphTransactionId('event', { id: 't1', updatedAt: '2026-09-10T10:00:00.000Z' })).not.toBe(a)
  })

  it('a task’s first copy carries it', async () => {
    const cal = outlookCalendar()
    outlookWorld('u-m-once', cal)
    const t = task('t-once')
    expect(await pushOutlookTask('u-m-once', 'acct', 'cal-1', t, undefined, '', { tz: 'UTC' })).toBe('created')
    expect(cal.creates.map(c => c.transactionId)).toEqual([graphTransactionId('task', t)])
  })

  it('when another device created the same version between the lookup and this create, the 409 finds its copy and writes over it', async () => {
    const t = task('t-race', { title: 'Pay the rent' })
    const cal = outlookCalendar({
      afterLookup: ({ events, used }) => {
        if (events.size) return
        events.set('theirs', { id: 'theirs', subject: 'Pay rent', singleValueExtendedProperties: [{ id: TASK_PROP, value: 't-race' }] })
        used.add(graphTransactionId('task', t))
      },
    })
    outlookWorld('u-m-race', cal)
    expect(await pushOutlookTask('u-m-race', 'acct', 'cal-1', t, undefined, '', { tz: 'UTC' })).toBe('updated')
    expect(cal.events.size).toBe(1)
    expect(cal.events.get('theirs')).toMatchObject({ subject: 'Pay the rent' })
    // the update never tries to change the transactionId, which Graph refuses
    expect(cal.events.get('theirs')).not.toHaveProperty('transactionId')
  })

  it('an entry the same way', async () => {
    const e = entry('e-race', { title: 'Dentist, moved' })
    const cal = outlookCalendar({
      afterLookup: ({ events, used }) => {
        if (events.size) return
        events.set('theirs', { id: 'theirs', subject: 'Dentist', singleValueExtendedProperties: [{ id: EVENT_PROP, value: 'e-race' }] })
        used.add(graphTransactionId('event', e))
      },
    })
    outlookWorld('u-m-entry', cal)
    expect(await pushOutlookEntry('u-m-entry', 'acct', 'cal-1', e, '')).toBe('updated')
    expect(cal.events.size).toBe(1)
    expect(cal.events.get('theirs')).toMatchObject({ subject: 'Dentist, moved' })
  })

  it('a transactionId Outlook still remembers for a copy that is gone creates once more without it', async () => {
    const t = task('t-gone')
    const cal = outlookCalendar()
    cal.used.add(graphTransactionId('task', t))
    outlookWorld('u-m-gone', cal)
    expect(await pushOutlookTask('u-m-gone', 'acct', 'cal-1', t, undefined, '', { tz: 'UTC' })).toBe('created')
    expect(cal.events.size).toBe(1)
    expect(cal.creates.map(c => 'transactionId' in c)).toEqual([true, false])
  })
})
