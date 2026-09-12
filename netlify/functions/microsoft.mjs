// Outlook / Microsoft 365 connection, per signed-in user, several accounts at
// once. Routes (see netlify.toml):
//   GET  /api/microsoft/callback   OAuth redirect target (state -> user)
//   POST /api/microsoft            { action } — session-gated:
//        status | auth | disconnect | calendars | push | pull
// Setup: Azure Portal -> App registrations -> New registration, "Accounts in
// any organizational directory and personal Microsoft accounts", redirect URI
// https://<site>/api/microsoft/callback -> MICROSOFT_CLIENT_ID and a client
// secret in MICROSOFT_CLIENT_SECRET.

import { adoptTimeZone } from './lib/timezone.mjs'
import { withCors } from './lib/cors.mjs'
import { getUser, settingsFind, settingsGet, settingsSet } from './lib/session.mjs'
import { runMirrorBatch } from './lib/mirror.mjs'
import { RETURN_COOKIE, clearCookieHeader, cookieHeader, handoffFresh, newHandoff, newVerifier, returnTarget, stateFor, verifyState } from './lib/oauth.mjs'
import { pushEntry,
  authUrl,
  connectAccount,
  disconnectAccount,
  exchangeCode,
  listAccounts,
  listCalendars,
  microsoftConfigured,
  missingMicrosoftEnv,
  oauthFailureCode,
  publicAccount,
  mirroredTaskIds,
  outlookMissing,
  pullChanges,
  pullEntryChanges,
  pushTask,
  resolveDrafterCalendar,
} from './lib/microsoft.mjs'

const redirectUriFor = origin => `${origin}/api/microsoft/callback`
const STATE_TTL_MS = 10 * 60_000

const MS_COOKIE = 'drafter_ms_oauth'

