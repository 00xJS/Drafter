import { describe, expect, it } from 'vitest'
import { CHAT_CONTEXT_TURNS, newMessage, newTurn, recentContext, thread, threadId, unreadSince } from '../chat'
import { PERSONAL_KINDS, SYNC_KINDS, readableRow } from '../../shared/kinds.mjs'
import { buildAskPrompt } from '../ask'
import { sanitizeChatTurn, sanitizeItem, sanitizeMessage } from '../schema'
import { MESSAGE_MAX, type Message } from '../types'

// Two chats, and the whole point of them is that they are two: the household's
// thread, and yours with the assistant. "I want both so our household chat is
// not being overtaken by the AI chat."

const JOE = '11111111-1111-1111-1111-111111111111'
const MARIA = '22222222-2222-2222-2222-222222222222'
const AT = new Date('2026-09-21T09:30:00.000Z')

describe('the two threads never mix', () => {
  it('keeps the household’s messages household-readable and the assistant’s turns personal', () => {
    // a message nobody else can read is not a message
    expect(PERSONAL_KINDS.has('message')).toBe(false)
    expect(readableRow({ kind: 'message' }, MARIA, JOE)).toBe(true)
    // what you asked the assistant is yours, at the database and not merely on screen
    expect(PERSONAL_KINDS.has('chat')).toBe(true)
    expect(readableRow({ kind: 'chat' }, MARIA, JOE)).toBe(false)
    expect(readableRow({ kind: 'chat' }, JOE, JOE)).toBe(true)
  })

  it('is two kinds the server has been told about', () => {
    expect(SYNC_KINDS.has('message')).toBe(true)
    expect(SYNC_KINDS.has('chat')).toBe(true)
  })
})

describe('a line is written once and never edited', () => {
  it('ids by the instant, so a list sorts on the id and two devices cannot collide', () => {
    const a = threadId('message', AT)
    const b = threadId('message', AT)
    expect(a.startsWith('message~2026-09-21T09:30:00.000Z~')).toBe(true)
    expect(a).not.toBe(b)
    // an earlier instant sorts first, whatever the random tail
    expect(threadId('message', new Date(AT.getTime() - 1)) < a).toBe(true)
  })

  it('refuses an empty line rather than writing a blank row', () => {
    expect(newMessage('   ')).toBeNull()
    expect(newTurn('you', '')).toBeNull()
    expect(newMessage('hello')).toMatchObject({ kind: 'message', body: 'hello' })
  })

  it('caps one line so a paste cannot fill a sync exchange', () => {
    expect(newMessage('x'.repeat(MESSAGE_MAX + 500))!.body).toHaveLength(MESSAGE_MAX)
    expect(sanitizeMessage({ id: 'message~a', body: 'y'.repeat(MESSAGE_MAX + 500), updatedAt: AT.toISOString() })!.body).toHaveLength(MESSAGE_MAX)
  })

  it('drops a turn whose speaker cannot be read, rather than putting it in the wrong voice', () => {
    expect(sanitizeChatTurn({ id: 'chat~a', role: 'somebody', text: 'hi' })).toBeNull()
    expect(sanitizeChatTurn({ id: 'chat~a', role: 'drafter', text: 'hi' })).toMatchObject({ role: 'drafter' })
  })

  it('reaches the store through the one sanitizer every write goes through', () => {
    expect(sanitizeItem({ kind: 'message', id: 'message~a', body: 'hi', updatedAt: AT.toISOString() })).toMatchObject({ kind: 'message' })
    expect(sanitizeItem({ kind: 'chat', id: 'chat~a', role: 'you', text: 'hi', updatedAt: AT.toISOString() })).toMatchObject({ kind: 'chat' })
  })
})

describe('a thread as it is drawn', () => {
  const msg = (id: string, ownerId: string, createdAt: string): Message =>
    ({ kind: 'message', id, body: id, ownerId, createdAt, updatedAt: createdAt }) as Message

  it('heads each day once and names a speaker once per run', () => {
    const rows = thread(
      [
        msg('a', JOE, '2026-09-20T09:00:00.000Z'),
        msg('b', JOE, '2026-09-20T09:01:00.000Z'),
        msg('c', MARIA, '2026-09-20T09:02:00.000Z'),
        msg('d', MARIA, '2026-09-21T09:00:00.000Z'),
      ],
      m => m.ownerId ?? 'me',
    )
    expect(rows.filter(r => 'day' in r)).toHaveLength(2)
    const said = rows.filter((r): r is { item: Message; firstOfRun: boolean } => 'item' in r)
    expect(said.map(r => r.firstOfRun)).toEqual([true, false, true, true])
  })
})

describe('what the badge counts', () => {
  const msg = (id: string, ownerId: string, createdAt: string): Message =>
    ({ kind: 'message', id, body: id, ownerId, createdAt, updatedAt: createdAt }) as Message
  const all = [msg('a', MARIA, '2026-09-20T09:00:00.000Z'), msg('b', JOE, '2026-09-21T09:00:00.000Z'), msg('c', MARIA, '2026-09-21T10:00:00.000Z')]

  it('counts what somebody else wrote since this device last showed you the thread', () => {
    expect(unreadSince(all, '2026-09-20T12:00:00.000Z', JOE)).toBe(1)
  })

  it('never counts your own', () => {
    expect(unreadSince(all, '2026-09-20T00:00:00.000Z', MARIA)).toBe(1)
  })

  it('opens at nothing rather than badging every message ever written', () => {
    expect(unreadSince(all, null, JOE)).toBe(0)
  })
})

describe('the assistant is reminded of the conversation, not fed by it', () => {
  const turn = (role: 'you' | 'drafter', text: string, i: number) => newTurn(role, text, undefined, new Date(AT.getTime() + i))!

  it('carries the last few turns, oldest first, and no more', () => {
    const turns = Array.from({ length: 20 }, (_, i) => turn(i % 2 ? 'drafter' : 'you', `line ${i}`, i))
    const lines = recentContext(turns)
    expect(lines).toHaveLength(CHAT_CONTEXT_TURNS)
    expect(lines[0]).toContain('line 12')
    expect(lines[lines.length - 1]).toContain('line 19')
  })

  it('tells the model the thread is context and every fact still comes from the records', () => {
    const { system, prompt } = buildAskPrompt('and what about Friday?', [], [], ['Them: tell me about my week', 'You: three things are due'])
    expect(system).toContain('never a source')
    expect(prompt).toContain('<thread>')
    expect(prompt).toContain('Them: tell me about my week')
    // and with no thread it is exactly the prompt Ask has always built
    expect(buildAskPrompt('q', [], []).prompt).not.toContain('<thread>')
    expect(buildAskPrompt('q', [], []).system).not.toContain('never a source')
  })

  it('sends the words alone — a reference it invented earlier never comes back as a record', () => {
    const turns = [turn('drafter', 'You saw Mum on Tuesday [T9]', 0)]
    expect(recentContext(turns)[0]).toBe('You: You saw Mum on Tuesday [T9]')
    // the thread block is prose; retrieval builds <records>, and parseAskAnswer
    // drops any reference that was not sent (ask.ts)
    expect(buildAskPrompt('q', [], [], recentContext(turns)).prompt).not.toContain('<records>\n[T9]')
  })
})
