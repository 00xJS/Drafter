import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gapi, googleNeedsSignIn, reconnectPatch } from '../../netlify/functions/lib/google.mjs'
import { accessToken as outlookToken, connectAccount, listAccounts, publicAccount } from '../../netlify/functions/lib/microsoft.mjs'
import { signInLine } from '../../netlify/functions/lib/signins.mjs'
import { type GoogleStatus, type PassTarget, mirrorPass } from '../calendars'
import { SIGN_IN_PROBE_MS, clearMirrorSignIn, dismissSignIn, passTargetsFor, readSignIn, readSignInDismissed, settleSignIns, signInBanner } from '../calendarstate'
import { openingGroup } from '../components/Settings'
import { GoogleCalendar } from '../components/settings/GoogleCalendar'
import type { SettingsCtx } from '../components/settings/context'
import { CalendarSignInBanner } from '../components/Today'
import type { Task } from '../types'
import { world } from './cal-world'
import { settled } from './rendered'

// A Google or Outlook sign-in that was revoked or ran out stopped the calendar
// mirror in silence: every pass retried it, backing off to every half hour
// forever, and only Settings said why. Now the server lets the dead grant go
// and keeps the account's address (the record the morning digest reads), the
// app stops asking until the account is signed in again, and Today says so
// once a streak, with the way to Settings → Calendars.

// Resolved at run time, not by tsc: a .d.mts beside a function would ship as a function.
const GOOGLE_FUNCTION = '../../netlify/functions/google.mjs'

function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: k => m.get(k) ?? null,
    key: i => [...m.keys()][i] ?? null,
    removeItem: k => {
      m.delete(k)
    },
    setItem: (k, v) => {
      m.set(k, String(v))
    },
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

// ---- the server ------------------------------------------------------------------

