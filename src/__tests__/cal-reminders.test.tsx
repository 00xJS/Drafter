import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COPY_REMINDERS_KEY, copyRemindersOn, setCopyReminders } from '../calendars'
import { CopyReminders } from '../components/settings/Reminders'
import { world } from './cal-world'

// The owner decided that Drafter alone sends reminders, as 1E's calendar-parity
// write-up recommended: every copy the mirrors write into Google and into every
// Outlook account carries no reminder of its own, and "Calendar copies remind
// me too" (Settings → Reminders, off by default) brings each calendar's own
// back. The switch is the account's, kept in its sign-in metadata, so the
// functions read it with the session. These run the real functions with it
// off and on, and pin the key the app writes to the one the functions read.
// Existing copies are corrected as they are next written: nothing here
// rewrites a calendar in bulk.

const auth = vi.hoisted(() => ({ meta: {} as Record<string, unknown>, updates: [] as unknown[] }))
vi.mock('../supabase', async importOriginal => ({
  ...(await importOriginal<typeof import('../supabase')>()),
  getSupabase: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'u-app', user_metadata: auth.meta } }, error: null }),
      updateUser: async (attrs: { data: Record<string, unknown> }) => {
        auth.updates.push(attrs)
        auth.meta = { ...auth.meta, ...attrs.data }
        return { data: {}, error: null }
      },
    },
  }),
}))

// Resolved at run time, not by tsc: a .d.mts beside a function would ship as a function.
const GOOGLE_FUNCTION = '../../netlify/functions/google.mjs'
const MICROSOFT_FUNCTION = '../../netlify/functions/microsoft.mjs'
const SITE = 'https://drafterz.netlify.app'
const TASK_PROP = 'String {66f5a359-4659-4830-9070-00047ec6ac6e} Name drafterTaskId'
const EVENT_PROP = 'String {66f5a359-4659-4830-9070-00047ec6ac6e} Name drafterEventId'

