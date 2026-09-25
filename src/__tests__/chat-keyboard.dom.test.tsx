// @vitest-environment happy-dom
import { act, fireEvent, render } from './dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AskSources } from '../ask'
import { newMessage } from '../chat'
import { Chat } from '../components/Chat'
import type { Message } from '../types'

// The keyboard coming up in the app shortens the page under the chat (the
// shell runs it at resize 'native'), and the newest lines — just above the
// composer — slid out of sight under it as you started a reply. A thread read
// at its end stays at its end while the keyboard comes up; one scrolled up to
// read something older is left alone.

const SOURCES: AskSources = { tasks: [], projects: [], people: [], places: [], recipes: [], meals: [], entries: [], feedEvents: [], journal: [] }
const noop = () => {}
const MESSAGES = ['Can you grab paper towels?', 'Yes, on the way home', 'The big pack'].map((body, i) => newMessage(body, undefined, new Date(Date.UTC(2026, 8, 25, 17, i)))!) as Message[]

/** The page as a phone lays it out: 2000px of thread in a window `height` tall, scrolled to `top`. */
const page = { height: 800, top: 1200, full: 2000 }
const root = document.documentElement
let moves: number[] = []

beforeEach(() => {
  page.height = 800
  page.full = 2000
  page.top = page.full - page.height
  moves = []
  Object.defineProperty(root, 'scrollHeight', { configurable: true, get: () => page.full })
  Object.defineProperty(root, 'clientHeight', { configurable: true, get: () => page.height })
  Object.defineProperty(root, 'scrollTop', { configurable: true, get: () => page.top, set: (v: number) => (page.top = v) })
  root.scrollTo = ((o: ScrollToOptions) => {
    // clamped, as a browser clamps it
    page.top = Math.max(0, Math.min(page.full - page.height, o.top ?? page.top))
    moves.push(page.top)
  }) as typeof root.scrollTo
})

afterEach(() => {
  root.classList.remove('keyboard-open')
  for (const key of ['scrollHeight', 'clientHeight', 'scrollTop']) delete (root as unknown as Record<string, unknown>)[key]
})

function mount() {
  return render(
    <Chat
      side="household"
      onSide={noop}
      messages={MESSAGES}
      turns={[]}
      household={null}
      myId={null}
      sources={SOURCES}
      tz="America/Phoenix"
      onSendMessage={noop}
      onRemoveMessage={noop}
      onWriteTurn={noop}
      onClearChat={noop}
      onOpen={noop}
    />,
  )
}

/** The keyboard: the class native.ts sets on <html>, then the web view a keyboard shorter. */
async function keyboardUp() {
  await act(async () => {
    root.classList.add('keyboard-open')
    // the observer hears the class change after this task
    await Promise.resolve()
  })
  page.height = 450
  await act(async () => {
    window.dispatchEvent(new Event('resize'))
  })
}

describe('the chat, as the keyboard comes up', () => {
  it('keeps a thread read at its end at its end', async () => {
    mount()
    // it opened at its end
    expect(page.top).toBe(page.full - page.height)
    moves = []
    await keyboardUp()
    // the page is 350px shorter, and the thread went with it to its end
    expect(moves.length).toBeGreaterThan(0)
    expect(page.top).toBe(page.full - 450)
  })

  it('leaves a thread scrolled up to read something older where it is', async () => {
    mount()
    await act(async () => {
      page.top = 300
      fireEvent.scroll(window)
    })
    moves = []
    await keyboardUp()
    expect(moves).toEqual([])
    expect(page.top).toBe(300)
  })

  it('hears a scroll up to read at once after the keyboard goes down', async () => {
    mount()
    await keyboardUp()
    await act(async () => {
      root.classList.remove('keyboard-open')
      await Promise.resolve()
    })
    page.height = 800
    page.top = Math.min(page.top, page.full - page.height)
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    await act(async () => {
      page.top = 300
      fireEvent.scroll(window)
    })
    moves = []
    await keyboardUp()
    expect(moves).toEqual([])
    expect(page.top).toBe(300)
  })

  it('follows the end again once the reader scrolls back down to it', async () => {
    mount()
    await act(async () => {
      page.top = 300
      fireEvent.scroll(window)
    })
    await act(async () => {
      page.top = page.full - page.height
      fireEvent.scroll(window)
    })
    moves = []
    await keyboardUp()
    expect(page.top).toBe(page.full - 450)
  })
})
