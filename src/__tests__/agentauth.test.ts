import { createHash } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_LIVE_CONNECTIONS,
  PREFIX,
  agentsHandler,
  cleanName,
  createManualToken,
  dropSession,
  forgetAllSessions,
  hashToken,
  listConnections,
  newSecret,
  normalizeScopes,
  revokeConnection,
  checkBearer,
  userAccessToken,
} from '../../netlify/functions/lib/agentauth.mjs'

// Agent tokens and the user session each assistant request acts under. The
// auth server and PostgREST are stubbed at fetch; what is pinned is the shape
// of every request (which key goes where), the session cache, and that the
// secret itself never leaves the function that made it.

const DB = 'https://db.example.test'
const U1 = '00000000-0000-0000-0000-0000000000a1'
const U2 = '00000000-0000-0000-0000-0000000000a2'
const EMAILS: Record<string, string> = { [U1]: 'one@example.test', [U2]: 'two@example.test' }

type Call = { path: string; search: string; method: string; headers: Record<string, string>; body: any }
let calls: Call[] = []

interface AuthFake {
  banned?: string
  flatLink?: boolean
  rejectVerifyTypes?: string[]
  session?: (userId: string, n: number) => Record<string, unknown>
  tokens?: Record<string, unknown>[]
}
let fake: AuthFake = {}
let minted = 0

function install() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path: url.pathname, search: url.search, method, headers, body })
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
    const admin = /^\/auth\/v1\/admin\/users\/(.+)$/.exec(url.pathname)
    if (admin) return EMAILS[admin[1]] ? json({ id: admin[1], email: EMAILS[admin[1]], banned_until: fake.banned ?? null }) : json({ msg: 'not found' }, 404)
    if (url.pathname === '/auth/v1/admin/generate_link') {
      const userId = Object.keys(EMAILS).find(k => EMAILS[k] === body.email)!
      const props = { action_link: 'https://x', email_otp: '123456', hashed_token: `hashed~${userId}~${++minted}`, redirect_to: '', verification_type: 'magiclink' }
      return json(fake.flatLink ? { id: userId, email: body.email, ...props } : { properties: props, user: { id: userId } })
    }
    if (url.pathname === '/auth/v1/verify') {
      if (fake.rejectVerifyTypes?.includes(body.type)) return json({ error: 'otp_expired' }, 403)
      const [, userId, n] = String(body.token_hash).split('~')
      const session = fake.session?.(userId, Number(n)) ?? { access_token: `jwt~${userId}~${n}`, expires_in: 3600, user: { id: userId } }
      return json(session)
    }
    if (url.pathname === '/auth/v1/logout') return new Response(null, { status: 204 })
    if (url.pathname === '/auth/v1/user') return headers.authorization === 'Bearer app-session' ? json({ id: U1, email: EMAILS[U1] }) : json({ msg: 'bad jwt' }, 401)
    if (url.pathname === '/rest/v1/rpc/agent_token_use') return json(fake.tokens?.find(t => t.hash === body.p_hash)?.row ?? null)
    if (url.pathname === '/rest/v1/agent_tokens') {
      if (method === 'GET') return json(fake.tokens?.filter(t => !t.hash).map(t => t.row) ?? [])
      if (method === 'POST') return json([{ id: '11111111-2222-4333-8444-555555555555', created_at: '2026-09-12T10:00:00.000Z', last_used_at: null, redirect_host: null, refresh_expires_at: null, ...body }])
      if (method === 'PATCH') return json([{ id: 'x' }])
    }
    if (url.pathname === '/rest/v1/user_settings') return method === 'GET' ? json([]) : new Response('', { status: 201 })
    return new Response(`the stub does not serve ${method} ${url.pathname}`, { status: 599 })
  }) as typeof fetch
}

beforeAll(() => {
  process.env.SUPABASE_URL = DB
  process.env.SUPABASE_ANON_KEY = 'anon-key'
  process.env.SUPABASE_SERVICE_KEY = 'service-key'
  delete process.env.MCP_RATE_LIMIT_PER_MIN
})

