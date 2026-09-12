import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as oauth from '../../netlify/functions/lib/oauthserver.mjs'
import { MAX_LIVE_CONNECTIONS, hashToken } from '../../netlify/functions/lib/agentauth.mjs'

// The OAuth 2.1 server assistants connect through. PostgREST is an in-memory
// stand-in here whose functions follow 20260921000000_agent_access.sql (the
// SQL itself is exercised by db:smoke and, through these same endpoints, by
// mcp:smoke); this pins the protocol: metadata, registration, consent that
// never redirects on a bad request, PKCE, single-use codes, refresh rotation.

const SITE = 'https://drafter.example'
const DB = 'https://db.example.test'
const USER = '00000000-0000-0000-0000-00000000000a'
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
const LOOPBACK = 'http://127.0.0.1:33418/callback'
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk' // RFC 7636 appendix B
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'

type Client = { client_id: string; client_name: string; redirect_uris: string[]; created_at: string; window_start: number | null; window_count: number }
type Code = { code_hash: string; client_id: string; user_id: string; redirect_uri: string; code_challenge: string; scopes: string[]; resource: string; expires_at: string; used_at: number | null; grant_id: string | null }
type Token = Record<string, any> & { id: string; revoked_at: string | null }

let clients: Map<string, Client>
let codes: Map<string, Code>
let tokens: Token[]
let calls: { path: string; method: string; search: string; body: any }[]

const iso = (ms: number) => new Date(ms).toISOString()

/** The SQL functions of the migration, in miniature. */
const RPC: Record<string, (a: any) => unknown> = {
  oauth_prune: () => null,
  oauth_client_use: ({ p_client_id, p_limit }) => {
    const k = clients.get(p_client_id)
    if (!k) return null
    const now = Date.now()
    if (k.window_start !== null && k.window_start > now - 60_000) k.window_count++
    else {
      k.window_start = now
      k.window_count = 1
    }
    return { client_id: k.client_id, client_name: k.client_name, redirect_uris: k.redirect_uris, over_limit: k.window_count > p_limit }
  },
  oauth_redeem_code: ({ p_hash }) => {
    const c = codes.get(p_hash)
    if (c && c.used_at === null && Date.parse(c.expires_at) > Date.now()) {
      c.used_at = Date.now()
      const { client_id, user_id, redirect_uri, code_challenge, scopes, resource } = c
      return { outcome: 'ok', client_id, user_id, redirect_uri, code_challenge, scopes, resource }
    }
    if (c && c.used_at !== null) {
      const t = tokens.find(x => x.id === c.grant_id && !x.revoked_at)
      if (t) t.revoked_at = iso(Date.now())
      return { outcome: 'reused' }
    }
    return { outcome: 'invalid' }
  },
  oauth_attach_grant: ({ p_hash, p_grant }) => {
    const c = codes.get(p_hash)
    if (c && c.grant_id === null) c.grant_id = p_grant
    return !!c
  },
  agent_token_rotate: ({ p_client_id, p_refresh_hash, p_new_access_hash, p_new_refresh_hash }) => {
    const now = Date.now()
    const done = (outcome: string, t: Token) => ({ outcome, grant_id: t.id, user_id: t.user_id, scopes: t.scopes })
    let t = tokens.find(x => x.refresh_hash === p_refresh_hash && x.client_id === p_client_id && !x.revoked_at && (!x.refresh_expires_at || Date.parse(x.refresh_expires_at) > now))
    if (t) {
      Object.assign(t, { prev_refresh_hash: t.refresh_hash, refresh_hash: p_new_refresh_hash, access_hash: p_new_access_hash, access_expires_at: iso(now + 3_600_000), refreshed_at: now })
      return done('rotated', t)
    }
    t = tokens.find(x => x.prev_refresh_hash === p_refresh_hash && x.client_id === p_client_id && !x.revoked_at && x.refreshed_at > now - 60_000)
    if (t) {
      Object.assign(t, { refresh_hash: p_new_refresh_hash, access_hash: p_new_access_hash })
      return done('rotated', t)
    }
    t = tokens.find(x => x.prev_refresh_hash === p_refresh_hash && !x.revoked_at)
    if (t) {
      t.revoked_at = iso(now)
      return done('reused', t)
    }
    return { outcome: 'invalid' }
  },
}

