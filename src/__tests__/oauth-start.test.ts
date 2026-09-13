import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { challengeFor } from '../../netlify/functions/lib/oauth.mjs'

// Connecting Google or Outlook starts in startOAuth. In the iPhone app it
// opens Safari's sheet and answers 'native', so Settings can clear its spinner
// and wait for the code to come back; in a browser it sends the page itself to
// the consent screen. Neither branch had a test, so the web branch running
// inside the app (stranding the consent page in the web view) or a lost
// 'native' would show up only when someone tapped Connect on the phone.

const env = vi.hoisted(() => ({
  native: true,
  /** What happened, in order: listening for Safari, asking the server, opening the sheet. */
  log: [] as string[],
  /** appUrlOpen listeners added since the module loaded; never reset, as the arming is not. */
  listens: 0,
  listeners: new Map<string, (e: { url: string }) => void>(),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => env.native, getPlatform: () => (env.native ? 'ios' : 'web') },
}))
vi.mock('@capacitor/browser', () => ({
  Browser: {
    open: vi.fn(async ({ url }: { url: string }) => {
      env.log.push(`open ${url}`)
    }),
    close: vi.fn(async () => {}),
  },
}))
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (name: string, fn: (e: { url: string }) => void) => {
      env.log.push(`listen ${name}`)
      if (name === 'appUrlOpen') env.listens++
      env.listeners.set(name, fn)
      return { remove: async () => void env.listeners.delete(name) }
    }),
  },
}))

import { Browser } from '@capacitor/browser'
import { connectCalendarAccount, onOAuthSettled } from '../calendars'
import { startOAuth } from '../native'

const SETTINGS = 'https://drafterz.netlify.app/settings'
const CONSENT = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=google-client&state=s'

/** Every call to a calendar function, as posted. */
let posted: { path: string; body: Record<string, unknown> }[] = []

beforeEach(() => {
  env.native = true
  env.log.length = 0
  posted = []
  vi.stubGlobal('window', { location: { href: SETTINGS }, open: vi.fn() })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      env.log.push(`${path} ${String(body.action)}`)
      posted.push({ path, body })
      return new Response(JSON.stringify(body.action === 'auth' ? { url: CONSENT } : { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('startOAuth', () => {
  it('in the app, opens the consent page in Safari’s sheet and answers "native"', async () => {
    expect(await startOAuth(CONSENT)).toBe('native')
    expect(Browser.open).toHaveBeenCalledWith({ url: CONSENT })
    // the web view stays on Settings, which is where the code comes back to
    expect(window.location.href).toBe(SETTINGS)
  })

  it('in a browser, sends this page to the consent screen, not Safari and not a new tab', async () => {
    env.native = false
    expect(await startOAuth(CONSENT)).toBe('redirect')
    expect(window.location.href).toBe(CONSENT)
    expect(Browser.open).not.toHaveBeenCalled()
    expect(window.open).not.toHaveBeenCalled()
  })
})

describe('connectCalendarAccount', () => {
  it('in a browser, asks for the consent page with no challenge and goes there', async () => {
    env.native = false
    expect(await connectCalendarAccount('microsoft')).toBe('redirect')
    expect(posted).toEqual([{ path: '/api/microsoft', body: { action: 'auth' } }])
    expect(window.location.href).toBe(CONSENT)
    expect(env.log).toEqual(['/api/microsoft auth'])
  })

  it('in the app, listens for Safari first, then asks for a page bound to a challenge, then opens it', async () => {
    const before = env.listens
    expect(await connectCalendarAccount('google')).toBe('native')
    // armed once per launch: the first step of the first Connect, and not repeated after
    const armedNow = env.listens > before
    expect(env.log).toEqual([...(armedNow ? ['listen appUrlOpen'] : []), '/api/google auth', `open ${CONSENT}`])
    expect(env.listens).toBe(1)
    expect(env.listeners.has('appUrlOpen')).toBe(true)
    expect(posted).toHaveLength(1)
    expect(posted[0].body).toMatchObject({ action: 'auth', native: true })
    expect(posted[0].body.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(window.location.href).toBe(SETTINGS)
  })

  it('listens once however often Connect is tapped, and finishes with the verifier behind the latest challenge', async () => {
    await connectCalendarAccount('google')
    await connectCalendarAccount('google')
    expect(env.listens).toBe(1)
    const [first, latest] = posted.map(p => p.body.challenge as string)
    expect(latest).not.toBe(first)

    const settled = new Promise(resolve => {
      const stop = onOAuthSettled(r => {
        stop()
        resolve(r)
      })
    })
    env.listeners.get('appUrlOpen')!({ url: 'drafter://oauth?google=connected&code=the-code&state=the-state' })
    expect(await settled).toEqual({ provider: 'google', ok: true })
    const complete = posted.find(p => p.body.action === 'complete')!
    expect(complete).toMatchObject({ path: '/api/google', body: { code: 'the-code', state: 'the-state' } })
    expect(challengeFor(complete.body.verifier as string)).toBe(latest)
  })
})
