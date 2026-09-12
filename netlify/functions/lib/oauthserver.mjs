// The OAuth 2.1 authorization server assistants use to connect to Drafter —
// claude.ai's custom connectors (and so the Claude phone apps), Claude Code,
// any MCP client: RFC 9728 protected-resource metadata, RFC 8414 server
// metadata, RFC 7591 registration of public clients, the authorization-code
// flow with PKCE S256, refresh-token rotation and RFC 7009 revocation.
// Not to be confused with lib/oauth.mjs, which binds Google and Microsoft
// sign-ins to the browser that started them.
//
// Consent is not a page of this function's: /oauth/authorize is the signed-in
// app itself (src/oauthRequest.ts keeps the query, ConnectAssistantSheet asks),
// which calls /api/oauth/request and /api/oauth/approve with its own session.
//
// The rules: public clients only; PKCE S256 required; exact redirect matching,
// the port ignored for loopback (RFC 8252); single-use hashed codes that live
// five minutes, and a replayed code revokes what it made; `iss` on every
// authorization response (RFC 9207); `resource` bound to /api/mcp (RFC 8707);
// refresh tokens rotate, with a 60 s grace for a lost response and revocation
// on a later replay; no token ever in a URL; every token response no-store;
// and a request that does not check out never redirects anywhere.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { withCors, withPublicCors } from './cors.mjs'
import { getUser } from './session.mjs'
import { adoptTimeZone } from './timezone.mjs'
import { MAX_LIVE_CONNECTIONS, PREFIX, SCOPES, agentAuthConfigured, cleanName, hashToken, listConnections, newSecret, normalizeScopes, serviceRest } from './agentauth.mjs'

export const DEFAULT_SITE = 'https://drafterz.netlify.app'
export const DEFAULT_REDIRECT_ALLOWLIST = 'claude.ai,claude.com,localhost,127.0.0.1'
export const CODE_TTL_MS = 5 * 60_000
export const ACCESS_TTL_S = 3600
const REFRESH_TTL_MS = 90 * 86_400_000
export const REGISTRATIONS_PER_HOUR = 30
export const TOKEN_REQUESTS_PER_MINUTE = 30
const LOOPBACK = new Set(['localhost', '127.0.0.1'])
const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' }

const trimSlash = s => String(s ?? '').replace(/\/+$/, '')

/** This site's origin, from Netlify's environment — never the Host header. Deploy previews use their own URL. */
export function issuer() {
  const preview = process.env.CONTEXT && process.env.CONTEXT !== 'production' ? process.env.DEPLOY_PRIME_URL : ''
  return trimSlash(preview || process.env.URL || DEFAULT_SITE)
}

/** The one resource tokens are for (RFC 8707). */
export function resourceUrl() {
  return `${issuer()}/api/mcp`
}

export function protectedResourceMetadata() {
  return {
    resource: resourceUrl(),
    authorization_servers: [issuer()],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Drafter',
  }
}

export function authorizationServerMetadata() {
  const base = issuer()
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    scopes_supported: [...SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
  }
}

function parseUri(uri) {
  if (typeof uri !== 'string' || !uri || uri.length > 2000) return null
  try {
    return new URL(uri)
  } catch {
    return null
  }
}

/**
 * May an assistant be sent back here? https on an allow-listed host (exactly,
 * no subdomains), or http on localhost / 127.0.0.1 at any port when those are
 * listed too. No fragment, no credentials, no other scheme.
 */
export function redirectAllowed(uri, allowlist = process.env.OAUTH_REDIRECT_ALLOWLIST ?? DEFAULT_REDIRECT_ALLOWLIST) {
  const u = parseUri(uri)
  if (!u || uri.includes('#') || u.username || u.password) return false
  const hosts = String(allowlist)
    .split(',')
    .map(h => h.trim().toLowerCase())
    .filter(Boolean)
  const host = u.hostname.toLowerCase()
  if (u.protocol === 'https:') return hosts.includes(host)
  if (u.protocol === 'http:') return LOOPBACK.has(host) && hosts.includes(host)
  return false
}

