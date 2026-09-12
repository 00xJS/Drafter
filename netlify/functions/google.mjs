// Google Calendar connection, per signed-in user. Routes (see netlify.toml):
//   GET  /api/google/callback   OAuth redirect target (state → user, no session)
//   POST /api/google            { action } — session-gated:
//        status | auth | disconnect | calendars | push
// Setup: Google Cloud project → enable Calendar API → OAuth client (Web) with
// redirect URI https://<site>/api/google/callback → GOOGLE_CLIENT_ID /
// GOOGLE_CLIENT_SECRET on the host. SUPABASE_SERVICE_KEY stores tokens per user.

import { adoptTimeZone } from './lib/timezone.mjs'
import { withCors } from './lib/cors.mjs'
import { getUser, settingsFind, settingsGet, settingsSet } from './lib/session.mjs'
import {
  NATIVE_UPDATE_NEEDED,
  RETURN_COOKIE,
  checkNativeCompletion,
  clearCookieHeader,
  completionMessage,
  cookieHeader,
  handoffChallenge,
  handoffFresh,
  isNativeState,
  nativeHandoff,
  nativeState,
  newVerifier,
  returnTarget,
  stateFor,
  validChallenge,
  verifyState,
} from './lib/oauth.mjs'
import { SCOPES, exchangeCode, googleConfigured, googlePullRows, listCalendars, listChangedMirrors, missingGoogleEnv, pushEntry, pushTask, randomToken, reconnectPatch, resolveDrafterCalendar, revoke } from './lib/google.mjs'
import { runMirrorBatch } from './lib/mirror.mjs'

const redirectUriFor = origin => `${origin}/api/google/callback`
const STATE_TTL_MS = 10 * 60_000

const GOOGLE_COOKIE = 'drafter_google_oauth'

function consentUrl(origin, state, loginHint) {
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUriFor(origin),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })
  if (loginHint) q.set('login_hint', loginHint)
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`
}

/** The connected account's address: shown in Settings, and how a reconnect is told from another account. Cosmetic if it fails. */
async function googleEmail(accessToken) {
  try {
    const me = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { authorization: `Bearer ${accessToken}` } }).then(r => r.json())
    return me?.email ?? ''
  } catch {
    return ''
  }
}

/** Safari, opened by the iOS app with a one-time handoff: set the cookie here, then on to Google. */
async function start(url) {
  const fail = reason => new Response(null, { status: 302, headers: { location: `drafter://oauth?google=error&reason=${encodeURIComponent(reason)}` } })
  if (!googleConfigured()) return fail('not_configured')
  const handoff = url.searchParams.get('h') ?? ''
  const row = handoff ? await settingsFind('oauth_handoff', handoff).catch(() => null) : null
  // the handoff carries the challenge of a verifier only the app holds; one
  // without it (an app build from before) could be finished by whoever opened it
  const challenge = handoffChallenge(handoff)
  if (!row || !handoffFresh(row.oauth_handoff_at) || !challenge) return fail('bad_state')
  const verifier = newVerifier()
  const state = nativeState(verifier, challenge)
  await settingsSet(row.user_id, { oauth_handoff: null, oauth_handoff_at: null, google_oauth_state: state, google_state_at: new Date().toISOString() })
  const headers = new Headers({ location: consentUrl(url.origin, state) })
  headers.append('set-cookie', cookieHeader(GOOGLE_COOKIE, verifier))
  headers.append('set-cookie', cookieHeader(RETURN_COOKIE, 'native'))
  return new Response(null, { status: 302, headers })
}