function install() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path: url.pathname, method, search: url.search, body })
    const q = url.searchParams
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
    const fn = /^\/rest\/v1\/rpc\/(.+)$/.exec(url.pathname)?.[1]
    if (fn && RPC[fn]) return json(RPC[fn](body ?? {}))
    if (url.pathname === '/rest/v1/oauth_clients') {
      if (method === 'POST') {
        const row: Client = { ...body, created_at: iso(Date.now()), window_start: null, window_count: 0 }
        clients.set(row.client_id, row)
        return json([row], 201)
      }
      if (q.get('client_id')) return json([...clients.values()].filter(k => q.get('client_id') === `eq.${k.client_id}`))
      const since = Date.parse(String(q.get('created_at')).replace(/^gte\./, ''))
      const [from, to] = String(headers.get('range')).split('-').map(Number)
      return json([...clients.values()].filter(k => Date.parse(k.created_at) >= since).slice(from, to + 1))
    }
    if (url.pathname === '/rest/v1/oauth_codes' && method === 'POST') {
      codes.set(body.code_hash, { ...body, used_at: null, grant_id: null })
      return new Response(null, { status: 201 })
    }
    if (url.pathname === '/rest/v1/agent_tokens') {
      if (method === 'POST') {
        const row: Token = { id: randomUUID(), created_at: iso(Date.now()), last_used_at: null, revoked_at: null, prev_refresh_hash: null, refreshed_at: null, token_prefix: null, ...body }
        tokens.push(row)
        return json([row], 201)
      }
      if (method === 'GET') return json(tokens.filter(t => q.get('user_id') === `eq.${t.user_id}` && !t.revoked_at))
      if (method === 'PATCH') {
        const or = /^\(access_hash\.eq\.([0-9a-f]+),refresh_hash\.eq\.([0-9a-f]+)\)$/.exec(String(q.get('or')))
        const client = q.get('client_id')?.replace(/^eq\./, '')
        for (const t of tokens) if (or && !t.revoked_at && (t.access_hash === or[1] || t.refresh_hash === or[2]) && (!client || t.client_id === client)) t.revoked_at = body.revoked_at
        return new Response(null, { status: 204 })
      }
    }
    if (url.pathname === '/auth/v1/user') return headers.get('authorization') === 'Bearer app-session' ? json({ id: USER, email: 'owner@example.test' }) : json({ msg: 'bad jwt' }, 401)
    if (url.pathname === '/rest/v1/user_settings') return method === 'GET' ? json([]) : new Response('', { status: 201 })
    return new Response(`the stub does not serve ${method} ${url.pathname}`, { status: 599 })
  }) as typeof fetch
}

beforeAll(() => {
  process.env.SUPABASE_URL = DB
  process.env.SUPABASE_ANON_KEY = 'anon-key'
  process.env.SUPABASE_SERVICE_KEY = 'service-key'
  process.env.URL = SITE
  delete process.env.CONTEXT
  delete process.env.DEPLOY_PRIME_URL
  delete process.env.OAUTH_REDIRECT_ALLOWLIST
})

beforeEach(() => {
  clients = new Map()
  codes = new Map()
  tokens = []
  calls = []
  install()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function register(redirects = [REDIRECT], name = 'Claude') {
  const r = await oauth.registerClient({ redirect_uris: redirects, client_name: name, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] })
  expect(r.status).toBe(201)
  return r.json!.client_id as string
}
const authorize = (clientId: string, over: Record<string, string> = {}) =>
  new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: 'S256', state: 'st4te', resource: `${SITE}/api/mcp`, scope: 'read write', ...over })
async function codeFor(clientId: string, scopes: string[] = ['read', 'write'], params = authorize(clientId)) {
  const a = await oauth.approve(USER, params, { decision: 'allow', scopes, timezone: 'Europe/London' })
  if (!a.ok) throw new Error(a.message)
  return new URL(a.redirect).searchParams.get('code')!
}
const exchange = (clientId: string, code: string, over: Record<string, string> = {}) =>
  oauth.tokenEndpoint(new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: VERIFIER, ...over }))
const refreshWith = (clientId: string, refresh: string) => oauth.tokenEndpoint(new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refresh }))

