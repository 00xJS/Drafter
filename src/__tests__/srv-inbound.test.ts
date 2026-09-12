import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import inboundFunction, { BUDGET_MS, CALL_MS } from '../../netlify/functions/inbound.mjs'

// The email webhook made every outbound call with no timeout, so one provider
// that never answered held the function until Netlify killed it. Fake time
// here: each test advances the clock until the webhook answers, and fails if it
// never does.

const inbound = inboundFunction as (req: Request) => Promise<Response>
const SUPABASE = 'https://db.example.test'
const KEY = 'k'.repeat(24)

type Route = 'settings' | 'store' | 'claim' | 'ai'
let slow: Set<Route>
let calls: Route[]
let aiReply = ''

/** A request that only ever ends by being aborted, like a provider that stopped answering. */
const hang = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError'))))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  vi.stubEnv('NVIDIA_API_KEY', 'nvidia-key')
  slow = new Set()
  calls = []
  aiReply = '{"title":"Pay the plumber","priority":"high"}'
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const route: Route = url.includes('/user_settings?')
        ? 'settings'
        : url.endsWith('/rpc/sync_posts')
          ? 'store'
          : url.includes('/rest/v1/posts?id=eq.')
            ? 'claim'
            : url.startsWith('https://integrate.api.nvidia.com/')
              ? 'ai'
              : (() => {
                  throw new Error(`unexpected fetch ${url}`)
                })()
      calls.push(route)
      if (slow.has(route)) return hang(init)
      if (route === 'settings') return Response.json([{ user_id: 'user-one', inbound_token: KEY }])
      if (route === 'store') return Response.json({ items: [], rejected: [] })
      if (route === 'claim') return new Response(null, { status: 204 })
      return Response.json({ choices: [{ message: { content: aiReply } }] })
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const email = () =>
  new Request(`https://site.test/api/inbound?key=${KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject: 'Invoice 42', text: 'Please pay by Friday.', from: 'plumber@example.test' }),
  })

/** Advance fake time in small steps until the webhook answers; how long it took, in fake time. */
async function answer(req: Request) {
  let res: Response | undefined
  inbound(req).then(r => (res = r))
  const started = Date.now()
  while (!res && Date.now() - started < 60_000) await vi.advanceTimersByTimeAsync(100)
  if (!res) throw new Error('the webhook never answered')
  return { res, elapsed: Date.now() - started }
}

describe('inbound email on a deadline', () => {
  it('stores the task and refines it when everyone answers', async () => {
    const { res } = await answer(email())
    expect(await res.json()).toMatchObject({ ok: true, title: 'Pay the plumber', triaged: true })
    expect(calls).toEqual(['settings', 'store', 'claim', 'ai', 'store', 'claim'])
  })

  it('answers 502 when the store never does, instead of hanging', async () => {
    slow.add('store')
    const { res, elapsed } = await answer(email())
    expect(res.status).toBe(502)
    expect(elapsed).toBeLessThanOrEqual(CALL_MS + 100)
  })

  it('answers 503 — try again — when the token lookup never does', async () => {
    slow.add('settings')
    const { res, elapsed } = await answer(email())
    expect(res.status).toBe(503)
    expect(elapsed).toBeLessThanOrEqual(CALL_MS + 100)
  })

  it('keeps the raw task and answers inside the budget when the AI provider never does', async () => {
    slow.add('ai')
    const { res, elapsed } = await answer(email())
    expect(await res.json()).toMatchObject({ ok: true, title: 'Invoice 42', triaged: false })
    expect(elapsed).toBeLessThan(BUDGET_MS)
    expect(calls).toEqual(['settings', 'store', 'claim', 'ai'])
  })

  it('never writes a refinement that arrives after the deadline', async () => {
    slow.add('ai')
    await answer(email())
    slow.delete('ai')
    await vi.advanceTimersByTimeAsync(BUDGET_MS)
    expect(calls.filter(c => c === 'store')).toHaveLength(1)
  })
})
