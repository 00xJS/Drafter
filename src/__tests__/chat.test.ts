import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

/*
 * Opening the chat.
 *
 * The sheet had no scroller of its own. Everything downstream had assumed one
 * since the chat was a page: `position: sticky` on the composer resolved
 * against the backdrop, so it floated in the middle of the thread; a long
 * thread drew straight past the card's rounded corner and over the page; and
 * the jump to the newest message reached the backdrop too, moving the whole
 * panel — in an effect, which is after the browser has painted, so you saw the
 * thread from the top and then it lurched down.
 *
 * One scroller fixes all three, and these hold it there.
 */
describe('the chat sheet scrolls itself', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  const css = read('../styles/11-people-review-search.css')
  const chat = read('../components/Chat.tsx')
  /** One rule's declarations, by selector. */
  const rule = (selector: string) => new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? ''

  it('gives the chat the overflow its sticky composer and its jump both need', () => {
    const pane = rule('.chat-modal > .chat')
    expect(pane).toMatch(/overflow-y:\s*auto/)
    // it has to be able to shrink inside the panel, or it never overflows
    expect(pane).toMatch(/min-height:\s*0/)
    // and a sheet does not hand its scroll to the page behind it
    expect(pane).toMatch(/overscroll-behavior:\s*contain/)
  })

  it('clips the card, so a long thread cannot draw outside it', () => {
    expect(rule('.chat-modal')).toMatch(/overflow:\s*hidden/)
  })

  it('holds the composer and the thread switcher against the card, not the page', () => {
    // both are sticky, and both need the card's ground or the thread shows through
    for (const sel of ['.chat-modal .chat-composer', '.chat-modal .chat-seg']) {
      expect(rule(sel), sel).toMatch(/background:\s*var\(--surface\)/)
    }
    expect(rule('.chat-seg')).not.toMatch(/position:\s*sticky/)
    expect(rule('.chat-modal .chat-seg')).toMatch(/position:\s*sticky/)
  })

  it('keeps nothing that sized the chat as a page under the tab bar', () => {
    // it is only ever drawn in a Modal now, so a viewport-tall floor only ever
    // forced the column out of the card
    // the rule, not a mention of it: the comment where it used to be still names it
    expect(css).not.toMatch(/\.content:has\(\.chat\)\s*\{/)
    expect(rule('.chat')).toMatch(/min-height:\s*0/)
    expect(rule('.chat')).not.toMatch(/100dvh/)
    expect(css).not.toMatch(/\.chat \{[^}]*min-height:[^}]*100dvh/)
    // and the composer no longer clears a bar it now sits over
    expect(css).not.toMatch(/\.chat-composer \{[^}]*--tabbar-h/)
  })

  it('moves its own pane before the first paint, rather than asking a marker to scroll', () => {
    expect(chat).toContain('useLayoutEffect')
    expect(chat).toMatch(/el\.scrollTo\(\{ top: el\.scrollHeight/)
    // scrollIntoView walks up to whatever scrolls; that was the whole bug
    expect(chat).not.toMatch(/\.scrollIntoView\(/)
    // and the marker it used to scroll to, which sat BELOW the composer, is gone
    expect(chat).not.toContain('ref={foot}')
    expect(chat).toContain('<section className="chat" ref={pane}>')
  })

  it('keeps each composer’s placeholder to one line at 375pt', () => {
    // measured in the iOS shell at 375pt: 16px type in a 268px box, and a
    // composer that starts one line tall (44pt) and cuts the second off.
    // 24 characters is where that box fills; both sit under it.
    for (const [, text] of chat.matchAll(/<Composer placeholder="([^"]+)"/g)) expect(text.length, text).toBeLessThanOrEqual(24)
    expect([...chat.matchAll(/<Composer placeholder="([^"]+)"/g)]).toHaveLength(2)
  })

  it('lands on open and on a thread switch, and travels only for a new message', () => {
    const effect = /useLayoutEffect\(\(\) => \{([\s\S]*?)\n {2}\}, \[side, messages\.length, turns\.length\]\)/.exec(chat)?.[1] ?? ''
    expect(effect).toBeTruthy()
    // a different thread is a different place, not a journey through this one
    expect(effect).toMatch(/const jump = shown\.current !== side \|\| stillWanted\(\)/)
    expect(effect).toMatch(/behavior: jump \? 'auto' : 'smooth'/)
    // scrollTo's smoothing does not read the setting itself
    expect(chat).toMatch(/stillWanted = \(\).*prefers-reduced-motion: reduce/s)
  })
})
