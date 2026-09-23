import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as lib from '../../netlify/functions/lib/ai.mjs'
// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import aiFunction from '../../netlify/functions/ai.mjs'

// The journal follows the normal provider order. Ask Drafter with its Journal
// chip on used to send its question to Claude alone; the owner runs Drafter on
// NVIDIA's open model with no paid Anthropic key, and reversed that on
// 2026-09-14. A question that carries journal entries now goes where every
// other ✨ request goes: NVIDIA first, and Claude once, as the backup, only
// when its key is set. The Anthropic SDK is replaced here and NVIDIA is a
// fetch stub, so each test sees who was asked, and with what.

const claude = vi.hoisted(() => ({ asked: 0 }))
vi.mock('@anthropic-ai/sdk', () => {
  const create = async () => {
    claude.asked++
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
/** What Ask sends with the chip on: the matching entries are among its records. */
const WITH_JOURNAL = 'Records:\n[J1] Journal · 2026-09-10: Felt great after seeing Mum\n\nQuestion: How did I feel last week?'
let nvidiaPrompts: string[]
let nvidiaStatus = 200

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('NVIDIA_API_KEY', 'nvidia-key')
  vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key')
  vi.stubEnv('AI_PROVIDER', '')
  // the build runs the tests with the site's own variables: a second NVIDIA key there must not count here
  vi.stubEnv('NVIDIA_API_KEY_2', '')
  claude.asked = 0
  nvidiaPrompts = []
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
        nvidiaPrompts.push(JSON.parse(String(init?.body)).messages.at(-1).content)
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

describe('/api/ai: a question with the journal in it follows the normal provider order', () => {
  it('goes to NVIDIA first, as every other request does, and not to Claude', async () => {
    const res = await askAi({ prompt: WITH_JOURNAL, json: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: 'from NVIDIA', provider: 'nvidia' })
    expect(nvidiaPrompts).toEqual([WITH_JOURNAL])
    expect(claude.asked).toBe(0)
  })

  it('reads the journal flag an older copy of the app still sends as nothing at all', async () => {
    expect(await (await askAi({ prompt: WITH_JOURNAL, json: true, journal: true })).json()).toEqual({ text: 'from NVIDIA', provider: 'nvidia' })
    expect(claude.asked).toBe(0)
  })

  it('never tries Claude when NVIDIA is rate-limited, a Claude key set or not: NVIDIA keys only', async () => {
    nvidiaStatus = 429
    const res = await askAi({ prompt: WITH_JOURNAL, journal: true })
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: expect.stringMatching(/^NVIDIA rate limit hit/) })
    expect([nvidiaPrompts.length, claude.asked]).toEqual([1, 0])
  })

  it('without a Claude key answers with NVIDIA’s own error, and no code of its own', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    nvidiaStatus = 429
    const res = await askAi({ prompt: WITH_JOURNAL, journal: true })
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: expect.stringMatching(/^NVIDIA rate limit hit/) })
    expect(claude.asked).toBe(0)
  })

  it('is off when Claude’s is the only key: a Claude key is used only where AI_PROVIDER names it', async () => {
    vi.stubEnv('NVIDIA_API_KEY', '')
    const res = await askAi({ prompt: WITH_JOURNAL, journal: true })
    expect(res.status).toBe(501)
    expect([nvidiaPrompts, claude.asked]).toEqual([[], 0])
  })

  it('keeps AI_PROVIDER’s order: anthropic goes first and never falls back to NVIDIA', async () => {
    vi.stubEnv('AI_PROVIDER', 'anthropic')
    expect(await (await askAi({ prompt: WITH_JOURNAL, journal: true })).json()).toEqual({ text: 'from Claude', provider: 'anthropic' })
    expect(nvidiaPrompts).toEqual([])
  })

  it('with no key at all is off, as every ✨ feature is', async () => {
    vi.stubEnv('NVIDIA_API_KEY', '')
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    const res = await askAi({ prompt: WITH_JOURNAL, journal: true })
    expect(res.status).toBe(501)
    expect(await res.json()).toEqual({ error: 'AI is not configured on this site: set NVIDIA_API_KEY in the host environment.' })
  })
})

describe('the Claude-only path is gone from the library', () => {
  it('exports no code for it, and a claudeOnly flag changes nothing', async () => {
    expect('CLAUDE_ONLY' in lib).toBe(false)
    expect(await lib.complete({ prompt: WITH_JOURNAL, claudeOnly: true } as Parameters<typeof lib.complete>[0])).toEqual({ text: 'from NVIDIA', provider: 'nvidia' })
    expect(claude.asked).toBe(0)
  })
})
