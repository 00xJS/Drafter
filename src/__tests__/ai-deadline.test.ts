import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_BUDGET_MS, MIN_ATTEMPT_MS, complete } from '../../netlify/functions/lib/ai.mjs'
// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import aiFunction from '../../netlify/functions/ai.mjs'

// /api/ai runs inside a synchronous Netlify function, which the platform stops
// at 10 s. The NVIDIA fetch had no deadline, so a provider that never answered
// held the function until it was killed, and the app got the platform's error
// page instead of a reason. Every attempt now runs against one budget, counted
// from when the request began: past it the call is abandoned as a 504 the app
// shows, and the other key or the Anthropic fallback only get what is left.
// NVIDIA is a fetch stub that answers each call as a test plans it; the
// Anthropic SDK is replaced.

const claude = vi.hoisted(() => ({ asked: 0, hang: false, signals: [] as (AbortSignal | undefined)[] }))
vi.mock('@anthropic-ai/sdk', () => {
  const create = (_request: unknown, options?: { signal?: AbortSignal }) => {
    claude.asked++
    claude.signals.push(options?.signal)
    if (claude.hang) return new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal?.reason)))
    return Promise.resolve({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'from Claude' }] })
  }
  return {
    default: class {
      messages = { create }
      beta = { messages: { create } }
    },
  }
})

const SUPABASE = 'https://db.example.test'
const NVIDIA = 'https://integrate.api.nvidia.com/v1/chat/completions'
const MAIN = 'nvapi-main-key-0000'
const SECOND = 'nvapi-second-key-1111'

type Key = 'main' | 'second'
/**
 * How NVIDIA answers each call on a key, in turn: `status` after `after` ms,
 * or never — `hang: 'honour'` until the request is aborted, as a real fetch
 * does, and `hang: 'ignore'` not even then. A key with no plan left answers 200 at once.
 */
type Plan = { after?: number; status?: number; hang?: 'honour' | 'ignore' }
let plans: Record<Key, Plan[]>
/** Each NVIDIA call: the key it carried, and the signal it was given. */
let asked: { key: Key; signal: AbortSignal | undefined }[]
/** How long the session check takes before /api/ai gets to the model. */
let authMs = 0

/** A wait that a real request would cut short when aborted. */
const wait = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    })
  })

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('NVIDIA_API_KEY', MAIN)
  vi.stubEnv('NVIDIA_API_KEY_2', '')
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  vi.stubEnv('AI_PROVIDER', '')
  vi.stubEnv('NVIDIA_MODEL', '')
  claude.asked = 0
  claude.hang = false
  claude.signals = []
  plans = { main: [], second: [] }
  asked = []
  authMs = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `${SUPABASE}/auth/v1/user`) {
        if (authMs) await wait(authMs)
        const m = /^Bearer good-(.+)$/.exec(new Headers(init?.headers).get('authorization') ?? '')
        return m ? Response.json({ id: m[1], email: `${m[1]}@example.test` }) : Response.json({ msg: 'invalid JWT' }, { status: 401 })
      }
      if (url === NVIDIA) {
        const bearer = new Headers(init?.headers).get('authorization')
        const key: Key | null = bearer === `Bearer ${MAIN}` ? 'main' : bearer === `Bearer ${SECOND}` ? 'second' : null
        if (!key) throw new Error('NVIDIA was asked with neither key')
        const signal = init?.signal ?? undefined
        asked.push({ key, signal })
        const plan = plans[key].shift() ?? {}
        if (plan.hang === 'ignore') return new Promise<Response>(() => {})
        if (plan.hang === 'honour') return new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)))
        // an answer due at once needs no timer: with the clock faked, it would wait for the test to move it
        if (plan.after) await wait(plan.after, signal)
        const status = plan.status ?? 200
        return status === 200 ? Response.json({ choices: [{ message: { content: `from the ${key} key` } }] }) : Response.json({ error: { message: `HTTP ${status}` } }, { status })
      }
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/** Fake the clock: timers and Date move together, and only when a test moves them. */
const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

/** A promise, and whether it has settled yet. */
function watch<T>(p: Promise<T>) {
  const state = { done: false }
  p.then(
    () => (state.done = true),
    () => (state.done = true),
  )
  return state
}

const TIMED_OUT = { status: 504, error: 'NVIDIA did not answer in time — try again in a moment.' }