describe('Google refuses the grant: let go, said, and never offered again', () => {
  const dead = () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } })

  it('lets the grant go, keeps the address and the Drafter calendar, and refuses at once after that', async () => {
    let refreshes = 0
    const w = world({
      googleToken: () => {
        refreshes++
        return dead()
      },
      google: () => ({ body: { items: [] } }),
    })
    w.rows.set('u-dead', { user_id: 'u-dead', google_refresh_token: 'grant', google_email: 'me@gmail.com', google_drafter_calendar_id: 'cal-1' })
    await expect(gapi('u-dead', '/users/me/calendarList')).rejects.toMatchObject({ status: 409, reason: 'reauth', message: 'Google Calendar needs you to sign in again.' })
    expect(w.rows.get('u-dead')).toMatchObject({ google_refresh_token: null, google_email: 'me@gmail.com', google_drafter_calendar_id: 'cal-1' })
    expect(googleNeedsSignIn(w.rows.get('u-dead'))).toBe(true)
    // no second ask of Google with a grant it refused
    await expect(gapi('u-dead', '/users/me/calendarList')).rejects.toMatchObject({ reason: 'reauth' })
    expect(refreshes).toBe(1)
    expect(w.seen.filter(r => r.url.includes('/calendar/v3/'))).toEqual([])
  })

  it('knows an account connected without its address read back by the Drafter calendar it mirrors into', () => {
    expect(googleNeedsSignIn({ google_email: '', google_refresh_token: null, google_drafter_calendar_id: 'cal-1' })).toBe(true)
    // disconnected: all three cleared, nothing to sign back into
    expect(googleNeedsSignIn({ google_email: null, google_refresh_token: null, google_drafter_calendar_id: null })).toBe(false)
  })

  it('never lets go of a grant a reconnect stored while the old one was being refused', async () => {
    const w = world({
      googleToken: () => {
        // the reconnect lands on another instance while this refresh is out
        w.rows.set('u-swap', { ...w.rows.get('u-swap'), google_refresh_token: 'grant-new' })
        return dead()
      },
    })
    w.rows.set('u-swap', { user_id: 'u-swap', google_refresh_token: 'grant-old', google_email: 'me@gmail.com' })
    await expect(gapi('u-swap', '/users/me/calendarList')).rejects.toMatchObject({ reason: 'reauth' })
    expect(w.rows.get('u-swap')?.google_refresh_token).toBe('grant-new')
  })

  it('Settings hears it needs signing in; a mirror push hears why, with the reason; a reconnect ends it', async () => {
    const w = world({ sessions: { 'session-1': { id: 'u-status', email: 'me@example.test' } }, googleToken: dead })
    w.rows.set('u-status', { user_id: 'u-status', google_refresh_token: 'grant', google_email: 'me@gmail.com', google_drafter_calendar_id: 'cal-1' })
    const handler = (await import(/* @vite-ignore */ GOOGLE_FUNCTION)).default as (req: Request) => Promise<Response>
    const ask = (body: Record<string, unknown>) =>
      handler(new Request('https://drafterz.netlify.app/api/google', { method: 'POST', headers: { authorization: 'Bearer session-1', 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    const push = await ask({ action: 'push', records: [], projects: {} })
    expect(push.status).toBe(409)
    expect(await push.json()).toEqual({ error: 'Google Calendar needs you to sign in again.', reason: 'reauth' })
    expect(await (await ask({ action: 'status' })).json()).toMatchObject({ connected: false, email: 'me@gmail.com', needsSignIn: true })
    // the same account signed in again: a grant, the same calendar, nothing to say
    w.rows.set('u-status', { ...w.rows.get('u-status'), ...reconnectPatch(w.rows.get('u-status') ?? null, 'grant-2', 'me@gmail.com') })
    const after = await (await ask({ action: 'status' })).json()
    expect(after).toMatchObject({ connected: true })
    expect(after).not.toHaveProperty('needsSignIn')
    expect(w.rows.get('u-status')?.google_drafter_calendar_id).toBe('cal-1')
  })
})

describe('Microsoft refuses an Outlook account’s grant: the same, for that account only', () => {
  it('marks the account, refuses at once after, and a reconnect clears it', async () => {
    let refreshes = 0
    world({
      msToken: form => {
        refreshes++
        return form.get('refresh_token') === 'r-dead' ? { status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS700082: The refresh token has expired.' } } : { body: { access_token: 'tok', expires_in: 3600 } }
      },
      me: () => ({ body: { id: 'acct-work', mail: 'me@work.test', displayName: 'Me at work' } }),
    }).rows.set('u-ms', {
      user_id: 'u-ms',
      microsoft_accounts: [
        { id: 'acct-home', email: 'me@home.test', name: 'Me', refreshToken: 'r-live', drafterCalendarId: 'cal-h' },
        { id: 'acct-work', email: 'me@work.test', name: 'Me at work', refreshToken: 'r-dead', drafterCalendarId: 'cal-w' },
      ],
    })
    await expect(outlookToken('u-ms', 'acct-work')).rejects.toMatchObject({ status: 409, reason: 'reauth', message: 'Outlook (me@work.test) needs you to sign in again.' })
    const [home, work] = await listAccounts('u-ms')
    expect(home).toMatchObject({ refreshToken: 'r-live' })
    expect(work).toMatchObject({ refreshToken: null, drafterCalendarId: 'cal-w' })
    expect(work.authFailedAt).toEqual(expect.any(String))
    expect(publicAccount(work)).toMatchObject({ needsSignIn: true })
    expect(publicAccount(home)).not.toHaveProperty('needsSignIn')
    await expect(outlookToken('u-ms', 'acct-work')).rejects.toMatchObject({ reason: 'reauth' })
    expect(refreshes).toBe(1)
    expect(await outlookToken('u-ms', 'acct-home')).toBe('tok')
    // signed in again: the account comes back whole, and needs nothing
    await connectAccount('u-ms', { access_token: 'fresh', refresh_token: 'r-new' })
    expect(publicAccount((await listAccounts('u-ms')).find(a => a.id === 'acct-work')!)).not.toHaveProperty('needsSignIn')
  })
})

describe('the morning digest says it every morning until it is signed in again', () => {
  it('names each calendar that needs signing in, and nothing when none does', () => {
    const google = { google_email: 'me@gmail.com', google_refresh_token: null }
    const outlook = { microsoft_accounts: [{ id: 'a', email: 'me@work.test', authFailedAt: '2026-09-20T00:00:00Z', refreshToken: null }] }
    expect(signInLine(google)).toBe('Google Calendar needs you to sign in again (Settings → Calendars): nothing reaches it until then.')
    expect(signInLine({ ...google, ...outlook })).toBe('Google Calendar and Outlook (me@work.test) need you to sign in again (Settings → Calendars): nothing reaches them until then.')
    for (const fine of [null, {}, { google_email: 'me@gmail.com', google_refresh_token: 'grant' }, { google_email: null, google_refresh_token: null }, { microsoft_accounts: [{ id: 'a', refreshToken: 'r' }] }]) {
      expect(signInLine(fine)).toBeNull()
    }
  })
})

// ---- the app ---------------------------------------------------------------------

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
const refused = (reason?: string) => Object.assign(new Error(reason ? 'Google Calendar needs you to sign in again.' : 'The calendar could not be reached.'), { status: reason ? 409 : 502, reason })

describe('a pass tells a dead sign-in from a blip', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))

  it('a push the account refuses for good is said, and not counted as a failure to retry', async () => {
    const t: PassTarget = { id: 'google', key: 'si-ledger-1', lock: 'si-lock-1', push: async () => Promise.reject(refused('reauth')), pull: async () => ({}) }
    const pass = await mirrorPass([t], [task('si-1')], {}, 'me', { pull: true })
    expect(pass.signIn).toEqual({ google: 'Google Calendar needs you to sign in again.' })
    expect(pass.accountErrors.google).toBe('Google Calendar needs you to sign in again.')
    expect(pass.failed).toBe(false)
  })

  it('so is a pull that finds it, with nothing owed', async () => {
    const t: PassTarget = { id: 'acct-1', key: 'si-ledger-2', lock: 'si-lock-2', push: async () => ({ done: [] }), pull: async () => Promise.reject(refused('reauth')) }
    const pass = await mirrorPass([t], [], {}, 'me', { pull: true })
    expect(pass.signIn).toEqual({ 'acct-1': 'Google Calendar needs you to sign in again.' })
    expect(pass.failed).toBe(false)
  })

  it('anything else is retried as before, and is no sign-in', async () => {
    const t: PassTarget = { id: 'google', key: 'si-ledger-3', lock: 'si-lock-3', push: async () => Promise.reject(refused()), pull: async () => ({}) }
    const pass = await mirrorPass([t], [task('si-3')], {}, 'me', { pull: true })
    expect(pass.signIn).toEqual({})
    expect(pass.failed).toBe(true)
  })
})

