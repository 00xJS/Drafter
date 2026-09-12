import { createHash } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mcpEndpoint } from '../../netlify/functions/lib/mcphttp.mjs'
import { forgetAllSessions } from '../../netlify/functions/lib/agentauth.mjs'
import { SCOPE_REFUSAL } from '../../mcp/protocol.mjs'
import { TOOLS } from '../../mcp/tools.mjs'

// /api/mcp end to end with fetch stubbed at the edge: the token check, the
// status codes a Streamable HTTP client relies on, lazy session minting, and
// that every data request goes out as the user — never with the service key.

const SITE = 'https://drafter.example'
const DB = 'https://db.example.test'
const USER = '00000000-0000-0000-0000-00000000000a'
const TOKEN = `drft_${'a'.repeat(43)}`
const READ_ONLY = `drft_${'r'.repeat(43)}`
const BUSY = `drft_${'b'.repeat(43)}`
const UNKNOWN = `drft_${'x'.repeat(43)}`
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const GRANTS: Record<string, Record<string, unknown>> = {
  [sha(TOKEN)]: { grant_id: 'c0ffee12-0000-4000-8000-000000000001', user_id: USER, scopes: ['read', 'write', 'journal'], kind: 'token', over_limit: false },
  [sha(READ_ONLY)]: { grant_id: 'feedface-0000-4000-8000-000000000002', user_id: USER, scopes: ['read'], kind: 'oauth', over_limit: false },
  [sha(BUSY)]: { grant_id: 'badc0de0-0000-4000-8000-000000000003', user_id: USER, scopes: ['read'], kind: 'token', over_limit: true },
}
const TASK = { kind: 'task', id: 't1', title: 'Take the bins out', description: '', status: 'todo', priority: 'normal', tags: [], updatedAt: '2026-09-08T10:00:00.000Z' }

type Call = { path: string; method: string; headers: Record<string, string>; body: any }
let calls: Call[] = []
let mints = 0
/** One-off answers for the next GETs of /rest/v1/posts. */
let postsOverrides: (() => Response)[] = []

function install() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path: url.pathname, method, headers, body })
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
    switch (url.pathname) {
      case '/rest/v1/rpc/agent_token_use':
        return json(GRANTS[body.p_hash] ?? null)
      case '/rest/v1/user_settings':
        return json([{ user_id: USER, timezone: 'Europe/London' }])
      case `/auth/v1/admin/users/${USER}`:
        return json({ id: USER, email: 'owner@example.test' })
      case '/auth/v1/admin/generate_link':
        return json({ properties: { hashed_token: `hash-${++mints}`, verification_type: 'magiclink' } })
      case '/auth/v1/verify':
        return json({ access_token: `jwt-${body.token_hash}`, expires_in: 3600, user: { id: USER } })
      case '/auth/v1/logout':
        return new Response(null, { status: 204 })
      case '/rest/v1/posts':
        return postsOverrides.shift()?.() ?? json([{ user_id: USER, data: TASK }])
      case '/rest/v1/rpc/sync_posts':
        return json({ items: body.incoming, rejected: [], stale: [], gone: [] })
    }
    return new Response(`the stub does not serve ${method} ${url.pathname}`, { status: 599 })
  }) as typeof fetch
}

beforeAll(() => {
  process.env.SUPABASE_URL = DB
  process.env.SUPABASE_ANON_KEY = 'anon-key'
  process.env.SUPABASE_SERVICE_KEY = 'service-key'
  process.env.URL = SITE
  delete process.env.CONTEXT
})

