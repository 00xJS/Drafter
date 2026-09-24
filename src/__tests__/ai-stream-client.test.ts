import { afterEach, describe, expect, it, vi } from 'vitest'
import { CUT_SHORT, complete } from '../ai'
import { OFFLINE_MESSAGE } from '../api'
import { sseEvent } from '../../shared/sse.mts'

// The app's side of a streamed answer (src/ai.ts): the words go to whoever is
// watching as they come, and what the call returns is the `done` event's text
// — the same text the ordinary answer carries — so every check a caller runs
// on it still holds. Where there is no stream to read (a deploy from before
// streaming, a proxy, a break before the first word) the ordinary request
// answers instead, and nobody sees the difference. /api/ai is a fetch stub
// that answers as a test plans it.

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** A streamed answer from /api/ai: its events, in pieces cut wherever the test says (an Error breaks the connection there). */
function streamed(pieces: (string | Error)[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const piece = pieces.shift()
      if (piece === undefined) controller.close()
      else if (piece instanceof Error) controller.error(piece)
      else controller.enqueue(encoder.encode(piece))
    },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}

const delta = (text: string) => sseEvent('delta', { text })
const done = (text: string) => sseEvent('done', { text, provider: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b' })

/** /api/ai answering each call in turn; the bodies the app sent. */
function api(...answers: (() => Response | Promise<Response>)[]) {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      const answer = answers[Math.min(bodies.length, answers.length) - 1]
      return answer()
    }),
  )
  return bodies
}

/** Every text `onText` heard, in order. */
function watcher() {
  const heard: string[] = []
  return { heard, onText: (soFar: string) => void heard.push(soFar) }
}

describe('a streamed answer, as the app reads it', () => {
  it('says the words as they arrive — cut anywhere, even inside a letter — and returns the whole answer the server ends with', async () => {
    const wire = `${delta('Two things ')}${delta('are due — ')}${delta('café')}${done('Two things are due — café')}`
    const bytes = new TextEncoder().encode(wire)
    // cut inside the é, which is two bytes
    const at = bytes.indexOf(0xa9)
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 5))
        c.enqueue(bytes.slice(5, at))
        c.enqueue(bytes.slice(at))
        c.close()
      },
    })
    const bodies = api(() => new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
    const w = watcher()
    expect(await complete('brief', 'What is due?', 900, false, { onText: w.onText, reasoning: 'off' })).toBe('Two things are due — café')
    expect(w.heard).toEqual(['Two things ', 'Two things are due — ', 'Two things are due — café'])
    expect(bodies).toEqual([{ system: 'brief', prompt: 'What is due?', maxTokens: 900, json: false, reasoning: 'off', stream: true }])
  })

  it('takes back what was shown on a reset', async () => {
    api(() => streamed([delta('The user wants'), sseEvent('reset', {}), delta('Milk is on the list.'), done('Milk is on the list.')]))
    const w = watcher()
    expect(await complete('brief', 'Milk?', 900, false, { onText: w.onText })).toBe('Milk is on the list.')
    expect(w.heard).toEqual(['The user wants', '', 'Milk is on the list.'])
  })

  it('fails with the server’s words when the answer breaks off part way, and asks nothing more', async () => {
    const bodies = api(() => streamed([delta('Two things'), sseEvent('error', { status: 504, error: 'NVIDIA did not answer in time — try again in a moment.' })]))
    const w = watcher()
    await expect(complete('brief', 'q', 900, false, { onText: w.onText })).rejects.toThrow('NVIDIA did not answer in time — try again in a moment.')
    expect(bodies).toHaveLength(1)
    expect(w.heard).toEqual(['Two things'])
  })

  it('fails as cut short when the connection drops after the first words, or the stream ends with no answer', async () => {
    const dropped = api(() => streamed([delta('Two things'), new TypeError('network connection was lost')]))
    await expect(complete('brief', 'q', 900, false, { onText: () => {} })).rejects.toThrow(CUT_SHORT)
    expect(dropped).toHaveLength(1)
    api(() => streamed([delta('Two things')]))
    await expect(complete('brief', 'q', 900, false, { onText: () => {} })).rejects.toThrow(CUT_SHORT)
  })

  it('starts the words afresh for a second try, when the first reply cannot be used', async () => {
    const bodies = api(
      () => streamed([done('')]),
      () => streamed([delta('Here it is.'), done('Here it is.')]),
    )
    const w = watcher()
    expect(await complete('brief', 'q', 900, false, { onText: w.onText })).toBe('Here it is.')
    expect(w.heard).toEqual(['', 'Here it is.'])
    expect(bodies.map(b => [b.stream, b.reasoning])).toEqual([
      [true, undefined],
      [true, 'off'],
    ])
  })
})