describe('metadata', () => {
  it('serves RFC 9728 protected-resource metadata for /api/mcp', async () => {
    expect(oauth.protectedResourceMetadata()).toEqual({
      resource: `${SITE}/api/mcp`,
      authorization_servers: [SITE],
      scopes_supported: ['read', 'write', 'journal'],
      bearer_methods_supported: ['header'],
      resource_name: 'Drafter',
    })
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/api/mcp', '/.netlify/functions/oauth/prm']) {
      const res = await oauth.oauthHandler(new Request(`${SITE}${path}`, { headers: { origin: 'https://claude.ai' } }))
      expect(res.status, path).toBe(200)
      expect(res.headers.get('cache-control')).toBe('public, max-age=3600')
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      expect((await res.json()).resource).toBe(`${SITE}/api/mcp`)
    }
  })

  it('serves RFC 8414 server metadata, also at the OpenID alias', async () => {
    expect(oauth.authorizationServerMetadata()).toMatchObject({
      issuer: SITE,
      authorization_endpoint: `${SITE}/oauth/authorize`,
      token_endpoint: `${SITE}/oauth/token`,
      registration_endpoint: `${SITE}/oauth/register`,
      revocation_endpoint: `${SITE}/oauth/revoke`,
      scopes_supported: ['read', 'write', 'journal'],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      authorization_response_iss_parameter_supported: true,
    })
    for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
      const res = await oauth.oauthHandler(new Request(`${SITE}${path}`))
      expect((await res.json()).issuer, path).toBe(SITE)
    }
  })

  it('takes the issuer from Netlify\'s environment (a deploy preview\'s own URL), never the Host header', async () => {
    process.env.CONTEXT = 'deploy-preview'
    process.env.DEPLOY_PRIME_URL = 'https://deploy-preview-7--drafterz.netlify.app/'
    try {
      expect(oauth.issuer()).toBe('https://deploy-preview-7--drafterz.netlify.app')
      const res = await oauth.oauthHandler(new Request('https://evil.example/.well-known/oauth-authorization-server', { headers: { host: 'evil.example' } }))
      expect((await res.json()).issuer).toBe('https://deploy-preview-7--drafterz.netlify.app')
    } finally {
      delete process.env.CONTEXT
      delete process.env.DEPLOY_PRIME_URL
    }
    expect(oauth.issuer()).toBe(SITE)
  })

  it('routes the public paths and their function rewrites, and nothing else', () => {
    expect(oauth.routeOf('/oauth/token')).toBe('token')
    expect(oauth.routeOf('/.netlify/functions/oauth/register')).toBe('register')
    expect(oauth.routeOf('/api/oauth/request')).toBe('request')
    expect(oauth.routeOf('/.netlify/functions/oauth/app/approve')).toBe('approve')
    expect(oauth.routeOf('/oauth/authorize')).toBeNull()
    expect(oauth.routeOf('/oauth/token/../admin')).toBeNull()
  })
})

describe('redirects and PKCE', () => {
  it('allows https on an allow-listed host exactly, and http only on loopback', () => {
    expect(oauth.redirectAllowed(REDIRECT)).toBe(true)
    expect(oauth.redirectAllowed('https://claude.com/cb')).toBe(true)
    expect(oauth.redirectAllowed(LOOPBACK)).toBe(true)
    expect(oauth.redirectAllowed('http://localhost:9/cb')).toBe(true)
    expect(oauth.redirectAllowed('https://evil.claude.ai/cb')).toBe(false)
    expect(oauth.redirectAllowed('https://claude.ai.evil.example/cb')).toBe(false)
    expect(oauth.redirectAllowed('http://claude.ai/cb')).toBe(false)
    expect(oauth.redirectAllowed('http://example.com/cb')).toBe(false)
    expect(oauth.redirectAllowed(`${REDIRECT}#frag`)).toBe(false)
    expect(oauth.redirectAllowed('https://user:pw@claude.ai/cb')).toBe(false)
    expect(oauth.redirectAllowed('javascript:alert(1)')).toBe(false)
    expect(oauth.redirectAllowed('cursor://anysphere/cb')).toBe(false)
    expect(oauth.redirectAllowed('https://example.org/cb', 'example.org')).toBe(true)
    expect(oauth.redirectAllowed(LOOPBACK, 'claude.ai')).toBe(false)
  })

  it('follows OAUTH_REDIRECT_ALLOWLIST when it is set', () => {
    process.env.OAUTH_REDIRECT_ALLOWLIST = 'claude.ai'
    try {
      expect(oauth.redirectAllowed('https://claude.com/cb')).toBe(false)
      expect(oauth.redirectAllowed(LOOPBACK)).toBe(false)
      expect(oauth.redirectAllowed(REDIRECT)).toBe(true)
    } finally {
      delete process.env.OAUTH_REDIRECT_ALLOWLIST
    }
  })

  it('matches redirects exactly, except a loopback redirect\'s port', () => {
    expect(oauth.sameRedirect(REDIRECT, REDIRECT)).toBe(true)
    expect(oauth.sameRedirect(REDIRECT, `${REDIRECT}/`)).toBe(false)
    expect(oauth.sameRedirect(REDIRECT, 'https://claude.ai:8443/api/mcp/auth_callback')).toBe(false)
    expect(oauth.sameRedirect(LOOPBACK, 'http://127.0.0.1:50000/callback')).toBe(true)
    expect(oauth.sameRedirect(LOOPBACK, 'http://127.0.0.1:50000/other')).toBe(false)
    expect(oauth.sameRedirect(LOOPBACK, 'http://localhost:33418/callback')).toBe(false)
  })

  it('checks PKCE S256 against RFC 7636\'s own example', () => {
    expect(createHash('sha256').update(VERIFIER).digest('base64url')).toBe(CHALLENGE)
    expect(oauth.pkceS256Matches(VERIFIER, CHALLENGE)).toBe(true)
    expect(oauth.pkceS256Matches(`${VERIFIER}x`, CHALLENGE)).toBe(false)
    expect(oauth.pkceS256Matches('short', CHALLENGE)).toBe(false)
    expect(oauth.pkceS256Matches(VERIFIER, '')).toBe(false)
  })
})

