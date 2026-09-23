import type { ReactElement } from 'react'
import { renderToStaticMarkup, renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// Connecting a calendar failed in silence twice over. Settings showed Google's
// error only once Google was already connected, so a sign-in that failed left
// the Connect button looking untouched. And in the iPhone app the planner
// toasted "Google Calendar connected" the moment Safari handed back a code,
// before the code had been exchanged — a failed exchange was never mentioned.

vi.mock('../calendars', async importOriginal => ({
  ...(await importOriginal<typeof import('../calendars')>()),
  // thrown at once rather than after a wait, so the failure lands inside the
  // render that pressed the button (see rendered.tsx)
  connectCalendarAccount: () => {
    throw new Error('Google sign-in is not set up for this site.')
  },
}))

import { beginNativeOAuth, finishOAuthReturn, type GoogleStatus } from '../calendars'
import { oauthSettledMessage, useDeepLinks } from '../components/planner/useDeepLinks'
import { GoogleCalendar } from '../components/settings/GoogleCalendar'
import type { SettingsCtx } from '../components/settings/context'
import { press, settled } from './rendered'

const ctx = {
  store: { calendars: [] },
  calendars: { events: [], errors: {}, names: {}, loading: false, refresh: async () => {} },
  googlePush: { pending: false, pushNow: async () => {} },
  household: { info: null, myId: 'me', refresh: async () => {} },
} as unknown as SettingsCtx
const status = (over: Partial<GoogleStatus> = {}): GoogleStatus => ({ configured: true, connected: false, email: null, missing: [], redirectUri: 'https://example.org/api/google/callback', ...over })
const html = (tree: unknown) => renderToStaticMarkup(tree as ReactElement)

describe('Settings → Google Calendar, before it is connected', () => {
  it('says why a connect failed, directly under Connect', () => {
    const out = html(settled(GoogleCalendar, { ...ctx, initialStatus: status() }, t => press(t, 'Connect Google Calendar')))
    const connect = out.indexOf('Connect Google Calendar')
    const said = out.indexOf('Google sign-in is not set up for this site.')
    expect(connect).toBeGreaterThan(-1)
    expect(said).toBeGreaterThan(connect)
    // the next paragraph after the Connect line, said as an alert
    expect(out.slice(out.indexOf('</p>', connect))).toMatch(/^<\/p><p class="warn" role="alert">Google sign-in is not set up/)
    // and the button is free to be tried again
    expect(out).not.toContain('Opening Google…')
  })

  it('says nothing under Connect when nothing has failed', () => {
    const out = html(settled(GoogleCalendar, { ...ctx, initialStatus: status() }))
    expect(out).toContain('Connect Google Calendar')
    expect(out).not.toContain('class="warn"')
  })

  it('still reads "not available" on a site with no Google set up', () => {
    const out = html(settled(GoogleCalendar, { ...ctx, initialStatus: status({ configured: false }) }))
    expect(out).toContain('Calendar sync isn’t available yet.')
  })
})

/** useDeepLinks over stand-ins that log every call, as p3-links.test.tsx has it. */
function links() {
  const calls: string[] = []
  const log = (name: string) => vi.fn((...args: unknown[]) => void calls.push(`${name} ${JSON.stringify(args)}`))
  const deps = {
    store: { loaded: true, journal: [], tasks: [], people: [], places: [] },
    showToast: log('toast'),
    setSettingsNonce: log('settingsNonce'),
    setPushed: log('pushed'),
  } as unknown as Parameters<typeof useDeepLinks>[0]
  const handed: { current: (raw: string) => void }[] = []
  function Shell() {
    handed.push(useDeepLinks(deps).applyLinkRef)
    return null
  }
  renderToString(<Shell />)
  return { apply: (raw: string) => handed[handed.length - 1].current(raw), calls }
}

/** A turn of the event loop: long enough for the calendars module, loaded already, to be handed over. */
const tick = () => new Promise(r => setTimeout(r, 0))
const CONNECTED = 'Google Calendar connected — pick the calendars to show in Settings.'

describe('coming back from a calendar sign-in', () => {
  it('in the app, opens Settings and says nothing until the code has been exchanged', async () => {
    const { apply, calls } = links()
    const url = 'drafter://oauth?google=connected&code=c0de&state=st4te'
    await beginNativeOAuth('google')
    apply(url)
    expect(calls).toEqual(['settingsNonce [null]', 'pushed ["settings"]'])
    await tick()
    await finishOAuthReturn(url, async () => {})
    expect(calls.filter(c => c.startsWith('toast'))).toEqual([`toast ["${CONNECTED}"]`])
  })

  it('in the app, says why the exchange was refused, for either provider', async () => {
    const { apply, calls } = links()
    const url = 'drafter://oauth?microsoft=connected&code=c0de&state=st4te'
    await beginNativeOAuth('microsoft')
    apply(url)
    await tick()
    await finishOAuthReturn(url, async () => {
      throw new Error('invalid_grant')
    })
    expect(calls.filter(c => c.startsWith('toast'))).toEqual(['toast ["Outlook could not be connected: invalid_grant"]'])
  })

  it('says it once, and nothing for a return this app did not start', async () => {
    const { apply, calls } = links()
    const url = 'drafter://oauth?google=connected&code=c0de&state=st4te'
    // no sign-in waiting on this phone: finishOAuthReturn lets it go, and so does the toast
    apply(url)
    await tick()
    await expect(finishOAuthReturn(url, async () => {})).resolves.toBeNull()
    expect(calls.filter(c => c.startsWith('toast'))).toEqual([])
    // a real one after it is said exactly once
    await beginNativeOAuth('google')
    apply(url)
    await tick()
    await finishOAuthReturn(url, async () => {})
    expect(calls.filter(c => c.startsWith('toast'))).toEqual([`toast ["${CONNECTED}"]`])
  })

  it('says a refusal handed back in the link at once: there is nothing to exchange', () => {
    const { apply, calls } = links()
    apply('drafter://oauth?google=error&reason=access_denied')
    expect(calls[0]).toBe('toast ["Google Calendar could not be connected (access was refused or the sign-in was cancelled)."]')
  })

  it('on the web, where the callback has already finished it, says the outcome at once', () => {
    const ok = links()
    ok.apply('/?google=connected')
    expect(ok.calls[0]).toBe(`toast ["${CONNECTED}"]`)
    const refused = links()
    refused.apply('/?microsoft=error&reason=access_denied')
    expect(refused.calls[0]).toBe('toast ["Outlook could not be connected (access was refused or the sign-in was cancelled)."]')
  })

  it('words what the exchange came to', () => {
    expect(oauthSettledMessage({ provider: 'google', ok: true })).toBe(CONNECTED)
    expect(oauthSettledMessage({ provider: 'microsoft', ok: true })).toBe('Outlook connected — pick the calendars to show in Settings.')
    // finishOAuthReturn's own sentence is kept as it is
    expect(oauthSettledMessage({ provider: 'google', ok: false, error: 'Google Calendar could not be connected (access denied).' })).toBe(
      'Google Calendar could not be connected (access denied).',
    )
    expect(oauthSettledMessage({ provider: 'google', ok: false })).toBe('Google Calendar could not be connected.')
  })
})
