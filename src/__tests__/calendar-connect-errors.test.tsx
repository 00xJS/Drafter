import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

import type { GoogleStatus } from '../calendars'
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

describe('coming back from a calendar sign-in', () => {
  it('in the app, opens Settings and waits for the exchange before saying anything', () => {
    for (const raw of ['drafter://oauth?google=connected&code=c0de&state=st4te', 'drafter://oauth?microsoft=connected&code=c0de&state=st4te', 'drafter://oauth?google=error&reason=access_denied']) {
      const { apply, calls } = links()
      apply(raw)
      expect(calls, raw).toEqual(['settingsNonce [null]', 'pushed ["settings"]'])
    }
  })

  it('on the web, where the callback has already finished it, says the outcome at once', () => {
    const ok = links()
    ok.apply('/?google=connected')
    expect(ok.calls[0]).toBe('toast ["Google Calendar connected — pick the calendars to show in Settings."]')
    const refused = links()
    refused.apply('/?microsoft=error&reason=access_denied')
    expect(refused.calls[0]).toBe('toast ["Outlook could not be connected (access was refused or the sign-in was cancelled)."]')
  })

  it('says what the exchange came to, for either provider', () => {
    expect(oauthSettledMessage({ provider: 'google', ok: true })).toBe('Google Calendar connected — pick the calendars to show in Settings.')
    expect(oauthSettledMessage({ provider: 'microsoft', ok: true })).toBe('Outlook connected — pick the calendars to show in Settings.')
    // finishOAuthReturn's own sentence is kept as it is
    expect(oauthSettledMessage({ provider: 'google', ok: false, error: 'Google Calendar could not be connected (access denied).' })).toBe(
      'Google Calendar could not be connected (access denied).',
    )
    // the server's words for a refused exchange are said against the provider
    expect(oauthSettledMessage({ provider: 'microsoft', ok: false, error: 'invalid_grant' })).toBe('Outlook could not be connected: invalid_grant')
    expect(oauthSettledMessage({ provider: 'google', ok: false })).toBe('Google Calendar could not be connected.')
  })

  it('hears every sign-in the app settles, for as long as the planner is up', () => {
    // effects do not run in a server render, so the one line that wires the
    // outcome to the toast is held here
    const hook = readFileSync(fileURLToPath(new URL('../components/planner/useDeepLinks.ts', import.meta.url)), 'utf8')
    expect(hook).toMatch(/useEffect\(\(\) => onOAuthSettled\(r => toastRef\.current\(oauthSettledMessage\(r\)\)\), \[\]\)/)
  })
})

