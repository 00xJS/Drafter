import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { slidingWindow } from '../../netlify/functions/lib/ratelimit.mjs'
// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import aiFunction from '../../netlify/functions/ai.mjs'
// @ts-expect-error — as above
import githubFunction from '../../netlify/functions/github.mjs'

// /api/ai spends the owner's AI keys and /api/github holds a write-capable
// GITHUB_TOKEN. Both used to check the session only when the auth settings were
// present, so a host that lost them would have served anyone. Now both fail
// closed, and /api/ai also has a per-account ceiling.

type Handler = (req: Request, context?: unknown) => Promise<Response>
const ai = aiFunction as Handler
const github = githubFunction as Handler

const SUPABASE = 'https://db.example.test'
const NVIDIA = 'https://integrate.api.nvidia.com/v1/chat/completions'

let modelCalls: { max_tokens: number }[] = []
let fetches: string[] = []

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('NVIDIA_API_KEY', 'nvidia-key')
  modelCalls = []
  fetches = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      fetches.push(url)
      if (url === `${SUPABASE}/auth/v1/user`) {
        // "good-<id>" is a valid session for user <id>; anything else is refused
        const m = /^Bearer good-(.+)$/.exec(new Headers(init?.headers).get('authorization') ?? '')
        return m ? Response.json({ id: m[1], email: `${m[1]}@example.test` }) : Response.json({ msg: 'invalid JWT' }, { status: 401 })
      }
      if (url === NVIDIA) {
        modelCalls.push(JSON.parse(String(init?.body)))
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

const bearer = (token?: string): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {})
const askAi = (token?: string, body: Record<string, unknown> = { prompt: 'Suggest tags for: paint the fence' }) =>
  ai(new Request('https://site.test/api/ai', { method: 'POST', headers: { 'content-type': 'application/json', ...bearer(token) }, body: JSON.stringify(body) }))
const askGithub = (token?: string, target = 'https://github.com/00xJS/Drafter/issues/1') =>
  github(new Request(`https://site.test/api/github?url=${encodeURIComponent(target)}`, { headers: bearer(token) }))

describe('/api/ai fails closed', () => {
  it('refuses a request without a session', async () => {
    const res = await askAi()
    expect(res.status).toBe(401)
    expect(modelCalls).toHaveLength(0)
  })

  it('refuses a session the auth server does not recognise', async () => {
    const res = await askAi('forged')
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('invalid session')
    expect(modelCalls).toHaveLength(0)
  })

  it('answers 503 when the site has no auth settings, instead of serving anyone', async () => {
    vi.stubEnv('SUPABASE_URL', '')
    vi.stubEnv('SUPABASE_ANON_KEY', '')
    const res = await askAi('good-anyone')
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/SUPABASE_URL and SUPABASE_ANON_KEY/)
    expect(fetches).toEqual([])
  })

  it('serves a signed-in account', async () => {
    const res = await askAi('good-u-ok')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: 'ok', provider: 'nvidia' })
  })

  it('clamps what a client may ask the model for to 4096 tokens', async () => {
    await askAi('good-u-clamp', { prompt: 'Write a novel', maxTokens: 100_000 })
    expect(modelCalls.map(c => c.max_tokens)).toEqual([4096])
  })

  it('stops an account at 30 calls in ten minutes, and only that account', async () => {
    for (let i = 0; i < 30; i++) expect((await askAi('good-u-busy')).status).toBe(200)
    const refused = await askAi('good-u-busy')
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(modelCalls).toHaveLength(30)
    expect((await askAi('good-u-quiet')).status).toBe(200)
  })
})

describe('/api/github fails closed', () => {
  it('refuses a request without a session', async () => {
    expect((await askGithub()).status).toBe(401)
  })

  it('refuses a session the auth server does not recognise', async () => {
    expect((await askGithub('forged')).status).toBe(401)
  })

  it('answers 503 when the site has no auth settings', async () => {
    vi.stubEnv('SUPABASE_URL', '')
    vi.stubEnv('SUPABASE_ANON_KEY', '')
    const res = await askGithub('good-anyone')
    expect(res.status).toBe(503)
    expect(fetches).toEqual([])
  })

  it('lets a signed-in account through to its own validation', async () => {
    const res = await askGithub('good-u-ok', 'https://example.com/not-github')
    expect(res.status).toBe(400)
    expect(fetches).toEqual([`${SUPABASE}/auth/v1/user`])
  })

  it('refuses a write without a session before it reads the body', async () => {
    const res = await github(new Request('https://site.test/api/github', { method: 'POST', body: JSON.stringify({ action: 'close', url: 'https://github.com/a/b/issues/1' }) }))
    expect(res.status).toBe(401)
  })
})

describe('slidingWindow', () => {
  it('admits `limit` calls per window, does not count refusals, and lets a key back in as old calls age out', () => {
    let t = 0
    const w = slidingWindow({ limit: 3, windowMs: 1000, now: () => t })
    expect([w.take('a'), w.take('a'), w.take('a')].map(x => x.ok)).toEqual([true, true, true])
    t = 400
    expect(w.take('a')).toEqual({ ok: false, remaining: 0, retryAfterMs: 600 })
    expect(w.take('b').ok).toBe(true)
    t = 999
    expect(w.take('a').ok).toBe(false)
    t = 1000 // all three calls from t=0 have aged out
    expect(w.take('a')).toEqual({ ok: true, remaining: 2, retryAfterMs: 0 })
  })

  it('forgets idle keys once it holds more than maxKeys', () => {
    let t = 0
    const w = slidingWindow({ limit: 1, windowMs: 100, now: () => t, maxKeys: 2 })
    w.take('a')
    w.take('b')
    t = 500
    w.take('c') // three keys: the sweep drops a and b, whose calls have aged out
    expect(w.take('a').ok).toBe(true)
  })
})
