import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handOver, writeAs } from '../../netlify/functions/lib/writeas.mjs'

// The one way the functions write for an account (v3.34). sync_posts under the
// service key has no signed-in caller, so a new row was born the site owner's
// and a losing copy went into the site owner's history; sync_posts_as writes
// as the account named. A database without it answers 404, and only then does
// this fall back to sync_posts and the hand-over PATCH: any other failure is a
// failure, never a write that would land as the site owner's.

const SUPABASE = 'https://db.example.test'
const REST = `${SUPABASE}/rest/v1/`
const MARIA = 'e5f6a7b8-0000-4000-8000-00000000000b'

let calls: { path: string; method: string; body: any }[]
/** What sync_posts_as answers: a status, a thrown error, or its verdicts. */
let writeAsAnswer: number | Error | Record<string, unknown>
let plainAnswer: Record<string, unknown>
/** PATCH attempts that fail before one goes through. */
let patchFailures: number

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  calls = []
  writeAsAnswer = { items: [], rejected: [], stale: [], gone: [] }
  plainAnswer = { items: [], rejected: [], stale: [], gone: [] }
  patchFailures = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(REST.length)
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ path, method, body })
      expect(new Headers(init?.headers).get('apikey')).toBe('service-key')
      if (path === 'rpc/sync_posts_as') {
        if (writeAsAnswer instanceof Error) throw writeAsAnswer
        if (typeof writeAsAnswer === 'number') return Response.json({ code: writeAsAnswer === 404 ? 'PGRST202' : 'XX000' }, { status: writeAsAnswer })
        return Response.json(writeAsAnswer)
      }
      if (path === 'rpc/sync_posts') return Response.json(plainAnswer)
      if (path.startsWith('posts?id=eq.') && method === 'PATCH') {
        if (patchFailures-- > 0) return new Response('unavailable', { status: 503 })
        return new Response(null, { status: 204 })
      }
      throw new Error(`unexpected ${method} ${path}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const task = (id: string) => ({ kind: 'task', id, title: 'Invoice 42', shared: false, createdAt: '2026-09-25T09:00:00.000Z', updatedAt: '2026-09-25T09:00:00.000Z' })

describe('writeAs', () => {
  it('writes through sync_posts_as, naming the account, and answers its verdicts', async () => {
    writeAsAnswer = { items: [], rejected: ['b'], stale: ['c'], gone: ['d'] }
    const out = await writeAs(MARIA, [task('a'), task('b'), task('c'), task('d')], { handOver: true })
    expect(out).toEqual({ ok: true, rejected: ['b'], stale: ['c'], gone: ['d'], owned: true })
    expect(calls).toEqual([{ path: 'rpc/sync_posts_as', method: 'POST', body: { p_owner: MARIA, incoming: [task('a'), task('b'), task('c'), task('d')] } }])
  })

  it('on a database before v3.34 (a 404) writes through sync_posts and hands each new row over, synced_at and all', async () => {
    writeAsAnswer = 404
    plainAnswer = { items: [], rejected: ['b'], stale: [], gone: [] }
    const out = await writeAs(MARIA, [task('a'), task('b')], { handOver: true })
    expect(out).toEqual({ ok: true, rejected: ['b'], stale: [], gone: [], owned: true })
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(['POST rpc/sync_posts_as', 'POST rpc/sync_posts', 'PATCH posts?id=eq.a'])
    // a future cursor: the answer is the verdicts, never the whole table
    expect(Date.parse(calls[1].body.since)).toBeGreaterThan(Date.now())
    expect(calls[2].body).toEqual({ user_id: MARIA, synced_at: expect.any(String) })
  })

  it('tries a hand-over twice, and says when the row is still the site owner’s', async () => {
    writeAsAnswer = 404
    patchFailures = 1
    expect(await writeAs(MARIA, [task('a')], { handOver: true })).toMatchObject({ ok: true, owned: true })
    patchFailures = 2
    calls = []
    expect(await writeAs(MARIA, [task('a')], { handOver: true })).toMatchObject({ ok: true, owned: false })
    expect(calls.filter(c => c.method === 'PATCH')).toHaveLength(2)
  })

  it('hands nothing over unless asked: an existing row keeps its owner', async () => {
    writeAsAnswer = 404
    expect(await writeAs(MARIA, [task('a')])).toMatchObject({ ok: true, owned: true })
    expect(calls.some(c => c.method === 'PATCH')).toBe(false)
  })

  it('any other failure is a failure, never a fall back that would write as the site owner', async () => {
    for (const answer of [500, 401, new TypeError('fetch failed')]) {
      writeAsAnswer = answer
      calls = []
      const out = await writeAs(MARIA, [task('a')], { handOver: true })
      expect(out.ok, String(answer)).toBe(false)
      expect(calls.map(c => c.path)).toEqual(['rpc/sync_posts_as'])
    }
  })

  it('goes through the caller’s own request when given one, a deadline and all', async () => {
    const seen: string[] = []
    const request = (path: string, init: RequestInit) => {
      seen.push(path)
      return fetch(`${REST}${path}`, { ...init, headers: { apikey: 'service-key', ...(init.headers as Record<string, string>) } })
    }
    await writeAs(MARIA, [task('a')], { request })
    expect(seen).toEqual(['rpc/sync_posts_as'])
  })
})

describe('handOver', () => {
  it('gives a row to its owner and moves synced_at with it', async () => {
    expect(await handOver(MARIA, 'mail-1')).toBe(true)
    expect(calls).toEqual([{ path: 'posts?id=eq.mail-1', method: 'PATCH', body: { user_id: MARIA, synced_at: expect.any(String) } }])
  })
})