type Handler = (req: Request) => Promise<Response>
const load = async (path: string) => (await import(/* @vite-ignore */ path)).default as Handler
const call = (handler: Handler, path: string, token: string, body: Record<string, unknown>) =>
  handler(new Request(`${SITE}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const task = { kind: 'task', id: 't1', title: 'Pay rent', description: '', status: 'todo', priority: 'normal', dueAt: '2026-09-20T13:00:00.000Z', updatedAt: '2026-09-14T10:00:00.000Z' }
const allDayTask = { ...task, id: 't2', dueAt: '2026-09-20T23:00:00.000Z' }
const event = { kind: 'event', id: 'ev1', title: 'Dentist', start: '2026-09-21T14:00:00.000Z', end: '2026-09-21T15:00:00.000Z', allDay: false, updatedAt: '2026-09-14T10:00:00.000Z' }
const SILENT = { useDefault: false, overrides: [] }
const THEIRS = { useDefault: true, overrides: [] }

/** A Google account whose Drafter calendar holds nothing yet, for one signed-in user. */
function google(userId: string, meta?: Record<string, unknown>) {
  const w = world({
    sessions: { [`s-${userId}`]: { id: userId, email: 'me@example.test', ...(meta ? { user_metadata: meta } : {}) } },
    googleToken: () => ({ body: { access_token: 'token', expires_in: 3600 } }),
    google: req => {
      const path = new URL(req.url).pathname
      if (req.method === 'GET' && path.endsWith('/calendars/cal-g')) return { body: { id: 'cal-g' } }
      if (req.method === 'GET' && path.endsWith('/events')) return { body: { items: [] } }
      if (req.method === 'POST' && path.endsWith('/events')) return { body: { id: 'made' } }
      return undefined
    },
  })
  w.rows.set(userId, { user_id: userId, google_refresh_token: 'grant', google_drafter_calendar_id: 'cal-g', timezone: 'Europe/London' })
  const written = () => w.seen.filter(r => r.method === 'POST' && r.url.includes('/events')).map(r => r.body as Record<string, unknown>)
  return { ...w, token: `s-${userId}`, written }
}

/** Two Outlook accounts, work and home, each with an empty Drafter calendar, for one signed-in user. */
function outlook(userId: string, meta?: Record<string, unknown>) {
  const w = world({
    sessions: { [`s-${userId}`]: { id: userId, email: 'me@example.test', ...(meta ? { user_metadata: meta } : {}) } },
    msToken: () => ({ body: { access_token: 'token', expires_in: 3600, refresh_token: 'r1' } }),
    graph: req => {
      const path = new URL(req.url).pathname
      if (req.method === 'GET' && /\/me\/calendars\/cal-[a-z]+$/.test(path)) return { body: { id: path.split('/').pop() } }
      if (req.method === 'GET' && path.endsWith('/events')) return { body: { value: [] } }
      if (req.method === 'POST' && path.endsWith('/events')) return { body: { id: 'made' } }
      return undefined
    },
  })
  w.rows.set(userId, {
    user_id: userId,
    timezone: 'Europe/London',
    microsoft_accounts: [
      { id: 'work', email: 'work@example.test', name: 'Work', refreshToken: 'r1', drafterCalendarId: 'cal-work' },
      { id: 'home', email: 'home@example.test', name: 'Home', refreshToken: 'r1', drafterCalendarId: 'cal-home' },
    ],
  })
  const written = () => w.seen.filter(r => r.method === 'POST' && r.url.includes('/events')).map(r => ({ calendar: r.url.split('/calendars/')[1]?.split('/')[0], body: r.body as Record<string, unknown> }))
  return { ...w, token: `s-${userId}`, written }
}

describe('Google: every copy Drafter writes is silent', () => {
  it('a sweep writes its task copies, timed and all-day, and its event copies with no reminder of their own', async () => {
    const g = google('u-remind-g1')
    const res = await call(await load(GOOGLE_FUNCTION), '/api/google', g.token, { action: 'push', records: [task, allDayTask, event], projects: {}, timezone: 'Europe/London' })
    expect(res.status).toBe(200)
    expect((await res.json()).done).toEqual(['t1', 't2', 'ev1'])
    expect(g.written().map(b => b.reminders)).toEqual([SILENT, SILENT, SILENT])
  })

  it('so does an event written the moment it is saved', async () => {
    const g = google('u-remind-g2')
    const res = await call(await load(GOOGLE_FUNCTION), '/api/google', g.token, { action: 'push-event', event })
    expect(res.status).toBe(200)
    expect(g.written().map(b => b.reminders)).toEqual([SILENT])
  })

  it('with “Calendar copies remind me too” on, the calendar’s own reminders come back', async () => {
    const g = google('u-remind-g3', { [COPY_REMINDERS_KEY]: true })
    const fn = await load(GOOGLE_FUNCTION)
    await call(fn, '/api/google', g.token, { action: 'push', records: [task, event], projects: {}, timezone: 'Europe/London' })
    await call(fn, '/api/google', g.token, { action: 'push-event', event: { ...event, id: 'ev2' } })
    expect(g.written().map(b => b.reminders)).toEqual([THEIRS, THEIRS, THEIRS])
  })

  it('only a true switch counts: any other value in the metadata is off', async () => {
    const g = google('u-remind-g4', { [COPY_REMINDERS_KEY]: 'yes' })
    await call(await load(GOOGLE_FUNCTION), '/api/google', g.token, { action: 'push', records: [task], projects: {}, timezone: 'Europe/London' })
    expect(g.written().map(b => b.reminders)).toEqual([SILENT])
  })
})

describe('Outlook: every copy, in every account, is silent', () => {
  it('both accounts get their task and event copies with the reminder off', async () => {
    const o = outlook('u-remind-m1')
    const fn = await load(MICROSOFT_FUNCTION)
    for (const accountId of ['work', 'home']) {
      const res = await call(fn, '/api/microsoft', o.token, { action: 'push', accountId, records: [task, event], projects: {}, timezone: 'Europe/London' })
      expect(res.status).toBe(200)
    }
    await call(fn, '/api/microsoft', o.token, { action: 'push-event', accountId: 'home', event: { ...event, id: 'ev2' } })
    expect(o.written().map(w => [w.calendar, w.body.isReminderOn])).toEqual([
      ['cal-work', false],
      ['cal-work', false],
      ['cal-home', false],
      ['cal-home', false],
      ['cal-home', false],
    ])
  })

  it('with the switch on, Outlook’s own reminder comes back in every account', async () => {
    const o = outlook('u-remind-m2', { [COPY_REMINDERS_KEY]: true })
    const fn = await load(MICROSOFT_FUNCTION)
    for (const accountId of ['work', 'home']) await call(fn, '/api/microsoft', o.token, { action: 'push', accountId, records: [task, event], projects: {}, timezone: 'Europe/London' })
    expect(o.written().map(w => w.body.isReminderOn)).toEqual([true, true, true, true])
  })
})

describe('the switch in Settings → Reminders', () => {
  it('is kept on the account under the key the functions read', async () => {
    auth.meta = {}
    auth.updates = []
    expect(await copyRemindersOn()).toBe(false)
    await setCopyReminders(true)
    expect(auth.updates).toEqual([{ data: { calendar_copies_remind: true } }])
    expect(await copyRemindersOn()).toBe(true)
    await setCopyReminders(false)
    expect(await copyRemindersOn()).toBe(false)
  })

  it('shows off by default, and waits until the account has answered', () => {
    const off = renderToStaticMarkup(<CopyReminders on={false} busy={false} onChange={() => {}} />)
    expect(off).toContain('Calendar copies remind me too')
    expect(off).not.toContain('checked')
    expect(off).not.toContain('disabled')
    expect(renderToStaticMarkup(<CopyReminders on={null} busy={false} onChange={() => {}} />)).toContain('disabled')
    expect(renderToStaticMarkup(<CopyReminders on={true} busy={false} onChange={() => {}} />)).toContain('checked')
    expect(renderToStaticMarkup(<CopyReminders on={false} busy={false} error="Offline" onChange={() => {}} />)).toContain('Offline')
  })
})

describe('Outlook: an entry deleted there is found the way a task is', () => {
  /** An account whose Drafter calendar holds task t1 and entry ev2, and nothing changed since the last pull. */
  function holding(userId: string, entries: string[] = ['ev2']) {
    const w = world({
      sessions: { [`s-${userId}`]: { id: userId, email: 'me@example.test' } },
      msToken: () => ({ body: { access_token: 'token', expires_in: 3600, refresh_token: 'r1' } }),
      graph: req => {
        const u = new URL(req.url)
        const q = decodeURIComponent(u.search)
        if (req.method === 'GET' && u.pathname.endsWith('/me/calendars/cal-1')) return { body: { id: 'cal-1' } }
        if (!u.pathname.endsWith('/events')) return undefined
        if (q.includes('lastModifiedDateTime')) return { body: { value: [] } }
        if (q.includes('drafterTaskId')) return { body: { value: [{ id: 'm1', singleValueExtendedProperties: [{ id: TASK_PROP, value: 't1' }] }] } }
        if (q.includes('drafterEventId')) return { body: { value: entries.map(id => ({ id: `m-${id}`, singleValueExtendedProperties: [{ id: EVENT_PROP, value: id }] })) } }
        return undefined
      },
    })
    w.rows.set(userId, { user_id: userId, microsoft_accounts: [{ id: 'acct', email: 'me@example.test', name: 'Me', refreshToken: 'r1', drafterCalendarId: 'cal-1' }] })
    return { ...w, token: `s-${userId}` }
  }
  const pull = async (token: string, extra: Record<string, unknown>) =>
    (await call(await load(MICROSOFT_FUNCTION), '/api/microsoft', token, { action: 'pull', accountId: 'acct', since: '2026-09-14T00:00:00.000Z', entries: true, calendarId: 'cal-1', ...extra })).json()

  it('the pull names the entries the calendar no longer holds, apart from the tasks', async () => {
    const w = holding('u-scan-1')
    expect(await pull(w.token, { live: ['t1'], liveEntries: ['ev1', 'ev2'] })).toMatchObject({ missing: [], missingEntries: ['ev1'], resend: [], calendarId: 'cal-1' })
  })

  it('nothing is judged about a calendar the app’s belief is not about', async () => {
    const w = holding('u-scan-2')
    expect(await pull(w.token, { live: ['t1'], liveEntries: ['ev1', 'ev2'], calendarId: 'cal-old' })).toMatchObject({ missing: [], missingEntries: [], resend: [] })
  })

  it('a mass disappearance is written back rather than put in the Trash', async () => {
    const w = holding('u-scan-3', ['e0'])
    const live = Array.from({ length: 10 }, (_, i) => `e${i}`)
    expect(await pull(w.token, { liveEntries: live })).toMatchObject({ missingEntries: [], resend: live.slice(1) })
  })
})
