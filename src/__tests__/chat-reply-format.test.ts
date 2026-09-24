import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AskDoc } from '../ask'
import { ASK_NUDGE, THOUGHT_OUT_LOUD, askDrafter, replyParts, shownSoFar } from '../ai'
import { CHAT_NUDGE, CUT_OFF, askInThread, askWithActions, buildChatPrompt, chatActionContext, chatSoFar, parseChatReply, type ChatReply } from '../chatactions'
import { GENERAL_LABEL } from '../assistanthelp'
import type { ChatTurn, Task } from '../types'
import { sseEvent } from '../../shared/sse.mts'

// The chat's reply in its new shape: the answer first, in plain words the
// thread shows as they arrive, then a ```json block with the references,
// the suggestions and the general flag. The block is never shown while it
// arrives; it is read at the end with the same checks as ever. A model that
// still answers in the old all-JSON shape is read as it always was. And
// nothing a streamed answer shows is ever written as a turn: only the whole
// reply, read and checked, or nothing at all.

afterEach(() => vi.unstubAllGlobals())

const TZ = 'America/Phoenix'
/** Tuesday 22 September 2026, 20:30 in Phoenix. */
const NOW = new Date('2026-09-23T03:30:00.000Z')
const STAMP = '2026-09-01T12:00:00.000Z'
const TASKS: Task[] = [{ kind: 'task', id: 't-plumber', title: 'Call the plumber', description: '', status: 'todo', priority: 'normal', createdAt: STAMP, updatedAt: STAMP, tags: [] }]
const DOCS: AskDoc[] = [{ ref: 'T1', kind: 'task', id: 't-plumber', title: 'Call the plumber', text: '' }]
const context = () =>
  chatActionContext({ intents: new Set(['tasks']) as never, personIds: [], placeIds: [], recipeIds: [] }, DOCS, { people: [], recipes: [], places: [], tasks: TASKS }, { now: NOW, tz: TZ })

const block = (details: unknown) => `\`\`\`json\n${JSON.stringify(details)}\n\`\`\``
const GROCERY = { type: 'add_grocery', items: ['milk', 'eggs'] }
/** A reply in the new shape. */
const twoPart = (words: string, details: unknown) => `${words}\n\n${block(details)}`

describe('the reply, read into its words and its details', () => {
  it('the answer first, then the fenced details — the new shape', () => {
    expect(replyParts(twoPart('I can add those [T1].', { cites: ['T1'], general: false, actions: [GROCERY] }))).toEqual({
      said: 'I can add those [T1].',
      details: { cites: ['T1'], general: false, actions: [GROCERY] },
      cutOff: false,
    })
  })

  it('the details unfenced, on a line of their own or after a sentence, and before the answer rather than after it', () => {
    expect(replyParts(`Sure.\n${JSON.stringify({ cites: [], actions: [GROCERY] })}`)).toMatchObject({ said: 'Sure.', details: { actions: [GROCERY] } })
    expect(replyParts(`Sure. ${JSON.stringify({ cites: [], actions: [GROCERY] })}`)).toMatchObject({ said: 'Sure.', details: { actions: [GROCERY] } })
    expect(replyParts(`${block({ cites: ['T1'] })}\nThe plumber is due Thursday [T1].`)).toMatchObject({ said: 'The plumber is due Thursday [T1].', details: { cites: ['T1'] } })
  })

  it('an answer that holds a block of its own before its details, and one that opens with a reference', () => {
    const formula = 'Use this in the sheet:\n```\n=SUM(A1:A3)\n```\nThen copy it down.'
    expect(replyParts(twoPart(formula, { cites: [], general: true, actions: [] }))).toMatchObject({ said: formula, details: { general: true } })
    expect(replyParts('[T1] is due on Thursday.')).toEqual({ said: '[T1] is due on Thursday.', details: null, cutOff: false })
  })

  it('the old all-JSON shape, as it always was: fenced, with chatter, or a bare list of suggestions', () => {
    const old = { answer: 'I can save that [T1].', cites: ['T1'], actions: [] }
    expect(replyParts(JSON.stringify(old))).toMatchObject({ said: 'I can save that [T1].', details: old })
    expect(replyParts(`Sure! \`\`\`json\n${JSON.stringify(old)}\n\`\`\` Hope that helps`)).toMatchObject({ said: 'I can save that [T1].', details: old })
    expect(replyParts(JSON.stringify([GROCERY]))).toEqual({ said: '', details: { actions: [GROCERY] }, cutOff: false })
  })

  it('a block begun and never finished: the words kept, the reply marked cut off', () => {
    expect(replyParts('I can add those.\n```json\n{"cites": [], "actions": [{"type": "add_gro')).toEqual({ said: 'I can add those.', details: null, cutOff: true })
    expect(replyParts('I can add those.\n```json')).toEqual({ said: 'I can add those.', details: null, cutOff: true })
    // a brace in a sentence is only a brace
    expect(replyParts('Wrap it in { and } like this.')).toEqual({ said: 'Wrap it in { and } like this.', details: null, cutOff: false })
  })

  it('nothing at all from JSON that says nothing, and the thinking taken out first', () => {
    expect(replyParts('{"":""}')).toEqual({ said: '', details: null, cutOff: false })
    expect(replyParts('{"answer": ""}')).toMatchObject({ said: '' })
    // an empty "answer" in the details of a reply whose words came first is no answer: the words are
    expect(replyParts(twoPart('Two things are due.', { answer: '', cites: [] }))).toMatchObject({ said: 'Two things are due.' })
    expect(replyParts('<think>{"answer":"not this"}</think>Two things.\n```json\n{"cites":[]}\n```')).toMatchObject({ said: 'Two things.', details: { cites: [] } })
  })
})

