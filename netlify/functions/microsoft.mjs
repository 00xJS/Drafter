// Outlook / Microsoft 365 connection, per signed-in user, several accounts at
// once. Routes (see netlify.toml):
//   GET  /api/microsoft/callback   OAuth redirect target (state -> user)
//   POST /api/microsoft            { action } — session-gated:
//        status | auth | disconnect | calendars | push | pull
// Setup: Azure Portal -> App registrations -> New registration, "Accounts in
// any organizational directory and personal Microsoft accounts", redirect URI
// https://<site>/api/microsoft/callback -> MICROSOFT_CLIENT_ID and a client
// secret in MICROSOFT_CLIENT_SECRET.

import { withCors } from './lib/cors.mjs'
import { getUser, settingsFind, settingsSet } from './lib/session.mjs'
import { RETURN_COOKIE, clearCookieHeader, cookieHeader, handoffFresh, newHandoff, newVerifier, returnTarget, stateFor, verifyState } from './lib/oauth.mjs'
import {
  authUrl,
  connectAccount,
  disconnectAccount,
  drafterCalendarId,
  exchangeCode,
  listAccounts,
  listCalendars,
  microsoftConfigured,
  missingMicrosoftEnv,
  publicAccount,
  pullChanges,
  pushTask,
} from './lib/microsoft.mjs'

const redirectUriFor = origin => `${origin}/api/microsoft/callback`
const STATE_TTL_MS = 10 * 60_000

const MS_COOKIE = 'drafter_ms_oauth'

/** Safari, opened by the iOS app with a one-time handoff: set the cookie here, then on to Microsoft. */
async function start(url) {
  const fail = reason => new Response(null, { status: 302, headers: { location: `${url.origin}/?microsoft=error&reason=${reason}` } })
  if (!microsoftConfigured()) return fail('not_configured')
  const handoff = url.searchParams.get('h') ?? ''
  const row = handoff ? await settingsFind('oauth_handoff', handoff).catch(() => null) : null
  if (!row || !handoffFresh(row.oauth_handoff_at)) return fail('bad_state')
  const verifier = newVerifier()
  const state = stateFor(verifier)
  await settingsSet(row.user_id, { oauth_handoff: null, oauth_handoff_at: null, ms_oauth_state: state, ms_state_at: new Date().toISOString() })
  const headers = new Headers({ location: authUrl(process.env.MICROSOFT_CLIENT_ID, redirectUriFor(url.origin), state) })
  headers.append('set-cookie', cookieHeader(MS_COOKIE, verifier))
  headers.append('set-cookie', cookieHeader(RETURN_COOKIE, 'native'))
  return new Response(null, { status: 302, headers })
}

