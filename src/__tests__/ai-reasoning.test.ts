import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Three rules of the server's AI call. `reasoning: 'off'` reaches the model
// the way its card says to ask (Nemotron 3 thinks before every answer unless
// told not to, and the thinking was most of a 20–60 second wait for a tag
// suggestion). A 400 walks on to another model only when it is about the
// model; one about the request came back as "no model was available" after
// being sent to four. And /api/ai turns away more than 64 KB of text before
// it spends one of the account's thirty requests.
//
// Each test loads the library afresh: which model a key answers with, and
// which refused the switch, outlive a call on purpose, and would outlive a test.

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

const SUPABASE = 'https://db.example.test'
const NVIDIA = 'https://integrate.api.nvidia.com/v1/chat/completions'
const SUPER = 'nvidia/nemotron-3-super-120b-a12b'
const LLAMA = 'nvidia/llama-3.1-nemotron-70b-instruct'

/** Each NVIDIA request's body, in order. */
let bodies: Record<string, unknown>[]
/** How NVIDIA answers a request: 200 unless this says otherwise. */
let answer: (body: Record<string, unknown>) => { status: number; message?: string }

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('NVIDIA_API_KEY', 'nvapi-main')
  vi.stubEnv('NVIDIA_API_KEY_2', '')
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  vi.stubEnv('AI_PROVIDER', '')
  vi.stubEnv('NVIDIA_MODEL', '')
  claude.asked = 0
  bodies = []
  answer = () => ({ status: 200 })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `${SUPABASE}/auth/v1/user`) {
        const m = /^Bearer good-(.+)$/.exec(new Headers(init?.headers).get('authorization') ?? '')
        return m ? Response.json({ id: m[1], email: `${m[1]}@example.test` }) : Response.json({ msg: 'invalid JWT' }, { status: 401 })
      }
      if (url === NVIDIA) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        bodies.push(body)
        const { status, message } = answer(body)
        return status === 200
          ? Response.json({ choices: [{ message: { content: `from ${body.model}` } }] })
          : Response.json({ error: { message: message ?? `HTTP ${status}` } }, { status })
      }
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const lib = () => import('../../netlify/functions/lib/ai.mjs')
/** A signed-in call to /api/ai, from the one account a test uses. */
const askAi = async (body: Record<string, unknown>) => {
  // @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
  const handler = (await import('../../netlify/functions/ai.mjs')).default as (req: Request) => Promise<Response>
  return handler(
    new Request('https://site.test/api/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer good-r1' },
      body: JSON.stringify(body),
    }),
  )
}
/** console.error, silenced, to read what the calls logged. */
const logs = () => vi.spyOn(console, 'error').mockImplementation(() => {})

describe('reasoning off, where the model has a switch for it', () => {
  it('asks Nemotron 3 Super to answer without thinking first, the way its model card says', async () => {
    const { complete } = await lib()
    expect(await complete({ prompt: 'Suggest tags', json: true, reasoning: 'off' })).toEqual({ text: `from ${SUPER}`, provider: 'nvidia' })
    expect(bodies[0]).toMatchObject({ model: SUPER, chat_template_kwargs: { enable_thinking: false }, response_format: { type: 'json_object' } })
    // the room stays: a model that ignores the switch still thinks
    expect(bodies[0].max_tokens).toBe(2048)
  })

  it('sends no switch when the caller says nothing, and none to a model that has no switch', async () => {
    await (await lib()).complete({ prompt: 'Write my review' })
    expect(bodies[0]).not.toHaveProperty('chat_template_kwargs')
    // afresh, so the model the key answered with just now does not go first
    vi.stubEnv('NVIDIA_MODEL', LLAMA)
    vi.resetModules()
    await (await lib()).complete({ prompt: 'Suggest tags', reasoning: 'off' })
    expect(bodies[1]).toMatchObject({ model: LLAMA })
    expect(bodies[1]).not.toHaveProperty('chat_template_kwargs')
  })

  it('asks a model that refuses the switch after all again without it, and never sends it there again', async () => {
    const spy = logs()
    answer = body => (body.chat_template_kwargs ? { status: 400, message: 'Unsupported parameter: chat_template_kwargs' } : { status: 200 })
    const { complete } = await lib()
    expect((await complete({ prompt: 'x', reasoning: 'off' })).text).toBe(`from ${SUPER}`)
    expect((await complete({ prompt: 'x', reasoning: 'off' })).text).toBe(`from ${SUPER}`)
    expect(bodies.map(b => [b.model, 'chat_template_kwargs' in b])).toEqual([
      [SUPER, true],
      [SUPER, false],
      [SUPER, false],
    ])
    expect(spy.mock.calls.map(c => String(c[0]))).toEqual([
      `ai: ${SUPER} refused the reasoning switch, so it is asked without one: Unsupported parameter: chat_template_kwargs`,
    ])
  })

  it('reaches the model from /api/ai as it was asked, and anything but off or on is no setting', async () => {
    await askAi({ prompt: 'x', reasoning: 'off' })
    await askAi({ prompt: 'x', reasoning: 'on' })
    await askAi({ prompt: 'x', reasoning: 'none at all' })
    expect(bodies.map(b => b.chat_template_kwargs)).toEqual([{ enable_thinking: false }, { enable_thinking: true }, undefined])
  })
})

