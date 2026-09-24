// @vitest-environment happy-dom
import { act, fireEvent, render, screen, within } from './dom'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item, Message, Notice } from '../types'

// A household message tells the other member: the device that wrote it asks
// /api/notify once the server has it, and their bell and lock screen say so.
// Here, the two ends on the device: the chat's Send is what notes a message —
// with somebody else in the household to tell, and never for one that came by
// sync — and a message's row in the bell opens the chat on its Household side,
// where the thread on screen marks the bell's word of it read.

// what the queue sends, heard at the one door it goes out by
const posts = vi.hoisted(() => [] as { url: string; body: unknown }[])
vi.mock('../api', () => ({
  apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    posts.push({ url, body: JSON.parse(String(init?.body ?? 'null')) })
    return Response.json({ ok: true, notified: 1 })
  }),
}))
// the chat's own chunk, straight: this is about what the screen does with it
vi.mock('../components/planner/lazy', async () => ({ Chat: (await import('../components/Chat')).Chat, EventEditor: () => null, TaskEditor: () => null }))

import { MESSAGE_WAIT_MS, watchActivity } from '../activity'
import { newMessage } from '../chat'
import { Chat, type ChatSide } from '../components/Chat'
import { NoticesSheet } from '../components/NoticesSheet'
import { ChatScreen } from '../components/planner/ChatScreen'
import type { PlannerCtx } from '../components/planner/ctx'
import { hubOpener } from '../components/planner/hubRouting'
import { useNavigation } from '../components/planner/useNavigation'
import { useOverlays } from '../components/planner/useOverlays'
import type { HouseholdInfo } from '../household'

const ME = 'me-00000-4000-8000-00000000000a'
const THEM = 'them-000-4000-8000-00000000000b'
const T = '2026-09-23T16:00:00.000Z'
const noop = () => {}

const HOUSEHOLD: HouseholdInfo = {
  me: { id: ME, email: 'joe@example.test', displayName: 'Joe' },
  household: { id: 'h1', name: 'Home', created_by: ME },
  members: [
    { id: ME, email: 'joe@example.test', displayName: 'Joe', role: 'owner', joinedAt: T },
    { id: THEM, email: 'maria@example.test', displayName: 'Maria', role: 'member', joinedAt: T },
  ],
}

const theirs = (body: string, at: string): Message => ({ ...newMessage(body, undefined, new Date(at))!, ownerId: THEM })
const HOME = theirs('Home by six', '2026-09-23T15:58:00.000Z')
const MILK = theirs('Bring milk', '2026-09-23T15:59:00.000Z')

const messageNotice = (over: Partial<Notice> = {}): Notice => ({
  kind: 'notice',
  id: `notice~${ME}~messages-${THEM}~1`,
  at: MILK.createdAt,
  type: 'message',
  actorId: THEM,
  target: { kind: 'message', id: MILK.id },
  title: 'Maria sent 2 messages',
  lines: ['Home by six', 'Bring milk'],
  messageIds: [HOME.id, MILK.id],
  createdAt: T,
  updatedAt: T,
  ...over,
})

afterEach(() => {
  vi.useRealTimers()
  posts.length = 0
})