beforeEach(() => {
  calls = []
  fake = {}
  minted = 0
  forgetAllSessions()
  install()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('tokens', () => {
  it('have fixed prefixes a secret scanner can find, and are stored as their SHA-256 hex', () => {
    expect(newSecret(PREFIX.manual)).toMatch(/^drft_[A-Za-z0-9_-]{43}$/)
    expect(newSecret(PREFIX.access)).toMatch(/^drft_at_[A-Za-z0-9_-]{43}$/)
    expect(newSecret(PREFIX.refresh)).toMatch(/^drft_rt_[A-Za-z0-9_-]{43}$/)
    expect(newSecret(PREFIX.manual)).not.toBe(newSecret(PREFIX.manual))
    expect(hashToken('drft_abc')).toBe(createHash('sha256').update('drft_abc').digest('hex'))
    expect(hashToken('drft_abc')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('scopes come back known, ordered, and always with read', () => {
    expect(normalizeScopes(['journal', 'admin', 'write'])).toEqual(['read', 'write', 'journal'])
    expect(normalizeScopes('write journal')).toEqual(['read', 'write', 'journal'])
    expect(normalizeScopes(undefined)).toEqual(['read'])
  })

  it('names are one printable line', () => {
    expect(cleanName('  Claude\tCode\n on the  laptop ')).toBe('Claude Code on the laptop')
    expect(cleanName(`bell${String.fromCharCode(7)}here`)).toBe('bell here')
    expect(cleanName('x'.repeat(200))).toHaveLength(80)
    expect(cleanName(null)).toBe('')
  })
})

describe('checkBearer', () => {
  const token = `drft_${'q'.repeat(43)}`

  it('checks the hash against the live connections with the service key and returns the grant', async () => {
    fake.tokens = [{ hash: hashToken(token), row: { grant_id: 'g-1', user_id: U1, scopes: ['read', 'journal', 'bogus'], kind: 'token', over_limit: false } }]
    expect(await checkBearer(token)).toEqual({ grantId: 'g-1', userId: U1, scopes: ['read', 'journal'], kind: 'token' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ path: '/rest/v1/rpc/agent_token_use', method: 'POST', body: { p_hash: hashToken(token), p_limit: 60 } })
    expect(calls[0].headers).toMatchObject({ apikey: 'service-key', authorization: 'Bearer service-key' })
    expect(JSON.stringify(calls)).not.toContain(token)
  })

  it('honours MCP_RATE_LIMIT_PER_MIN and reports a connection over it', async () => {
    fake.tokens = [{ hash: hashToken(token), row: { grant_id: 'g-1', user_id: U1, scopes: ['read'], kind: 'token', over_limit: true } }]
    process.env.MCP_RATE_LIMIT_PER_MIN = '5'
    try {
      expect(await checkBearer(token)).toEqual({ error: 'rate_limited' })
      expect(calls[0].body.p_limit).toBe(5)
    } finally {
      delete process.env.MCP_RATE_LIMIT_PER_MIN
    }
  })

  it('an unknown, revoked or expired token is invalid; a malformed one or a refresh token never reaches the database', async () => {
    expect(await checkBearer(token)).toEqual({ error: 'invalid' })
    calls = []
    for (const bad of ['', 'Bearer x', 'sk-ant-something-long-enough-to-pass-a-length-check', `drft_rt_${'r'.repeat(43)}`, 'drft_short', undefined]) {
      expect(await checkBearer(bad as string), String(bad)).toEqual({ error: 'invalid' })
    }
    expect(calls).toEqual([])
  })
})

describe('userAccessToken: a real session for the user, minted without an email', () => {
  it('looks the user up, generates a magic link and verifies its hashed token with the anon key', async () => {
    expect(await userAccessToken(U1)).toBe(`jwt~${U1}~1`)
    const [who, link, verify] = calls
    expect(who).toMatchObject({ path: `/auth/v1/admin/users/${U1}`, method: 'GET' })
    expect(who.headers).toMatchObject({ apikey: 'service-key', authorization: 'Bearer service-key' })
    expect(link).toMatchObject({ path: '/auth/v1/admin/generate_link', method: 'POST', body: { type: 'magiclink', email: EMAILS[U1] } })
    expect(link.headers).toMatchObject({ apikey: 'service-key', authorization: 'Bearer service-key' })
    expect(verify).toMatchObject({ path: '/auth/v1/verify', method: 'POST', body: { type: 'magiclink', token_hash: `hashed~${U1}~1` } })
    expect(verify.headers.apikey).toBe('anon-key')
    expect(verify.headers.authorization).toBeUndefined()
    expect(calls).toHaveLength(3)
  })

  it('reads generate_link\'s fields at the top level too, as the raw endpoint returns them', async () => {
    fake.flatLink = true
    expect(await userAccessToken(U1)).toBe(`jwt~${U1}~1`)
  })

  it('retries verify once with type "email" when the auth server refuses "magiclink"', async () => {
    fake.rejectVerifyTypes = ['magiclink']
    expect(await userAccessToken(U1)).toBe(`jwt~${U1}~1`)
    expect(calls.filter(c => c.path === '/auth/v1/verify').map(c => c.body.type)).toEqual(['magiclink', 'email'])
    fake.rejectVerifyTypes = ['magiclink', 'email']
    forgetAllSessions()
    await expect(userAccessToken(U1)).rejects.toThrow(/verify answered 403/)
  })

  it('reuses the session until a minute before it expires, then mints a new one and logs the old one out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-12T10:00:00.000Z'))
    fake.session = (userId, n) => ({ access_token: `jwt~${userId}~${n}`, expires_in: 120, user: { id: userId } }) // no expires_at
    const first = await userAccessToken(U1)
    vi.setSystemTime(new Date('2026-09-12T10:00:50.000Z'))
    expect(await userAccessToken(U1)).toBe(first)
    expect(calls.filter(c => c.path === '/auth/v1/verify')).toHaveLength(1)
    vi.setSystemTime(new Date('2026-09-12T10:01:01.000Z'))
    const second = await userAccessToken(U1)
    expect(second).not.toBe(first)
    const logout = calls.find(c => c.path === '/auth/v1/logout')
    expect(logout).toMatchObject({ method: 'POST', search: '?scope=local' })
    expect(logout?.headers).toMatchObject({ apikey: 'anon-key', authorization: `Bearer ${first}` })
  })

  it('prefers expires_at over expires_in when the auth server sends both', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-12T10:00:00.000Z'))
    const expiresAt = Date.parse('2026-09-12T11:00:00.000Z') / 1000
    fake.session = (userId, n) => ({ access_token: `jwt~${userId}~${n}`, expires_in: 30, expires_at: expiresAt, user: { id: userId } })
    const first = await userAccessToken(U1)
    vi.setSystemTime(new Date('2026-09-12T10:30:00.000Z'))
    expect(await userAccessToken(U1)).toBe(first)
    vi.setSystemTime(new Date('2026-09-12T10:59:30.000Z'))
    expect(await userAccessToken(U1)).not.toBe(first)
  })

  it('concurrent requests share one mint', async () => {
    const [a, b, c] = await Promise.all([userAccessToken(U1), userAccessToken(U1), userAccessToken(U1)])
    expect(new Set([a, b, c]).size).toBe(1)
    expect(calls.filter(c => c.path === '/auth/v1/admin/generate_link')).toHaveLength(1)
  })

  it('keeps two users apart: separate sessions, and dropping one leaves the other', async () => {
    const [one, two] = await Promise.all([userAccessToken(U1), userAccessToken(U2)])
    expect(one).toContain(U1)
    expect(two).toContain(U2)
    dropSession(U1)
    calls = []
    expect(await userAccessToken(U2)).toBe(two)
    expect(calls).toEqual([])
    const again = await userAccessToken(U1)
    expect(again).not.toBe(one)
    expect(again).toContain(U1)
    // a dropped session was already refused by PostgREST: nothing to log out
    expect(calls.some(c => c.path === '/auth/v1/logout')).toBe(false)
  })

  it('refuses a suspended account, an unknown one, and a session that belongs to someone else', async () => {
    fake.banned = '2999-01-01T00:00:00.000Z'
    await expect(userAccessToken(U1)).rejects.toThrow(/suspended/)
    fake.banned = undefined
    await expect(userAccessToken('00000000-0000-0000-0000-00000000dead')).rejects.toThrow(/account lookup failed \(404\)/)
    fake.session = () => ({ access_token: 'jwt-of-someone-else', expires_in: 3600, user: { id: U2 } })
    await expect(userAccessToken(U1)).rejects.toThrow(/different account/)
  })
})

describe('connections', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    row: { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', kind: 'token', name: 'Laptop', redirect_host: null, scopes: ['read', 'write'], token_prefix: 'drft_AbCd', created_at: '2026-09-01T00:00:00.000Z', last_used_at: null, refresh_expires_at: null, ...over },
  })

  it('lists live connections as the app shows them, dropping an OAuth grant whose refresh has expired', async () => {
    fake.tokens = [row(), row({ id: 'x2', kind: 'oauth', name: 'Claude', redirect_host: 'claude.ai', token_prefix: null, refresh_expires_at: '2020-01-01T00:00:00.000Z' })]
    expect(await listConnections(U1)).toEqual([
      { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', kind: 'token', name: 'Laptop', redirectHost: null, scopes: ['read', 'write'], tokenPrefix: 'drft_AbCd', createdAt: '2026-09-01T00:00:00.000Z', lastUsedAt: null },
    ])
    expect(calls[0].search).toContain(`user_id=eq.${U1}`)
    expect(calls[0].search).toContain('revoked_at=is.null')
  })

  it('creates a manual token: the database gets its hash and a short prefix, the caller the secret, once', async () => {
    const { token, connection } = await createManualToken(U1, { name: ' Claude Code ', scopes: ['read', 'write'] })
    expect(token).toMatch(/^drft_[A-Za-z0-9_-]{43}$/)
    const insert = calls.find(c => c.method === 'POST' && c.path === '/rest/v1/agent_tokens')!
    expect(insert.body).toEqual({ user_id: U1, kind: 'token', name: 'Claude Code', scopes: ['read', 'write'], token_prefix: token.slice(0, 9), access_hash: hashToken(token) })
    expect(JSON.stringify(calls)).not.toContain(token)
    expect(connection).toMatchObject({ kind: 'token', name: 'Claude Code', scopes: ['read', 'write'], tokenPrefix: token.slice(0, 9) })
  })

  it('refuses a nameless token, one without read, and the twenty-first', async () => {
    await expect(createManualToken(U1, { name: '  ', scopes: ['read'] })).rejects.toMatchObject({ status: 400 })
    await expect(createManualToken(U1, { name: 'x', scopes: ['write'] })).rejects.toMatchObject({ status: 400 })
    await expect(createManualToken(U1, { name: 'x', scopes: ['read', 'admin'] })).rejects.toMatchObject({ status: 400 })
    fake.tokens = Array.from({ length: MAX_LIVE_CONNECTIONS }, (_, i) => row({ id: `t${i}` }))
    await expect(createManualToken(U1, { name: 'x', scopes: ['read'] })).rejects.toMatchObject({ status: 409, code: 'limit' })
  })

  it('revokes only the user\'s own live rows, and never queries with a malformed id', async () => {
    expect(await revokeConnection(U1, 'not-a-uuid')).toBe(false)
    expect(calls).toEqual([])
    expect(await revokeConnection(U1, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')).toBe(true)
    expect(calls[0]).toMatchObject({ method: 'PATCH', path: '/rest/v1/agent_tokens' })
    expect(calls[0].search).toContain('id=eq.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    expect(calls[0].search).toContain(`user_id=eq.${U1}`)
    expect(calls[0].search).toContain('revoked_at=is.null')
    expect(Object.keys(calls[0].body)).toEqual(['revoked_at'])
  })
})

describe('/api/agents', () => {
  const req = (method: string, body?: unknown, token = 'app-session') =>
    new Request('https://drafter.example/api/agents', {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  it('needs a session', async () => {
    expect((await agentsHandler(req('GET', undefined, 'forged'))).status).toBe(401)
  })

  it('reports not configured without the service key', async () => {
    const key = process.env.SUPABASE_SERVICE_KEY
    delete process.env.SUPABASE_SERVICE_KEY
    try {
      expect(await (await agentsHandler(req('GET'))).json()).toEqual({ configured: false, connections: [] })
      expect((await agentsHandler(req('POST', { action: 'create', name: 'x', scopes: ['read'] }))).status).toBe(501)
    } finally {
      process.env.SUPABASE_SERVICE_KEY = key
    }
  })

  it('lists, creates (201, no-store, the zone adopted), revokes and renames', async () => {
    expect(await (await agentsHandler(req('GET'))).json()).toEqual({ configured: true, connections: [] })
    const created = await agentsHandler(req('POST', { action: 'create', name: 'Laptop', scopes: ['read', 'write'], timezone: 'Europe/London' }))
    expect(created.status).toBe(201)
    expect(created.headers.get('cache-control')).toBe('no-store')
    const body = await created.json()
    expect(body.token).toMatch(/^drft_/)
    expect(body.connection.name).toBe('Laptop')
    expect(calls.find(c => c.path === '/rest/v1/user_settings' && c.method === 'POST')?.body).toMatchObject({ user_id: U1, timezone: 'Europe/London' })
    expect(await (await agentsHandler(req('POST', { action: 'revoke', id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }))).json()).toEqual({ ok: true })
    expect(await (await agentsHandler(req('POST', { action: 'rename', id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Work laptop' }))).json()).toEqual({ ok: true })
    expect((await agentsHandler(req('POST', { action: 'rename', id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: ' ' }))).status).toBe(400)
    expect((await agentsHandler(req('POST', { action: 'explode' }))).status).toBe(400)
    expect((await agentsHandler(req('DELETE'))).status).toBe(405)
  })

  it('answers 409 { error: "limit" } past twenty, and 400 with a reason for bad input', async () => {
    fake.tokens = Array.from({ length: MAX_LIVE_CONNECTIONS }, (_, i) => ({ row: { id: `t${i}`, kind: 'token', name: 'x', scopes: ['read'], created_at: '2026-09-01T00:00:00.000Z' } }))
    const res = await agentsHandler(req('POST', { action: 'create', name: 'One more', scopes: ['read'] }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'limit' })
    const bad = await agentsHandler(req('POST', { action: 'create', name: 'x', scopes: ['write'] }))
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toMatch(/read/)
  })
})
