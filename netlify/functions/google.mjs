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
import { RETURN_COOKIE, clearCookieHeader, cookieHeader, handoffFresh, newHandoff, newVerifier, returnTarget, stateFor, verifyState } from './lib/oauth.mjs'
import { SCOPES, drafterCalendarId, exchangeCode, googleConfigured, listCalendars, missingGoogleEnv, pushEntry, pushTask, randomToken, revoke } from './lib/google.mjs'
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

/** Safari, opened by the iOS app with a one-time handoff: set the cookie here, then on to Google. */
async function start(url) {
  const fail = reason => new Response(null, { status: 302, headers: { location: `drafter://oauth?google=error&reason=${encodeURIComponent(reason)}` } })
  if (!googleConfigured()) return fail('not_configured')
  const handoff = url.searchParams.get('h') ?? ''
  const row = handoff ? await settingsFind('oauth_handoff', handoff).catch(() => null) : null
  if (!row || !handoffFresh(row.oauth_handoff_at)) return fail('bad_state')
  const verifier = newVerifier()
  const state = stateFor(verifier)
  await settingsSet(row.user_id, { oauth_handoff: null, oauth_handoff_at: null, google_oauth_state: state, google_state_at: new Date().toISOString() })
  const headers = new Headers({ location: consentUrl(url.origin, state) })
  headers.append('set-cookie', cookieHeader(GOOGLE_COOKIE, verifier))
  headers.append('set-cookie', cookieHeader(RETURN_COOKIE, 'native'))
  return new Response(null, { status: 302, headers })
}

async function callback(req, url) {
  const back = q => {
    const headers = new Headers({ location: `${returnTarget(req, url.origin)}?${q}` })
    headers.append('set-cookie', clearCookieHeader(GOOGLE_COOKIE))
    headers.append('set-cookie', clearCookieHeader(RETURN_COOKIE))
    return new Response(null, { status: 302, headers })
  }
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
  await settingsSet(row.user_id, { google_oauth_state: null, google_state_at: null })
  try {
    const tokens = await exchangeCode(code, redirectUriFor(url.origin))
    if (!tokens.refresh_token) return back('google=error&reason=no_refresh_token')
    let email = ''
    try {
      const me = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { authorization: `Bearer ${tokens.access_token}` } }).then(r => r.json())
      email = me?.email ?? ''
    } catch {
      /* cosmetic */
    }
    await settingsSet(row.user_id, { google_refresh_token: tokens.refresh_token, google_email: email, google_drafter_calendar_id: null })
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
        // the app cannot hold the cookie; Safari will, via /start
        const handoff = newHandoff()
        await settingsSet(user.id, { oauth_handoff: handoff, oauth_handoff_at: new Date().toISOString() })
        return Response.json({ url: `${url.origin}/api/google/start?h=${handoff}` })
      }
      const verifier = newVerifier()
      const state = stateFor(verifier)
      await settingsSet(user.id, { google_oauth_state: state, google_state_at: new Date().toISOString() })
      return Response.json({ url: consentUrl(url.origin, state, user.email) }, { headers: { 'set-cookie': cookieHeader(GOOGLE_COOKIE, verifier) } })
    }
    if (action === 'disconnect') {
      await revoke(user.id)
      return Response.json({ ok: true })
    }
    if (action === 'calendars') {
      return Response.json({ calendars: await listCalendars(user.id) })
    }
    if (action === 'pull') {
      // events in the Drafter calendar the user moved in Google since `since`
      const calendarId = await drafterCalendarId(user.id)
      const since = Number.isFinite(Date.parse(body.since)) ? new Date(body.since).toISOString() : new Date(Date.now() - 7 * 86_400_000).toISOString()
      const page = await (await import('./lib/google.mjs')).gapi(user.id, `/calendars/${encodeURIComponent(calendarId)}/events?updatedMin=${encodeURIComponent(since)}&singleEvents=true&showDeleted=true&maxResults=250&privateExtendedProperty=${encodeURIComponent('drafter=1')}`)
      const changes = (page.items ?? [])
        .filter(ev => ev.extendedProperties?.private?.taskId)
        .map(ev => ({
          taskId: ev.extendedProperties.private.taskId,
          deleted: ev.status === 'cancelled',
          // date-only for all-day; client writes local midnight
          start: ev.start?.dateTime ?? ev.start?.date ?? null,
          allDay: !!ev.start?.date,
          updated: ev.updated,
        }))
      return Response.json({ changes, at: new Date().toISOString() })
    }
    if (action === 'push') {
      const startedAt = Date.now()
      // judge "untimed" in the owner's zone, not UTC: adopt the device's zone
      // when the account has none, never overwriting one that was chosen
      await adoptTimeZone(user.id, body.timezone)
      const projectNames = body.projects && typeof body.projects === 'object' ? body.projects : {}
      const calendarId = await drafterCalendarId(user.id)
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
      return Response.json({ calendarId, ...result })
    }
    if (action === 'push-event') {
      // one entry at a time: this fires on save, not on a sweep
      const entry = body.event && typeof body.event === 'object' ? body.event : null
      if (!entry || typeof entry.id !== 'string') return Response.json({ error: 'event required' }, { status: 400 })
      const calendarId = await drafterCalendarId(user.id)
      const result = await (await import('./lib/google.mjs')).pushEntry(user.id, calendarId, entry, url.origin, { revive: body.revive === true })
      return Response.json({ calendarId, result })
    }
    return Response.json({ error: 'unknown action' }, { status: 400 })
  } catch (e) {
    const status = e?.status === 409 || e?.status === 401 ? 409 : e?.status === 501 ? 501 : 502
    return Response.json({ error: e?.message ?? 'Google request failed' }, { status })
  }
}

export default withCors(handler)