describe('a message’s row in the bell', () => {
  /** The shell as far as the bell and the chat go: the real navigation and overlays, the hub's own opener. */
  function Shell({ notices, onRead }: { notices: Notice[]; onRead(n: Notice): void }) {
    const nav = useNavigation()
    const overlays = useOverlays()
    const p = { store: { tasks: [], events: [] }, showToast: noop, ...nav, ...overlays } as unknown as PlannerCtx
    return (
      <>
        <button type="button" onClick={() => overlays.openSheet({ kind: 'notices' })}>
          Bell
        </button>
        {/* the chat was last left on the assistant's side */}
        <button type="button" onClick={() => nav.setChatSide('assistant')}>
          Ask the assistant
        </button>
        {overlays.sheet?.kind === 'notices' && (
          <NoticesSheet
            notices={notices}
            tasks={[]}
            people={[]}
            places={[]}
            meals={[]}
            events={[]}
            myId={ME}
            onRead={onRead}
            onReadAll={noop}
            onOpen={hubOpener(p, overlays.closeSheet)}
            onClose={overlays.closeSheet}
          />
        )}
        {overlays.pushed === 'chat' && (
          <Chat
            side={nav.chatSide}
            onSide={nav.setChatSide}
            messages={[HOME, MILK]}
            turns={[]}
            household={HOUSEHOLD}
            myId={ME}
            sources={{ tasks: [], projects: [], people: [], places: [], recipes: [], meals: [], entries: [], feedEvents: [], journal: [] }}
            tz="America/Phoenix"
            onSendMessage={noop}
            onRemoveMessage={noop}
            onWriteTurn={noop}
            onClearChat={noop}
            onOpen={noop}
          />
        )}
      </>
    )
  }

  it('says who and what, with the chat’s icon, and opens the chat on the Household side, read', () => {
    const read: string[] = []
    render(<Shell notices={[messageNotice()]} onRead={n => void read.push(n.id)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ask the assistant' }))
    fireEvent.click(screen.getByRole('button', { name: 'Bell' }))

    const hub = screen.getByRole('dialog', { name: 'Notifications' })
    const row = within(hub).getByRole('button', { name: /Maria sent 2 messages/ })
    expect(row.className).toBe('notice-row unread')
    expect(row.querySelector('.notice-icon')?.className).toBe('notice-icon is-message')
    expect([...row.querySelectorAll('.notice-line')].map(l => l.textContent)).toEqual(['Home by six', 'Bring milk'])

    fireEvent.click(row)
    expect(read).toEqual([messageNotice().id])
    expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull()
    // the chat is up, on the household's thread, though it was left on the assistant's
    expect(screen.getByRole('tab', { name: 'Household' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: 'Assistant' }).getAttribute('aria-selected')).toBe('false')
    expect(document.querySelector('.chat-thread')?.textContent).toContain('Bring milk')
  })
})

describe('the chat screen', () => {
  /** Lists the chat screen reads, all empty. */
  const LISTS = { tasks: [], projects: [], people: [], places: [], recipes: [], meals: [], groceries: [], notes: [], events: [], chat: [], garments: [], outfits: [], wears: [], allItems: [] }

  /** What the screen wrote through the store, in order. */
  let written: Item[]
  /** A message from somebody else, arriving the way a sync round brings one: into the store, and through nothing else. */
  let arrive: (m: Message) => void
  /** Which half of the chat is showing, moved from outside. */
  let showSide: (side: ChatSide) => void

  beforeEach(() => {
    written = []
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date(T))
  })

  interface HostProps {
    myId: string | null
    inHousehold: boolean
    messages?: Message[]
    notices?: Notice[]
    side?: ChatSide
    /** The newest message this device had shown before (useNavigation's chatSeenAt). */
    seenAt?: string | null
  }

  /**
   * The chat screen over a store of its own: the messages and notices the
   * screen writes land in it and are drawn again, and anything else the
   * planner would hand it is a stand-in.
   */
  function Host({ myId, inHousehold, messages = [], notices = [], side: initialSide = 'household', seenAt: seenBefore = null }: HostProps) {
    const [lists, setLists] = useState({ messages, notices })
    const [side, setSide] = useState<ChatSide>(initialSide)
    const [seenAt, setSeenAt] = useState<string | null>(seenBefore)
    arrive = m => setLists(l => ({ ...l, messages: [...l.messages, m] }))
    showSide = setSide
    const upsert = (item: Item) => {
      written.push(item)
      if (item.kind === 'message') setLists(l => ({ ...l, messages: [...l.messages.filter(x => x.id !== item.id), item] }))
      if (item.kind === 'notice') setLists(l => ({ ...l, notices: l.notices.map(n => (n.id === item.id ? item : n)) }))
    }
    const given: Record<string, unknown> = {
      store: { ...LISTS, myId, messages: lists.messages, notices: lists.notices },
      household: { info: inHousehold ? HOUSEHOLD : null, myId },
      inHousehold,
      allEvents: [],
      upsert,
      chatSide: side,
      setChatSide: setSide,
      chatSeenAt: seenAt,
      markChatSeen: (at: string) => setSeenAt(at),
    }
    const p = new Proxy(given, { get: (target, key: string) => (key in target ? target[key] : noop) }) as unknown as PlannerCtx
    return <ChatScreen p={p} />
  }

  /** Say something in the household thread, and press Send. */
  const say = (words: string) => {
    fireEvent.change(screen.getByPlaceholderText('Message the household…'), { target: { value: words } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  }
  const notifies = () => posts.filter(p => p.url === '/api/notify').map(p => p.body)
  const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

  /** Telling started for `myId`, as the store starts it signed in; the server has whatever is written until told otherwise. */
  function telling(myId: string) {
    const server = { has: true }
    const stop = watchActivity({ myId, pending: () => !server.has, live: () => true })
    return { server, stop }
  }

  it('tells the other member what was sent, once the server has it', async () => {
    const { server, stop } = telling(ME)
    // the engine has not written it yet when it is sent
    server.has = false
    render(<Host myId={ME} inHousehold />)
    await act(async () => say('On my way'))
    const sent = written.find((i): i is Message => i.kind === 'message')!
    expect(sent.body).toBe('On my way')
    await wait(MESSAGE_WAIT_MS * 2)
    expect(notifies()).toEqual([])
    // the server has it now: told within a second or so, and once
    server.has = true
    await wait(1_000)
    expect(notifies()).toEqual([{ messageId: sent.id }])
    await wait(60_000)
    expect(notifies()).toHaveLength(1)
    stop()
  })

  it('tells nobody in a household of one, or in local mode', async () => {
    const { stop } = telling(ME)
    const alone = render(<Host myId={ME} inHousehold={false} />)
    await act(async () => say('Note to self'))
    expect(written.map(i => i.kind)).toEqual(['message'])
    await wait(60_000)
    expect(notifies()).toEqual([])
    expect(localStorage.getItem(`drafter:activity:messages:${ME}`)).toBeNull()
    alone.unmount()
    stop()

    // no account, so nothing started telling, and nobody to tell
    render(<Host myId={null} inHousehold />)
    await act(async () => say('Hello?'))
    await wait(60_000)
    expect(written.map(i => i.kind)).toEqual(['message', 'message'])
    expect(notifies()).toEqual([])
    expect(Object.keys(localStorage).filter(k => k.startsWith('drafter:activity'))).toEqual([])
  })

  it('never tells a message that arrived by sync: only the device that wrote it does', async () => {
    const { stop } = telling(ME)
    render(<Host myId={ME} inHousehold />)
    await act(async () => arrive(theirs('Back at eight', T)))
    expect(document.querySelector('.chat-thread')?.textContent).toContain('Back at eight')
    await wait(60_000)
    expect(notifies()).toEqual([])
    expect(localStorage.getItem(`drafter:activity:messages:${ME}`)).toBeNull()
    stop()
  })

  const reads = () => written.filter((i): i is Notice => i.kind === 'notice' && !!i.readAt).map(n => n.id)

  it('marks the bell’s word of messages read once the thread has shown them, and of more as they arrive', async () => {
    const later = theirs('Actually seven', '2026-09-23T16:05:00.000Z')
    const shown = messageNotice()
    const waiting = messageNotice({ id: `notice~${ME}~messages-${THEM}~2`, at: later.createdAt, title: 'Maria sent a message', lines: ['Actually seven'], messageIds: [later.id] })
    render(<Host myId={ME} inHousehold messages={[HOME, MILK]} notices={[shown, waiting]} />)
    // the thread shows both of the first notice's messages, and not yet the second's
    expect(reads()).toEqual([shown.id])
    // a newer stamp, so the reader's other devices take the mark
    expect(Date.parse(written.find(i => i.id === shown.id)!.updatedAt)).toBeGreaterThan(Date.parse(shown.updatedAt))
    // the message the second is about arrives while the thread is open
    await act(async () => arrive(later))
    expect(reads()).toEqual([shown.id, waiting.id])
  })

  it('leaves them unread while the page is in the background, and marks them once it is in front again', async () => {
    const hide = (hidden: boolean) => {
      Object.defineProperty(document, 'visibilityState', { value: hidden ? 'hidden' : 'visible', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    }
    try {
      hide(true)
      render(<Host myId={ME} inHousehold messages={[HOME, MILK]} notices={[messageNotice()]} />)
      expect(reads()).toEqual([])
      await act(async () => hide(false))
      expect(reads()).toEqual([messageNotice().id])
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState
    }
  })

  it('leaves them unread while the chat shows the assistant’s side, and marks them on the household’s', async () => {
    // this device had shown both messages before, on another visit
    render(<Host myId={ME} inHousehold messages={[HOME, MILK]} notices={[messageNotice()]} side="assistant" seenAt={MILK.createdAt} />)
    expect(reads()).toEqual([])
    await act(async () => showSide('household'))
    expect(reads()).toEqual([messageNotice().id])
  })
})