describe('where there is no stream to read, the ordinary answer', () => {
  it('from a server that answers whole — a deploy from before streaming — in the one request', async () => {
    const bodies = api(() => Response.json({ text: 'Answered whole.', provider: 'nvidia' }))
    const w = watcher()
    expect(await complete('brief', 'q', 900, false, { onText: w.onText })).toBe('Answered whole.')
    expect(bodies).toHaveLength(1)
    expect(w.heard).toEqual([])
  })

  it('from the ordinary request, when the stream breaks, or ends, before a word of it', async () => {
    const bodies = api(
      () => streamed([new TypeError('Load failed')]),
      () => Response.json({ text: 'Asked the ordinary way.', provider: 'nvidia' }),
    )
    expect(await complete('brief', 'q', 900, false, { onText: () => {} })).toBe('Asked the ordinary way.')
    expect(bodies.map(b => b.stream)).toEqual([true, undefined])

    const empty = api(
      () => streamed([': a proxy said nothing\n\n']),
      () => Response.json({ text: 'Asked the ordinary way.', provider: 'nvidia' }),
    )
    expect(await complete('brief', 'q', 900, false, { onText: () => {} })).toBe('Asked the ordinary way.')
    expect(empty).toHaveLength(2)
  })

  it('from a body that is neither a stream nor an answer, asked for again the ordinary way', async () => {
    const bodies = api(
      () => new Response('<html>a proxy’s page</html>', { headers: { 'content-type': 'text/html' } }),
      () => Response.json({ text: 'Asked the ordinary way.', provider: 'nvidia' }),
    )
    expect(await complete('brief', 'q', 900, false, { onText: () => {} })).toBe('Asked the ordinary way.')
    expect(bodies).toHaveLength(2)
  })

  it('read whole at the end by a web view that cannot read a response as it arrives', async () => {
    api(
      () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'text/event-stream' }),
          body: null,
          text: async () => `${delta('Two ')}${delta('things.')}${done('Two things.')}`,
        }) as unknown as Response,
    )
    const w = watcher()
    expect(await complete('brief', 'q', 900, false, { onText: w.onText })).toBe('Two things.')
    expect(w.heard).toEqual(['Two ', 'Two things.'])
  })
})

describe('a refusal is said as the ordinary request says it, and never asked twice', () => {
  it('the server’s own words for a rate limit, and a session that ran out', async () => {
    const bodies = api(() => Response.json({ error: 'Too many AI requests from this account — try again in 3 min.' }, { status: 429 }))
    await expect(complete('brief', 'q', 900, false, { onText: () => {} })).rejects.toThrow('Too many AI requests from this account — try again in 3 min.')
    expect(bodies).toHaveLength(1)
    api(() => Response.json({ error: 'invalid session' }, { status: 401 }))
    await expect(complete('brief', 'q', 900, false, { onText: () => {} })).rejects.toThrow('Session expired — sign in again and retry.')
  })

  it('offline as offline', async () => {
    const calls = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', calls)
    await expect(complete('brief', 'q', 900, false, { onText: () => {} })).rejects.toThrow(OFFLINE_MESSAGE)
    expect(calls).toHaveBeenCalledTimes(1)
  })
})

describe('a call nobody is watching', () => {
  it('asks the ordinary way, as every call did before', async () => {
    const bodies = api(() => Response.json({ text: 'Whole.', provider: 'nvidia' }))
    expect(await complete('brief', 'q', 900, false)).toBe('Whole.')
    expect(bodies[0]).not.toHaveProperty('stream')
  })
})
