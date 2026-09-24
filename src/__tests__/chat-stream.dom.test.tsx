// @vitest-environment happy-dom
import { act, fireEvent, render, screen, within } from './dom'
import { useSyncExternalStore } from 'react'
import { afterAll, describe, expect, it } from 'vitest'
import type { AskSources } from '../ask'
import { newTurn } from '../chat'
import type { ChatReply } from '../chatactions'
import { CUT_SHORT } from '../ai'
import { AskSheet } from '../components/AskSheet'
import { Chat } from '../components/Chat'
import type { ChatAction, ChatTurn, Task } from '../types'

// The assistant's answer as the chat draws it while it arrives: its words
// grow in a bubble where the answer will be, the waiting line gives way to
// them, and once the whole reply is read the answer takes the bubble's place
// with its cards under it. Only the question and that answer are ever written
// as turns — never what was shown on the way, and nothing at all for an
// answer that breaks off part way, which says so with Try again.

const zone = process.env.TZ
process.env.TZ = 'America/Phoenix'
afterAll(() => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})

const NOW = new Date('2026-09-23T03:30:00.000Z')
const SOURCES: AskSources = { tasks: [], projects: [], people: [], places: [], recipes: [], meals: [], entries: [], feedEvents: [], journal: [] }
const GROCERY: ChatAction = { type: 'add_grocery', items: ['milk', 'eggs'] }
const noop = () => {}

/** The model call, held open: the test says each word, and how it ends. */
function heldAsk() {
  const call: { words?: (shown: string) => void; answer?: (r: ChatReply) => void; fail?: (e: Error) => void; asked: number } = { asked: 0 }
  const ask = (...args: unknown[]) =>
    new Promise<ChatReply>((resolve, reject) => {
      call.asked++
      call.words = args[5] as (shown: string) => void
      call.answer = resolve
      call.fail = reject
    })
  return { call, ask }
}

/**
 * The thread, kept outside the chat and read the way the app reads its store
 * (useSyncExternalStore): a turn written is drawn at once, before the chat
 * hears anything more. `written` is every turn written, in order.
 */
