import { afterEach, describe, expect, it, vi } from 'vitest'
import { challengeFor, checkNativeCompletion, handoffChallenge, isNativeState, nativeHandoff, nativeState, stateFor, verifyState } from '../../netlify/functions/lib/oauth.mjs'
import { beginNativeOAuth, finishOAuthReturn, newOAuthVerifier, oauthChallenge, onOAuthSettled, parseOAuthReturn } from '../calendars'
import { world } from './cal-world'

// The iOS app cannot share its cookies with the Safari sheet that runs a
// calendar's consent screen, so it handed Safari a one-time link, and whoever
// opened that link within its two minutes could attach THEIR calendar to the
// account that started it. The flow is now bound to the app that started it:
// the app keeps a verifier and sends only its challenge, the callback hands the
// code back to the app instead of finishing, and only that signed-in account,
// presenting that verifier, can finish it. These pin the pieces, then run the
// whole handoff through the real Google and Microsoft functions.

// Resolved at run time, not by tsc: a .d.mts beside a function would ship as a function.
const GOOGLE_FUNCTION = '../../netlify/functions/google.mjs'
const MICROSOFT_FUNCTION = '../../netlify/functions/microsoft.mjs'
const SITE = 'https://drafterz.netlify.app'

type Handler = (req: Request) => Promise<Response>
const load = async (path: string) => (await import(/* @vite-ignore */ path)).default as Handler