/** Exact match, except that a loopback redirect may come back on any port (RFC 8252 §7.3). */
export function sameRedirect(registered, given) {
  if (registered === given) return true
  const a = parseUri(registered)
  const b = parseUri(given)
  if (!a || !b || a.protocol !== 'http:' || b.protocol !== 'http:' || !LOOPBACK.has(a.hostname) || a.hostname !== b.hostname) return false
  return a.pathname === b.pathname && a.search === b.search && !a.hash && !b.hash
}

/** base64url(sha256(verifier)) === challenge, for a verifier of RFC 7636's shape. */
export function pkceS256Matches(verifier, challenge) {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false
  if (typeof challenge !== 'string' || !challenge) return false
  const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'))
  const given = Buffer.from(challenge)
  return computed.length === given.length && timingSafeEqual(computed, given)
}

/** Query-string, form or JSON parameters as URLSearchParams (strings only). */
function paramsOf(input) {
  if (input instanceof URLSearchParams) return input
  if (typeof input === 'string') return new URLSearchParams(input.startsWith('?') ? input.slice(1) : input)
  const p = new URLSearchParams()
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const [k, v] of Object.entries(input)) if (typeof v === 'string') p.set(k, v)
  }
  return p
}

const hostOf = uri => parseUri(uri)?.hostname ?? null

async function findClient(clientId) {
  if (typeof clientId !== 'string' || !/^dcr_[A-Za-z0-9_-]{16,64}$/.test(clientId)) return null
  const rows = await serviceRest(`/rest/v1/oauth_clients?client_id=eq.${encodeURIComponent(clientId)}&select=client_id,client_name,redirect_uris`)
  return Array.isArray(rows) && rows[0] ? rows[0] : null
}

// -------------------------------------------------------------- registration

const registrationError = (error, description) => ({ status: 400, json: { error, error_description: description } })

/** RFC 7591, public clients only. -> { status, json } */
export async function registerClient(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return registrationError('invalid_client_metadata', 'Expected a JSON object.')
  const uris = body.redirect_uris
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || uris.some(u => typeof u !== 'string')) {
    return registrationError('invalid_redirect_uri', 'redirect_uris must list one to five URIs.')
  }
  const refused = uris.find(u => !redirectAllowed(u))
  if (refused !== undefined) {
    return registrationError('invalid_redirect_uri', `${refused.slice(0, 200)} is not allowed: use https on an allow-listed host, or http on localhost / 127.0.0.1, with no fragment.`)
  }
  if ((body.token_endpoint_auth_method ?? 'none') !== 'none') {
    return registrationError('invalid_client_metadata', 'Only public clients are supported: token_endpoint_auth_method must be "none".')
  }
  const grants = body.grant_types ?? ['authorization_code', 'refresh_token']
  if (!Array.isArray(grants) || !grants.includes('authorization_code') || grants.some(g => g !== 'authorization_code' && g !== 'refresh_token')) {
    return registrationError('invalid_client_metadata', 'grant_types may only be authorization_code and refresh_token.')
  }
  const responses = body.response_types ?? ['code']
  if (!Array.isArray(responses) || responses.some(r => r !== 'code')) return registrationError('invalid_client_metadata', 'response_types must be ["code"].')
  const name = cleanName(body.client_name, 100) || 'AI assistant'

  // housekeeping rides along with the rare call that creates rows
  await serviceRest('/rest/v1/rpc/oauth_prune', { method: 'POST', body: {} }).catch(() => null)
  const since = new Date(Date.now() - 3_600_000).toISOString()
  const recent = await serviceRest(`/rest/v1/oauth_clients?select=client_id&created_at=gte.${encodeURIComponent(since)}`, {
    headers: { 'range-unit': 'items', range: `0-${REGISTRATIONS_PER_HOUR - 1}` },
  })
  if (Array.isArray(recent) && recent.length >= REGISTRATIONS_PER_HOUR) {
    return { status: 429, json: { error: 'temporarily_unavailable', error_description: 'Too many new connections this hour — try again later.' }, headers: { 'retry-after': '600' } }
  }

  const clientId = `dcr_${randomBytes(16).toString('base64url')}`
  const redirects = [...new Set(uris)]
  const rows = await serviceRest('/rest/v1/oauth_clients?select=client_id,created_at', {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: { client_id: clientId, client_name: name, redirect_uris: redirects },
  })
  const created = Date.parse((Array.isArray(rows) ? rows[0] : rows)?.created_at ?? '')
  return {
    status: 201,
    json: {
      client_id: clientId,
      client_id_issued_at: Math.floor((Number.isFinite(created) ? created : Date.now()) / 1000),
      client_name: name,
      redirect_uris: redirects,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
  }
}

