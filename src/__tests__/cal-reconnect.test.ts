import { afterEach, describe, expect, it, vi } from 'vitest'
import { DRAFTER_DESCRIPTION, gapi, pickDrafterCalendar, reconnectPatch, resolveDrafterCalendar } from '../../netlify/functions/lib/google.mjs'
import { graph, resolveDrafterCalendar as resolveOutlookCalendar } from '../../netlify/functions/lib/microsoft.mjs'
import { type PassTarget, mirrorPass } from '../calendars'
import type { Task } from '../types'
import { world } from './cal-world'

// Reconnects went wrong three ways. A Google reconnect could mint a second
// "Drafter" calendar: the lookup went by display name, skipped hidden
// calendars, and two requests racing after a reconnect each made one. A warm
// function kept a revoked token for up to an hour. And a Drafter calendar the
// owner deleted was quietly recreated empty. These pin the lookup, the token
// cache and the "replaced" signal; the app side (refill, and say so) is at the end.

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('pickDrafterCalendar: which calendar is Drafter’s', () => {
  const cal = (id: string, over: Record<string, unknown> = {}) => ({ id, summary: 'Drafter', accessRole: 'owner', ...over })

  it('finds it hidden, or renamed for display, by its real title', () => {
    expect(pickDrafterCalendar([cal('a', { hidden: true })], null)).toBe('a')
    expect(pickDrafterCalendar([cal('b', { summaryOverride: 'Work tasks' })], null)).toBe('b')
  })

  it('finds one retitled in Google by the description Drafter gave it', () => {
    expect(pickDrafterCalendar([cal('c', { summary: 'My tasks', description: DRAFTER_DESCRIPTION })], null)).toBe('c')
  })

  it('never takes a calendar someone else owns, one that is not Drafter’s, or a deleted one', () => {
    expect(pickDrafterCalendar([cal('d', { accessRole: 'writer' }), { id: 'e', summary: 'Family', accessRole: 'owner' }, cal('f', { deleted: true })], null)).toBeNull()
  })

  it('keeps the stored one, and otherwise lands on the same one every time', () => {
    expect(pickDrafterCalendar([cal('z'), cal('m')], 'z')).toBe('z')
    expect(pickDrafterCalendar([cal('z'), cal('m')], null)).toBe('m')
    expect(pickDrafterCalendar([cal('m'), cal('z')], 'gone')).toBe('m')
  })
})

describe('Google: the Drafter calendar across reconnects', () => {
  function google(userId: string, row: Record<string, unknown>, calendars: unknown[], gone?: string) {
    let made = 0
    const w = world({
      googleToken: () => ({ body: { access_token: 'token', expires_in: 3600 } }),
      google: req => {
        const path = new URL(req.url).pathname
        if (gone && req.method === 'GET' && path.endsWith(`/calendars/${gone}`)) return { status: 404, body: { error: { message: 'Not Found' } } }
        if (req.method === 'GET' && path.includes('/users/me/calendarList')) return { body: { items: calendars } }
        if (req.method === 'GET' && /\/calendars\/[^/]+$/.test(path)) return { body: { id: path.split('/').pop() } }
        if (req.method === 'POST' && path.endsWith('/calendars')) return { body: { id: `made-${++made}` } }
        return undefined
      },
    })
    w.rows.set(userId, { user_id: userId, google_refresh_token: 'grant', ...row })
    return { ...w, made: () => made }
  }

  it('uses the stored calendar while it exists, without listing anything', async () => {
    const w = google('u-g-alive', { google_drafter_calendar_id: 'stored-1' }, [])
    expect(await resolveDrafterCalendar('u-g-alive')).toEqual({ id: 'stored-1', replaced: false, created: false })
    expect(w.seen.some(r => r.url.includes('calendarList'))).toBe(false)
  })

  it('a reconnect finds the existing calendar — hidden, renamed — instead of making a second', async () => {
    const w = google('u-g-hidden', { google_drafter_calendar_id: null }, [
      { id: 'primary', summary: 'me@example.test', accessRole: 'owner', primary: true },
      { id: 'drafter-1', summary: 'Drafter', summaryOverride: 'Work tasks', hidden: true, accessRole: 'owner' },
    ])
    expect(await resolveDrafterCalendar('u-g-hidden')).toEqual({ id: 'drafter-1', replaced: false, created: false })
    expect(w.made()).toBe(0)
    expect(w.rows.get('u-g-hidden')?.google_drafter_calendar_id).toBe('drafter-1')
    expect(w.seen.find(r => r.url.includes('calendarList'))?.url).toContain('showHidden=true')
  })

  it('two requests racing after a reconnect share one lookup: one calendar, not two', async () => {
    const w = google('u-g-race', {}, [])
    const [a, b] = await Promise.all([resolveDrafterCalendar('u-g-race'), resolveDrafterCalendar('u-g-race')])
    expect([a.id, b.id]).toEqual(['made-1', 'made-1'])
    expect(w.made()).toBe(1)
  })

  it('a deleted calendar is replaced, and the reply says so', async () => {
    const w = google('u-g-deleted', { google_drafter_calendar_id: 'gone-1' }, [], 'gone-1')
    expect(await resolveDrafterCalendar('u-g-deleted')).toEqual({ id: 'made-1', replaced: true, created: true })
    expect(w.seen.find(r => r.method === 'POST' && r.url.endsWith('/calendars'))?.body).toMatchObject({ summary: 'Drafter', description: DRAFTER_DESCRIPTION })
  })

  it('the same account coming back keeps its calendar; another account starts from its own', () => {
    expect(reconnectPatch({ google_email: 'me@example.test' }, 'grant-2', 'me@example.test')).toEqual({ google_refresh_token: 'grant-2', google_email: 'me@example.test' })
    expect(reconnectPatch({ google_email: 'me@example.test' }, 'grant-2', 'other@example.test')).toMatchObject({ google_drafter_calendar_id: null })
    // no email read back: nothing proves it is the same account
    expect(reconnectPatch({ google_email: 'me@example.test' }, 'grant-2', '')).toMatchObject({ google_drafter_calendar_id: null })
  })
})