describe('the hooks stop asking until the account is signed in again', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))
  const google = { id: 'google', key: 'google:me' }
  const outlook = { id: 'acct-9', key: 'ms:acct-9' }

  it('an automatic pass leaves a dead sign-in out; one that was asked for tries it, and so does one a day on', () => {
    const at = Date.parse('2026-09-20T08:00:00.000Z')
    settleSignIns([google], { signIn: { google: 'Google Calendar needs you to sign in again.' }, accountErrors: { google: 'x' } }, new Date(at).toISOString())
    expect(passTargetsFor([google, outlook], false, undefined, at + 60_000)).toEqual([outlook])
    expect(passTargetsFor([google, outlook], true, undefined, at + 60_000)).toEqual([google, outlook])
    // signed in again on another device, perhaps: asked once more a day later
    expect(passTargetsFor([google, outlook], false, undefined, at + SIGN_IN_PROBE_MS)).toEqual([google, outlook])
    // …and that try, refused again, waits another day, the streak still the one it was
    settleSignIns([google], { signIn: { google: 'Google Calendar needs you to sign in again.' }, accountErrors: { google: 'x' } }, new Date(at + SIGN_IN_PROBE_MS).toISOString())
    expect(passTargetsFor([google, outlook], false, undefined, at + SIGN_IN_PROBE_MS + 60_000)).toEqual([outlook])
    expect(readSignIn('google:me')?.since).toBe('2026-09-20T08:00:00.000Z')
  })

  it('a streak keeps the time it began, ends when the account works again, and not on another failure', () => {
    const dead = { signIn: { google: 'Google Calendar needs you to sign in again.' }, accountErrors: { google: 'x' } }
    settleSignIns([google], dead, '2026-09-20T08:00:00.000Z')
    settleSignIns([google], dead, '2026-09-20T09:00:00.000Z')
    expect(readSignIn('google:me')).toMatchObject({ since: '2026-09-20T08:00:00.000Z', provider: 'google', id: 'google:me|2026-09-20T08:00:00.000Z' })
    settleSignIns([google], { signIn: {}, accountErrors: { google: 'offline' } }, '2026-09-20T10:00:00.000Z')
    expect(readSignIn('google:me')?.since).toBe('2026-09-20T08:00:00.000Z')
    settleSignIns([google], { signIn: {}, accountErrors: {} }, '2026-09-20T11:00:00.000Z')
    expect(readSignIn('google:me')).toBeNull()
  })

  it('Settings finding the account connected clears it: Google whole, Outlook by account', () => {
    const dead = (id: string) => ({ signIn: { [id]: 'needs you to sign in again' }, accountErrors: { [id]: 'x' } })
    settleSignIns([google], dead('google'), '2026-09-20T08:00:00.000Z')
    settleSignIns([outlook], dead('acct-9'), '2026-09-20T08:00:00.000Z')
    settleSignIns([{ id: 'acct-2', key: 'ms:acct-2' }], dead('acct-2'), '2026-09-20T08:00:00.000Z')
    clearMirrorSignIn('microsoft', 'acct-9')
    expect([readSignIn('google:me'), readSignIn('ms:acct-9'), readSignIn('ms:acct-2')].map(t => !!t)).toEqual([true, false, true])
    clearMirrorSignIn('google')
    expect(readSignIn('google:me')).toBeNull()
  })
})