// ------------------------------------------------------- consent (app-only)

/** Check an authorization request. Failures carry a message for the consent sheet and never a redirect. */
async function validateAuthorize(input) {
  const p = paramsOf(input)
  const fail = (error, message) => ({ ok: false, error, message })
  if (p.get('response_type') !== 'code') return fail('unsupported_response_type', 'Drafter only issues authorization codes (response_type=code).')
  const client = await findClient(p.get('client_id'))
  if (!client) return fail('unknown_client', 'This request comes from an app Drafter does not know, or its registration has expired. Start connecting again from the assistant.')
  const registered = Array.isArray(client.redirect_uris) ? client.redirect_uris : []
  const redirect = p.get('redirect_uri') || (registered.length === 1 ? registered[0] : '')
  if (!redirect || !registered.some(r => sameRedirect(r, redirect))) return fail('redirect_mismatch', 'The app asked to be sent somewhere it did not register. Nothing was shared.')
  if (!redirectAllowed(redirect)) return fail('redirect_not_allowed', `Drafter does not send connections back to ${hostOf(redirect) ?? 'that address'}.`)
  const challenge = p.get('code_challenge') ?? ''
  if (p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return fail('pkce_required', 'The app must use PKCE (S256). Update the assistant and try again.')
  }
  const resource = p.get('resource')
  if (resource && trimSlash(resource) !== resourceUrl()) return fail('invalid_resource', 'The app asked for access to something other than Drafter.')
  const requested = (p.get('scope') ?? '').split(/\s+/).filter(s => SCOPES.includes(s))
  return {
    ok: true,
    client,
    redirect,
    state: p.get('state'),
    challenge,
    resource: resourceUrl(),
    requestedScopes: requested.length ? normalizeScopes(requested) : ['read', 'write'],
  }
}

/** What the consent sheet shows: who is asking, where the answer goes, what they asked for. */
export async function describeAuthorizeRequest(userId, params) {
  const v = await validateAuthorize(params)
  if (!v.ok) return v
  const host = hostOf(v.redirect)
  let existingConnectionId = null
  try {
    const live = await listConnections(userId)
    existingConnectionId = live.find(c => c.kind === 'oauth' && c.name === cleanName(v.client.client_name, 80) && c.redirectHost === host)?.id ?? null
  } catch {
    /* only a hint */
  }
  return { ok: true, clientName: v.client.client_name, redirectHost: host, loopback: LOOPBACK.has(host), requestedScopes: v.requestedScopes, existingConnectionId }
}

/**
 * The user's answer. Allow stores a single-use code (hashed, five minutes)
 * bound to the client, the exact redirect, the PKCE challenge, the scopes the
 * user ticked (read always among them) and the resource; deny sends
 * access_denied. Both carry `state` and `iss`. -> { ok, redirect } | { ok: false, error, message }
 */