describe('a token the provider refuses is dropped at once', () => {
  it('Google: dropped, and the call made once more with a fresh one', async () => {
    let issued = 0
    const w = world({
      googleToken: () => ({ body: { access_token: `tok-${++issued}`, expires_in: 3600 } }),
      google: req => (req.auth === 'Bearer tok-1' ? { status: 401, body: { error: { message: 'Invalid Credentials' } } } : { body: { items: [] } }),
    })
    w.rows.set('u-g-401', { user_id: 'u-g-401', google_refresh_token: 'grant' })
    expect(await gapi('u-g-401', '/users/me/calendarList')).toEqual({ items: [] })
    expect(issued).toBe(2)
  })

  it('Google: a revoked grant says reconnect, and the dead token is never tried again', async () => {
    let revoked = false
    let refreshes = 0
    const w = world({
      googleToken: () => {
        refreshes++
        return revoked ? { status: 400, body: { error: 'invalid_grant' } } : { body: { access_token: 'tok-live', expires_in: 3600 } }
      },
      google: () => (revoked ? { status: 401, body: { error: { message: 'Invalid Credentials' } } } : { body: { items: [] } }),
    })
    w.rows.set('u-g-revoked', { user_id: 'u-g-revoked', google_refresh_token: 'grant' })
    await gapi('u-g-revoked', '/users/me/calendarList')
    revoked = true
    await expect(gapi('u-g-revoked', '/users/me/calendarList')).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/reconnect/) })
    await expect(gapi('u-g-revoked', '/users/me/calendarList')).rejects.toMatchObject({ status: 409 })
    // before: the cached token was sent for up to an hour after the revoke
    expect(refreshes).toBe(3)
    expect(w.seen.filter(r => r.url.includes('calendarList'))).toHaveLength(2)
  })

  it('Google: a token from a grant replaced since is dropped the next time settings are read', async () => {
    const u = 'u-g-grant'
    let issued = 0
    const w = world({
      googleToken: form => ({ body: { access_token: `tok-${form.get('refresh_token')}-${++issued}`, expires_in: 3600 } }),
      google: req => (req.url.includes('/calendars/cal-1') ? { body: { id: 'cal-1' } } : undefined),
    })
    w.rows.set(u, { user_id: u, google_refresh_token: 'grant-A', google_drafter_calendar_id: 'cal-1' })
    await resolveDrafterCalendar(u)
    // reconnected, with the callback served by another warm instance
    w.rows.set(u, { ...w.rows.get(u), google_refresh_token: 'grant-B' })
    await resolveDrafterCalendar(u)
    expect(w.seen.filter(r => r.url.includes('/calendars/cal-1')).map(r => r.auth)).toEqual(['Bearer tok-grant-A-1', 'Bearer tok-grant-B-2'])
  })

  it('Outlook: dropped, and the call made once more with a fresh one', async () => {
    let issued = 0
    const w = world({
      msToken: () => ({ body: { access_token: `ms-${++issued}`, expires_in: 3600, refresh_token: 'r1' } }),
      graph: req => (req.auth === 'Bearer ms-1' ? { status: 401, body: { error: { message: 'InvalidAuthenticationToken' } } } : { body: { value: [] } }),
    })
    w.rows.set('u-m-401', { user_id: 'u-m-401', microsoft_accounts: [{ id: 'acct', email: 'me@example.test', refreshToken: 'r1', drafterCalendarId: null }] })
    expect(await graph('u-m-401', 'acct', '/me/calendars')).toEqual({ value: [] })
    expect(issued).toBe(2)
  })
})

