import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHAT_HELP, GENERAL_LABEL, isHelpQuestion } from '../assistanthelp'
import { CHAT_PROMPTS } from '../chat'
import { askWithActions, buildChatPrompt, chatActionContext, parseChatReply, type ChatActionContext } from '../chatactions'
import { CHAT_ACTION_TYPES } from '../types'

// Asked "What all can you do?", the chat said it didn't have that information
// in the records. It was told only about the planner, and told to say so when
// the records didn't hold an answer. Now a question about the assistant is
// answered at once from its own help, the model is told what it can do, and a
// general question gets a general answer that says it is one.

afterEach(() => vi.unstubAllGlobals())

const NOW = new Date('2026-09-23T03:30:00.000Z')
const nothing = { intents: new Set() as never, personIds: [], placeIds: [], recipeIds: [] }
const ctx = (): ChatActionContext => chatActionContext(nothing, [], { people: [], recipes: [], places: [], tasks: [] }, { now: NOW, tz: 'America/Phoenix' })
const facts = ['Today is Tuesday, 22 September 2026 (America/Phoenix).']

describe('a question about the assistant itself', () => {
  it('is known however it is put', () => {
    for (const q of [
      'What all can you do?',
      'what can you do',
      'What else can you do?',
      'What can you help me with?',
      'What kind of things can you do?',
      'Hey Drafter, what can you do for me?',
      'What can I ask you?',
      'How can you help me?',
      'Can you help?',
      'How do I use this?',
      'How does this work?',
      'help',
      'Help!',
      'I need help',
      'Who are you?',
      'What is Drafter?',
      'What’s this?',
      'What are your capabilities?',
      'What are you able to do?',
      'Tell me what you can do',
    ])
      expect(isHelpQuestion(q), q).toBe(true)
  })

  it('is not a request that happens to use the same words', () => {
    for (const q of [
      'Help me plan tacos for Tuesday',
      'Can you help me plan dinner?',
      'What can I cook tonight?',
      'What can I make with chicken?',
      'What do I have to do today?',
      'What can you tell me about my week?',
      'What can you do with my grocery list?',
      'How do I get to Nopi?',
      'Who is Maria?',
      'What is this week looking like?',
      'What’s due tomorrow?',
      '',
    ])
      expect(isHelpQuestion(q), q).toBe(false)
  })

  it('is the first thing the empty chat offers to ask', () => {
    expect(CHAT_PROMPTS[0]).toBe('What can you do?')
    expect(isHelpQuestion(CHAT_PROMPTS[0])).toBe(true)
    // the others are about the planner, and go to the model
    for (const p of CHAT_PROMPTS.slice(1)) expect(isHelpQuestion(p), p).toBe(false)
  })

  it('is answered at once, with no model call', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const r = await askWithActions('What all can you do?', [], facts, [], ctx())
    expect(fetch).not.toHaveBeenCalled()
    expect(r).toEqual({ answer: CHAT_HELP, cites: [], actions: [], dropped: [] })
  })

  it('gets a help text that names every kind of change the chat can suggest', () => {
    // a new kind of card that the help never mentions would be a feature nobody asks for
    const said: Record<(typeof CHAT_ACTION_TYPES)[number], string> = {
      create_task: 'add a task',
      update_task: 'move or finish one',
      add_grocery: 'grocery list',
      plan_meal: 'plan a meal',
      log_visit: 'log a visit',
      create_note: 'save a note',
      create_event: 'calendar event',
    }
    for (const type of CHAT_ACTION_TYPES) expect(CHAT_HELP, type).toContain(said[type])
    // and what it will not do, as the chat does not: the journal stays out of it
    expect(CHAT_HELP).toContain('can’t read your journal')
  })
})

describe('what the model is told about itself', () => {
  it('says what it can do, and how each kind of question is answered', () => {
    const { system } = buildChatPrompt('Can you text Maria?', [], facts, [], ctx())
    expect(system).toContain('What you can do, for questions about yourself or about using Drafter')
    expect(system).toContain('You cannot read the journal here, send messages to anyone, or look anything up online.')
    expect(system).toContain('A question about yourself or about using Drafter is answered from what you can do, with no references.')
    expect(system).toContain('with "general" set to true and no references')
    expect(system).toContain('A greeting or thanks gets a short, friendly reply.')
    // "say so plainly" is for the planner's own questions now, not for everything
    expect(system).toContain("If a question about their own planner isn't answered by the records, say so plainly.")
    expect(system).toContain('"general": false')
  })
})

describe('a general answer', () => {
  const reply = (o: Record<string, unknown>) => JSON.stringify({ cites: [], actions: [], ...o })

  it('says it is general, under the answer', () => {
    const r = parseChatReply(reply({ answer: 'About 4 minutes a side for medium rare.', general: true }), ctx())
    expect(r.general).toBe(true)
    expect(r.answer).toBe(`About 4 minutes a side for medium rare.\n\n${GENERAL_LABEL}`)
  })

  it('is not one when it cites a record or suggests a change, whatever the flag says', () => {
    const docs = [{ ref: 'R1', kind: 'recipe' as const, id: 'r-steak', title: 'Steak', text: '' }]
    const withRecord = chatActionContext(nothing, docs, { people: [], recipes: [], places: [], tasks: [] }, { now: NOW, tz: 'America/Phoenix' })
    const cited = parseChatReply(reply({ answer: 'Your recipe says 4 minutes [R1].', general: true }), withRecord)
    expect(cited.general).toBeUndefined()
    expect(cited.answer).not.toContain(GENERAL_LABEL)
    const offered = parseChatReply(reply({ answer: 'I can add that.', general: true, actions: [{ type: 'add_grocery', items: ['steak'] }] }), ctx())
    expect(offered.general).toBeUndefined()
    expect(offered.answer).not.toContain(GENERAL_LABEL)
  })

  it('is not one unless the model says so', () => {
    for (const general of [false, 'true', undefined]) {
      const r = parseChatReply(reply({ answer: 'Nothing is due tomorrow.', general }), ctx())
      expect(r.general).toBeUndefined()
      expect(r.answer).toBe('Nothing is due tomorrow.')
    }
  })
})