async function callback(req, url) {
  const to = (target, q) => {
    const headers = new Headers({ location: `${target}?${q}` })
    headers.append('set-cookie', clearCookieHeader(GOOGLE_COOKIE))
    headers.append('set-cookie', clearCookieHeader(RETURN_COOKIE))
    return new Response(null, { status: 302, headers })
  }
  const back = q => to(returnTarget(req, url.origin), q)
  if (!googleConfigured()) return back('google=error&reason=not_configured')
  if (url.searchParams.get('error')) return back(`google=error&reason=${encodeURIComponent(url.searchParams.get('error'))}`)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) return back('google=error&reason=bad_state')
  // the state must match BOTH the user row it was minted into and the cookie
  // set in this browser, so a consent URL cannot be handed to someone else
  if (!verifyState(req, GOOGLE_COOKIE, state)) return back('google=error&reason=state_mismatch')
  const row = await settingsFind('google_oauth_state', state).catch(() => null)
  if (!row || !row.google_state_at || Date.now() - Date.parse(row.google_state_at) > STATE_TTL_MS) return back('google=error&reason=bad_state')
  if (isNativeState(state)) {
    // Started in the app. Finishing here would attach whoever consented in
    // THIS browser — anyone who opened the link — to the account that started
    // the flow. So the code goes back to the app, always, and the app finishes
    // with its own session and the verifier only it holds ('complete'). The
    // state stays on the row until then and is used up there.
    return to('drafter://oauth', `google=connected&${new URLSearchParams({ code, state })}`)
  }
  await settingsSet(row.user_id, { google_oauth_state: null, google_state_at: null })
  try {
    const tokens = await exchangeCode(code, redirectUriFor(url.origin))
    if (!tokens.refresh_token) return back('google=error&reason=no_refresh_token')
    const email = await googleEmail(tokens.access_token)
    await settingsSet(row.user_id, reconnectPatch(row, tokens.refresh_token, email))
    return back('google=connected')
  } catch (e) {
    return back(`google=error&reason=${encodeURIComponent(e?.message ?? 'exchange_failed')}`)
  }
}