describe('Outlook: the Drafter calendar', () => {
  function outlook(userId: string, drafterCalendarId: string | null) {
    let made = 0
    const w = world({
      msToken: () => ({ body: { access_token: 'tok', expires_in: 3600, refresh_token: 'r2' } }),
      graph: req => {
        if (req.method === 'GET' && req.url.includes('/me/calendars/gone')) return { status: 404, body: { error: { message: 'Not found' } } }
        if (req.method === 'GET' && req.url.includes('/me/calendars?')) return { body: { value: [{ id: 'cal-a', name: 'Calendar', canEdit: true, isDefaultCalendar: true }] } }
        if (req.method === 'POST' && req.url.endsWith('/me/calendars')) return { body: { id: `new-${++made}` } }
        return undefined
      },
    })
    w.rows.set(userId, { user_id: userId, microsoft_accounts: [{ id: 'acct', email: 'me@example.test', name: 'Me', refreshToken: 'r1', drafterCalendarId }] })
    return { ...w, made: () => made }
  }

  it('a replaced calendar keeps the refresh token Microsoft rotated during the lookup', async () => {
    const w = outlook('u-m-rotate', 'gone')
    expect(await resolveOutlookCalendar('u-m-rotate', 'acct')).toEqual({ id: 'new-1', replaced: true, created: true })
    // before: the account list read at the start was written back, undoing r1 -> r2
    expect(w.rows.get('u-m-rotate')?.microsoft_accounts).toEqual([{ id: 'acct', email: 'me@example.test', name: 'Me', refreshToken: 'r2', drafterCalendarId: 'new-1' }])
  })

  it('two lookups at once make at most one calendar', async () => {
    const w = outlook('u-m-race', null)
    const [a, b] = await Promise.all([resolveOutlookCalendar('u-m-race', 'acct'), resolveOutlookCalendar('u-m-race', 'acct')])
    expect([a.id, b.id]).toEqual(['new-1', 'new-1'])
    expect(w.made()).toBe(1)
  })
})

describe('the app refills a replaced calendar, and says so', () => {
  const task = (id: string): Task => ({
    kind: 'task',
    id,
    title: 'Pay rent',
    description: '',
    status: 'todo',
    priority: 'normal',
    dueAt: '2026-09-20T09:00:00.000Z',
    tags: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-10T10:00:00.000Z',
    ownerId: 'me',
  })

  it('says the calendar had been deleted and is being filled again', async () => {
    const t: PassTarget = {
      id: 'google',
      key: 'notice-ledger-1',
      lock: 'notice-lock-1',
      push: async records => ({ done: records.map(r => String(r.id)), calendarId: 'cal-2', replaced: true }),
      pull: async () => ({}),
    }
    const pass = await mirrorPass([t], [task('n1')], {}, 'me', { pull: false })
    expect(pass.notices.google).toMatch(/Drafter calendar in Google had been deleted, so a new one was made/)
  })

  it('names a move to another calendar that a pull found', async () => {
    let calendarId = 'cal-1'
    const t: PassTarget = {
      id: 'acct-9',
      key: 'notice-ledger-2',
      lock: 'notice-lock-2',
      push: async records => ({ done: records.map(r => String(r.id)), calendarId }),
      pull: async () => ({ calendarId }),
    }
    expect((await mirrorPass([t], [task('n2')], {}, 'me', { pull: true })).notices).toEqual({})
    calendarId = 'cal-9'
    const pass = await mirrorPass([t], [task('n2')], {}, 'me', { pull: true })
    expect(pass.notices['acct-9']).toMatch(/different Drafter calendar in this Outlook account/)
    expect(pass.more).toBe(true)
  })
})