describe('one budget for every attempt', () => {
  it('is 55 seconds, inside Netlify\'s fixed 60, and a second attempt needs five of them left', () => {
    expect(AI_BUDGET_MS).toBe(55_000)
    expect(MIN_ATTEMPT_MS).toBe(5_000)
  })

  it('a provider that never answers — and ignores the abort — ends at the deadline as a 504', async () => {
    plans.main = [{ hang: 'ignore' }]
    const started = Date.now()
    expect(await complete({ prompt: 'x', deadline: Date.now() + 40 })).toEqual(TIMED_OUT)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('aborts the NVIDIA request itself when the budget runs out, and not a moment before', async () => {
    fakeClock()
    plans.main = [{ hang: 'honour' }]
    const answer = complete({ prompt: 'x' })
    const state = watch(answer)
    await vi.advanceTimersByTimeAsync(AI_BUDGET_MS - 1)
    expect(state.done).toBe(false)
    expect(asked[0].signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await answer).toEqual(TIMED_OUT)
    expect(asked[0].signal?.aborted).toBe(true)
  })

  it('lets NVIDIA use all of it: a slow answer inside the budget still lands (the chat asks for 900 JSON tokens)', async () => {
    fakeClock()
    plans.main = [{ after: AI_BUDGET_MS - 500 }]
    const answer = complete({ prompt: 'x', maxTokens: 900, json: true })
    await vi.advanceTimersByTimeAsync(AI_BUDGET_MS)
    expect(await answer).toEqual({ text: 'from the main key', provider: 'nvidia' })
  })
})

describe('what is left of it', () => {
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key')
  })

  it('goes to the Anthropic fallback, whose request is aborted when the budget runs out', async () => {
    fakeClock()
    plans.main = [{ after: 3_000, status: 503 }]
    claude.hang = true
    const answer = complete({ prompt: 'x' })
    const state = watch(answer)
    await vi.advanceTimersByTimeAsync(AI_BUDGET_MS - 1)
    expect(claude.asked).toBe(1)
    expect(state.done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    // the fallback did not answer either, so NVIDIA's own failure stands
    expect(await answer).toMatchObject({ status: 502, upstream: 503 })
    expect(claude.signals[0]?.aborted).toBe(true)
  })

  it('and the fallback answers when it can', async () => {
    fakeClock()
    plans.main = [{ after: 3_000, status: 503 }]
    const answer = complete({ prompt: 'x' })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await answer).toEqual({ text: 'from Claude', provider: 'anthropic' })
  })

  it('is not enough for the fallback once less than MIN_ATTEMPT_MS remains', async () => {
    fakeClock()
    plans.main = [{ after: AI_BUDGET_MS - MIN_ATTEMPT_MS + 1, status: 503 }]
    const answer = complete({ prompt: 'x' })
    await vi.advanceTimersByTimeAsync(AI_BUDGET_MS)
    expect(await answer).toMatchObject({ status: 502, upstream: 503 })
    expect(claude.asked).toBe(0)
  })

  it('is nothing at all after NVIDIA hangs: the 504 comes back, and Claude is never asked', async () => {
    fakeClock()
    plans.main = [{ hang: 'honour' }]
    const answer = complete({ prompt: 'x' })
    await vi.advanceTimersByTimeAsync(AI_BUDGET_MS)
    expect(await answer).toEqual(TIMED_OUT)
    expect(claude.asked).toBe(0)
  })

  it('goes to the second NVIDIA key only while there is time for it', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    vi.stubEnv('NVIDIA_API_KEY_2', SECOND)
    fakeClock()
    plans.main = [{ after: 1_000, status: 429 }, { after: AI_BUDGET_MS - MIN_ATTEMPT_MS + 1, status: 429 }]
    const early = complete({ prompt: 'x' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await early).toEqual({ text: 'from the second key', provider: 'nvidia' })
    const late = complete({ prompt: 'x' })
    await vi.advanceTimersByTimeAsync(AI_BUDGET_MS)
    expect(await late).toMatchObject({ status: 429, upstream: 429 })
    expect(asked.map(a => a.key)).toEqual(['main', 'second', 'main'])
  })
})

describe('whose budget', () => {
  let accounts = 0
  const askAi = (body: Record<string, unknown>) =>
    (aiFunction as (req: Request) => Promise<Response>)(
      new Request('https://site.test/api/ai', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer good-d${++accounts}` }, body: JSON.stringify(body) }),
    )

  it('/api/ai counts it from the request’s start, so a slow session check comes out of it', async () => {
    fakeClock()
    authMs = 1_500
    plans.main = [{ hang: 'honour' }]
    const res = askAi({ prompt: 'x' })
    const state = watch(res)
    await vi.advanceTimersByTimeAsync(AI_BUDGET_MS - 1)
    expect(state.done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const answer = await res
    expect(answer.status).toBe(504)
    expect(await answer.json()).toEqual({ error: TIMED_OUT.error })
  })

  it('background work passing no deadline is held to none here: it stops waiting at a deadline of its own', async () => {
    fakeClock()
    plans.main = [{ after: 20_000 }, { hang: 'honour' }]
    const draft = complete({ prompt: 'x', background: true })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await draft).toEqual({ text: 'from the main key', provider: 'nvidia' })
    const bounded = complete({ prompt: 'x', background: true, deadline: Date.now() + 1_000 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await bounded).toEqual(TIMED_OUT)
  })
})