/** Safari, opened by the iOS app with a one-time handoff: set the cookie here, then on to Microsoft. */
async function start(url) {
  const fail = reason => new Response(null, { status: 302, headers: { location: `drafter://oauth?microsoft=error&reason=${encodeURIComponent(reason)}` } })
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
  // Microsoft's own refusal (consent, account type, a secret problem it caught
  // early). The browser only ever gets a short code — the client would collapse
  // the prose to "unknown error" anyway — so the full explanation is logged
  // here, where whoever administers the site can read it.
  if (url.searchParams.get('error')) {
    const error = url.searchParams.get('error')
    const description = url.searchParams.get('error_description') ?? ''
    console.error('microsoft callback: Microsoft returned', error, description)
    return back(`microsoft=error&reason=${encodeURIComponent(oauthFailureCode({ error, error_description: description }))}`)
  }
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) return back('microsoft=error&reason=bad_state')
  // the state must match BOTH the user row it was minted into and the cookie
  // set in this browser, so a consent URL cannot be handed to someone else
  if (!verifyState(req, MS_COOKIE, state)) return back('microsoft=error&reason=state_mismatch')
  const row = await settingsFind('ms_oauth_state', state).catch(() => null)
  if (!row || !row.ms_state_at || Date.now() - Date.parse(row.ms_state_at) > STATE_TTL_MS) return back('microsoft=error&reason=bad_state')
  await settingsSet(row.user_id, { ms_oauth_state: null, ms_state_at: null })
  let tokens
  try {
    tokens = await exchangeCode(code, redirectUriFor(url.origin))
  } catch (e) {
    // an expired or mistyped client secret lands here, as does a redirect URI
    // Azure does not know — exchangeCode has already read the AADSTS code out
    console.error('microsoft callback: token exchange failed —', e?.message)
    return back(`microsoft=error&reason=${encodeURIComponent(e?.code ?? oauthFailureCode({ error_description: e?.message }))}`)
  }
  if (!tokens.refresh_token) return back('microsoft=error&reason=no_refresh_token')
  try {
    await connectAccount(row.user_id, tokens)
  } catch (e) {
    // signed in fine; writing the account to user_settings is what failed
    console.error('microsoft callback: saving the account failed —', e?.message)
    return back('microsoft=error&reason=save_failed')
  }
  return back('microsoft=connected')
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
          out.push({ account: publicAccount(a), calendars: await listCalendars(user.id, a.id, a.drafterCalendarId ?? null) })
        } catch (e) {
          out.push({ account: publicAccount(a), calendars: [], error: e?.message ?? 'could not list calendars' })
        }
      }
      return Response.json({ accounts: out })
    }
    if (action === 'push') {
      const startedAt = Date.now()
      // judge "untimed" in the owner's zone, not UTC: adopt the device's zone
      // when the account has none, never overwriting one that was chosen
      await adoptTimeZone(user.id, body.timezone)
      const accountId = String(body.accountId ?? '')
      const projectNames = body.projects && typeof body.projects === 'object' ? body.projects : {}
      const cal = await resolveDrafterCalendar(user.id, accountId)
      const calendarId = cal.id
      const tz = (await settingsGet(user.id).catch(() => null))?.timezone ?? null
      // `records` is the sweep (tasks and entries, chunked, budgeted, `left` to
      // resend); `tasks` is an older app build, which keeps its old contract
      const sweep = Array.isArray(body.records)
      const records = sweep ? body.records : Array.isArray(body.tasks) ? body.tasks : []
      const result = await runMirrorBatch(
        records,
        r => {
          const project = r.projectId ? projectNames[r.projectId] : undefined
          if (!sweep || r.kind === 'task') return pushTask(user.id, accountId, calendarId, r, project, url.origin, { tz })
          if (r.kind === 'event') return pushEntry(user.id, accountId, calendarId, r, url.origin)
          // pushTask treats anything that is not a task as "remove its copy"
          throw Object.assign(new Error('not a task or an entry'), { status: 400 })
        },
        sweep ? { startedAt } : { budgetMs: Infinity },
      )
      return Response.json({ calendarId, replaced: cal.replaced, ...result })
    }
    if (action === 'pull') {
      const accountId = String(body.accountId ?? '')
      // stamped before reading, so a change that lands mid-read falls inside the next window
      const at = new Date().toISOString()
      const since = Number.isFinite(Date.parse(body.since)) ? new Date(body.since).toISOString() : new Date(Date.now() - 7 * 86_400_000).toISOString()
      const sinceGraph = since.replace(/\.\d{3}Z$/, 'Z')
      const cal = await resolveDrafterCalendar(user.id, accountId)
      const calendarId = cal.id
      const changes = await pullChanges(user.id, accountId, calendarId, sinceGraph)
      // entry edits need a listing of their own; only builds that apply them ask
      const entries = body.entries === true ? await pullEntryChanges(user.id, accountId, calendarId, sinceGraph) : []
      // Graph hard-deletes, so a task deleted in Outlook never shows up above.
      // The app names the tasks it believes are there; the ones the calendar no
      // longer holds were deleted by the owner, and the app treats them as it
      // treats Google's cancelled copy. Only when the app's belief is about THIS
      // calendar (not one since deleted and recreated), from a complete listing.
      let missing = []
      let resend = []
      if (Array.isArray(body.live) && body.live.length && body.calendarId === calendarId) {
        const present = await mirroredTaskIds(user.id, accountId, calendarId)
        if (present.complete) {
          const r = outlookMissing(body.live.slice(0, 2000).map(String), present.ids)
          missing = r.missing
          resend = r.suspicious ? r.absent : []
        }
      }
      return Response.json({ changes, entries, missing, resend, calendarId, replaced: cal.replaced, at })
    }
    if (action === 'push-event') {
      // one entry, one account: the client fans out across every enabled
      // Microsoft mirror, the same way it already does for tasks
      const accountId = String(body.accountId ?? '')
      const entry = body.event && typeof body.event === 'object' ? body.event : null
      if (!accountId) return Response.json({ error: 'accountId required' }, { status: 400 })
      if (!entry || typeof entry.id !== 'string') return Response.json({ error: 'event required' }, { status: 400 })
      const cal = await resolveDrafterCalendar(user.id, accountId)
      const result = await pushEntry(user.id, accountId, cal.id, entry, url.origin)
      return Response.json({ calendarId: cal.id, replaced: cal.replaced, result })
    }
    return Response.json({ error: 'unknown action' }, { status: 400 })
  } catch (e) {
    const status = e?.status === 409 || e?.status === 401 ? 409 : e?.status === 501 ? 501 : 502
    return Response.json({ error: e?.message ?? 'Microsoft request failed' }, { status })
  }
}

export default withCors(handler)