describe('the verifier and its challenge', () => {
  it('are RFC 7636’s S256, computed the same on both sides', async () => {
    const v = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    expect(challengeFor(v)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
    expect(await oauthChallenge(v)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('the app’s verifier is 256 random bits, never the same twice', () => {
    const a = newOAuthVerifier()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newOAuthVerifier()).not.toBe(a)
  })
})

describe('the handoff and the state carry the challenge', () => {
  const ch = challengeFor('kept-by-the-app')

  it('a handoff names its challenge; an old app’s handoff, or a mangled one, names none', () => {
    expect(handoffChallenge(nativeHandoff(ch))).toBe(ch)
    expect(handoffChallenge('legacyhandofftoken')).toBeNull()
    expect(handoffChallenge(`abc.${ch.slice(1)}`)).toBeNull()
  })

  it('the browser half of a native state still has to match this browser’s cookie', () => {
    const state = nativeState('cookie-verifier', ch)
    expect(isNativeState(state)).toBe(true)
    expect(isNativeState(stateFor('cookie-verifier'))).toBe(false)
    const req = (cookie: string) => new Request(SITE, { headers: { cookie: `drafter_google_oauth=${cookie}` } })
    expect(verifyState(req('cookie-verifier'), 'drafter_google_oauth', state)).toBe(true)
    expect(verifyState(req('another-browser'), 'drafter_google_oauth', state)).toBe(false)
  })
})

describe('checkNativeCompletion: who may finish', () => {
  const verifier = 'the-app-kept-this'
  const state = nativeState('cookie', challengeFor(verifier))
  const now = Date.parse('2026-09-12T10:01:00.000Z')
  const ok = { stored: state, storedAt: '2026-09-12T10:00:00.000Z', state, verifier, code: 'code', now }

  it('the account that started it, presenting the verifier it kept', () => {
    expect(checkNativeCompletion(ok)).toEqual({ ok: true })
  })

  it('not another account (its own row holds no such state), nor a flow already finished', () => {
    expect(checkNativeCompletion({ ...ok, stored: null })).toEqual({ ok: false, reason: 'state_mismatch' })
    expect(checkNativeCompletion({ ...ok, stored: nativeState('cookie', challengeFor('someone else')) })).toEqual({ ok: false, reason: 'state_mismatch' })
  })

  it('not with any other verifier', () => {
    expect(checkNativeCompletion({ ...ok, verifier: 'a-guess' })).toEqual({ ok: false, reason: 'verifier_mismatch' })
  })

  it('not a stale flow, a web flow, or one with no code', () => {
    expect(checkNativeCompletion({ ...ok, now: now + 11 * 60_000 })).toEqual({ ok: false, reason: 'expired' })
    const web = stateFor('cookie')
    expect(checkNativeCompletion({ ...ok, stored: web, state: web })).toEqual({ ok: false, reason: 'bad_state' })
    expect(checkNativeCompletion({ ...ok, code: '' })).toEqual({ ok: false, reason: 'missing_code' })
  })
})

describe('the app finishes only the flow it started', () => {
  it('reads what Safari hands back', () => {
    expect(parseOAuthReturn('drafter://oauth?google=connected&code=4%2F0Ab&state=s.t')).toEqual({ provider: 'google', code: '4/0Ab', state: 's.t' })
    expect(parseOAuthReturn('drafter://oauth?microsoft=error&reason=access_denied')).toEqual({ provider: 'microsoft', error: 'access_denied' })
    expect(parseOAuthReturn(`${SITE}/?google=connected`)).toBeNull()
    expect(parseOAuthReturn('drafter://journal?text=hi')).toBeNull()
    expect(parseOAuthReturn('not a url')).toBeNull()
  })

  it('sends back the verifier whose challenge it began with, once', async () => {
    const { challenge } = await beginNativeOAuth('google')
    const calls: [string, string, Record<string, unknown>][] = []
    const url = 'drafter://oauth?google=connected&code=c1&state=s1'
    expect(await finishOAuthReturn(url, async (p, name, payload) => void calls.push([p, name, payload]))).toEqual({ provider: 'google', ok: true })
    const [provider, name, payload] = calls[0]
    expect([provider, name, payload.code, payload.state]).toEqual(['google', 'complete', 'c1', 's1'])
    expect(challengeFor(String(payload.verifier))).toBe(challenge)
    expect(await finishOAuthReturn(url, async () => ({}))).toBeNull()
  })

  it('does nothing for a return it did not start, for the other provider, or once stale', async () => {
    const never = async () => {
      throw new Error('must not be called')
    }
    expect(await finishOAuthReturn('drafter://oauth?google=connected&code=c&state=s', never)).toBeNull()
    await beginNativeOAuth('microsoft')
    expect(await finishOAuthReturn('drafter://oauth?google=connected&code=c&state=s', never)).toBeNull()
    await beginNativeOAuth('google', Date.now() - 11 * 60_000)
    expect(await finishOAuthReturn('drafter://oauth?google=connected&code=c&state=s', never)).toBeNull()
  })

  it('hands Settings a refusal from the provider or the server', async () => {
    const heard: unknown[] = []
    const stop = onOAuthSettled(r => heard.push(r))
    await beginNativeOAuth('microsoft')
    await finishOAuthReturn('drafter://oauth?microsoft=error&reason=access_denied', async () => ({}))
    await beginNativeOAuth('google')
    await finishOAuthReturn('drafter://oauth?google=connected&code=c&state=s', async () => {
      throw new Error('That sign-in was started somewhere else.')
    })
    stop()
    expect(heard).toEqual([
      { provider: 'microsoft', ok: false, error: expect.stringMatching(/refused or the sign-in was cancelled/) },
      { provider: 'google', ok: false, error: 'That sign-in was started somewhere else.' },
    ])
  })
})

describe('the native handoff, end to end through the real functions', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  function setup() {
    const exchanged: URLSearchParams[] = []
    const w = world({
      sessions: { 's-owner': { id: 'u-owner', email: 'owner@example.test' }, 's-other': { id: 'u-other', email: 'other@example.test' } },
      googleToken: form => {
        exchanged.push(form)
        return { body: { access_token: 'at', refresh_token: `rt-for-${form.get('code')}`, expires_in: 3600 } }
      },
      userinfo: () => ({ body: { email: 'owner@gmail.example' } }),
      msToken: form => {
        exchanged.push(form)
        return { body: { access_token: 'ms-at', refresh_token: `ms-rt-for-${form.get('code')}`, expires_in: 3600 } }
      },
      me: () => ({ body: { id: 'ms-acct-1', mail: 'owner@outlook.example', displayName: 'Owner' } }),
    })
    w.rows.set('u-owner', { user_id: 'u-owner' })
    w.rows.set('u-other', { user_id: 'u-other' })
    return { ...w, exchanged }
  }

  const post = (handler: Handler, provider: string, session: string, body: Record<string, unknown>) =>
    handler(new Request(`${SITE}/api/${provider}`, { method: 'POST', headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }))

  /** The cookies a response set, as the next request from that browser sends them. */
  const cookiesFrom = (res: Response) =>
    res.headers
      .getSetCookie()
      .map(c => c.split(';')[0])
      .filter(c => !c.endsWith('='))
      .join('; ')

  /** The app asks, Safari opens /start, someone consents, the provider calls back: what that browser is handed. */
  async function throughSafari(handler: Handler, provider: 'google' | 'microsoft', challenge: string, code: string) {
    const auth = await post(handler, provider, 's-owner', { action: 'auth', native: true, challenge })
    const { url } = (await auth.json()) as { url: string }
    const start = await handler(new Request(url))
    expect(start.status).toBe(302)
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!
    const back = await handler(new Request(`${SITE}/api/${provider}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, { headers: { cookie: cookiesFrom(start) } }))
    return parseOAuthReturn(back.headers.get('location')!)!
  }

  it('Google: the callback attaches nothing; the app that started it finishes it, once', async () => {
    const w = setup()
    const google = await load(GOOGLE_FUNCTION)
    const verifier = newOAuthVerifier()
    const handed = await throughSafari(google, 'google', await oauthChallenge(verifier), 'code-owner')
    expect(handed).toMatchObject({ provider: 'google', code: 'code-owner' })
    expect(w.exchanged).toHaveLength(0)
    expect(w.rows.get('u-owner')?.google_refresh_token).toBeUndefined()

    const done = await post(google, 'google', 's-owner', { action: 'complete', code: handed.code, state: handed.state, verifier })
    expect(done.status).toBe(200)
    expect(w.rows.get('u-owner')).toMatchObject({ google_refresh_token: 'rt-for-code-owner', google_email: 'owner@gmail.example', google_oauth_state: null })
    expect(w.exchanged[0].get('redirect_uri')).toBe(`${SITE}/api/google/callback`)

    const again = await post(google, 'google', 's-owner', { action: 'complete', code: handed.code, state: handed.state, verifier })
    expect(again.status).toBe(403)
  })

  it('Google: someone else who opens the link cannot attach their calendar to this account', async () => {
    const w = setup()
    const google = await load(GOOGLE_FUNCTION)
    const verifier = newOAuthVerifier()
    // the owner's app starts a flow; the link reaches another person, who consents in their own browser
    const handed = await throughSafari(google, 'google', await oauthChallenge(verifier), 'code-of-someone-else')
    // before: the callback had already stored their tokens on the owner's row
    expect(w.rows.get('u-owner')?.google_refresh_token).toBeUndefined()
    // the code lands on THEIR device; their app, signed in as them, cannot finish it
    expect((await post(google, 'google', 's-other', { action: 'complete', code: handed.code, state: handed.state, verifier: newOAuthVerifier() })).status).toBe(403)
    // and without the verifier the owner's app kept, not for the owner's account either
    expect((await post(google, 'google', 's-owner', { action: 'complete', code: handed.code, state: handed.state, verifier: newOAuthVerifier() })).status).toBe(403)
    expect(w.exchanged).toHaveLength(0)
    expect(w.rows.get('u-owner')?.google_refresh_token).toBeUndefined()
    expect(w.rows.get('u-other')?.google_refresh_token).toBeUndefined()
  })

  it('an app build that sends no challenge is told to update, and a link with its challenge swapped goes nowhere', async () => {
    setup()
    const google = await load(GOOGLE_FUNCTION)
    const old = await post(google, 'google', 's-owner', { action: 'auth', native: true })
    expect(old.status).toBe(400)
    expect(((await old.json()) as { error: string }).error).toMatch(/Update the app/)

    const auth = await post(google, 'google', 's-owner', { action: 'auth', native: true, challenge: await oauthChallenge(newOAuthVerifier()) })
    const tampered = new URL(((await auth.json()) as { url: string }).url)
    tampered.searchParams.set('h', `${tampered.searchParams.get('h')!.split('.')[0]}.${await oauthChallenge(newOAuthVerifier())}`)
    const start = await google(new Request(tampered.toString()))
    expect(start.headers.get('location')).toBe('drafter://oauth?google=error&reason=bad_state')
  })

  it('the web flow is unchanged: bound to the browser by its cookie, finished at the callback', async () => {
    const w = setup()
    const google = await load(GOOGLE_FUNCTION)
    const auth = await post(google, 'google', 's-owner', { action: 'auth' })
    const state = new URL(((await auth.json()) as { url: string }).url).searchParams.get('state')!
    const back = await google(new Request(`${SITE}/api/google/callback?code=web-code&state=${encodeURIComponent(state)}`, { headers: { cookie: cookiesFrom(auth) } }))
    expect(back.headers.get('location')).toBe(`${SITE}/?google=connected`)
    expect(w.rows.get('u-owner')?.google_refresh_token).toBe('rt-for-web-code')
    // and a web consent URL handed to another browser still fails at the cookie
    const stolen = await google(new Request(`${SITE}/api/google/callback?code=web-code&state=${encodeURIComponent(state)}`))
    expect(stolen.headers.get('location')).toBe(`${SITE}/?google=error&reason=state_mismatch`)
  })

  it('Outlook: the same binding, and the account lands on the account that started it', async () => {
    const w = setup()
    const microsoft = await load(MICROSOFT_FUNCTION)
    const verifier = newOAuthVerifier()
    const handed = await throughSafari(microsoft, 'microsoft', await oauthChallenge(verifier), 'ms-code')
    expect(handed.provider).toBe('microsoft')
    expect(w.exchanged).toHaveLength(0)
    // even holding the verifier, another signed-in account cannot finish it
    expect((await post(microsoft, 'microsoft', 's-other', { action: 'complete', code: handed.code, state: handed.state, verifier })).status).toBe(403)
    const done = await post(microsoft, 'microsoft', 's-owner', { action: 'complete', code: handed.code, state: handed.state, verifier })
    expect(done.status).toBe(200)
    expect(w.rows.get('u-owner')?.microsoft_accounts).toEqual([expect.objectContaining({ id: 'ms-acct-1', email: 'owner@outlook.example', refreshToken: 'ms-rt-for-ms-code' })])
    expect(w.rows.get('u-other')?.microsoft_accounts).toBeUndefined()
  })
})
