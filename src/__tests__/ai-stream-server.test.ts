import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sseReader } from '../../shared/sse.mts'

// /api/ai with `stream: true`: the chat's answer word by word, where it used
// to wait twenty seconds and come back whole. NVIDIA is a fetch stub that
// streams each answer as a test plans it — pieces cut wherever the test
// likes, an error part way, a stream that never ends — and the handler is
// read as the app reads it. Up to the first words everything is as before,
// failures and all, so another key can still take over; after them there is
// nobody to hand over to, and a break is an error event the app shows.
//
// Each test loads the library afresh: which model a key answers with outlives
// a call on purpose, and would outlive a test.

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
const MAIN = 'nvapi-main-key-0000'
const SECOND = 'nvapi-second-key-1111'
const SUPER = 'nvidia/nemotron-3-super-120b-a12b'

type Key = 'main' | 'second'
/**
 * One piece of a streamed answer: text to send, a wait for the test to open a
 * gate, an error that breaks the connection, or a hang until the request is
 * aborted.
 */
type Piece = string | { gate: Promise<void> } | Error | 'hang'
/** How NVIDIA answers a request: a status with a message, a whole JSON answer, or a stream of pieces. */
type Plan = { status: number; message?: string } | { whole: string } | { pieces: Piece[] }

let plans: Record<Key, Plan[]>
/** Each NVIDIA request: the key it carried and the body it sent. */
let asked: { key: Key; body: Record<string, unknown> }[]

/** One chunk as NVIDIA streams it: the choice's delta, and its finish reason when there is one. */
const chunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: SUPER, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
const words = (text: string) => chunk({ content: text })
const END = `${chunk({ content: '' }, 'stop')}data: [DONE]\n\n`

function streamed(pieces: Piece[], signal: AbortSignal | undefined): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const piece = pieces.shift()
      if (piece === undefined) return controller.close()
      if (piece instanceof Error) return controller.error(piece)
      if (piece === 'hang') {
        await new Promise<void>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)))
        return
      }
      if (typeof piece !== 'string') {
        await piece.gate
        return
      }
      controller.enqueue(encoder.encode(piece))
    },
  })
  // a real fetch's body fails when its request is aborted
  signal?.addEventListener('abort', () => body.cancel(signal.reason).catch(() => {}))
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('NVIDIA_API_KEY', MAIN)
  vi.stubEnv('NVIDIA_API_KEY_2', SECOND)
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  vi.stubEnv('AI_PROVIDER', '')
  vi.stubEnv('NVIDIA_MODEL', '')
  claude.asked = 0
  plans = { main: [], second: [] }
  asked = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `${SUPABASE}/auth/v1/user`) {
        const m = /^Bearer good-(.+)$/.exec(new Headers(init?.headers).get('authorization') ?? '')
        return m ? Response.json({ id: m[1], email: `${m[1]}@example.test` }) : Response.json({ msg: 'invalid JWT' }, { status: 401 })
      }
      if (url === NVIDIA) {
        const bearer = new Headers(init?.headers).get('authorization')
        const key: Key | null = bearer === `Bearer ${MAIN}` ? 'main' : bearer === `Bearer ${SECOND}` ? 'second' : null
        if (!key) throw new Error('NVIDIA was asked with neither key')
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        asked.push({ key, body })
        const plan = plans[key].shift() ?? { pieces: [words(`from the ${key} key`), END] }
        if ('status' in plan) return Response.json({ error: { message: plan.message ?? `HTTP ${plan.status}` } }, { status: plan.status })
        if ('whole' in plan) return Response.json({ choices: [{ message: { content: plan.whole } }] })
        return streamed([...plan.pieces], init?.signal ?? undefined)
      }
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const lib = () => import('../../netlify/functions/lib/ai.mjs')