export async function approve(userId, params, { decision, scopes, timezone } = {}) {
  const v = await validateAuthorize(params)
  if (!v.ok) return v
  const back = fields => {
    const u = new URL(v.redirect)
    for (const [k, value] of Object.entries(fields)) u.searchParams.set(k, value)
    if (v.state) u.searchParams.set('state', v.state)
    u.searchParams.set('iss', issuer())
    return u.toString()
  }
  if (decision !== 'allow') return { ok: true, redirect: back({ error: 'access_denied' }) }
  if ((await listConnections(userId)).length >= MAX_LIVE_CONNECTIONS) {
    return { ok: false, error: 'limit', message: `You already have ${MAX_LIVE_CONNECTIONS} connections — revoke one in Settings → Assistants, then connect again.` }
  }
  const code = newSecret('')
  await serviceRest('/rest/v1/oauth_codes', {
    method: 'POST',
    headers: { prefer: 'return=minimal' },
    body: {
      code_hash: hashToken(code),
      client_id: v.client.client_id,
      user_id: userId,
      redirect_uri: v.redirect,
      code_challenge: v.challenge,
      scopes: normalizeScopes(scopes),
      resource: v.resource,
      expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    },
  })
  await adoptTimeZone(userId, timezone)
  return { ok: true, redirect: back({ code }) }
}

// -------------------------------------------------------------------- tokens

const tokenError = (status, error, description) => ({ status, json: { error, error_description: description } })

const tokenPair = (access, refresh, scopes) => ({
  access_token: access,
  token_type: 'Bearer',
  expires_in: ACCESS_TTL_S,
  refresh_token: refresh,
  scope: scopes.join(' '),
})

