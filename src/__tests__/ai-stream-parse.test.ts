import { describe, expect, it } from 'vitest'
import { stripThinking, thinkingFilter } from '../../shared/ai.mts'
import { sseEvent, sseReader, type SseEvent } from '../../shared/sse.mts'

// The two readers a streamed answer goes through. NVIDIA's event stream, and
// the one /api/ai sends on to the app, arrive in whatever pieces the network
// cuts them into: mid-line, mid-event, between the \r and \n of one line
// break. And a reasoning model's thinking has to stay out of the words the
// app shows as they come — a <think> block cut across pieces, the model's own
// reasoning field, or a lone </think> that means everything before it was
// thinking — agreeing, piece by piece, with what stripThinking makes of the
// whole.

/** Every event in `text`, fed to a reader in the pieces given by `cuts`. */
function read(text: string, cuts: number[] = []): SseEvent[] {
  const reader = sseReader()
  const out: SseEvent[] = []
  let from = 0
  for (const at of [...cuts, text.length]) {
    out.push(...reader.push(text.slice(from, at)))
    from = at
  }
  return [...out, ...reader.end()]
}

/** Every way to cut `text` into three pieces. */
const everyCut = (text: string) => Array.from({ length: text.length + 1 }, (_, i) => Array.from({ length: text.length - i + 1 }, (_, j) => [i, i + j])).flat()

describe('reading an event stream', () => {
  const STREAM = 'data: {"a":1}\n\nevent: delta\ndata: {"text":"Two things"}\n\n: keep-alive\n\ndata: first line\ndata: second line\n\ndata: [DONE]\n\n'
  const EVENTS = [
    { event: 'message', data: '{"a":1}' },
    { event: 'delta', data: '{"text":"Two things"}' },
    { event: 'message', data: 'first line\nsecond line' },
    { event: 'message', data: '[DONE]' },
  ]

  it('reads data lines, named events, multi-line data and [DONE], and skips comments', () => {
    expect(read(STREAM)).toEqual(EVENTS)
  })

  it('reads the same events however the stream is cut: mid-line, mid-event, mid-field name', () => {
    for (const cuts of everyCut(STREAM)) expect(read(STREAM, cuts), JSON.stringify(cuts)).toEqual(EVENTS)
  })

  it('reads CRLF and lone CR line breaks, even with a piece ending between the \\r and the \\n', () => {
    const crlf = 'data: one\r\n\r\ndata: two\r\rdata: three\n\n'
    const events = [
      { event: 'message', data: 'one' },
      { event: 'message', data: 'two' },
      { event: 'message', data: 'three' },
    ]
    for (const cuts of everyCut(crlf)) expect(read(crlf, cuts), JSON.stringify(cuts)).toEqual(events)
  })

  it('reads a last event the stream never closed with a blank line, and ignores a byte-order mark', () => {
    expect(read('\uFEFFdata: {"text":"hi"}\n\ndata: {"text":"end"}')).toEqual([
      { event: 'message', data: '{"text":"hi"}' },
      { event: 'message', data: '{"text":"end"}' },
    ])
  })

  it('takes one space after the colon, a field with no colon as empty, and an event with no data as nothing', () => {
    expect(read('data:  two spaces\ndata\n\nevent: ping\n\n')).toEqual([{ event: 'message', data: ' two spaces\n' }])
  })

  it('writes an event as one line of JSON that it reads back whole, line breaks and all', () => {
    const data = { text: 'line one\nline two\r\n“quoted” — and a \u2028' }
    const wire = sseEvent('delta', data)
    expect(wire.split('\n').filter(Boolean)).toHaveLength(2)
    expect(read(wire).map(e => ({ event: e.event, data: JSON.parse(e.data) }))).toEqual([{ event: 'delta', data }])
  })
})

/** What the app shows after `pieces` go through the filter: a reset takes back what was shown. */
function shown(pieces: string[]): { text: string; resets: number } {
  const filter = thinkingFilter()
  let text = ''
  let resets = 0
  for (const piece of pieces) {
    const got = filter.push(piece)
    if (got.reset) {
      text = ''
      resets++
    }
    text += got.text
  }
  return { text: text + filter.end(), resets }
}

/** `text` cut into pieces of `n` characters. */
const pieces = (text: string, n: number) => Array.from({ length: Math.ceil(text.length / n) }, (_, i) => text.slice(i * n, (i + 1) * n))

describe('keeping the thinking out of words that are still arriving', () => {
  it('holds back a <think> block whose tags are cut across pieces', () => {
    expect(shown(['<th', 'ink>the user wants milk</thi', 'nk>Milk is on the list.'])).toEqual({ text: 'Milk is on the list.', resets: 0 })
    expect(shown(['Sure. <', 'reasoning>hmm</reasoning', '> Done.'])).toEqual({ text: 'Sure.  Done.', resets: 0 })
  })

  it('takes back what was shown when a lone </think> says it was the thinking', () => {
    // the chat template opened the block in the prompt; the model only ever wrote the close
    expect(shown(['The user asks about milk. ', 'I should check the list.</th', 'ink>Milk is on the list.'])).toEqual({ text: 'Milk is on the list.', resets: 1 })
  })

  it('needs no take-back when nothing had been shown yet', () => {
    const filter = thinkingFilter()
    expect(filter.push('reasoning</think>Answer')).toEqual({ text: 'Answer', reset: false })
  })

  it('takes one lone close back, as stripThinking does, and leaves a second in the text', () => {
    const text = 'a </think> b </think> c'
    expect(shown(pieces(text, 3)).text.trim()).toBe(stripThinking(text))
  })

  it('holds back everything after an open that never closes, and lets a "<" that is no tag through', () => {
    expect(shown(['Two things. <think>and then', ' more thinking'])).toEqual({ text: 'Two things. ', resets: 0 })
    expect(shown(['1 < 2 and 3 <', '4, <b>bold</b>, <thin', 'gs>'])).toEqual({ text: '1 < 2 and 3 <4, <b>bold</b>, <things>', resets: 0 })
  })

  it('knows the tags in any case, and NIM’s triangle ones as written', () => {
    expect(shown(['<THINK>x</Think>Yes'])).toEqual({ text: 'Yes', resets: 0 })
    expect(shown(['◁thi', 'nk▷x◁/think▷', 'Yes'])).toEqual({ text: 'Yes', resets: 0 })
  })

  it('holds back only a piece that could still become a tag, and lets it go at the end', () => {
    const filter = thinkingFilter()
    expect(filter.push('Two things <thi')).toEqual({ text: 'Two things ', reset: false })
    expect(filter.end()).toBe('<thi')
  })

  it('agrees with stripThinking over the whole text, however the text is cut', () => {
    const samples = [
      'Plain answer, nothing to take out.',
      '<think>Let me look at the records.</think>You have two things due.',
      'Planning the reply.\nThe user wants eggs.</think>\n\nI can add eggs [T1].',
      'Answer first <thinking>aside</thinking> and more <reasoning>why</reasoning> end.',
      'An answer that runs out mid-thought <think>because the budget',
      '◁think▷triangles◁/think▷ and words',
      'Words, <THINK>shouted</think> and done.',
    ]
    for (const text of samples)
      for (const n of [1, 2, 3, 5, 8, 13, 1000]) {
        const got = shown(pieces(text, n))
        expect(got.text.trim(), `${JSON.stringify(text)} in pieces of ${n}`).toBe(stripThinking(text))
      }
  })
})