async function callback(req, url) {
  const back = q => {
    const headers = new Headers({ location: `${returnTarget(req, url.origin)}?${q}` })
    headers.append('set-cookie', clearCookieHeader(MS_COOKIE))
    headers.append('set-cookie', clearCookieHeader(RETURN_COOKIE))
    return new Response(null, { status: 302, headers })
  }
  if (!microsoftConfigured()) return back('microsoft=error&reason=not_configured')
  if (url.searchParams.get('error')) return back(`microsoft=error&reason=${encodeURIComponent(url.searchParams.get('error_description') ?? url.searchParams.get('error'))}`)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) return back('microsoft=error&reason=bad_state')
  // the state must match BOTH the user row it was minted into and the cookie
  // set in this browser, so a consent URL cannot be handed to someone else
  if (!verifyState(req, MS_COOKIE, state)) return back('microsoft=error&reason=state_mismatch')
  const row = await settingsFind('ms_oauth_state', state).catch(() => null)
  if (!row || !row.ms_state_at || Date.now() - Date.parse(row.ms_state_at) > STATE_TTL_MS) return back('microsoft=error&reason=bad_state')
  await settingsSet(row.user_id, { ms_oauth_state: null, ms_state_at: null })
  try {
    const tokens = await exchangeCode(code, redirectUriFor(url.origin))
    if (!tokens.refresh_token) return back('microsoft=error&reason=no_refresh_token')
    await connectAccount(row.user_id, tokens)
    return back('microsoft=connected')
  } catch (e) {
    return back(`microsoft=error&reason=${encodeURIComponent(e?.message ?? 'exchange_failed')}`)
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
  if (unconfigured || !user) return Response.json({ error: 'Outlook needs a signed-in account (Supabase) — not available in local mode.' }, { status: 501 })

  let body
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 })
  }
  const action = body?.action

  try {
    if (action === 'status') {
      const configured = microsoftConfigured()
      const accounts = configured ? await listAccounts(user.id) : []
      return Response.json({ configured, accounts: accounts.map(publicAccount), missing: missingMicrosoftEnv(), redirectUri: redirectUriFor(url.origin) })
    }
    if (!microsoftConfigured()) return Response.json({ error: `Outlook is not configured on the host: set ${missingMicrosoftEnv().join(', ')}` }, { status: 501 })

    if (action === 'auth') {
      if (body.native) {
        const handoff = newHandoff()
        await settingsSet(user.id, { oauth_handoff: handoff, oauth_handoff_at: new Date().toISOString() })
        return Response.json({ url: `${url.origin}/api/microsoft/start?h=${handoff}` })
      }
      const verifier = newVerifier()
      const state = stateFor(verifier)
      await settingsSet(user.id, { ms_oauth_state: state, ms_state_at: new Date().toISOString() })
      return Response.json(
        { url: authUrl(process.env.MICROSOFT_CLIENT_ID, redirectUriFor(url.origin), state, body.loginHint) },
        { headers: { 'set-cookie': cookieHeader(MS_COOKIE, verifier) } },
      )
    }
    if (action === 'disconnect') {
      await disconnectAccount(user.id, String(body.accountId ?? ''))
      return Response.json({ accounts: (await listAccounts(user.id)).map(publicAccount) })
    }
    if (action === 'calendars') {
      const accounts = await listAccounts(user.id)
      const out = []
      for (const a of accounts) {
        try {
          out.push({ account: publicAccount(a), calendars: await listCalendars(user.id, a.id) })
        } catch (e) {
          out.push({ account: publicAccount(a), calendars: [], error: e?.message ?? 'could not list calendars' })
        }
      }
      return Response.json({ accounts: out })
    }
    if (action === 'push') {
      const accountId = String(body.accountId ?? '')
      const tasks = Array.isArray(body.tasks) ? body.tasks.slice(0, 200) : []
      const projectNames = body.projects && typeof body.projects === 'object' ? body.projects : {}
      const calendarId = await drafterCalendarId(user.id, accountId)
      const results = { created: 0, updated: 0, removed: 0, skipped: 0 }
      const errors = []
      for (const t of tasks) {
        try {
          results[await pushTask(user.id, accountId, calendarId, t, t.projectId ? projectNames[t.projectId] : undefined, url.origin)]++
        } catch (e) {
          errors.push({ id: t.id, error: e?.message ?? String(e) })
          if (e?.status === 409 || e?.status === 401 || e?.status === 403) break
        }
      }
      return Response.json({ calendarId, ...results, errors })
    }
    if (action === 'pull') {
      const accountId = String(body.accountId ?? '')
      const since = Number.isFinite(Date.parse(body.since)) ? new Date(body.since).toISOString() : new Date(Date.now() - 7 * 86_400_000).toISOString()
      const calendarId = await drafterCalendarId(user.id, accountId)
      return Response.json({ changes: await pullChanges(user.id, accountId, calendarId, since.replace(/\.\d{3}Z$/, 'Z')), at: new Date().toISOString() })
    }
    return Response.json({ error: 'unknown action' }, { status: 400 })
  } catch (e) {
    const status = e?.status === 409 || e?.status === 401 ? 409 : e?.status === 501 ? 501 : 502
    return Response.json({ error: e?.message ?? 'Microsoft request failed' }, { status })
  }
}

export default withCors(handler)