describe('which failures walk on to another model', () => {
  it('a 400 about the request is said plainly, logged in full, and sent to no other model', async () => {
    const spy = logs()
    answer = () => ({ status: 400, message: "This model's maximum context length is 131072 tokens. However, you requested 150000 tokens." })
    const { complete } = await lib()
    expect(await complete({ prompt: 'x' })).toEqual({
      status: 502,
      upstream: 400,
      error: 'NVIDIA couldn’t take that request (HTTP 400) — try again, or with less text.',
    })
    expect(bodies).toHaveLength(1)
    expect(spy.mock.calls.map(c => String(c[0]))).toEqual([
      `ai: NVIDIA answered ${SUPER} on NVIDIA_API_KEY with HTTP 400: This model's maximum context length is 131072 tokens. However, you requested 150000 tokens.`,
    ])
  })

  it('a 400 that names the model, or a parameter it lacks, walks on as a 404 does', async () => {
    answer = body => (body.model === SUPER ? { status: 400, message: `Model ${SUPER} is not supported for this account` } : { status: 200 })
    const { complete } = await lib()
    expect((await complete({ prompt: 'x' })).text).toBe(`from ${LLAMA}`)
    answer = body => (body.model === LLAMA ? { status: 422, message: 'response_format is not supported by this model' } : { status: 200 })
    vi.resetModules()
    bodies = []
    vi.stubEnv('NVIDIA_MODEL', LLAMA)
    expect((await (await lib()).complete({ prompt: 'x', json: true })).text).toBe(`from ${SUPER}`)
    expect(bodies.map(b => b.model)).toEqual([LLAMA, SUPER])
  })

  it('a provider error reads plainly on the page, with NVIDIA’s own words in the log', async () => {
    const spy = logs()
    answer = () => ({ status: 503, message: 'upstream connect error or disconnect/reset before headers' })
    const res = await askAi({ prompt: 'x' })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'NVIDIA’s service had a problem (HTTP 503) — try again in a moment.' })
    expect(String(spy.mock.calls[0][0])).toContain('upstream connect error')
  })
})

describe('how much one call may send', () => {
  it('turns away more than 64 KB of text with a 413, before it counts against the account', async () => {
    const tooLong = { system: 'Read this recipe.', prompt: 'x'.repeat(64 * 1024) }
    // thirty of them, as many as the account may make in ten minutes
    for (let i = 0; i < 30; i++) {
      const res = await askAi(tooLong)
      expect(res.status).toBe(413)
      expect(await res.json()).toEqual({ error: 'That is more text than the assistant takes at once — try again with less.' })
    }
    expect(bodies).toHaveLength(0)
    // and the next ordinary one still goes
    expect((await askAi({ prompt: 'x' })).status).toBe(200)
  })

  it('counts bytes, not letters, and takes a long ordinary request', async () => {
    expect((await askAi({ prompt: 'é'.repeat(33 * 1024) })).status).toBe(413)
    expect((await askAi({ system: 's'.repeat(8 * 1024), prompt: 'p'.repeat(40 * 1024) })).status).toBe(200)
  })
})
