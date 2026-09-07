// Google Calendar connection, per signed-in user. Routes (see netlify.toml):
//   GET  /api/google/callback   OAuth redirect target (state → user, no session)
//   POST /api/google            { action } — session-gated:
//        status | auth | disconnect | calendars | push
// Setup: Google Cloud project → enable Calendar API → OAuth client (Web) with
// redirect URI https://<site>/api/google/callback → GOOGLE_CLIENT_ID /
// GOOGLE_CLIENT_SECRET on the host. SUPABASE_SERVICE_KEY stores tokens per user.

import { getUser, settingsFind, settingsGet, settingsSet } from './lib/session.mjs'
import { clearCookieHeader, cookieHeader, newVerifier, stateFor, verifyState } from './lib/oauth.mjs'
import { SCOPES, drafterCalendarId, exchangeCode, googleConfigured, listCalendars, missingGoogleEnv, pushTask, randomToken, revoke } from './lib/google.mjs'

const redirectUriFor = origin => `${origin}/api/google/callback`
const STATE_TTL_MS = 10 * 60_000

const GOOGLE_COOKIE = 'drafter_google_oauth'

async function callback(req, url) {
  const back = q => new Response(null, { status: 302, headers: { location: `${url.origin}/?${q}`, 'set-cookie': clearCookieHeader(GOOGLE_COOKIE) } })
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

export default async req => {
  const url = new URL(req.url)
  if (url.pathname.endsWith('/callback')) {
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
    return callback(req, url)
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
      const verifier = newVerifier()
      const state = stateFor(verifier)
      await settingsSet(user.id, { google_oauth_state: state, google_state_at: new Date().toISOString() })
      const q = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: redirectUriFor(url.origin),
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        login_hint: user.email,
        state,
      })
      return Response.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${q}` }, { headers: { 'set-cookie': cookieHeader(GOOGLE_COOKIE, verifier) } })
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
          start: ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T09:00:00` : null),
          allDay: !!ev.start?.date,
          updated: ev.updated,
        }))
      return Response.json({ changes, at: new Date().toISOString() })
    }
    if (action === 'push') {
      const tasks = Array.isArray(body.tasks) ? body.tasks.slice(0, 200) : []
      const projectNames = body.projects && typeof body.projects === 'object' ? body.projects : {}
      const calendarId = await drafterCalendarId(user.id)
      const results = { created: 0, updated: 0, removed: 0, skipped: 0 }
      const errors = []
      for (const t of tasks) {
        try {
          results[await pushTask(user.id, calendarId, t, t.projectId ? projectNames[t.projectId] : undefined, url.origin)]++
        } catch (e) {
          errors.push({ id: t.id, error: e?.message ?? String(e) })
          if (e?.status === 409 || e?.status === 401 || e?.status === 403) break
        }
      }
      return Response.json({ calendarId, ...results, errors })
    }
    return Response.json({ error: 'unknown action' }, { status: 400 })
  } catch (e) {
    const status = e?.status === 409 || e?.status === 401 ? 409 : e?.status === 501 ? 501 : 502
    return Response.json({ error: e?.message ?? 'Google request failed' }, { status })
  }
}
