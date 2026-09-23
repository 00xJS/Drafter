import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHAT_HELP, GENERAL_LABEL } from '../assistanthelp'
import { CHAT_EVAL, judgeReply, runChatEval, type EvalCase } from '../chateval'
import { askWithActions, type ChatReply } from '../chatactions'

// Admin's "Check the assistant" asks the chat one question of each kind it
// should handle, through the real model, and says which came back as they
// should. These hold the verdicts to what each kind means, and the run to its
// promises: every case asked, two at a time, each verdict as it lands, and a
// failed call a failed case rather than a failed check.

afterEach(() => vi.unstubAllGlobals())

const said = (answer: string, o: Partial<ChatReply> = {}): ChatReply => ({ answer, cites: [], actions: [], dropped: [], ...o })
const caseOf = (expect: EvalCase['expect']) => CHAT_EVAL.find(c => c.expect === expect)!

describe('a verdict', () => {
  it('wants the help text for what it can do, with no model call', () => {
    expect(judgeReply(caseOf('help'), said(CHAT_HELP)).pass).toBe(true)
    expect(judgeReply(caseOf('help'), said('I can help with lots of things.'))).toEqual({ pass: false, why: 'went to the model instead of the help text' })
  })

  it('fails "not in the records" for anything but the planner’s own question', () => {
    const refusals = ['I don’t have that information in the records.', "That isn't in your records.", 'There is no information about that.', 'I do not have any information on that.']
    for (const kind of ['about', 'general', 'chat'] as const)
      for (const r of refusals) expect(judgeReply(caseOf(kind), said(r, { general: kind === 'general' })), `${kind}: ${r}`).toMatchObject({ pass: false })
    // for the planner's own question it is the right answer
    expect(judgeReply(caseOf('unknown'), said('Your planner doesn’t show a dinner on 1 January.')).pass).toBe(true)
    expect(judgeReply(caseOf('unknown'), said('That isn’t in your records.')).pass).toBe(true)
  })

  it('wants a general question marked general, and nothing else marked so', () => {
    expect(judgeReply(caseOf('general'), said(`About 4 minutes a side.\n\n${GENERAL_LABEL}`, { general: true })).pass).toBe(true)
    expect(judgeReply(caseOf('general'), said('About 4 minutes a side.'))).toEqual({ pass: false, why: 'not marked as general' })
    expect(judgeReply(caseOf('about'), said('I can’t send texts.', { general: true })).pass).toBe(false)
    expect(judgeReply(caseOf('unknown'), said('Most people eat something festive.', { general: true }))).toEqual({ pass: false, why: 'made up an answer from general knowledge' })
  })

  it('wants a thank-you answered in a line, with nothing to apply', () => {
    expect(judgeReply(caseOf('chat'), said('You’re welcome — glad it helped!')).pass).toBe(true)
    expect(judgeReply(caseOf('chat'), said('Glad to help.', { actions: [{ type: 'create_note', title: 'Thanks', text: '' }] })).pass).toBe(false)
    expect(judgeReply(caseOf('chat'), said(Array.from({ length: 50 }, () => 'word').join(' '))).why).toBe('50 words for a thank-you')
  })

  it('wants the change it was asked for, as a card', () => {
    expect(judgeReply(caseOf('add_grocery'), said('I can add those.', { actions: [{ type: 'add_grocery', items: ['milk', 'eggs'] }] }))).toEqual({
      pass: true,
      why: 'offered a grocery suggestion',
    })
    expect(judgeReply(caseOf('create_task'), said('Sure, done.'))).toEqual({ pass: false, why: 'no task suggestion' })
  })
})

describe('the check', () => {
  it('asks every case, two at a time, and says each verdict as it lands', async () => {
    let running = 0
    let most = 0
    const seen: number[] = []
    const ask: typeof askWithActions = async question => {
      running++
      most = Math.max(most, running)
      await new Promise(resolve => setTimeout(resolve, 5))
      running--
      const c = CHAT_EVAL.find(x => x.question === question)!
      if (c.expect === 'general') return said(`About 4 minutes a side.\n\n${GENERAL_LABEL}`, { general: true })
      if (c.expect === 'add_grocery') return said('I can add those.', { actions: [{ type: 'add_grocery', items: ['milk'] }] })
      if (c.expect === 'create_task') throw new Error('Too many AI requests')
      return said(c.expect === 'help' ? CHAT_HELP : 'Happy to help.')
    }
    const results = await runChatEval({ ask, now: new Date('2026-09-23T03:30:00.000Z'), tz: 'America/Phoenix', onResult: (_r, i) => seen.push(i) })
    expect(most).toBe(2)
    expect(results.map(r => r.case)).toEqual(CHAT_EVAL)
    expect([...seen].sort()).toEqual(CHAT_EVAL.map((_, i) => i))
    // a failed call is a failed case, with the reason
    expect(results.find(r => r.case.expect === 'create_task')).toMatchObject({ pass: false, why: 'no answer: Too many AI requests', answer: '' })
    expect(results.find(r => r.case.expect === 'general')?.pass).toBe(true)
  })

  it('sends nothing from anyone’s planner, and answers the help case without the model', async () => {
    const bodies: { prompt: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        return Response.json({ text: JSON.stringify({ answer: 'Happy to help.', cites: [], actions: [] }) })
      }),
    )
    const results = await runChatEval({ now: new Date('2026-09-23T03:30:00.000Z'), tz: 'America/Phoenix' })
    // every case but the help one is one call
    expect(bodies).toHaveLength(CHAT_EVAL.length - 1)
    expect(results.find(r => r.case.expect === 'help')).toMatchObject({ pass: true, answer: CHAT_HELP })
    for (const b of bodies) {
      expect(b.prompt).not.toMatch(/^\[[A-Z]+\d+\]/m)
      expect(b.prompt).not.toContain('People:')
    }
  })
})
