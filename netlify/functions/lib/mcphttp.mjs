// /api/mcp: Drafter's hosted MCP endpoint — Streamable HTTP, stateless,
// POST-only, JSON responses (no SSE stream, no session). netlify/functions/
// mcp.mjs serves this; it lives here so the tests can import it.
//
// Per request:
//   1. the bearer is checked against agent_tokens (checkBearer), so a revoked
//      connection stops at its next call;
//   2. the tool context is built lazily — initialize, ping and tools/list
//      mint no session; the first tool that touches data mints the user's
//      JWT (agentauth.userAccessToken) and reads through the posts policies;
//   3. the user's zone comes from user_settings (cached five minutes);
//   4. every tool call must finish by 8.5 s, inside Netlify's 10 s limit;
//   5. a PostgREST 401 drops the cached session, re-mints once and retries.
//
// Logged per tool call: its name, milliseconds and the first 8 characters of
// the grant id. Never a header, never an argument.

import { withPublicCors } from './cors.mjs'
import { agentAuthConfigured, dropSession, supabaseEnv, checkBearer, userAccessToken } from './agentauth.mjs'
import { issuer } from './oauthserver.mjs'
import { settingsGet } from './session.mjs'
import { validTimeZone } from './timezone.mjs'
import { createRestData } from '../../../mcp/data.mjs'
import { TOOLS, defaultNewId, defaultRand } from '../../../mcp/tools.mjs'
import { PROTOCOL_VERSIONS, SERVER_INFO, handleBody, hasInitialize, instructionsFor } from '../../../mcp/protocol.mjs'
import { makeClock } from '../../../shared/clock.mjs'

export const MAX_BODY_BYTES = 1_000_000
export const DEADLINE_MS = 8_500
const ZONE_TTL_MS = 5 * 60_000

export const MCP_CORS = {
  methods: 'POST, OPTIONS',
  headers: 'authorization, content-type, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, last-event-id',
  expose: 'www-authenticate',
}

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' }
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } })

/** Where a client learns how to get a token (RFC 9728). */
export function resourceMetadataUrl() {
  return `${issuer()}/.well-known/oauth-protected-resource/api/mcp`
}

function unauthorized(tokenSent) {
  const challenge = [`realm="drafter"`, `resource_metadata="${resourceMetadataUrl()}"`]
  if (tokenSent) challenge.push('error="invalid_token"')
  return json({ error: tokenSent ? 'invalid_token' : 'unauthorized' }, 401, { 'www-authenticate': `Bearer ${challenge.join(', ')}` })
}

const zones = new Map()

/** The user's IANA zone from user_settings, or UTC; cached for five minutes. */
async function userTimeZone(userId) {
  const hit = zones.get(userId)
  if (hit && Date.now() - hit.at < ZONE_TTL_MS) return hit.tz
  let tz = 'UTC'
  try {
    tz = validTimeZone((await settingsGet(userId))?.timezone) ?? 'UTC'
  } catch {
    /* the planner still answers, in UTC */
  }
  zones.set(userId, { tz, at: Date.now() })
  return tz
}

/** The body as text, or null past the limit (a chunked upload has no Content-Length to refuse early). */
async function readBody(req, limit) {
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function mcpHandler(req) {
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST, OPTIONS' } })

  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get('authorization') ?? '')?.[1]
  if (!bearer) return unauthorized(false)
  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (type !== 'application/json') return json({ error: 'Content-Type must be application/json' }, 415)
  const declared = Number(req.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return json({ error: 'body over 1 MB' }, 413)
  if (!agentAuthConfigured()) return json({ error: 'not configured' }, 501)

  let grant
  try {
    grant = await checkBearer(bearer)
  } catch (e) {
    if (e?.status === 501) return json({ error: 'not configured' }, 501)
    return json({ error: 'Drafter could not check the token — try again.' }, 503, { 'retry-after': '5' })
  }
  if (grant.error === 'rate_limited') return json({ error: 'rate_limited' }, 429, { 'retry-after': '60' })
  if (grant.error) return unauthorized(true)

  const raw = await readBody(req, MAX_BODY_BYTES)
  if (raw === null) return json({ error: 'body over 1 MB' }, 413)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400)
  }
  // after initialize a client names the version it negotiated; initialize itself may carry anything
  const version = req.headers.get('mcp-protocol-version')
  if (version && !PROTOCOL_VERSIONS.includes(version) && !hasInitialize(parsed)) {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `Unsupported MCP-Protocol-Version "${version}"; this server speaks ${PROTOCOL_VERSIONS.join(', ')}` } }, 400)
  }

  const { url, anonKey } = supabaseEnv()
  const { userId, scopes, grantId } = grant
  const buildContext = async () => ({
    db: createRestData({
      baseUrl: url,
      mode: 'user',
      userId,
      auth: async () => ({ apikey: anonKey, bearer: await userAccessToken(userId) }),
      onUnauthorized: () => dropSession(userId),
    }),
    clock: makeClock(await userTimeZone(userId)),
    scopes,
    userId,
    newId: defaultNewId,
    rand: defaultRand,
  })
  const result = await handleBody(parsed, {
    tools: TOOLS,
    scopes,
    ctx: buildContext,
    serverInfo: SERVER_INFO,
    instructions: ctx => instructionsFor({ tz: ctx.clock.tz, scopes }),
    deadlineMs: Date.now() + DEADLINE_MS,
    onToolCall: ({ name, ms, isError }) => console.log(`mcp ${grantId.slice(0, 8)} ${name} ${ms}ms${isError ? ' error' : ''}`),
  })
  if (result.status === 202) return new Response(null, { status: 202 })
  return json(result.json, result.status)
}

/** The deployed handler: open CORS for any MCP client, bearer-only. */
export const mcpEndpoint = withPublicCors(mcpHandler, MCP_CORS)
