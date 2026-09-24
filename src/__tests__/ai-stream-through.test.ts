import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AskDoc } from '../ask'
import { askWithActions, chatActionContext } from '../chatactions'
import type { Task } from '../types'

// The chat's question through both ends at once: the app's call (src/ai.ts),
// the /api/ai function it reaches, and NVIDIA behind that, streaming. The
// server's events are the ones the app reads, the words shown are the answer's
// alone, and what the chat keeps is the whole reply, suggestion and all.
// NVIDIA and the sign-in check are fetch stubs; the rest is the real code.

vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }))

const SUPABASE = 'https://db.example.test'
const NVIDIA = 'https://integrate.api.nvidia.com/v1/chat/completions'
const STAMP = '2026-09-01T12:00:00.000Z'
const TASKS: Task[] = [{ kind: 'task', id: 't-plumber', title: 'Call the plumber', description: '', status: 'todo', priority: 'normal', createdAt: STAMP, updatedAt: STAMP, tags: [] }]
const DOCS: AskDoc[] = [{ ref: 'T1', kind: 'task', id: 't-plumber', title: 'Call the plumber', text: '' }]
const NOW = new Date('2026-09-23T03:30:00.000Z')
const context = () =>
  chatActionContext({ intents: new Set(['tasks']) as never, personIds: [], placeIds: [], recipeIds: [] }, DOCS, { people: [], recipes: [], places: [], tasks: TASKS }, { now: NOW, tz: 'America/Phoenix' })

/** What NVIDIA writes, a few characters a chunk: thinking in its own field, then the answer and its details. */
const ANSWER = 'The plumber [T1] can move to Friday.\n\n```json\n{"cites": ["T1"], "general": false, "actions": [{"type": "update_task", "ref": "T1", "date": "2026-09-25"}]}\n```'
const chunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

let nvidiaBodies: Record<string, unknown>[]
/** Held shut, NVIDIA stops after the answer's first words until the test opens it. */
let gate: Promise<void> | null

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('NVIDIA_API_KEY', 'nvapi-main')
  nvidiaBodies = []
  gate = null
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `${SUPABASE}/auth/v1/user`) return Response.json({ id: 'u1', email: 'u1@example.test' })
      if (url === NVIDIA) {
        nvidiaBodies.push(JSON.parse(String(init?.body)))
        const pieces: (string | Promise<void>)[] = [chunk({ role: 'assistant', content: '' }), chunk({ reasoning_content: 'They want the plumber moved.' })]
        for (let i = 0; i < ANSWER.length; i += 9) pieces.push(chunk({ content: ANSWER.slice(i, i + 9) }))
        pieces.push(chunk({ content: '' }, 'stop'), 'data: [DONE]\n\n')
        // after the role, the thinking and the answer's first nine characters
        if (gate) pieces.splice(3, 0, gate)
        const encoder = new TextEncoder()
        return new Response(
          new ReadableStream<Uint8Array>({
            pull: async c => {
              const piece = pieces.shift()
              if (piece === undefined) c.close()
              else if (typeof piece === 'string') c.enqueue(encoder.encode(piece))
              else await piece
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }
      if (url === '/api/ai') {
        // the app's own call, signed in, to the function itself
        // @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
        const handler = (await import('../../netlify/functions/ai.mjs')).default as (req: Request) => Promise<Response>
        return handler(new Request('https://site.test/api/ai', { ...init, headers: { ...(init?.headers as Record<string, string>), authorization: 'Bearer good-u1' } }))
      }
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('the chat’s question, from the app to NVIDIA and back', () => {
  it('shows the answer’s words as they come, without its thinking or its details, and keeps the whole reply', async () => {
    const shown: string[] = []
    const reply = await askWithActions('Move the plumber to Friday', DOCS, [], [], context(), s => shown.push(s))
    expect(reply).toEqual({
      answer: 'The plumber [T1] can move to Friday.',
      cites: ['T1'],
      actions: [{ type: 'update_task', taskId: 't-plumber', title: 'Call the plumber', date: '2026-09-25' }],
      dropped: [],
    })
    // word by word, never the block the app reads, never the thinking
    expect(shown.length).toBeGreaterThan(2)
    expect(shown.at(-1)).toBe('The plumber [T1] can move to Friday.')
    expect(shown.some(s => /```|\{|They want/.test(s))).toBe(false)
    // one request to NVIDIA, streamed, without the thinking first
    expect(nvidiaBodies).toHaveLength(1)
    expect(nvidiaBodies[0]).toMatchObject({ stream: true, chat_template_kwargs: { enable_thinking: false } })
  })
})

describe('words before the answer is written', () => {
  it('are on screen while NVIDIA is still writing the rest', async () => {
    let open!: () => void
    gate = new Promise<void>(resolve => (open = resolve))
    const shown: string[] = []
    let settled = false
    const asked = askWithActions('Move the plumber to Friday', DOCS, [], [], context(), s => shown.push(s)).finally(() => (settled = true))
    await vi.waitFor(() => expect(shown.at(-1)).toBe('The plumb'))
    expect(settled).toBe(false)
    open()
    expect((await asked).answer).toBe('The plumber [T1] can move to Friday.')
  })
})