function threadStore() {
  let turns: ChatTurn[] = []
  const listeners = new Set<() => void>()
  const written: ChatTurn[] = []
  return {
    written,
    write(t: ChatTurn) {
      written.push(t)
      turns = [...turns, t]
      for (const l of listeners) l()
    },
    subscribe(l: () => void) {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
    read: () => turns,
  }
}
type ThreadStore = ReturnType<typeof threadStore>

/** The chat over a thread of its own. */
function Thread({ ask, store }: { ask: ReturnType<typeof heldAsk>['ask']; store: ThreadStore }) {
  const turns = useSyncExternalStore(store.subscribe, store.read)
  return (
    <Chat
      side="assistant"
      onSide={noop}
      messages={[]}
      turns={turns}
      household={null}
      myId={null}
      sources={SOURCES}
      tz="America/Phoenix"
      onSendMessage={noop}
      onRemoveMessage={noop}
      onWriteTurn={store.write}
      onClearChat={noop}
      onOpen={noop}
      ask={ask}
      now={NOW}
    />
  )
}

/** Type a question and press Enter, as a person does. */
function send(question: string) {
  const box = screen.getByPlaceholderText('Ask about your week…')
  fireEvent.change(box, { target: { value: question } })
  fireEvent.keyDown(box, { key: 'Enter' })
}

/** The bubble an answer is arriving in, if there is one. */
const arriving = () => document.querySelector('.chat-arriving')

describe('an answer arriving in the chat', () => {
  it('grows where the answer will be, then becomes the answer with its cards', async () => {
    const { call, ask } = heldAsk()
    const store = threadStore()
    const written = store.written
    render(<Thread ask={ask} store={store} />)
    await act(async () => send('Add milk and eggs'))
    expect(call.asked).toBe(1)
    expect(screen.getByText('Reading your planner…')).toBeTruthy()
    expect(arriving()).toBeNull()

    await act(async () => call.words!('I can add'))
    expect(arriving()?.textContent).toBe('✈ DrafterI can add')
    expect(screen.queryByText('Reading your planner…')).toBeNull()
    await act(async () => call.words!('I can add milk and eggs to'))
    expect(within(arriving() as HTMLElement).getByText('I can add milk and eggs to')).toBeTruthy()
    // nothing shown on the way is written
    expect(written.map(t => t.role)).toEqual(['you'])

    await act(async () => call.answer!({ answer: 'I can add milk and eggs to the list.', cites: [], actions: [GROCERY], dropped: [] }))
    expect(arriving()).toBeNull()
    expect(screen.queryByText('Reading your planner…')).toBeNull()
    const answer = screen.getByText('I can add milk and eggs to the list.').closest('li') as HTMLElement
    expect(answer.className).toBe('chat-line theirs drafter has-cards')
    const cards = within(answer).getByRole('list', { name: 'Suggested changes' })
    expect(within(cards).getByText('milk, eggs', { exact: false })).toBeTruthy()
    expect(within(cards).getByRole('button', { name: 'Apply' })).toBeTruthy()
    // the question, then the whole answer with its suggestion: nothing else
    expect(written.map(t => [t.role, t.text, t.actions])).toEqual([
      ['you', 'Add milk and eggs', undefined],
      ['drafter', 'I can add milk and eggs to the list.', [GROCERY]],
    ])
  })

  it('leaves nothing behind when it breaks off part way: the failure line, Try again, and only the question written', async () => {
    const { call, ask } = heldAsk()
    const store = threadStore()
    const written = store.written
    render(<Thread ask={ask} store={store} />)
    await act(async () => send('Tell me about my week'))
    await act(async () => call.words!('It was a busy one: you'))
    expect(arriving()?.textContent).toContain('It was a busy one: you')

    await act(async () => call.fail!(new Error(CUT_SHORT)))
    expect(arriving()).toBeNull()
    expect(screen.queryByText(/It was a busy one/)).toBeNull()
    expect(screen.getByRole('status').textContent).toContain(`No answer came back: ${CUT_SHORT}`)
    expect(written.map(t => t.role)).toEqual(['you'])

    // Try again asks the same question, without writing it twice, and starts the words afresh
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Try again' })))
    expect(call.asked).toBe(2)
    expect(arriving()).toBeNull()
    expect(screen.getByText('Reading your planner…')).toBeTruthy()
    await act(async () => call.words!('A quiet one.'))
    await act(async () => call.answer!({ answer: 'A quiet one.', cites: [], actions: [], dropped: [] }))
    expect(written.map(t => [t.role, t.text])).toEqual([
      ['you', 'Tell me about my week'],
      ['drafter', 'A quiet one.'],
    ])
  })

  it('never draws the answer twice: once its turn is in the thread, the words that became it are gone, whatever the chat has heard', async () => {
    // The store draws a turn the moment it is written, and the chat learns that
    // its question was answered a render later: the thread alone decides.
    const { call, ask } = heldAsk()
    const store = threadStore()
    render(<Thread ask={ask} store={store} />)
    await act(async () => send('Add milk and eggs'))
    await act(async () => call.words!('I can add milk and eggs to the list.'))
    await act(async () => store.write(newTurn('drafter', 'I can add milk and eggs to the list.', undefined, new Date(NOW.getTime() + 60_000))!))
    expect(arriving()).toBeNull()
    expect(screen.getAllByText('I can add milk and eggs to the list.')).toHaveLength(1)
    expect(screen.queryByText('Reading your planner…')).toBeNull()
  })

  it('shows what the model is taking back as taken back', async () => {
    const { call, ask } = heldAsk()
    render(<Thread ask={ask} store={threadStore()} />)
    await act(async () => send('What is due?'))
    await act(async () => call.words!('The user asks'))
    expect(arriving()).not.toBeNull()
    // an empty word: what was shown was not the answer
    await act(async () => call.words!(''))
    expect(arriving()).toBeNull()
    expect(screen.getByText('Reading your planner…')).toBeTruthy()
  })
})

describe('an answer arriving in Ask', () => {
  const STAMP = '2026-09-01T12:00:00.000Z'
  const plumber: Task = { kind: 'task', id: 't-plumber', title: 'Call the plumber', description: '', status: 'todo', priority: 'normal', dueAt: '2026-09-25T16:00:00.000Z', createdAt: STAMP, updatedAt: STAMP, tags: [] }

  it('shows the words as they come, a reference already a chip, then the answer once it is whole', async () => {
    const call: { words?: (shown: string) => void; answer?: (a: { answer: string; cites: string[] }) => void } = {}
    const ask = (_q: string, _docs: unknown, _facts: unknown, onText?: (shown: string) => void) =>
      new Promise<{ answer: string; cites: string[] }>(resolve => {
        call.words = onText
        call.answer = resolve
      })
    render(<AskSheet initialQuestion="When do I call the plumber?" sources={{ ...SOURCES, tasks: [plumber] }} tz="America/Phoenix" now={NOW} onOpen={noop} onClose={noop} ask={ask} />)
    await act(async () => {})
    expect(screen.getByText('Reading your planner…')).toBeTruthy()
    // the one record retrieval found, under the reference the model is shown
    expect(screen.getByRole('region', { name: 'Sources' }).textContent).toContain('Call the plumber')
    const ref = 'T1'

    await act(async () => call.words!(`You call the plumber on Friday [${ref}]`))
    const growing = document.querySelector('.ask-arriving') as HTMLElement
    expect(growing.textContent).toContain('You call the plumber on Friday')
    expect(within(growing).getByTitle('Open Call the plumber')).toBeTruthy()
    expect(screen.queryByText('Reading your planner…')).toBeNull()

    await act(async () => call.answer!({ answer: `You call the plumber on Friday [${ref}].`, cites: [ref] }))
    expect(document.querySelector('.ask-arriving')).toBeNull()
    expect((document.querySelector('.ask-answer') as HTMLElement).textContent).toContain('You call the plumber on Friday')
  })
})