const handler = async req => {
  const url = new URL(req.url)
  if (url.pathname.endsWith('/callback')) {
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
    return callback(req, url)
  }
  if (url.pathname.endsWith('/start')) {
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
    return start(url)
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const { user, response, unconfigured } = await getUser(req)
  if (response) return response
  if (unconfigured || !user) return Response.json({ error: 'Google Calendar needs a signed-in account (Supabase) — not available in local mode.' }, { status: 501 })

  let body
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 })
  }
  const action = body?.action

  try {
    if (action === 'status') {
      const configured = googleConfigured()
      const s = configured ? await settingsGet(user.id) : null
      return Response.json({ configured, connected: !!s?.google_refresh_token, email: s?.google_email ?? null, missing: missingGoogleEnv(), redirectUri: redirectUriFor(url.origin) })
    }
    if (!googleConfigured()) return Response.json({ error: `Google Calendar is not configured on the host: set ${missingGoogleEnv().join(', ')}` }, { status: 501 })

    if (action === 'auth') {
      if (body.native) {
        // The app cannot hold the cookie; Safari will, via /start. The app
        // keeps a verifier and sends only its challenge, so this flow can be
        // finished by that app alone, signed in as this user ('complete').
        if (!validChallenge(body.challenge)) return Response.json({ error: NATIVE_UPDATE_NEEDED }, { status: 400 })
        const handoff = nativeHandoff(body.challenge)
        await settingsSet(user.id, { oauth_handoff: handoff, oauth_handoff_at: new Date().toISOString() })
        return Response.json({ url: `${url.origin}/api/google/start?h=${encodeURIComponent(handoff)}` })
      }
      const verifier = newVerifier()
      const state = stateFor(verifier)
      await settingsSet(user.id, { google_oauth_state: state, google_state_at: new Date().toISOString() })
      return Response.json({ url: consentUrl(url.origin, state, user.email) }, { headers: { 'set-cookie': cookieHeader(GOOGLE_COOKIE, verifier) } })
    }
    if (action === 'complete') {
      // The second half of a flow started in the app: only the account that
      // started it, presenting the verifier it kept, can attach the calendar.
      const row = await settingsGet(user.id)
      const code = String(body.code ?? '')
      const check = checkNativeCompletion({
        stored: row?.google_oauth_state,
        storedAt: row?.google_state_at,
        state: String(body.state ?? ''),
        verifier: String(body.verifier ?? ''),
        code,
        ttlMs: STATE_TTL_MS,
      })
      if (!check.ok) return Response.json({ error: completionMessage(check.reason), reason: check.reason }, { status: 403 })
      // used up before the exchange, so the same code and state cannot be tried twice
      await settingsSet(user.id, { google_oauth_state: null, google_state_at: null })
      const tokens = await exchangeCode(code, redirectUriFor(url.origin))
      if (!tokens.refresh_token) return Response.json({ error: 'Google sent no refresh token. Connect again.', reason: 'no_refresh_token' }, { status: 400 })
      const email = await googleEmail(tokens.access_token)
      await settingsSet(user.id, reconnectPatch(row, tokens.refresh_token, email))
      return Response.json({ ok: true, email })
    }
    if (action === 'disconnect') {
      await revoke(user.id)
      return Response.json({ ok: true })
    }
    if (action === 'calendars') {
      return Response.json({ calendars: await listCalendars(user.id) })
    }
    if (action === 'pull') {
      // Drafter events changed in Google since `since`: tasks moved or deleted
      // there, and entries whose time or title was edited there. Stamped before
      // reading, so a change that lands mid-read falls inside the next window.
      const at = new Date().toISOString()
      const cal = await resolveDrafterCalendar(user.id)
      const calendarId = cal.id
      const since = Number.isFinite(Date.parse(body.since)) ? new Date(body.since).toISOString() : new Date(Date.now() - 7 * 86_400_000).toISOString()
      const { changes, entries } = googlePullRows(await listChangedMirrors(user.id, calendarId, since))
      return Response.json({ changes, entries, calendarId, replaced: cal.replaced, at })
    }
    if (action === 'push') {
      const startedAt = Date.now()
      // judge "untimed" in the owner's zone, not UTC: adopt the device's zone
      // when the account has none, never overwriting one that was chosen
      await adoptTimeZone(user.id, body.timezone)
      const projectNames = body.projects && typeof body.projects === 'object' ? body.projects : {}
      const cal = await resolveDrafterCalendar(user.id)
      const calendarId = cal.id
      const tz = (await settingsGet(user.id).catch(() => null))?.timezone ?? null
      // `records` is the sweep: tasks and entries together, in small chunks, cut
      // short by the time budget with `left` naming what to send again. `tasks`
      // is what an app build from before the sweep still sends, and it keeps its
      // old contract exactly: no budget, and its cursor moves only on no errors.
      const sweep = Array.isArray(body.records)
      const records = sweep ? body.records : Array.isArray(body.tasks) ? body.tasks : []
      const result = await runMirrorBatch(
        records,
        r => {
          const project = r.projectId ? projectNames[r.projectId] : undefined
          if (!sweep || r.kind === 'task') return pushTask(user.id, calendarId, r, project, url.origin, { tz })
          if (r.kind === 'event') return pushEntry(user.id, calendarId, r, url.origin)
          // pushTask treats anything that is not a task as "remove its copy"
          throw Object.assign(new Error('not a task or an entry'), { status: 400 })
        },
        sweep ? { startedAt } : { budgetMs: Infinity },
      )
      return Response.json({ calendarId, replaced: cal.replaced, ...result })
    }
    if (action === 'push-event') {
      // one entry at a time: this fires on save, not on a sweep
      const entry = body.event && typeof body.event === 'object' ? body.event : null
      if (!entry || typeof entry.id !== 'string') return Response.json({ error: 'event required' }, { status: 400 })
      const cal = await resolveDrafterCalendar(user.id)
      const result = await pushEntry(user.id, cal.id, entry, url.origin, { revive: body.revive === true })
      return Response.json({ calendarId: cal.id, replaced: cal.replaced, result })
    }
    return Response.json({ error: 'unknown action' }, { status: 400 })
  } catch (e) {
    const status = e?.status === 409 || e?.status === 401 ? 409 : e?.status === 501 ? 501 : 502
    return Response.json({ error: e?.message ?? 'Google request failed' }, { status })
  }
}

export default withCors(handler)