/** POST /oauth/token (form-encoded or JSON). -> { status, json, headers? } */
export async function tokenEndpoint(input) {
  const f = paramsOf(input)
  const grantType = f.get('grant_type')
  if (!grantType) return tokenError(400, 'invalid_request', 'grant_type is required.')
  if (grantType !== 'authorization_code' && grantType !== 'refresh_token') return tokenError(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.')
  const clientId = f.get('client_id')
  if (!clientId) return tokenError(400, 'invalid_request', 'client_id is required.')
  const client = /^dcr_[A-Za-z0-9_-]{16,64}$/.test(clientId)
    ? await serviceRest('/rest/v1/rpc/oauth_client_use', { method: 'POST', body: { p_client_id: clientId, p_limit: TOKEN_REQUESTS_PER_MINUTE } })
    : null
  if (!client || typeof client !== 'object' || !client.client_id) return tokenError(401, 'invalid_client', 'Unknown client — register again.')
  if (client.over_limit) return { status: 429, json: { error: 'temporarily_unavailable', error_description: 'Too many token requests from this app — wait a minute.' }, headers: { 'retry-after': '60' } }

  if (grantType === 'authorization_code') {
    const code = f.get('code')
    const redirect = f.get('redirect_uri')
    const verifier = f.get('code_verifier')
    if (!code || !redirect || !verifier) return tokenError(400, 'invalid_request', 'code, redirect_uri and code_verifier are required.')
    const codeHash = hashToken(code)
    // single use: redeeming marks it used whatever the checks below decide
    const redeemed = await serviceRest('/rest/v1/rpc/oauth_redeem_code', { method: 'POST', body: { p_hash: codeHash } })
    if (redeemed?.outcome === 'reused') return tokenError(400, 'invalid_grant', 'That code was already used, so the connection it made has been revoked. Connect again.')
    if (redeemed?.outcome !== 'ok') return tokenError(400, 'invalid_grant', 'The code is invalid or has expired.')
    if (redeemed.client_id !== clientId) return tokenError(400, 'invalid_grant', 'The code was issued to a different app.')
    if (redeemed.redirect_uri !== redirect) return tokenError(400, 'invalid_grant', 'redirect_uri does not match the authorization request.')
    const resource = f.get('resource')
    if (resource && trimSlash(resource) !== redeemed.resource) return tokenError(400, 'invalid_target', 'The code was issued for a different resource.')
    if (!pkceS256Matches(verifier, redeemed.code_challenge)) return tokenError(400, 'invalid_grant', 'code_verifier does not match the code challenge.')

    const access = newSecret(PREFIX.access)
    const refresh = newSecret(PREFIX.refresh)
    const scopes = normalizeScopes(redeemed.scopes)
    const now = Date.now()
    const rows = await serviceRest('/rest/v1/agent_tokens?select=id', {
      method: 'POST',
      headers: { prefer: 'return=representation' },
      body: {
        user_id: redeemed.user_id,
        kind: 'oauth',
        name: cleanName(client.client_name, 80) || 'AI assistant',
        client_id: clientId,
        redirect_host: hostOf(redirect),
        resource: redeemed.resource,
        scopes,
        access_hash: hashToken(access),
        access_expires_at: new Date(now + ACCESS_TTL_S * 1000).toISOString(),
        refresh_hash: hashToken(refresh),
        refresh_expires_at: new Date(now + REFRESH_TTL_MS).toISOString(),
      },
    })
    const grantId = (Array.isArray(rows) ? rows[0] : rows)?.id
    if (!grantId) throw Object.assign(new Error('the connection was not stored'), { status: 502 })
    await serviceRest('/rest/v1/rpc/oauth_attach_grant', { method: 'POST', body: { p_hash: codeHash, p_grant: grantId } })
    return { status: 200, json: tokenPair(access, refresh, scopes) }
  }

  const refresh = f.get('refresh_token')
  if (!refresh) return tokenError(400, 'invalid_request', 'refresh_token is required.')
  const resource = f.get('resource')
  if (resource && trimSlash(resource) !== resourceUrl()) return tokenError(400, 'invalid_target', 'Tokens here are only for Drafter’s /api/mcp.')
  if (!refresh.startsWith(PREFIX.refresh) || refresh.length > 200) return tokenError(400, 'invalid_grant', 'The refresh token is invalid, expired or revoked.')
  const access = newSecret(PREFIX.access)
  const next = newSecret(PREFIX.refresh)
  const rotated = await serviceRest('/rest/v1/rpc/agent_token_rotate', {
    method: 'POST',
    body: { p_client_id: clientId, p_refresh_hash: hashToken(refresh), p_new_access_hash: hashToken(access), p_new_refresh_hash: hashToken(next) },
  })
  if (rotated?.outcome === 'reused') return tokenError(400, 'invalid_grant', 'That refresh token was already used, so the connection has been revoked. Connect again.')
  if (rotated?.outcome !== 'rotated') return tokenError(400, 'invalid_grant', 'The refresh token is invalid, expired or revoked.')
  return { status: 200, json: tokenPair(access, next, normalizeScopes(rotated.scopes)) }
}

/** POST /oauth/revoke (RFC 7009): by access or refresh token; always 200, whether or not it matched. */
export async function revokeEndpoint(input) {
  const f = paramsOf(input)
  const token = f.get('token')
  if (token && token.startsWith(PREFIX.manual) && token.length <= 200) {
    const h = hashToken(token)
    const clientId = f.get('client_id')
    const forClient = clientId ? `&client_id=eq.${encodeURIComponent(clientId)}` : ''
    await serviceRest(`/rest/v1/agent_tokens?or=(access_hash.eq.${h},refresh_hash.eq.${h})&revoked_at=is.null${forClient}`, {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: { revoked_at: new Date().toISOString() },
    }).catch(() => null)
  }
  return { status: 200 }
}

// -------------------------------------------------------------------- router

/** The route for a public path or its /.netlify/functions/oauth/<route> rewrite. */
export function routeOf(pathname) {
  const p = trimSlash(pathname)
  if (p === '/.well-known/oauth-protected-resource' || p.startsWith('/.well-known/oauth-protected-resource/') || p === '/.netlify/functions/oauth/prm') return 'prm'
  if (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/openid-configuration' || p === '/.netlify/functions/oauth/as') return 'as'
  const open = /^(?:\/oauth|\/\.netlify\/functions\/oauth)\/(register|token|revoke)$/.exec(p)
  if (open) return open[1]
  const app = /^(?:\/api\/oauth|\/\.netlify\/functions\/oauth\/app)\/(request|approve)$/.exec(p)
  if (app) return app[1]
  return null
}

function respond({ status, json, headers = {} }) {
  if (json === undefined) return new Response(null, { status, headers: { ...NO_STORE, ...headers } })
  return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json', ...NO_STORE, ...headers } })
}

/** A token request's parameters: form-encoded as the RFC says, JSON accepted too. Null past 64 KB. */
async function readParams(req) {
  const text = await req.text()
  if (text.length > 65_536) return null
  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (type === 'application/json') {
    try {
      const j = JSON.parse(text)
      return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
    } catch {
      return {}
    }
  }
  return new URLSearchParams(text)
}

async function publicRoutes(req) {
  const route = routeOf(new URL(req.url).pathname)
  if (route === 'prm' || route === 'as') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: { allow: 'GET, OPTIONS' } })
    const doc = route === 'prm' ? protectedResourceMetadata() : authorizationServerMetadata()
    return new Response(req.method === 'HEAD' ? null : JSON.stringify(doc), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' } })
  }
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST, OPTIONS' } })
  if (!agentAuthConfigured()) return respond({ status: 501, json: { error: 'temporarily_unavailable', error_description: 'Assistants are not configured on this site yet.' } })
  try {
    if (route === 'register') return respond(await registerClient(await req.json().catch(() => null)))
    const params = await readParams(req)
    if (params === null) return respond({ status: 413, json: { error: 'invalid_request', error_description: 'Request too large.' } })
    if (route === 'token') return respond(await tokenEndpoint(params))
    if (route === 'revoke') return respond(await revokeEndpoint(params))
  } catch (e) {
    const status = e?.status === 501 ? 501 : 503
    return respond({ status, json: { error: 'temporarily_unavailable', error_description: status === 501 ? 'Assistants are not configured on this site yet.' : 'Drafter could not finish that — try again.' } })
  }
  return respond({ status: 404, json: { error: 'not_found' } })
}