beforeEach(() => {
  calls = []
  mints = 0
  postsOverrides = []
  forgetAllSessions()
  install()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

function post(body: unknown, { token = TOKEN as string | null, headers = {} as Record<string, string>, raw = undefined as string | undefined } = {}) {
  return mcpEndpoint(
    new Request(`${SITE}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: raw ?? JSON.stringify(body),
    }),
  )
}
const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
const RESOURCE_METADATA = `${SITE}/.well-known/oauth-protected-resource/api/mcp`

describe('transport rules', () => {
  it('answers a preflight from any origin with exactly the MCP headers and no credentials', async () => {
    const res = await mcpEndpoint(new Request(`${SITE}/api/mcp`, { method: 'OPTIONS', headers: { origin: 'https://claude.ai', 'access-control-request-method': 'POST' } }))
    expect(res.status).toBe(204)
    expect(Object.fromEntries(res.headers.entries())).toEqual({
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, last-event-id',
      'access-control-expose-headers': 'www-authenticate',
      'access-control-max-age': '86400',
    })
  })

  it('is POST only: GET and DELETE are 405 with Allow', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await mcpEndpoint(new Request(`${SITE}/api/mcp`, { method }))
      expect(res.status, method).toBe(405)
      expect(res.headers.get('allow')).toBe('POST, OPTIONS')
    }
    expect(calls).toEqual([])
  })

  it('401s without a bearer, pointing at the protected-resource metadata, before touching anything', async () => {
    const res = await post(rpc(1, 'tools/list'), { token: null })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(`Bearer realm="drafter", resource_metadata="${RESOURCE_METADATA}"`)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-expose-headers')).toBe('www-authenticate')
    expect(calls).toEqual([])
  })

  it('401s an unknown or revoked token with error="invalid_token"', async () => {
    const res = await post(rpc(1, 'tools/list'), { token: UNKNOWN })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(`Bearer realm="drafter", resource_metadata="${RESOURCE_METADATA}", error="invalid_token"`)
    expect(calls.map(c => c.path)).toEqual(['/rest/v1/rpc/agent_token_use'])
    expect(calls[0].body).toEqual({ p_hash: sha(UNKNOWN), p_limit: 60 })
    expect(calls[0].headers.authorization).toBe('Bearer service-key')
    // a malformed bearer never reaches the database
    calls = []
    expect((await post(rpc(1, 'tools/list'), { token: 'not-a-drafter-token' })).status).toBe(401)
    expect(calls).toEqual([])
  })

  it('429s a connection over its per-minute limit, with Retry-After', async () => {
    const res = await post(rpc(1, 'tools/list'), { token: BUSY })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
  })

  it('415s anything but JSON, 413s a body over 1 MB, 400s one that does not parse', async () => {
    expect((await post(rpc(1, 'ping'), { headers: { 'content-type': 'text/plain' } })).status).toBe(415)
    expect((await post(rpc(1, 'ping'), { headers: { 'content-length': '2000000' } })).status).toBe(413)
    const huge = JSON.stringify({ ...rpc(1, 'ping'), pad: 'x'.repeat(1_100_000) })
    expect((await post(null, { raw: huge })).status).toBe(413)
    const bad = await post(null, { raw: '{"jsonrpc": "2.0", "id": ' })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
  })

  it('400s an unsupported MCP-Protocol-Version after initialize, and lets initialize negotiate', async () => {
    expect((await post(rpc(1, 'tools/list'), { headers: { 'mcp-protocol-version': '2099-01-01' } })).status).toBe(400)
    expect((await post(rpc(1, 'tools/list'), { headers: { 'mcp-protocol-version': '2025-06-18' } })).status).toBe(200)
    const init = await post(rpc(1, 'initialize', { protocolVersion: '2099-01-01' }), { headers: { 'mcp-protocol-version': '2099-01-01' } })
    expect(init.status).toBe(200)
    expect((await init.json()).result.protocolVersion).toBe('2025-11-25')
  })

  it('202s a notification with an empty body', async () => {
    const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
  })

  it('issues no session and ignores one sent', async () => {
    const res = await post(rpc(1, 'ping'), { headers: { 'mcp-session-id': 'made-up-session' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('mcp-session-id')).toBeNull()
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
  })

  it('answers a batch as an array', async () => {
    const res = await post([rpc(1, 'initialize', { protocolVersion: '2025-03-26' }), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc(2, 'tools/list')])
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(out.map((r: { id: number }) => r.id)).toEqual([1, 2])
  })

  it('501s until the host has the keys it needs', async () => {
    const key = process.env.SUPABASE_SERVICE_KEY
    delete process.env.SUPABASE_SERVICE_KEY
    try {
      expect((await post(rpc(1, 'ping'))).status).toBe(501)
    } finally {
      process.env.SUPABASE_SERVICE_KEY = key
    }
  })
})

describe('acting as the user', () => {
  const authCalls = () => calls.filter(c => c.path.startsWith('/auth/v1/'))

  it('initialize, ping and tools/list mint no session and read no data', async () => {
    const init = await post(rpc(1, 'initialize', { protocolVersion: '2025-06-18' }))
    const body = await init.json()
    expect(body.result.protocolVersion).toBe('2025-06-18')
    expect(body.result.instructions).toContain('Europe/London')
    await post(rpc(2, 'ping'))
    const list = await (await post(rpc(3, 'tools/list'))).json()
    expect(list.result.tools).toHaveLength(TOOLS.length)
    expect(authCalls()).toEqual([])
    expect(calls.filter(c => c.path === '/rest/v1/posts')).toEqual([])
  })

  it('a tool call mints the user\'s session once and reads with it — never with the service key', async () => {
    const res = await (await post(rpc(1, 'tools/call', { name: 'list_tasks', arguments: {} }))).json()
    expect(JSON.parse(res.result.content[0].text).tasks[0].title).toBe('Take the bins out')

    const [who, link, verify] = authCalls()
    expect(who).toMatchObject({ path: `/auth/v1/admin/users/${USER}`, method: 'GET' })
    expect(who.headers).toMatchObject({ apikey: 'service-key', authorization: 'Bearer service-key' })
    expect(link).toMatchObject({ path: '/auth/v1/admin/generate_link', method: 'POST', body: { type: 'magiclink', email: 'owner@example.test' } })
    expect(link.headers.authorization).toBe('Bearer service-key')
    expect(verify).toMatchObject({ path: '/auth/v1/verify', method: 'POST', body: { type: 'magiclink', token_hash: 'hash-1' } })
    expect(verify.headers.apikey).toBe('anon-key')
    expect(verify.headers.authorization).toBeUndefined()

    const reads = calls.filter(c => c.path === '/rest/v1/posts')
    expect(reads.length).toBeGreaterThan(0)
    for (const r of reads) expect(r.headers).toMatchObject({ apikey: 'anon-key', authorization: 'Bearer jwt-hash-1' })
    // the service key: the token check, the zone (cached for five minutes, so maybe not this time), and minting
    const serviceKeyPaths = new Set(calls.filter(c => c.headers.authorization === 'Bearer service-key').map(c => c.path))
    for (const path of serviceKeyPaths) expect(['/auth/v1/admin/generate_link', `/auth/v1/admin/users/${USER}`, '/rest/v1/rpc/agent_token_use', '/rest/v1/user_settings']).toContain(path)
    expect(serviceKeyPaths.has('/rest/v1/rpc/agent_token_use')).toBe(true)

    calls = []
    await post(rpc(2, 'tools/call', { name: 'list_tasks', arguments: {} }))
    expect(authCalls(), 'the session is reused while it is fresh').toEqual([])
  })

  it('writes as the user too', async () => {
    const res = await (await post(rpc(1, 'tools/call', { name: 'create_task', arguments: { title: 'Descale the kettle' } }))).json()
    expect(res.result.isError).toBe(false)
    const write = calls.find(c => c.path === '/rest/v1/rpc/sync_posts')
    expect(write?.headers).toMatchObject({ apikey: 'anon-key', authorization: 'Bearer jwt-hash-1' })
    expect(write?.body.incoming[0]).toMatchObject({ kind: 'task', title: 'Descale the kettle' })
    expect(write?.body.incoming[0].id).toMatch(/^mcp-/)
  })

  it('a read-only connection sees no write tools and is refused one it calls anyway', async () => {
    const list = await (await post(rpc(1, 'tools/list'), { token: READ_ONLY })).json()
    const names = list.result.tools.map((t: { name: string }) => t.name)
    expect(names).toContain('list_tasks')
    expect(names).not.toContain('create_task')
    expect(names).not.toContain('list_journal')
    const res = await (await post(rpc(2, 'tools/call', { name: 'create_task', arguments: { title: 'x' } }), { token: READ_ONLY })).json()
    expect(res.result).toEqual({ content: [{ type: 'text', text: SCOPE_REFUSAL }], isError: true })
    expect(calls.some(c => c.path === '/rest/v1/rpc/sync_posts')).toBe(false)
    expect(authCalls()).toEqual([])
  })

  it('a PostgREST 401 drops the session, mints once more and retries', async () => {
    postsOverrides = [() => new Response('{"message":"JWT expired"}', { status: 401 })]
    const res = await (await post(rpc(1, 'tools/call', { name: 'list_tasks', arguments: {} }))).json()
    expect(res.result.isError).toBe(false)
    expect(mints).toBe(2)
    const reads = calls.filter(c => c.path === '/rest/v1/posts').map(c => c.headers.authorization)
    expect(reads.slice(0, 2)).toEqual(['Bearer jwt-hash-1', 'Bearer jwt-hash-2'])
  })

  it('logs the tool, the time and the grant\'s first 8 characters — never the token or the arguments', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await post(rpc(1, 'tools/call', { name: 'list_tasks', arguments: { search: 'private words' } }))
    const lines = log.mock.calls.map(args => args.join(' '))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^mcp c0ffee12 list_tasks \d+ms$/)
    expect(lines.join('\n')).not.toContain('private words')
    expect(lines.join('\n')).not.toContain(TOKEN)
  })
})