/** A signed-in call to /api/ai. */
async function askAi(body: Record<string, unknown>): Promise<Response> {
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

type Event = { event: string; data: Record<string, unknown> }
/** Every event in a streamed body, read to its end. */
async function eventsOf(body: ReadableStream<Uint8Array> | null): Promise<Event[]> {
  const reader = sseReader()
  const text = await new Response(body).text()
  return [...reader.push(text), ...reader.end()].map(e => ({ event: e.event, data: JSON.parse(e.data) as Record<string, unknown> }))
}
/** The words the app would show from `events`: deltas, with a reset taking back what came before it. */
const shownFrom = (events: Event[]) => events.reduce((soFar, e) => (e.event === 'reset' ? '' : e.event === 'delta' ? soFar + String(e.data.text) : soFar), '')
const keys = () => asked.map(a => a.key)
/** console.error, silenced, to read what the calls logged. */
const logs = () => vi.spyOn(console, 'error').mockImplementation(() => {})

describe('a streamed answer', () => {
  it('goes out word by word as NVIDIA writes it, and ends with the whole answer and who wrote it', async () => {
    let open!: () => void
    const gate = new Promise<void>(resolve => (open = resolve))
    // cut mid-event and mid-line, a role-only chunk first, as NVIDIA begins
    const first = words('Two things ')
    plans.main = [{ pieces: [chunk({ role: 'assistant', content: '' }), first.slice(0, 17), first.slice(17), { gate }, words('are due'), words(' tomorrow [T1].'), END] }]
    const res = await askAi({ system: 'brief', prompt: 'What is due?', maxTokens: 900, reasoning: 'off', stream: true })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform')
    // the first words are here while NVIDIA is still writing the rest
    const reader = res.body!.getReader()
    const firstRead = new TextDecoder().decode((await reader.read()).value)
    expect(firstRead).toBe('event: delta\ndata: {"text":"Two things "}\n\n')
    open()
    const rest = await eventsOf(new ReadableStream({ pull: async c => {
      const { done, value } = await reader.read()
      if (done) c.close()
      else c.enqueue(value)
    } }))
    expect(rest).toEqual([
      { event: 'delta', data: { text: 'are due' } },
      { event: 'delta', data: { text: ' tomorrow [T1].' } },
      { event: 'done', data: { text: 'Two things are due tomorrow [T1].', provider: 'nvidia', model: SUPER } },
    ])
    // asked to stream, without the thinking first, as the app asked
    expect(asked[0].body).toMatchObject({ model: SUPER, stream: true, chat_template_kwargs: { enable_thinking: false }, max_tokens: 2048 })
  })

  it('keeps the thinking out: a reasoning field, a <think> block cut across pieces, and a lone </think> taking back what was shown', async () => {
    plans.main = [
      { pieces: [chunk({ reasoning_content: 'The user wants milk.' }), words('<th'), words('ink>still thinking</th'), words('ink>Milk is '), words('on the list.'), END] },
      { pieces: [words('The user asks about eggs. '), words('I should say so.</think>'), words('Eggs are on the list.'), END] },
    ]
    const one = await eventsOf((await askAi({ prompt: 'Milk?', stream: true })).body)
    expect(shownFrom(one)).toBe('Milk is on the list.')
    expect(one.at(-1)).toEqual({ event: 'done', data: { text: 'Milk is on the list.', provider: 'nvidia', model: SUPER } })
    expect(JSON.stringify(one)).not.toMatch(/thinking|wants milk/)

    const two = await eventsOf((await askAi({ prompt: 'Eggs?', stream: true })).body)
    expect(two.map(e => e.event)).toEqual(['delta', 'reset', 'delta', 'done'])
    expect(shownFrom(two)).toBe('Eggs are on the list.')
    // the same text the answer would have carried whole: stripThinking over all of it
    expect(two.at(-1)?.data.text).toBe('Eggs are on the list.')
  })

  it('hands a failure before the first words to the next key: a rate limit, an outage, or an error NVIDIA puts in its stream', async () => {
    const spy = logs()
    plans.main = [{ status: 429 }]
    expect(shownFrom(await eventsOf((await askAi({ prompt: 'x', stream: true })).body))).toBe('from the second key')
    expect(keys()).toEqual(['main', 'second'])

    asked = []
    plans.main = [{ pieces: [chunk({ role: 'assistant', content: '' }), `data: ${JSON.stringify({ error: { message: 'Worker overloaded', code: 503 } })}\n\n`] }]
    const events = await eventsOf((await askAi({ prompt: 'x', stream: true })).body)
    expect(shownFrom(events)).toBe('from the second key')
    expect(keys()).toEqual(['main', 'second'])
    expect(spy).not.toHaveBeenCalledWith(expect.stringContaining('broke off'))
  })

  it('answers a failure before the first words as the ordinary answer does, when no key can take over', async () => {
    vi.stubEnv('NVIDIA_API_KEY_2', '')
    logs()
    plans.main = [{ status: 503, message: 'upstream connect error' }]
    const res = await askAi({ prompt: 'x', stream: true })
    expect(res.status).toBe(502)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(await res.json()).toEqual({ error: 'NVIDIA’s service had a problem (HTTP 503) — try again in a moment.' })
  })

  it('never hands over once words are on their way: a break after them ends the stream with an error event', async () => {
    const spy = logs()
    plans.main = [{ pieces: [words('Two things'), new TypeError('terminated')] }]
    const events = await eventsOf((await askAi({ prompt: 'x', stream: true })).body)
    expect(events).toEqual([
      { event: 'delta', data: { text: 'Two things' } },
      { event: 'error', data: { status: 502, error: 'The assistant’s provider stopped part way through — try again in a moment.' } },
    ])
    expect(keys()).toEqual(['main'])
    expect(String(spy.mock.calls[0][0])).toContain('terminated')

    asked = []
    plans.main = [{ pieces: [words('Two things'), `data: ${JSON.stringify({ error: { message: 'Worker died', code: 500 } })}\n\n`] }]
    const again = await eventsOf((await askAi({ prompt: 'x', stream: true })).body)
    expect(again.at(-1)).toEqual({ event: 'error', data: { status: 502, error: 'NVIDIA’s service stopped part way through the answer — try again in a moment.' } })
    expect(keys()).toEqual(['main'])
  })

  it('ends an empty answer as an empty answer, for the app to ask again as it always has — no other key is asked', async () => {
    plans.main = [{ pieces: [chunk({ role: 'assistant', content: '' }), END] }]
    const events = await eventsOf((await askAi({ prompt: 'x', stream: true })).body)
    expect(events).toEqual([{ event: 'done', data: { text: '', provider: 'nvidia', model: SUPER } }])
    expect(keys()).toEqual(['main'])
  })
})

describe('the budget, streamed', () => {
  it('ends the wait for the first words at the deadline as the 504 it always was', async () => {
    plans.main = [{ pieces: ['hang'] }]
    const { completeStream } = await lib()
    const started = Date.now()
    expect(await completeStream({ prompt: 'x', deadline: Date.now() + 60 })).toEqual({ status: 504, error: 'NVIDIA did not answer in time — try again in a moment.' })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('ends an answer still going at the deadline with an error event, and stops asking NVIDIA for it', async () => {
    plans.main = [{ pieces: [words('Two things'), 'hang'] }]
    const { completeStream } = await lib()
    const result = await completeStream({ prompt: 'x', deadline: Date.now() + 80 })
    expect(result).toMatchObject({ provider: 'nvidia', model: SUPER })
    expect(await eventsOf(result.body ?? null)).toEqual([
      { event: 'delta', data: { text: 'Two things' } },
      { event: 'error', data: { status: 504, error: 'NVIDIA did not answer in time — try again in a moment.' } },
    ])
  })
})

describe('what is answered whole', () => {
  it('JSON, which has nothing to show until it is whole', async () => {
    plans.main = [{ whole: '{"tags":["home"]}' }]
    const res = await askAi({ prompt: 'x', json: true, stream: true })
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(await res.json()).toEqual({ text: '{"tags":["home"]}', provider: 'nvidia' })
    expect(asked[0].body).toMatchObject({ stream: false, response_format: { type: 'json_object' } })
  })

  it('a host that names Anthropic, which answers whole as it always did', async () => {
    vi.stubEnv('AI_PROVIDER', 'anthropic')
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key')
    const res = await askAi({ prompt: 'x', stream: true })
    expect(await res.json()).toEqual({ text: 'from Claude', provider: 'anthropic' })
    expect([claude.asked, asked]).toEqual([1, []])
  })

  it('a gateway that answers the streamed request whole, and a model that will not stream', async () => {
    const spy = logs()
    plans.main = [{ whole: '<think>hm</think>Two things.' }]
    expect(await (await askAi({ prompt: 'x', stream: true })).json()).toEqual({ text: 'Two things.', provider: 'nvidia' })

    plans.main = [{ status: 400, message: 'Streaming is not supported for this model' }, { whole: 'Asked whole.' }]
    expect(await (await askAi({ prompt: 'x', stream: true })).json()).toEqual({ text: 'Asked whole.', provider: 'nvidia' })
    expect(asked.slice(1).map(a => [a.key, a.body.stream])).toEqual([
      ['main', true],
      ['main', false],
    ])
    expect(String(spy.mock.calls[0][0])).toContain('refused to stream')
  })

  it('every call that does not ask to stream, as before', async () => {
    plans.main = [{ whole: 'The review.' }]
    const res = await askAi({ prompt: 'x' })
    expect(await res.json()).toEqual({ text: 'The review.', provider: 'nvidia' })
    expect(asked[0].body.stream).toBe(false)
  })
})

describe('the account’s thirty', () => {
  it('counts a streamed call once, however many words it streams', async () => {
    for (let i = 0; i < 30; i++) {
      plans.main.push({ pieces: [words('one '), words('two '), words('three'), END] })
      const res = await askAi({ prompt: 'x', stream: true })
      expect(res.status).toBe(200)
      expect(shownFrom(await eventsOf(res.body))).toBe('one two three')
    }
    const over = await askAi({ prompt: 'x', stream: true })
    expect(over.status).toBe(429)
    expect(asked).toHaveLength(30)
  })
})
