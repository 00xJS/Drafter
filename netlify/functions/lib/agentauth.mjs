// Agent connections: the bearer tokens assistants present on /api/mcp, the
// Supabase session each request then acts under, and /api/agents, where the
// signed-in app lists, creates, renames and revokes them.
//
// A connection belongs to one user and acts only as that user. Every database
// read and write an assistant causes goes through that user's own JWT, so the
// posts policies (household sharing, personal kinds, ownership of new rows)
// apply exactly as they do in the app. The service key is used for three
// things only: the three service-only tables of 20260921000000_agent_access,
// the admin user lookup, and generate_link.
//
// Secrets are never stored or logged: a token is shown once, kept as its
// SHA-256 hex, and only its first few characters ever appear in the UI.

import { createHash, randomBytes } from 'node:crypto'
import { getUser } from './session.mjs'
import { adoptTimeZone } from './timezone.mjs'

/** Fixed prefixes, so secret scanners can find a leaked token. */
export const PREFIX = { manual: 'drft_', access: 'drft_at_', refresh: 'drft_rt_' }
export const SCOPES = ['read', 'write', 'journal']
/** Live connections (tokens and OAuth grants together) one account may hold. */
export const MAX_LIVE_CONNECTIONS = 20
/** A minted session is replaced this long before it expires. */
const SESSION_MARGIN_MS = 60_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function newSecret(prefix = '') {
  return `${prefix}${randomBytes(32).toString('base64url')}`
}

export function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex')
}

/** Known scopes in a stable order, `read` always among them. */
export function normalizeScopes(scopes) {
  const list = Array.isArray(scopes) ? scopes : typeof scopes === 'string' ? scopes.split(/[\s,]+/) : []
  const wanted = new Set(list.map(s => String(s).trim()))
  wanted.add('read')
  return SCOPES.filter(s => wanted.has(s))
}

export function supabaseEnv() {
  return {
    url: (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, ''),
    anonKey: process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? '',
    serviceKey: process.env.SUPABASE_SERVICE_KEY ?? '',
  }
}

/** Everything /api/mcp and the OAuth server need: the project URL, the anon key and the service key. */
export function agentAuthConfigured() {
  const e = supabaseEnv()
  return !!(e.url && e.anonKey && e.serviceKey)
}

function httpError(message, status, code) {
  return Object.assign(new Error(message), { status, code })
}

/**
 * PostgREST with the service key — for the three service-only tables and
 * their functions, nothing else. A 404 means the table or function is not
 * there: the migration has not been applied, which callers report as 501.
 */
export async function serviceRest(path, { method = 'GET', body, headers = {} } = {}) {
  const { url, serviceKey } = supabaseEnv()
  if (!url || !serviceKey) throw httpError('SUPABASE_SERVICE_KEY is not set on the host', 501, 'not_configured')
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) {
    const status = res.status === 404 ? 501 : 502
    throw httpError(`Supabase ${res.status}: ${text.slice(0, 200)}`, status, status === 501 ? 'not_configured' : 'upstream')
  }
  return text ? JSON.parse(text) : null
}

// ---------------------------------------------------------------- bearer check

/**
 * Check a bearer from /api/mcp against the live connections. Every request
 * asks the database, so a revoked connection stops at its very next call.
 */
export async function checkBearer(bearer, { limit = Number(process.env.MCP_RATE_LIMIT_PER_MIN) || 60 } = {}) {
  const token = typeof bearer === 'string' ? bearer.trim() : ''
  // a refresh token is never a bearer, and nothing else we issue lacks the prefix
  if (!token.startsWith(PREFIX.manual) || token.startsWith(PREFIX.refresh) || token.length < 40 || token.length > 200) return { error: 'invalid' }
  const row = await serviceRest('/rest/v1/rpc/agent_token_use', { method: 'POST', body: { p_hash: hashToken(token), p_limit: limit } })
  if (!row || typeof row !== 'object' || !row.grant_id || !row.user_id) return { error: 'invalid' }
  if (row.over_limit) return { error: 'rate_limited' }
  return {
    grantId: String(row.grant_id),
    userId: String(row.user_id),
    scopes: SCOPES.filter(s => Array.isArray(row.scopes) && row.scopes.includes(s)),
    kind: row.kind === 'oauth' ? 'oauth' : 'token',
  }
}

// ---------------------------------------------------------- acting as the user
//
// Decision (a) of the design: mint a real session for the user the way a
// magic link would, without sending anything. The admin API makes a one-time
// link (generate_link emails nothing) and /verify redeems its hashed token
// with the anon key, exactly as the browser would. Plain fetch on purpose:
// supabase-js's verifyOtp stores the session inside the client, and a client
// shared across users would hand one user's session to the next.

