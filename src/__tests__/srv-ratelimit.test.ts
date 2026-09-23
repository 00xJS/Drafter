import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SHARED_PAUSE_MS, serviceRpc, sharedWindow, slidingWindow, type Rpc, type SharedTake } from '../../netlify/functions/lib/ratelimit.mjs'

// /api/ai spends the owner's AI quota, recipe import and Find address fetch
// from our servers, and /api/log writes to client_errors. Each capped its
// callers in the function's own memory, and Netlify runs a function on several
// instances and recycles them, so calls spread over cold starts were never
// counted together. They are now: public.rate_limit_take (migration v3.33)
// counts a call per account and bucket, whichever instance asks, and each
// instance keeps its own window too — the only one there is until the
// migration is applied.

type Handler = (req: Request, context?: unknown) => Promise<Response>
type Args = { p_subject: string; p_bucket: string; p_limit: number; p_window_seconds: number }

/** public.rate_limit_take as v3.33 writes it: a window from its first call, refused past the limit until it ends. */
function fakeRateLimits(now: () => number) {
  const rows = new Map<string, { start: number; count: number }>()
  const asked: Args[] = []
  const take = (a: Args): SharedTake => {
    asked.push(a)
    const span = a.p_window_seconds * 1000
    const t = now()
    const row = rows.get(`${a.p_subject}|${a.p_bucket}`)
    const next = row && row.start > t - span ? { start: row.start, count: Math.min(row.count + 1, a.p_limit + 1) } : { start: t, count: 1 }
    rows.set(`${a.p_subject}|${a.p_bucket}`, next)
    const allowed = next.count <= a.p_limit
    return { allowed, remaining: Math.max(a.p_limit - next.count, 0), retry_after_ms: allowed ? 0 : next.start + span - t }
  }
  /** As another instance would have left it: `count` calls of `bucket` already made in a window that began at `start`. */
  const seed = (subject: string, bucket: string, count: number, start = now()) => void rows.set(`${subject}|${bucket}`, { start, count })
  return { take, seed, asked }
}