describe('what shows while the reply arrives', () => {
  it('the answer’s words, never the details: cut at the fence, and a backtick or a brace at the end held back', () => {
    expect(shownSoFar('  Two things are due')).toBe('Two things are due')
    expect(shownSoFar('Two things are due.\n\n`')).toBe('Two things are due.')
    expect(shownSoFar('Two things are due.\n\n``')).toBe('Two things are due.')
    expect(shownSoFar('Two things are due.\n\n```json\n{"cites": ["T1"], "act')).toBe('Two things are due.')
    expect(shownSoFar('Two things are due.\n{')).toBe('Two things are due.')
    expect(shownSoFar('Two things are due. {"cites"')).toBe('Two things are due.')
  })

  it('the old shape’s answer as it grows, escapes and all, and nothing of any other JSON', () => {
    expect(shownSoFar('{"answer": "Two things are du')).toBe('Two things are du')
    expect(shownSoFar('```json\n{"answer": "She said \\"hi\\" and caf\\u00e9')).toBe('She said "hi" and café')
    // an escape cut in half waits for the rest of it
    expect(shownSoFar('{"answer": "caf\\u00')).toBe('caf')
    expect(shownSoFar('{"cites": ["T1"], "answer": "Two')).toBe('')
    expect(shownSoFar('[')).toBe('')
    expect(shownSoFar('[T1] is due')).toBe('[T1] is due')
  })

  it('in the thread, as the finished answer will show it: a reference to nothing that was sent left out', () => {
    expect(chatSoFar('The plumber [T1] and the gutters [T9] are', DOCS)).toBe('The plumber [T1] and the gutters are')
    expect(chatSoFar('```json', DOCS)).toBe('')
  })
})

describe('the new shape, checked as strictly as the old', () => {
  it('reads the suggestions, the references and the general flag from the details', () => {
    const r = parseChatReply(twoPart('I can add milk and eggs [T1].', { cites: ['T1'], general: false, actions: [GROCERY] }), context())
    expect(r).toEqual({ answer: 'I can add milk and eggs [T1].', cites: ['T1'], actions: [GROCERY], dropped: [] })
    const general = parseChatReply(twoPart('About four minutes a side.', { cites: [], general: true, actions: [] }), context())
    expect(general.answer).toBe(`About four minutes a side.\n\n${GENERAL_LABEL}`)
  })

  it('takes a reply that forgot its details as the answer, with nothing to apply', () => {
    expect(parseChatReply('You have one thing due tomorrow [T1].', context())).toMatchObject({ answer: 'You have one thing due tomorrow [T1].', cites: ['T1'], actions: [] })
  })

  it('refuses a reply that stopped inside its details: what it suggested is lost', () => {
    expect(() => parseChatReply('I can add those.\n```json\n{"cites": [], "actions": [{"type": "add_gro', context())).toThrow(CUT_OFF)
  })

  it('tells the model the new shape, and the nudge asks for it again', () => {
    const { system, rules } = buildChatPrompt('Add milk', DOCS, [], [], context())
    expect(system).toContain('```json block with the details: {"cites": ["T3"], "general": false, "actions": []}')
    expect(system).not.toContain('Reply with ONLY JSON')
    // the shape is not a rule an answer could be caught quoting
    expect(rules).not.toContain('```json')
    expect(CHAT_NUDGE).toContain('```json block')
  })
})

/**
 * /api/ai answering each call in turn: a reply, streamed in pieces when the
 * call asks for a stream (streamOf) and whole when it does not, or the raw
 * pieces of a stream ('BREAK' drops the connection there). The bodies the app sent.
 */
function api(...answers: (string | string[])[]) {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      const answer = answers[Math.min(bodies.length, answers.length) - 1]
      if (typeof answer === 'string' && !body.stream) return Response.json({ text: answer, provider: 'nvidia' })
      const pieces = typeof answer === 'string' ? streamOf(answer) : [...answer]
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            const piece = pieces.shift()
            if (piece === undefined) c.close()
            else if (piece === 'BREAK') c.error(new TypeError('network connection was lost'))
            else c.enqueue(encoder.encode(piece))
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }),
  )
  return bodies
}
/** A reply streamed as the server sends it: its text in deltas of `n` characters, then done with the whole. */
const streamOf = (text: string, n = 7) => [...Array.from({ length: Math.ceil(text.length / n) }, (_, i) => sseEvent('delta', { text: text.slice(i * n, (i + 1) * n) })), sseEvent('done', { text, provider: 'nvidia', model: 'm' })]