describe('dynamic client registration', () => {
  it('registers a public client and says so', async () => {
    const r = await oauth.registerClient({ redirect_uris: [REDIRECT, REDIRECT], client_name: 'Claude', application_type: 'web' })
    expect(r.status).toBe(201)
    expect(r.json).toMatchObject({ client_name: 'Claude', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' })
    expect(r.json!.client_id).toMatch(/^dcr_[A-Za-z0-9_-]{22}$/)
    expect(typeof r.json!.client_id_issued_at).toBe('number')
    expect(calls.some(c => c.path === '/rest/v1/rpc/oauth_prune')).toBe(true)
    expect((await oauth.registerClient({ redirect_uris: [LOOPBACK] })).json!.client_name).toBe('AI assistant')
  })

  it('refuses redirects off the allow-list, confidential clients and other grants', async () => {
    const refuse = async (body: unknown, error: string) => {
      const r = await oauth.registerClient(body)
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect(r.json!.error).toBe(error)
    }
    await refuse({ redirect_uris: ['https://evil.example/cb'] }, 'invalid_redirect_uri')
    await refuse({ redirect_uris: [`${REDIRECT}#x`] }, 'invalid_redirect_uri')
    await refuse({ redirect_uris: [] }, 'invalid_redirect_uri')
    await refuse({ redirect_uris: Array.from({ length: 6 }, (_, i) => `http://localhost:${4000 + i}/cb`) }, 'invalid_redirect_uri')
    await refuse({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' }, 'invalid_client_metadata')
    await refuse({ redirect_uris: [REDIRECT], grant_types: ['client_credentials'] }, 'invalid_client_metadata')
    await refuse({ redirect_uris: [REDIRECT], response_types: ['token'] }, 'invalid_client_metadata')
    await refuse(null, 'invalid_client_metadata')
    expect(clients.size).toBe(0)
  })

  it('throttles the site to thirty registrations an hour', async () => {
    for (let i = 0; i < oauth.REGISTRATIONS_PER_HOUR; i++) await register()
    const r = await oauth.registerClient({ redirect_uris: [REDIRECT] })
    expect(r.status).toBe(429)
    expect(r.headers?.['retry-after']).toBeDefined()
  })
})

describe('consent: request and approve', () => {
  it('describes a good request: who, where it goes back to, what it asked for', async () => {
    const id = await register()
    expect(await oauth.describeAuthorizeRequest(USER, authorize(id))).toEqual({
      ok: true,
      clientName: 'Claude',
      redirectHost: 'claude.ai',
      loopback: false,
      requestedScopes: ['read', 'write'],
      existingConnectionId: null,
    })
    const local = await register([LOOPBACK], 'Claude Code')
    const desc = await oauth.describeAuthorizeRequest(USER, authorize(local, { redirect_uri: 'http://127.0.0.1:6001/callback', scope: 'read journal' }))
    expect(desc).toMatchObject({ ok: true, loopback: true, redirectHost: '127.0.0.1', requestedScopes: ['read', 'journal'] })
  })

  it('never redirects a request that does not check out', async () => {
    const id = await register()
    const cases: [URLSearchParams, string][] = [
      [authorize('dcr_nobodyregisteredthis0'), 'unknown_client'],
      [authorize(id, { redirect_uri: 'https://claude.ai/elsewhere' }), 'redirect_mismatch'],
      [authorize(id, { response_type: 'token' }), 'unsupported_response_type'],
      [authorize(id, { code_challenge_method: 'plain' }), 'pkce_required'],
      [authorize(id, { code_challenge: '' }), 'pkce_required'],
      [authorize(id, { resource: 'https://other.example/api/mcp' }), 'invalid_resource'],
    ]
    for (const [params, error] of cases) {
      for (const answer of [await oauth.describeAuthorizeRequest(USER, params), await oauth.approve(USER, params, { decision: 'allow', scopes: ['read'] })]) {
        expect(answer, error).toMatchObject({ ok: false, error })
        expect(answer, error).not.toHaveProperty('redirect')
      }
    }
    process.env.OAUTH_REDIRECT_ALLOWLIST = 'claude.com'
    try {
      expect(await oauth.approve(USER, authorize(id), { decision: 'deny' })).toMatchObject({ ok: false, error: 'redirect_not_allowed' })
    } finally {
      delete process.env.OAUTH_REDIRECT_ALLOWLIST
    }
    expect(codes.size).toBe(0)
  })

  it('deny sends access_denied with state and iss, and stores nothing', async () => {
    const id = await register()
    const a = await oauth.approve(USER, authorize(id), { decision: 'deny' })
    expect(a).toEqual({ ok: true, redirect: `${REDIRECT}?error=access_denied&state=st4te&iss=${encodeURIComponent(SITE)}` })
    expect(codes.size).toBe(0)
  })

  it('allow stores a hashed, five-minute code for exactly what the user ticked, read always included', async () => {
    const id = await register()
    const a = await oauth.approve(USER, authorize(id), { decision: 'allow', scopes: ['journal', 'admin'], timezone: 'Europe/London' })
    if (!a.ok) throw new Error(a.message)
    const back = new URL(a.redirect)
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT)
    expect([...back.searchParams.keys()]).toEqual(['code', 'state', 'iss'])
    expect(back.searchParams.get('iss')).toBe(SITE)
    const code = back.searchParams.get('code')!
    expect(codes.has(code)).toBe(false)
    const stored = codes.get(hashToken(code))!
    expect(stored).toMatchObject({ client_id: id, user_id: USER, redirect_uri: REDIRECT, code_challenge: CHALLENGE, scopes: ['read', 'journal'], resource: `${SITE}/api/mcp` })
    expect(Date.parse(stored.expires_at) - Date.now()).toBeGreaterThan(oauth.CODE_TTL_MS - 5000)
    expect(Date.parse(stored.expires_at) - Date.now()).toBeLessThanOrEqual(oauth.CODE_TTL_MS)
  })

  it('refuses a twenty-first connection before issuing a code', async () => {
    const id = await register()
    for (let i = 0; i < MAX_LIVE_CONNECTIONS; i++) tokens.push({ id: `t${i}`, user_id: USER, kind: 'token', name: 'x', scopes: ['read'], created_at: iso(Date.now()), revoked_at: null })
    expect(await oauth.approve(USER, authorize(id), { decision: 'allow', scopes: ['read'] })).toMatchObject({ ok: false, error: 'limit' })
    expect(codes.size).toBe(0)
  })
})

describe('the token endpoint', () => {
  it('exchanges a code for a Bearer pair, and stores only their hashes', async () => {
    const id = await register()
    const code = await codeFor(id)
    const r = await exchange(id, code)
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'read write' })
    expect(r.json!.access_token).toMatch(/^drft_at_[A-Za-z0-9_-]{43}$/)
    expect(r.json!.refresh_token).toMatch(/^drft_rt_[A-Za-z0-9_-]{43}$/)
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toMatchObject({
      user_id: USER,
      kind: 'oauth',
      name: 'Claude',
      client_id: id,
      redirect_host: 'claude.ai',
      resource: `${SITE}/api/mcp`,
      scopes: ['read', 'write'],
      access_hash: hashToken(r.json!.access_token),
      refresh_hash: hashToken(r.json!.refresh_token),
    })
    expect(JSON.stringify(tokens)).not.toContain(r.json!.access_token)
    expect(codes.get(hashToken(code))!.grant_id).toBe(tokens[0].id)
  })

  it('a code works once: a replay is refused and revokes the connection it made', async () => {
    const id = await register()
    const code = await codeFor(id)
    expect((await exchange(id, code)).status).toBe(200)
    const replay = await exchange(id, code)
    expect(replay).toMatchObject({ status: 400, json: { error: 'invalid_grant' } })
    expect(tokens[0].revoked_at).not.toBeNull()
  })

  it('refuses a wrong verifier, redirect, resource or client — and the code is spent either way', async () => {
    const id = await register()
    const other = await register()
    const tries: [Record<string, string>, string, string][] = [
      [{ code_verifier: `${VERIFIER.slice(0, -1)}A` }, 'invalid_grant', 'a wrong verifier'],
      [{ redirect_uri: 'https://claude.ai/other' }, 'invalid_grant', 'another redirect'],
      [{ resource: 'https://other.example/api/mcp' }, 'invalid_target', 'another resource'],
      [{ client_id: other }, 'invalid_grant', 'another client'],
    ]
    for (const [over, error, what] of tries) {
      const code = await codeFor(id)
      expect(await exchange(id, code, over), what).toMatchObject({ status: 400, json: { error } })
      expect((await exchange(id, code)).json!.error, `${what}: the code is spent`).toBe('invalid_grant')
    }
    expect(tokens).toHaveLength(0)
  })

  it('an unknown client is 401 invalid_client; missing or unknown parameters are 400', async () => {
    expect(await exchange('dcr_nobodyregisteredthis0', 'x')).toMatchObject({ status: 401, json: { error: 'invalid_client' } })
    const id = await register()
    expect(await oauth.tokenEndpoint(new URLSearchParams({ client_id: id }))).toMatchObject({ status: 400, json: { error: 'invalid_request' } })
    expect(await oauth.tokenEndpoint(new URLSearchParams({ grant_type: 'password', client_id: id }))).toMatchObject({ status: 400, json: { error: 'unsupported_grant_type' } })
    expect(await oauth.tokenEndpoint(new URLSearchParams({ grant_type: 'authorization_code', client_id: id }))).toMatchObject({ status: 400, json: { error: 'invalid_request' } })
    expect(await oauth.tokenEndpoint(new URLSearchParams({ grant_type: 'authorization_code', code: 'x', redirect_uri: REDIRECT, code_verifier: VERIFIER }))).toMatchObject({ status: 400, json: { error: 'invalid_request' } })
  })

  it('rotates refresh tokens, forgives a retry within 60 s, and revokes on a replay after that', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-12T10:00:00.000Z'))
    const id = await register()
    const first = (await exchange(id, await codeFor(id))).json!
    const second = await refreshWith(id, first.refresh_token)
    expect(second).toMatchObject({ status: 200, json: { token_type: 'Bearer', expires_in: 3600, scope: 'read write' } })
    expect(second.json!.refresh_token).not.toBe(first.refresh_token)
    expect(tokens[0].access_hash).toBe(hashToken(second.json!.access_token))

    // the client never saw that answer and retries with the old token: a fresh pair, the missed one dead
    vi.setSystemTime(new Date('2026-09-12T10:00:30.000Z'))
    const retry = await refreshWith(id, first.refresh_token)
    expect(retry.status).toBe(200)
    expect(tokens[0].refresh_hash).toBe(hashToken(retry.json!.refresh_token))
    expect((await refreshWith(id, second.json!.refresh_token)).json!.error).toBe('invalid_grant')

    // the same old token a minute later is someone else's copy: the connection goes
    vi.setSystemTime(new Date('2026-09-12T10:01:01.000Z'))
    expect(await refreshWith(id, first.refresh_token)).toMatchObject({ status: 400, json: { error: 'invalid_grant' } })
    expect(tokens[0].revoked_at).not.toBeNull()
    expect((await refreshWith(id, retry.json!.refresh_token)).json!.error).toBe('invalid_grant')
  })

  it('a refresh token only works for its own client, and not once it has expired', async () => {
    const id = await register()
    const other = await register()
    const pair = (await exchange(id, await codeFor(id))).json!
    expect((await refreshWith(other, pair.refresh_token)).json!.error).toBe('invalid_grant')
    tokens[0].refresh_expires_at = iso(Date.now() - 1000)
    expect((await refreshWith(id, pair.refresh_token)).json!.error).toBe('invalid_grant')
    expect(await oauth.tokenEndpoint(new URLSearchParams({ grant_type: 'refresh_token', client_id: id, refresh_token: pair.refresh_token, resource: 'https://x.example' }))).toMatchObject({
      status: 400,
      json: { error: 'invalid_target' },
    })
  })

  it('throttles one client to thirty token requests a minute', async () => {
    const id = await register()
    for (let i = 0; i < oauth.TOKEN_REQUESTS_PER_MINUTE; i++) expect((await exchange(id, `nope-${i}`)).status).toBe(400)
    const r = await exchange(id, 'one-more')
    expect(r.status).toBe(429)
    expect(r.headers?.['retry-after']).toBe('60')
  })

  it('revokes by access or refresh token, and answers 200 whatever it was given', async () => {
    const id = await register()
    const pair = (await exchange(id, await codeFor(id))).json!
    expect(await oauth.revokeEndpoint(new URLSearchParams({ token: 'nonsense' }))).toEqual({ status: 200 })
    expect(await oauth.revokeEndpoint(new URLSearchParams({}))).toEqual({ status: 200 })
    expect(tokens[0].revoked_at).toBeNull()
    expect(await oauth.revokeEndpoint(new URLSearchParams({ token: pair.refresh_token, client_id: id }))).toEqual({ status: 200 })
    expect(tokens[0].revoked_at).not.toBeNull()
  })
})

