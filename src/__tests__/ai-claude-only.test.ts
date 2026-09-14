import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_ONLY, complete } from '../../netlify/functions/lib/ai.mjs'
// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import aiFunction from '../../netlify/functions/ai.mjs'
import { CLAUDE_ONLY as APP_CLAUDE_ONLY } from '../ai'

// Ask Drafter with the Journal chip on sends journal entries, and those go to
// Claude and nowhere else: never to NVIDIA, first or as a fallback. Everything
// else keeps NVIDIA first with Claude as the backup. The Anthropic SDK is
// replaced here and NVIDIA is a fetch stub, so each test sees who was asked.

const claude = vi.hoisted(() => ({ asked: 0, fail: '' }))
vi.mock('@anthropic-ai/sdk', () => {
  const create = async () => {
    claude.asked++
    if (claude.fail) throw new Error(claude.fail)
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'from Claude' }] }
  }
  return {
    default: class {
      messages = { create }
      beta = { messages: { create } }
    },
  }
})

type Handler = (req: Request) => Promise<Response>
const ai = aiFunction as Handler

const SUPABASE = 'https://db.example.test'
const NVIDIA = 'https://integrate.api.nvidia.com/v1/chat/completions'
let nvidiaAsked = 0
let nvidiaStatus = 200

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('NVIDIA_API_KEY', 'nvidia-key')
  vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key')
  vi.stubEnv('AI_PROVIDER', '')
  claude.asked = 0
  claude.fail = ''
  nvidiaAsked = 0
  nvidiaStatus = 200
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `${SUPABASE}/auth/v1/user`) {
        const m = /^Bearer good-(.+)$/.exec(new Headers(init?.headers).get('authorization') ?? '')
        return m ? Response.json({ id: m[1], email: `${m[1]}@example.test` }) : Response.json({ msg: 'invalid JWT' }, { status: 401 })
      }
      if (url === NVIDIA) {
        nvidiaAsked++
        return nvidiaStatus === 200 ? Response.json({ choices: [{ message: { content: 'from NVIDIA' } }] }) : Response.json({ error: { message: 'slow down' } }, { status: nvidiaStatus })
      }
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/** A signed-in call to /api/ai: a new account each time, so the per-account ceiling never meets the next test. */
let accounts = 0
const askAi = (body: Record<string, unknown>) =>
  ai(new Request('https://site.test/api/ai', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer good-u${++accounts}` }, body: JSON.stringify(body) }))

describe('/api/ai: a request carrying the journal goes to Claude alone', () => {
  it('asks Claude and never NVIDIA, though NVIDIA would go first', async () => {
    const res = await askAi({ prompt: 'How did I feel last week?', json: true, journal: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: 'from Claude', provider: 'anthropic' })
    expect(claude.asked).toBe(1)
    expect(nvidiaAsked).toBe(0)
  })

  it('keeps to Claude when AI_PROVIDER puts NVIDIA first', async () => {
    vi.stubEnv('AI_PROVIDER', 'nvidia')
    expect(await (await askAi({ prompt: 'x', journal: true })).json()).toMatchObject({ provider: 'anthropic' })
    expect(nvidiaAsked).toBe(0)
  })

  it('says the journal needs Claude when Claude is not set up, and asks nobody', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    const res = await askAi({ prompt: 'x', journal: true })
    expect(res.status).toBe(501)
    const body = await res.json()
    expect(body.code).toBe('claude_only')
    expect(body.error).toMatch(/Claude only, and Claude is not set up on this site: set ANTHROPIC_API_KEY/)
    expect(claude.asked).toBe(0)
    expect(nvidiaAsked).toBe(0)
  })

  it('says so when Claude fails, rather than trying NVIDIA', async () => {
    claude.fail = 'Overloaded'
    const res = await askAi({ prompt: 'x', journal: true })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ code: 'claude_only', error: 'This request goes to Claude only, and Claude could not answer: Overloaded' })
    expect(nvidiaAsked).toBe(0)
  })
})

describe('everything else keeps NVIDIA first, with Claude as the backup', () => {
  it('asks NVIDIA, and not Claude', async () => {
    expect(await (await askAi({ prompt: 'Suggest tags for: paint the fence' })).json()).toEqual({ text: 'from NVIDIA', provider: 'nvidia' })
    expect(claude.asked).toBe(0)
  })

  it('tries Claude once when NVIDIA is rate-limited', async () => {
    nvidiaStatus = 429
    expect(await (await askAi({ prompt: 'x' })).json()).toEqual({ text: 'from Claude', provider: 'anthropic' })
    expect([nvidiaAsked, claude.asked]).toEqual([1, 1])
  })

  it('answers a failure with no code: only a Claude-only request has one', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    nvidiaStatus = 429
    const res = await askAi({ prompt: 'x' })
    expect(res.status).toBe(429)
    expect(await res.json()).not.toHaveProperty('code')
  })
})

describe('complete() and the app agree on the code', () => {
  it('is the same string on both sides', () => {
    expect(APP_CLAUDE_ONLY).toBe(CLAUDE_ONLY)
  })

  it('routes claudeOnly to Claude in the library itself', async () => {
    expect(await complete({ prompt: 'x', claudeOnly: true })).toEqual({ text: 'from Claude', provider: 'anthropic' })
    expect(nvidiaAsked).toBe(0)
  })
})