/** userId -> { accessToken, refreshAtMs } */
const sessions = new Map()
/** userId -> the mint in flight, so concurrent requests share one */
const minting = new Map()

function sessionError(message) {
  return httpError(`Drafter could not act as you: ${message}`, 502, 'session')
}

async function mintSession(userId) {
  const { url, anonKey, serviceKey } = supabaseEnv()
  if (!url || !anonKey || !serviceKey) throw httpError('Assistants are not configured on this site.', 501, 'not_configured')
  const admin = { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' }

  const who = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { headers: admin })
  if (!who.ok) throw sessionError(`the account lookup failed (${who.status}).`)
  const user = await who.json()
  const banned = Date.parse(user?.banned_until ?? '')
  if (Number.isFinite(banned) && banned > Date.now()) throw sessionError('this account is suspended.')
  const email = typeof user?.email === 'string' ? user.email : ''
  if (!email) throw sessionError('the account has no email address to sign in with.')

  const link = await fetch(`${url}/auth/v1/admin/generate_link`, { method: 'POST', headers: admin, body: JSON.stringify({ type: 'magiclink', email }) })
  if (!link.ok) throw sessionError(`generate_link answered ${link.status}.`)
  const linkBody = await link.json()
  // auth-js moves these into `properties`; the raw endpoint returns them at the top level
  const props = linkBody?.properties ?? linkBody
  const hashed = typeof props?.hashed_token === 'string' ? props.hashed_token : ''
  if (!hashed) throw sessionError('generate_link returned no token.')

  const verify = type =>
    fetch(`${url}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ type, token_hash: hashed }),
    })
  const firstType = typeof props.verification_type === 'string' && props.verification_type ? props.verification_type : 'magiclink'
  let res = await verify(firstType)
  // 'magiclink' is deprecated as a verify type; newer auth servers want 'email'
  if (res.status >= 400 && res.status < 500 && firstType !== 'email') res = await verify('email')
  if (!res.ok) throw sessionError(`verify answered ${res.status}.`)
  const body = await res.json()
  const session = body?.session ?? body
  const accessToken = typeof session?.access_token === 'string' ? session.access_token : ''
  if (!accessToken) throw sessionError('verify returned no session.')
  const sessionUser = session.user?.id ?? body?.user?.id
  if (sessionUser && sessionUser !== userId) throw sessionError('the session belongs to a different account.')

  const expiresAt = Number(session.expires_at)
  const expiresIn = Number(session.expires_in)
  const expiresAtMs = expiresAt > 0 ? expiresAt * 1000 : Date.now() + (expiresIn > 0 ? expiresIn : 3600) * 1000
  return { accessToken, refreshAtMs: expiresAtMs - SESSION_MARGIN_MS }
}

/** Best effort: end a session this process no longer uses. */
function logout(accessToken) {
  const { url, anonKey } = supabaseEnv()
  if (!url || !anonKey) return
  fetch(`${url}/auth/v1/logout?scope=local`, { method: 'POST', headers: { apikey: anonKey, authorization: `Bearer ${accessToken}` } }).catch(() => {})
}

/** A JWT for this user, minted at most once at a time and reused until a minute before it expires. */
export async function userAccessToken(userId) {
  const cached = sessions.get(userId)
  if (cached && Date.now() < cached.refreshAtMs) return cached.accessToken
  let pending = minting.get(userId)
  if (!pending) {
    pending = mintSession(userId)
      .then(session => {
        const replaced = sessions.get(userId)
        sessions.set(userId, session)
        if (replaced && replaced.accessToken !== session.accessToken) logout(replaced.accessToken)
        return session.accessToken
      })
      .finally(() => minting.delete(userId))
    minting.set(userId, pending)
  }
  return pending
}

/** PostgREST said 401: forget the session so the next call mints a fresh one. */
export function dropSession(userId) {
  sessions.delete(userId)
}

/** Tests and a cold start only. */
export function forgetAllSessions() {
  sessions.clear()
  minting.clear()
}

// ----------------------------------------------------------------- connections

const CONNECTION_COLUMNS = 'id,kind,name,redirect_host,scopes,token_prefix,created_at,last_used_at,refresh_expires_at'

/** A display name: one line, printable, at most `max` characters. */
export function cleanName(name, max = 80) {
  // control characters become spaces (no regex: a control range in one is its own lint error)
  return Array.from(String(name ?? ''), ch => {
    const code = ch.codePointAt(0) ?? 0
    return code < 32 || code === 127 ? ' ' : ch
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim()
}

function toConnection(r) {
  return {
    id: r.id,
    kind: r.kind === 'oauth' ? 'oauth' : 'token',
    name: r.name,
    redirectHost: r.redirect_host ?? null,
    scopes: SCOPES.filter(s => Array.isArray(r.scopes) && r.scopes.includes(s)),
    tokenPrefix: r.token_prefix ?? null,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at ?? null,
  }
}

/** Live connections, newest first. An OAuth grant whose refresh token has expired is gone for good. */
export async function listConnections(userId) {
  const rows = await serviceRest(`/rest/v1/agent_tokens?select=${CONNECTION_COLUMNS}&user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null&order=created_at.desc`)
  const now = Date.now()
  return (Array.isArray(rows) ? rows : []).filter(r => r.kind !== 'oauth' || !r.refresh_expires_at || Date.parse(r.refresh_expires_at) > now).map(toConnection)
}

/** A manual token for Claude Code or a local stdio server. The secret leaves this function once. */
export async function createManualToken(userId, { name, scopes } = {}) {
  const clean = cleanName(name)
  if (!clean) throw httpError('Give the token a name.', 400, 'invalid')
  if (!Array.isArray(scopes) || !scopes.includes('read') || scopes.some(s => !SCOPES.includes(s))) {
    throw httpError('scopes must include "read" and may add "write" and "journal".', 400, 'invalid')
  }
  if ((await listConnections(userId)).length >= MAX_LIVE_CONNECTIONS) throw httpError('limit', 409, 'limit')
  const token = newSecret(PREFIX.manual)
  const rows = await serviceRest(`/rest/v1/agent_tokens?select=${CONNECTION_COLUMNS}`, {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: {
      user_id: userId,
      kind: 'token',
      name: clean,
      scopes: SCOPES.filter(s => scopes.includes(s)),
      token_prefix: token.slice(0, PREFIX.manual.length + 4),
      access_hash: hashToken(token),
    },
  })
  const row = Array.isArray(rows) ? rows[0] : rows
  if (!row?.id) throw httpError('the token was not stored', 502, 'upstream')
  return { token, connection: toConnection(row) }
}

async function patchOwn(userId, id, patch) {
  if (!UUID.test(String(id ?? ''))) return false
  const rows = await serviceRest(`/rest/v1/agent_tokens?id=eq.${id}&user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null&select=id`, {
    method: 'PATCH',
    headers: { prefer: 'return=representation' },
    body: patch,
  })
  return Array.isArray(rows) && rows.length > 0
}

/** Revoke one of the user's own connections. The next request on it is a 401. */
export function revokeConnection(userId, id) {
  return patchOwn(userId, id, { revoked_at: new Date().toISOString() })
}

export async function renameConnection(userId, id, name) {
  const clean = cleanName(name)
  if (!clean) return false
  return patchOwn(userId, id, { name: clean })
}

// ------------------------------------------------------------------ /api/agents

const NO_STORE = { 'cache-control': 'no-store' }

/**
 * /api/agents, session-gated like feed.mjs:
 *   GET                                         -> { configured, connections }
 *   POST { action: 'create', name, scopes, timezone } -> 201 { token, connection } (the only time the secret is sent)
 *   POST { action: 'revoke', id } | { action: 'rename', id, name } -> { ok }
 */
export async function agentsHandler(req) {
  if (req.method !== 'GET' && req.method !== 'POST') return Response.json({ error: 'method not allowed' }, { status: 405, headers: { allow: 'GET, POST, OPTIONS' } })
  const { user, response, unconfigured } = await getUser(req)
  if (response) return response
  const configured = !unconfigured && !!user && agentAuthConfigured()
  if (!configured) {
    if (req.method === 'GET') return Response.json({ configured: false, connections: [] }, { headers: NO_STORE })
    return Response.json({ error: 'not configured' }, { status: 501 })
  }
  try {
    if (req.method === 'GET') return Response.json({ configured: true, connections: await listConnections(user.id) }, { headers: NO_STORE })
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') return Response.json({ error: 'expected a JSON body' }, { status: 400 })
    if (body.action === 'create') {
      const created = await createManualToken(user.id, { name: body.name, scopes: body.scopes })
      await adoptTimeZone(user.id, body.timezone)
      return Response.json(created, { status: 201, headers: NO_STORE })
    }
    if (body.action === 'revoke') return Response.json({ ok: await revokeConnection(user.id, body.id) })
    if (body.action === 'rename') {
      if (!cleanName(body.name)) return Response.json({ error: 'Give the connection a name.' }, { status: 400 })
      return Response.json({ ok: await renameConnection(user.id, body.id, body.name) })
    }
    return Response.json({ error: 'unknown action' }, { status: 400 })
  } catch (e) {
    if (e?.code === 'limit') return Response.json({ error: 'limit' }, { status: 409 })
    if (e?.status === 400) return Response.json({ error: e.message }, { status: 400 })
    if (e?.status === 501) return Response.json({ error: 'not configured' }, { status: 501 })
    return Response.json({ error: 'Assistants are unavailable right now — try again.' }, { status: 502 })
  }
}