describe('Today says it once a streak', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))
  const trouble = (id: string, since: string) => ({ id: `${id}|${since}`, provider: 'google' as const, since, message: `${id} needs you to sign in again.` })

  it('shows the oldest streak not put aside; put aside, it stays aside until a new streak', () => {
    const a = trouble('google:me', '2026-09-20T08:00:00.000Z')
    const b = trouble('ms:acct-9', '2026-09-21T08:00:00.000Z')
    expect(signInBanner([b, a], [])).toBe(a)
    const dismissed = dismissSignIn(a.id)
    expect(readSignInDismissed()).toEqual([a.id])
    expect(signInBanner([b, a], dismissed)).toBe(b)
    expect(signInBanner([a], dismissed)).toBeNull()
    // signed in, then refused again: a new streak, said again
    expect(signInBanner([trouble('google:me', '2026-09-25T08:00:00.000Z')], dismissed)?.since).toBe('2026-09-25T08:00:00.000Z')
  })

  it('the banner names the calendar and opens Settings → Calendars', () => {
    const html = renderToStaticMarkup(<CalendarSignInBanner trouble={trouble('google:me', '2026-09-20T08:00:00.000Z')} onOpen={() => {}} onDismiss={() => {}} />)
    expect(html).toContain('role="status" aria-label="Calendar sign-in"')
    expect(html).toContain('<strong>google:me needs you to sign in again.</strong> Nothing reaches that calendar until you do.')
    expect(html).toContain('Open Settings → Calendars')
    expect(openingGroup('calendars', false)).toBe('calendars')
    expect(openingGroup('calendars', true)).toBe('calendars')
    // Settings opened any other way starts where it always has
    expect(openingGroup(undefined, true)).toBe('you')
    expect(openingGroup('nowhere', false)).toBe('appearance')
  })

  it('Settings → Google Calendar asks to sign in again, with a way to forget it', () => {
    const ctx = {
      store: { calendars: [] },
      calendars: { events: [], errors: {}, names: {}, loading: false, refresh: async () => {} },
      googlePush: { pending: false, pushNow: async () => {} },
      household: { info: null, myId: 'me', refresh: async () => {} },
    } as unknown as SettingsCtx
    const status: GoogleStatus = { configured: true, connected: false, email: 'me@gmail.com', needsSignIn: true, missing: [], redirectUri: 'https://example.org/api/google/callback' }
    const out = renderToStaticMarkup(settled(GoogleCalendar, { ...ctx, initialStatus: status }) as ReactElement)
    expect(out).toContain('Google stopped letting Drafter into me@gmail.com')
    expect(out).toContain('Sign in to Google again')
    expect(out).toContain('Disconnect')
  })
})