describe('the function', () => {
  const form = (fields: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://claude.ai' }, body: new URLSearchParams(fields).toString() })

  it('token responses are no-store, open to any origin, form-encoded or JSON, at either path', async () => {
    const id = await register()
    const code = await codeFor(id)
    const res = await oauth.oauthHandler(new Request(`${SITE}/oauth/token`, form({ grant_type: 'authorization_code', client_id: id, code, redirect_uri: REDIRECT, code_verifier: VERIFIER })))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('pragma')).toBe('no-cache')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const json = await oauth.oauthHandler(
      new Request(`${SITE}/.netlify/functions/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', client_id: id, refresh_token: (await res.json()).refresh_token }) }),
    )
    expect(json.status).toBe(200)
    const err = await oauth.oauthHandler(new Request(`${SITE}/oauth/token`, form({ grant_type: 'nope', client_id: id })))
    expect(err.status).toBe(400)
    expect(err.headers.get('cache-control')).toBe('no-store')
    expect((await oauth.oauthHandler(new Request(`${SITE}/oauth/token`))).status).toBe(405)
    const pre = await oauth.oauthHandler(new Request(`${SITE}/oauth/token`, { method: 'OPTIONS', headers: { origin: 'https://claude.ai' } }))
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('registers over HTTP', async () => {
    const res = await oauth.oauthHandler(new Request(`${SITE}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Claude' }) }))
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('request and approve need the app\'s session and keep the app-only CORS', async () => {
    const id = await register()
    const call = (route: string, body: unknown, headers: Record<string, string>) =>
      oauth.oauthHandler(new Request(`${SITE}/api/oauth/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }))
    expect((await call('request', { params: authorize(id).toString() }, {})).status).toBe(401)
    const fromApp = await call('request', { params: `?${authorize(id).toString()}` }, { authorization: 'Bearer app-session', origin: 'capacitor://localhost' })
    expect(fromApp.status).toBe(200)
    expect(fromApp.headers.get('access-control-allow-origin')).toBe('capacitor://localhost')
    expect((await fromApp.json()).clientName).toBe('Claude')
    const fromElsewhere = await call('request', { params: authorize(id).toString() }, { authorization: 'Bearer app-session', origin: 'https://evil.example' })
    expect(fromElsewhere.headers.get('access-control-allow-origin')).toBeNull()
    const bad = await call('request', { params: authorize('dcr_nobodyregisteredthis0').toString() }, { authorization: 'Bearer app-session' })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ ok: false, error: 'unknown_client' })
    const approved = await call('approve', { params: authorize(id).toString(), decision: 'allow', scopes: ['read', 'write'], timezone: 'Europe/London' }, { authorization: 'Bearer app-session' })
    expect(approved.status).toBe(200)
    expect((await approved.json()).redirect).toMatch(/^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?code=/)
    const preflight = await oauth.oauthHandler(new Request(`${SITE}/api/oauth/approve`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }))
    expect(preflight.status).toBe(403)
  })
})