describe('the chat’s question, streamed', () => {
  const REPLY = twoPart('I can add milk and eggs to the list.', { cites: [], general: false, actions: [GROCERY] })

  it('shows the answer’s words as they come — never the details — and reads the suggestions from the whole reply', async () => {
    const bodies = api(REPLY)
    const shown: string[] = []
    const r = await askWithActions('Add milk and eggs', DOCS, [], [], context(), s => shown.push(s))
    expect(r.actions).toEqual([GROCERY])
    expect(r.answer).toBe('I can add milk and eggs to the list.')
    expect(shown.at(-1)).toBe('I can add milk and eggs to the list.')
    expect(shown.every(s => !s.includes('`') && !s.includes('{'))).toBe(true)
    expect(bodies[0]).toMatchObject({ stream: true, json: false, maxTokens: 900, reasoning: 'off' })
  })

  it('writes the question and then the whole answer — nothing that was only shown on the way', async () => {
    api(REPLY)
    const written: ChatTurn[] = []
    const shown: string[] = []
    const asked = await askInThread({
      question: 'Add milk and eggs',
      lock: { current: false },
      write: t => written.push(t),
      ask: () => askWithActions('Add milk and eggs', DOCS, [], [], context(), s => shown.push(s)),
      now: () => NOW,
    })
    expect(asked).toEqual({ asked: written[0] })
    expect(shown.length).toBeGreaterThan(3)
    expect(written.map(t => [t.role, t.text, t.actions])).toEqual([
      ['you', 'Add milk and eggs', undefined],
      ['drafter', 'I can add milk and eggs to the list.', [GROCERY]],
    ])
  })

  it('writes nothing but the question when the answer breaks off part way, however much of it was shown', async () => {
    api([...streamOf(REPLY).slice(0, 4), 'BREAK'])
    const written: ChatTurn[] = []
    const shown: string[] = []
    const failed = await askInThread({
      question: 'Add milk and eggs',
      lock: { current: false },
      write: t => written.push(t),
      ask: () => askWithActions('Add milk and eggs', DOCS, [], [], context(), s => shown.push(s)),
      now: () => NOW,
    })
    // four pieces of seven characters had shown
    expect(shown.at(-1)).toBe('I can add milk and eggs to t')
    expect((failed?.error as Error).message).toBe('The answer stopped part way through — try again.')
    expect(written.map(t => t.role)).toEqual(['you'])
  })

  it('shows a second try afresh when the first reply cannot be used, and keeps only the second', async () => {
    const bodies = api('I can add those.\n```json\n{"cites": [], "actions": [{"type": "add_gro', REPLY)
    const shown: string[] = []
    const r: ChatReply = await askWithActions('Add milk and eggs', DOCS, [], [], context(), s => shown.push(s))
    expect(r.actions).toEqual([GROCERY])
    expect(bodies).toHaveLength(2)
    expect(String(bodies[1].system)).toContain(CHAT_NUDGE)
    // the first try's words, taken back, then the second's
    expect(shown).toContain('')
    expect(shown.slice(shown.lastIndexOf('') + 1).at(-1)).toBe('I can add milk and eggs to the list.')
  })

})

describe('Ask, streamed', () => {
  it('shows the answer’s words as they come, never its details, and reads the references from the whole reply', async () => {
    const bodies = api(twoPart('The plumber is due Friday [T1].', { cites: ['T1'] }))
    const shown: string[] = []
    expect(await askDrafter('When is the plumber?', DOCS, [], [], s => shown.push(s))).toEqual({ answer: 'The plumber is due Friday [T1].', cites: ['T1'] })
    expect(shown.at(-1)).toBe('The plumber is due Friday [T1].')
    expect(shown.every(s => !s.includes('`') && !s.includes('{'))).toBe(true)
    expect(bodies[0]).toMatchObject({ stream: true, json: false, maxTokens: 500, reasoning: 'off' })
  })

  it('asks again when the answer says its rules back — the echo check reads the words, not the whole brief — and says so when the second does too', async () => {
    const ECHO = 'We should cite every fact you use with its reference in square brackets.'
    const bodies = api(ECHO, 'The plumber is due Friday [T1].')
    expect((await askDrafter('When is the plumber?', DOCS, [])).answer).toBe('The plumber is due Friday [T1].')
    expect(bodies).toHaveLength(2)
    expect(String(bodies[1].system)).toContain(ASK_NUDGE)
    api(ECHO)
    await expect(askDrafter('When is the plumber?', DOCS, [])).rejects.toThrow(THOUGHT_OUT_LOUD)
    // an answer that names what the planner holds is not an echo, though the brief names it too
    api('Your planner holds tasks, people, places, meals, calendar, bills, clothes and journal.')
    expect((await askDrafter('What do you know about?', DOCS, [])).answer).toContain('clothes and journal')
    // nor is the answer the brief asks for when the records hold none
    const plain = api("The answer isn't in the records.")
    expect((await askDrafter('Who fixed the gate?', DOCS, [])).answer).toBe("The answer isn't in the records.")
    expect(plain).toHaveLength(1)
  })
})