async function appRoutes(req) {
  const route = routeOf(new URL(req.url).pathname)
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST, OPTIONS' } })
  const { user, response, unconfigured } = await getUser(req)
  if (response) return response
  if (unconfigured || !user || !agentAuthConfigured()) {
    return Response.json({ ok: false, error: 'not_configured', message: 'Assistants are not configured on this site yet.' }, { status: 501, headers: NO_STORE })
  }
  const body = (await req.json().catch(() => null)) ?? {}
  try {
    const out =
      route === 'request'
        ? await describeAuthorizeRequest(user.id, body.params)
        : await approve(user.id, body.params, { decision: body.decision, scopes: body.scopes, timezone: body.timezone })
    return Response.json(out, { status: out.ok ? 200 : 400, headers: NO_STORE })
  } catch (e) {
    return Response.json({ ok: false, error: 'unavailable', message: 'Drafter could not check this request — try again.' }, { status: e?.status === 501 ? 501 : 502, headers: NO_STORE })
  }
}

const publicHandler = withPublicCors(publicRoutes, { methods: 'GET, POST, OPTIONS', headers: 'authorization, content-type, mcp-protocol-version' })
const appHandler = withCors(appRoutes)

/** netlify/functions/oauth.mjs: the metadata, registration, token and revocation endpoints, open to any origin; request and approve, app-only. */
export async function oauthHandler(req, context) {
  const route = routeOf(new URL(req.url).pathname)
  if (!route) return new Response('Not found', { status: 404 })
  return route === 'request' || route === 'approve' ? appHandler(req, context) : publicHandler(req, context)
}
