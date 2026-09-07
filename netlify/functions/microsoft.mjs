// Outlook / Microsoft 365 connection, per signed-in user, several accounts at
// once. Routes (see netlify.toml):
//   GET  /api/microsoft/callback   OAuth redirect target (state -> user)
//   POST /api/microsoft            { action } — session-gated:
//        status | auth | disconnect | calendars | push | pull
// Setup: Azure Portal -> App registrations -> New registration, "Accounts in
// any organizational directory and personal Microsoft accounts", redirect URI
// https://<site>/api/microsoft/callback -> MICROSOFT_CLIENT_ID and a client
// secret in MICROSOFT_CLIENT_SECRET.

import { getUser, settingsFind, settingsGet, settingsSet } from './lib/session.mjs'
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
  randomState,
} from './lib/microsoft.mjs'

const redirectUriFor = origin => `${origin}/api/microsoft/callback`
const STATE_TTL_MS = 10 * 60_000

async function callback(url) {
  const back = q => Response.redirect(`${url.origin}/?${q}`, 302)
  if (!microsoftConfigured()) return back('microsoft=error&reason=not_configured')
  if (url.searchParams.get('error')) return back(`microsoft=error&reason=${encodeURIComponent(url.searchParams.get('error_description') ?? url.searchParams.get('error'))}`)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) return back('microsoft=error&reason=bad_state')
  // the state was minted for exactly one user by a session-gated call
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

export default async req => {
  const url = new URL(req.url)
  if (url.pathname.endsWith('/callback')) {
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
    return callback(url)
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
      const state = randomState()
      await settingsSet(user.id, { ms_oauth_state: state, ms_state_at: new Date().toISOString() })
      return Response.json({ url: authUrl(process.env.MICROSOFT_CLIENT_ID, redirectUriFor(url.origin), state, body.loginHint) })
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