describe('sharedWindow', () => {
  it('counts an account’s calls across instances, so the fifth is refused wherever it lands', async () => {
    let t = 1_000_000
    const db = fakeRateLimits(() => t)
    const rpc: Rpc = async (name, args) => (name === 'rate_limit_take' ? db.take(args as Args) : null)
    // two warm instances, each with its own memory
    const one = sharedWindow({ bucket: 'ai', limit: 4, windowMs: 60_000, now: () => t, rpc })
    const two = sharedWindow({ bucket: 'ai', limit: 4, windowMs: 60_000, now: () => t, rpc })
    for (const instance of [one, two, one, two]) expect((await instance.take('u1')).ok).toBe(true)
    expect(db.asked[0]).toEqual({ p_subject: 'u1', p_bucket: 'ai', p_limit: 4, p_window_seconds: 60 })
    // neither instance has seen more than two, and the account is still stopped
    t += 15_000
    expect(await one.take('u1')).toEqual({ ok: false, remaining: 0, retryAfterMs: 45_000 })
    expect((await two.take('u1')).ok).toBe(false)
    // another account counts on its own
    expect(await two.take('u2')).toEqual({ ok: true, remaining: 3, retryAfterMs: 0 })
    // and the window ends a minute after its first call
    t += 45_000
    expect((await one.take('u1')).ok).toBe(true)
  })

  it('says as few are left as the stricter of the two windows does', async () => {
    const t = 0
    const db = fakeRateLimits(() => t)
    db.seed('u1', 'geocode', 6)
    const w = sharedWindow({ bucket: 'geocode', limit: 10, windowMs: 60_000, now: () => t, rpc: async (_n, a) => db.take(a as Args) })
    expect(await w.take('u1')).toEqual({ ok: true, remaining: 3, retryAfterMs: 0 })
  })

  it('never asks Postgres about a call its own instance already refuses', async () => {
    const t = 0
    const rpc = vi.fn<Rpc>(async () => ({ allowed: true, remaining: 99, retry_after_ms: 0 }))
    const w = sharedWindow({ bucket: 'log', limit: 2, windowMs: 60_000, now: () => t, rpc })
    await w.take('u1')
    await w.take('u1')
    const refused = await w.take('u1')
    expect(refused.ok).toBe(false)
    expect(refused.retryAfterMs).toBe(60_000)
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('counts on its own when the function is not there yet, and asks again a minute later', async () => {
    let t = 0
    const rpc = vi.fn<Rpc>(async () => {
      throw new Error('rpc/rate_limit_take: 404')
    })
    const w = sharedWindow({ bucket: 'ai', limit: 3, windowMs: 10 * 60_000, now: () => t, rpc })
    // exactly as before v3.33: this instance's own three
    for (let i = 0; i < 3; i++) expect((await w.take('u1')).ok).toBe(true)
    expect((await w.take('u1')).ok).toBe(false)
    // one failed request, then none while it waits, so a missing migration costs no round trips
    expect(rpc).toHaveBeenCalledTimes(1)
    t += SHARED_PAUSE_MS
    rpc.mockResolvedValueOnce({ allowed: false, remaining: 0, retry_after_ms: 5_000 })
    expect(await w.take('u2')).toEqual({ ok: false, remaining: 0, retryAfterMs: 5_000 })
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('treats an answer it cannot read as no answer, and pauses the same way', async () => {
    const rpc = vi.fn<Rpc>(async () => [{ allowed: 'yes' }])
    const w = sharedWindow({ bucket: 'ai', limit: 3, windowMs: 60_000, now: () => 0, rpc })
    expect((await w.take('u1')).ok).toBe(true)
    expect((await w.take('u1')).ok).toBe(true)
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('on a host with no service key counts in memory, and never pauses', async () => {
    const rpc = vi.fn<Rpc>(async () => null)
    const w = sharedWindow({ bucket: 'ai', limit: 2, windowMs: 60_000, now: () => 0, rpc })
    expect((await w.take('u1')).ok).toBe(true)
    expect((await w.take('u1')).ok).toBe(true)
    expect((await w.take('u1')).ok).toBe(false)
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('keeps the old window’s promise: a refused call is not counted against the caller', async () => {
    let t = 0
    const local = slidingWindow({ limit: 1, windowMs: 1_000, now: () => t })
    const w = sharedWindow({ bucket: 'ai', limit: 1, windowMs: 1_000, now: () => t, rpc: async () => null, local })
    expect((await w.take('u1')).ok).toBe(true)
    t = 500
    expect((await w.take('u1')).ok).toBe(false)
    t = 1_000
    expect((await w.take('u1')).ok).toBe(true)
  })
})

describe('serviceRpc', () => {
  const SUPABASE = 'https://db.example.test'
  let sent: { url: string; init: RequestInit }[]

  beforeEach(() => {
    sent = []
    vi.stubEnv('SUPABASE_URL', SUPABASE)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push({ url: String(input), init: init ?? {} })
        return Response.json({ allowed: true, remaining: 4, retry_after_ms: 0 })
      }),
    )
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('posts the arguments with the service key — on apikey alone for a secret key', async () => {
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'sb_secret_abc')
    expect(await serviceRpc('rate_limit_take', { p_subject: 'u1' })).toEqual({ allowed: true, remaining: 4, retry_after_ms: 0 })
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe(`${SUPABASE}/rest/v1/rpc/rate_limit_take`)
    expect(sent[0].init.method).toBe('POST')
    expect(JSON.parse(String(sent[0].init.body))).toEqual({ p_subject: 'u1' })
    const headers = new Headers(sent[0].init.headers)
    expect(headers.get('apikey')).toBe('sb_secret_abc')
    expect(headers.get('authorization')).toBeNull()
    expect(sent[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  it('is null on a host with no service key, and asks nothing', async () => {
    vi.stubEnv('SUPABASE_SERVICE_KEY', '')
    expect(await serviceRpc('rate_limit_take', {})).toBeNull()
    expect(sent).toEqual([])
  })

  it('throws when PostgREST refuses, so the caller counts on its own', async () => {
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'sb_secret_abc')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'Could not find the function public.rate_limit_take' }, { status: 404 })))
    await expect(serviceRpc('rate_limit_take', {})).rejects.toThrow(/rpc\/rate_limit_take: 404/)
  })
})

describe('the endpoints count across instances', () => {
  const SUPABASE = 'https://db.example.test'
  const NVIDIA = 'https://integrate.api.nvidia.com/v1/chat/completions'
  let db: ReturnType<typeof fakeRateLimits>
  /** What the shared window answers: the fake's count, or a status as PostgREST gives it. */
  let rpcStatus: number
  let modelCalls: number
  let stored: number
  let serial = 0

  beforeEach(() => {
    db = fakeRateLimits(() => Date.now())
    rpcStatus = 200
    modelCalls = 0
    stored = 0
    vi.stubEnv('SUPABASE_URL', SUPABASE)
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'sb_secret_service')
    vi.stubEnv('NVIDIA_API_KEY', 'nvapi-main')
    vi.stubEnv('NVIDIA_API_KEY_2', '')
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    vi.stubEnv('AI_PROVIDER', '')
    vi.stubEnv('NVIDIA_MODEL', '')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === `${SUPABASE}/auth/v1/user`) {
          const m = /^Bearer good-(.+)$/.exec(new Headers(init?.headers).get('authorization') ?? '')
          return m ? Response.json({ id: m[1], email: `${m[1]}@example.test` }) : Response.json({ msg: 'invalid JWT' }, { status: 401 })
        }
        if (url === `${SUPABASE}/rest/v1/rpc/rate_limit_take`) {
          if (rpcStatus !== 200) return Response.json({ message: 'Could not find the function public.rate_limit_take' }, { status: rpcStatus })
          return Response.json(db.take(JSON.parse(String(init?.body))))
        }
        if (url === `${SUPABASE}/rest/v1/rpc/log_client_errors`) {
          stored++
          return Response.json(1)
        }
        if (url === NVIDIA) {
          modelCalls++
          return Response.json({ choices: [{ message: { content: 'ok' } }] })
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
    )
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  /** A fresh copy of an endpoint, as a cold start gets one: its own memory, nothing counted in it yet. */
  const coldStart = async (name: 'ai' | 'log' | 'geocode' | 'recipe-import'): Promise<Handler> => {
    vi.resetModules()
    return ((await import(`../../netlify/functions/${name}.mjs`)) as { default: Handler }).default
  }
  const account = () => `acct-${++serial}`
  const post = (handler: Handler, path: string, id: string, body: unknown) =>
    handler(new Request(`https://site.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer good-${id}` }, body: JSON.stringify(body) }))

  it('/api/ai: thirty an account in ten minutes, whichever instance the calls land on', async () => {
    const me = account()
    const first = await coldStart('ai')
    for (let i = 0; i < 15; i++) expect((await post(first, '/api/ai', me, { prompt: 'Suggest tags' })).status).toBe(200)
    const second = await coldStart('ai')
    for (let i = 0; i < 15; i++) expect((await post(second, '/api/ai', me, { prompt: 'Suggest tags' })).status).toBe(200)
    expect(db.asked[0]).toEqual({ p_subject: me, p_bucket: 'ai', p_limit: 30, p_window_seconds: 600 })
    // a third instance has counted nothing, and still turns the thirty-first away before the model is asked
    const refused = await post(await coldStart('ai'), '/api/ai', me, { prompt: 'Suggest tags' })
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(590)
    expect((await refused.json()).error).toMatch(/Too many AI requests from this account — try again in 10 min/)
    expect(modelCalls).toBe(30)
  })

  it('/api/ai before the migration: the instance’s own thirty, as before', async () => {
    rpcStatus = 404
    const me = account()
    const ai = await coldStart('ai')
    for (let i = 0; i < 30; i++) expect((await post(ai, '/api/ai', me, { prompt: 'Suggest tags' })).status).toBe(200)
    expect((await post(ai, '/api/ai', me, { prompt: 'Suggest tags' })).status).toBe(429)
    expect(modelCalls).toBe(30)
  })

  it('/api/log: twenty requests an account, and nothing stored past them', async () => {
    const me = account()
    db.seed(me, 'log', 20)
    const res = await post(await coldStart('log'), '/api/log', me, { reports: [{ message: 'TypeError: a is undefined', platform: 'web' }] })
    expect(res.status).toBe(429)
    expect(db.asked[db.asked.length - 1]).toMatchObject({ p_subject: me, p_bucket: 'log', p_limit: 20, p_window_seconds: 600 })
    expect(stored).toBe(0)
  })

  it('/api/geocode: sixty lookups an account, refused before OpenStreetMap is asked', async () => {
    const me = account()
    db.seed(me, 'geocode', 60)
    const res = await post(await coldStart('geocode'), '/api/geocode', me, { q: 'Chipotle' })
    expect(res.status).toBe(429)
    expect(db.asked[db.asked.length - 1]).toMatchObject({ p_subject: me, p_bucket: 'geocode', p_limit: 60, p_window_seconds: 600 })
  })

  it('/api/recipe-import: twenty imports an account, refused before the page is fetched', async () => {
    const me = account()
    db.seed(me, 'recipe-import', 20)
    const res = await post(await coldStart('recipe-import'), '/api/recipe-import', me, { url: 'https://recipes.example.com/r' })
    expect(res.status).toBe(429)
    expect((await res.json()).error).toMatch(/Too many imports from this account/)
    expect(db.asked[db.asked.length - 1]).toMatchObject({ p_subject: me, p_bucket: 'recipe-import', p_limit: 20, p_window_seconds: 600 })
  })
})
