import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEBOUNCE_MS,
  MAX_AGE_MS,
  MESSAGE_RECHECK_MS,
  MESSAGE_WAIT_MS,
  PENDING_RECHECK_MS,
  coalesce,
  createActivityQueue,
  taskActivity,
  worthTelling,
  type ActivityDeps,
  type QueuedEvent,
} from '../activity'
import { newMessage } from '../chat'
import { cookTaskId } from '../kitchen'
import type { ActivityEvent } from '../../shared/notices.mts'
import type { Message, Task } from '../types'
import { plannerSource } from './source'

// What a member changes on a task they share is told to the other member
// (/api/notify), from the device that made the change, once the task has been
// quiet a moment and the server has the edit. Changes that cancel out while
// they wait are never told; nothing waits for ever.

const ME = 'me-0000-4000-8000-00000000000a'
const THEM = 'them-000-4000-8000-00000000000b'
const T = '2026-09-23T16:00:00.000Z'

const task = (over: Partial<Task> = {}): Task => ({
  kind: 'task',
  id: 'bins',
  title: 'Take bins out',
  description: '',
  status: 'todo',
  priority: 'normal',
  tags: [],
  createdAt: T,
  updatedAt: T,
  ownerId: THEM,
  assigneeId: ME,
  assignedBy: THEM,
  checklist: [
    { id: 's1', text: 'Green bin', done: false },
    { id: 's2', text: 'Blue bin', done: false },
  ],
  ...over,
})
const kinds = (es: readonly QueuedEvent[]) => es.map(e => `${e.type}:${e.detail ?? ''}${e.done === undefined ? '' : e.done ? '+' : '-'}`)

describe('what an edit changed', () => {
  it('status, steps ticked and unticked, a comment, the due date, the title, who is doing it', () => {
    const before = task()
    const after = task({
      status: 'doing',
      checklist: [
        { id: 's1', text: 'Green bin', done: true },
        { id: 's2', text: 'Blue bin', done: false },
        { id: 's3', text: 'Brown bin', done: true },
      ],
      comments: [{ id: 'c1', body: 'Blue one was full', createdAt: T, by: ME }],
      dueAt: '2026-09-24T01:00:00.000Z',
      title: 'Take the bins out',
      assigneeId: THEM,
    })
    // a step added already ticked is no tick
    expect(kinds(taskActivity(before, after, ME))).toEqual([
      'status:doing',
      'checklist:Green bin+',
      'comment:Blue one was full',
      'due:2026-09-24T01:00:00.000Z',
      'title:Take the bins out',
      `assigned:${THEM}`,
    ])
  })

  it('a new task handed to someone else is a hand-over; my own new task is nothing', () => {
    expect(kinds(taskActivity(undefined, task({ ownerId: undefined, assignedBy: ME, assigneeId: THEM }), ME))).toEqual([`assigned:${THEM}`])
    expect(taskActivity(undefined, task({ ownerId: undefined, assignedBy: undefined, assigneeId: undefined }), ME)).toEqual([])
  })

  it('nothing on a task nobody else is party to, nor on one of mine kept private, nor without an account', () => {
    const alone = { ownerId: ME, assigneeId: ME, assignedBy: ME }
    expect(taskActivity(task(alone), task({ ...alone, status: 'done' }), ME)).toEqual([])
    expect(taskActivity(task({ ownerId: undefined, assigneeId: undefined, assignedBy: undefined }), task({ ownerId: undefined, assigneeId: undefined, assignedBy: undefined, status: 'done' }), ME)).toEqual([])
    const privately = { ownerId: ME, assigneeId: undefined, assignedBy: THEM, shared: false }
    expect(taskActivity(task(privately), task({ ...privately, status: 'done' }), ME)).toEqual([])
    expect(taskActivity(task(), task({ status: 'done' }), null)).toEqual([])
  })

  it('a date written another way is the same date', () => {
    expect(taskActivity(task({ dueAt: '2026-09-24T01:00:00Z' }), task({ dueAt: '2026-09-24T01:00:00.000Z' }), ME)).toEqual([])
  })

  it('a cook task’s title follows its meal on either device, so it is not news', () => {
    const cook = { id: cookTaskId('meal~2026-09-24~dinner'), title: 'Cook dinner: Pasta' }
    expect(taskActivity(task(cook), task({ ...cook, title: 'Cook dinner: Soup' }), ME)).toEqual([])
  })

  it('nothing for a task sent to the Trash', () => {
    expect(taskActivity(task(), task({ status: 'done', deletedAt: T }), ME)).toEqual([])
  })
})

describe('changes that cancel out while they wait', () => {
  const d = (e: Partial<QueuedEvent> & Pick<QueuedEvent, 'type' | 'key'>): QueuedEvent => e as QueuedEvent

  it('done and then undone is nothing; done then doing keeps where it started', () => {
    const done = d({ type: 'status', key: 'status', detail: 'done', from: 'todo' })
    expect(coalesce([done], [d({ type: 'status', key: 'status', detail: 'todo', from: 'done' })])).toEqual([])
    expect(coalesce([done], [d({ type: 'status', key: 'status', detail: 'doing', from: 'done' })])).toEqual([d({ type: 'status', key: 'status', detail: 'doing', from: 'todo' })])
  })

  it('a step ticked and unticked is nothing', () => {
    expect(coalesce([d({ type: 'checklist', key: 'step:s1', detail: 'Green bin', done: true })], [d({ type: 'checklist', key: 'step:s1', detail: 'Green bin', done: false })])).toEqual([])
  })

  it('a comment is told once, and not at all once deleted unsent', () => {
    const c = d({ type: 'comment', key: 'comment:c1', detail: 'hi' })
    expect(coalesce([c], [c])).toEqual([c])
    expect(coalesce([c], [], new Set())).toEqual([])
    expect(coalesce([c], [], new Set(['c1']))).toEqual([c])
  })

  it('handed over and back is nothing, and a hand-over to nobody or to me is never sent', () => {
    const over = d({ type: 'assigned', key: 'assigned', detail: THEM, from: '' })
    expect(coalesce([over], [d({ type: 'assigned', key: 'assigned', detail: '', from: THEM })])).toEqual([])
    expect(worthTelling([d({ type: 'assigned', key: 'assigned', detail: '', from: THEM }), d({ type: 'assigned', key: 'assigned', detail: ME, from: THEM })], ME)).toEqual([])
    expect(worthTelling([over], ME)).toEqual([over])
  })
})

type Told = { taskId: string; events: ActivityEvent[] } | { messageId: string }

/**
 * A queue on a clock the test moves, a storage the test reads, and a server
 * that answers as told. `sent` is what went about tasks, `told` the messages;
 * `gone` holds the records deleted on this device.
 */
function world(answer: (body: Told) => number | Promise<number> = () => 200, store = new Map<string, string>()) {
  let now = Date.parse(T)
  const timers: { at: number; fn: () => void; id: number }[] = []
  let n = 0
  const sent: { taskId: string; events: ActivityEvent[] }[] = []
  const told: string[] = []
  const pending = new Set<string>()
  const gone = new Set<string>()
  const deps: ActivityDeps = {
    storage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: k => void store.delete(k) },
    send: async body => {
      if ('messageId' in body) told.push(body.messageId)
      else sent.push(body)
      return answer(body)
    },
    pending: id => pending.has(id),
    live: id => !gone.has(id),
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++n
      timers.push({ at: now + ms, fn, id })
      return id
    },
    clearTimeout: h => {
      const i = timers.findIndex(t => t.id === h)
      if (i >= 0) timers.splice(i, 1)
    },
  }
  const q = createActivityQueue(ME, deps)
  /** Move the clock on, firing what falls due, and let each flush finish. */
  const advance = async (ms: number) => {
    const until = now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (!next || next.at > until) break
      timers.shift()
      now = Math.max(now, next.at)
      next.fn()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    }
    now = until
  }
  return { q, sent, told, pending, gone, store, advance, setNow: (ms: number) => (now = ms) }
}

describe('the queue', () => {
  it('waits for the task to be quiet, then tells what changed, once', async () => {
    const w = world()
    w.q.note(task(), task({ status: 'doing' }))
    await w.advance(DEBOUNCE_MS - 1)
    expect(w.sent).toEqual([])
    // another change restarts the wait, and joins the same message
    w.q.note(task({ status: 'doing' }), task({ status: 'doing', checklist: [{ id: 's1', text: 'Green bin', done: true }, { id: 's2', text: 'Blue bin', done: false }] }))
    await w.advance(DEBOUNCE_MS - 1)
    expect(w.sent).toEqual([])
    await w.advance(1)
    expect(w.sent).toEqual([{ taskId: 'bins', events: [{ type: 'status', detail: 'doing' }, { type: 'checklist', detail: 'Green bin', done: true }] }])
    expect(w.q.waiting()).toEqual({})
    await w.advance(60_000)
    expect(w.sent).toHaveLength(1)
  })

  it('never tells Done-then-Undo', async () => {
    const w = world()
    w.q.note(task(), task({ status: 'done' }))
    w.q.note(task({ status: 'done' }), task({ status: 'todo' }))
    await w.advance(DEBOUNCE_MS * 3)
    expect(w.sent).toEqual([])
    expect(w.q.waiting()).toEqual({})
  })

  it('waits while the server has not got the edit, so it reads the task as changed', async () => {
    const w = world()
    w.pending.add('bins')
    w.q.note(task(), task({ status: 'done' }))
    await w.advance(DEBOUNCE_MS + PENDING_RECHECK_MS * 3)
    expect(w.sent).toEqual([])
    w.pending.delete('bins')
    await w.advance(PENDING_RECHECK_MS)
    expect(w.sent.map(s => s.events)).toEqual([[{ type: 'status', detail: 'done' }]])
  })

  it('offline, it keeps the change in storage and tries again later, backing off', async () => {
    let online = false
    const w = world(() => (online ? 200 : 0))
    w.q.note(task(), task({ status: 'done' }))
    await w.advance(DEBOUNCE_MS)
    expect(w.sent).toHaveLength(1)
    // kept where a reload finds it
    expect(Object.keys(JSON.parse(w.store.get(`drafter:activity:${ME}`)!))).toEqual(['bins'])
    await w.advance(29_000)
    expect(w.sent).toHaveLength(1)
    await w.advance(1_000)
    expect(w.sent).toHaveLength(2)
    online = true
    await w.advance(60_000)
    expect(w.sent).toHaveLength(3)
    expect(w.q.waiting()).toEqual({})
  })

  it('a queue from a reload goes out, and one a day old is dropped unsent', async () => {
    const w = world()
    w.q.note(task(), task({ status: 'done' }))
    const again = world()
    for (const [k, v] of w.store) again.store.set(k, v)
    await again.q.flush()
    expect(again.sent).toEqual([])
    await again.advance(DEBOUNCE_MS)
    expect(again.sent).toHaveLength(1)

    const late = world(() => 0)
    late.q.note(task(), task({ status: 'done' }))
    await late.advance(MAX_AGE_MS + 60_000)
    const tries = late.sent.length
    expect(late.q.waiting()).toEqual({})
    await late.advance(MAX_AGE_MS)
    expect(late.sent).toHaveLength(tries)
  })

  it('what the server will never take is let go: a task it cannot find, or a site with no notices', async () => {
    const gone = world(() => 404)
    gone.q.note(task(), task({ status: 'done' }))
    await gone.advance(DEBOUNCE_MS)
    expect(gone.q.waiting()).toEqual({})

    const none = world(() => 501)
    none.q.note(task(), task({ status: 'done' }))
    none.q.note(task({ id: 'other' }), task({ id: 'other', status: 'done' }))
    await none.advance(DEBOUNCE_MS)
    expect(none.sent).toHaveLength(1)
    expect(none.q.waiting()).toEqual({})
  })

  it('a change made while the last one was being sent is told next, not lost', async () => {
    let release: (n: number) => void = () => {}
    const w = world(() => new Promise<number>(r => (release = r)))
    w.q.note(task(), task({ status: 'doing' }))
    await w.advance(DEBOUNCE_MS)
    expect(w.sent).toHaveLength(1)
    // while that request is out, a comment is added
    w.q.note(task({ status: 'doing' }), task({ status: 'doing', comments: [{ id: 'c1', body: 'On it', createdAt: T, by: ME }] }))
    release(200)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(Object.values(w.q.waiting()).map(e => kinds(e.events))).toEqual([['comment:On it']])
    await w.advance(DEBOUNCE_MS)
    expect(w.sent[1].events).toEqual([{ type: 'comment', detail: 'On it' }])
  })

  it('keeps each member’s changes apart, under their own key', () => {
    const w = world()
    w.q.note(task(), task({ status: 'done' }))
    expect([...w.store.keys()]).toEqual([`drafter:activity:${ME}`])
  })
})

describe('a household message', () => {
  const said = (body = 'Home by six', at = new Date(T)): Message => newMessage(body, undefined, at)!
  const KEY = `drafter:activity:messages:${ME}`

  it('is told as soon as the server has it — no quiet time — and once', async () => {
    const w = world()
    const m = said()
    w.pending.add(m.id)
    w.q.noteMessage(m)
    // the engine writes it two seconds after it is sent; until the server has it, nothing goes
    await w.advance(MESSAGE_WAIT_MS + MESSAGE_RECHECK_MS * 2)
    expect(w.told).toEqual([])
    w.pending.delete(m.id)
    await w.advance(MESSAGE_RECHECK_MS)
    expect(w.told).toEqual([m.id])
    expect(w.q.waitingMessages()).toEqual({})
    expect(w.store.has(KEY)).toBe(false)
    await w.advance(60_000)
    expect(w.told).toEqual([m.id])
  })

  it('goes within a second or two of the server having it, never a task’s ten seconds', async () => {
    const w = world()
    const m = said()
    w.q.noteMessage(m)
    await w.advance(MESSAGE_WAIT_MS - 1)
    expect(w.told).toEqual([])
    await w.advance(1)
    expect(w.told).toEqual([m.id])
    expect(MESSAGE_WAIT_MS + MESSAGE_RECHECK_MS).toBeLessThan(DEBOUNCE_MS)
  })

  it('noted twice before it goes, it goes once', async () => {
    const w = world()
    const m = said()
    w.q.noteMessage(m)
    w.q.noteMessage(m)
    await w.advance(MESSAGE_WAIT_MS)
    expect(w.told).toEqual([m.id])
  })

  it('offline, it is kept in storage and tried again, backing off, until it goes', async () => {
    let online = false
    const w = world(() => (online ? 200 : 0))
    const m = said()
    w.q.noteMessage(m)
    await w.advance(MESSAGE_WAIT_MS)
    expect(w.told).toHaveLength(1)
    // kept where a reload finds it, apart from the tasks'
    expect(Object.keys(JSON.parse(w.store.get(KEY)!))).toEqual([m.id])
    expect(w.store.has(`drafter:activity:${ME}`)).toBe(false)
    await w.advance(29_000)
    expect(w.told).toHaveLength(1)
    await w.advance(1_000)
    expect(w.told).toHaveLength(2)
    online = true
    await w.advance(60_000)
    expect(w.told).toEqual([m.id, m.id, m.id])
    expect(w.q.waitingMessages()).toEqual({})
  })

  it('survives a reload while offline, and goes from the next launch once the server has it', async () => {
    const before = world(() => 0)
    const m = said()
    before.q.noteMessage(m)
    before.q.stop()
    // the app is closed before anything went; the next launch reads the same storage
    const again = world(() => 200, before.store)
    again.pending.add(m.id)
    await again.q.flush()
    await again.advance(MESSAGE_WAIT_MS)
    expect(again.told).toEqual([])
    again.pending.delete(m.id)
    await again.advance(PENDING_RECHECK_MS)
    expect(again.told).toEqual([m.id])
    expect(again.store.has(KEY)).toBe(false)
  })

  it('deleted before it went, it is never told', async () => {
    const w = world()
    const m = said()
    w.pending.add(m.id)
    w.q.noteMessage(m)
    await w.advance(MESSAGE_WAIT_MS)
    // deleted while it waited: the tombstone reaches the server, and nothing is said of it
    w.gone.add(m.id)
    w.pending.delete(m.id)
    await w.advance(60_000)
    expect(w.told).toEqual([])
    expect(w.q.waitingMessages()).toEqual({})
  })

  it('a tombstone is never noted at all', async () => {
    const w = world()
    w.q.noteMessage({ ...said(), deletedAt: T })
    await w.advance(60_000)
    expect(w.told).toEqual([])
    expect(w.store.size).toBe(0)
  })

  it('what the server will never take is let go, and a day unsent is no longer news', async () => {
    const gone = world(() => 404)
    gone.q.noteMessage(said())
    await gone.advance(MESSAGE_WAIT_MS)
    expect(gone.q.waitingMessages()).toEqual({})

    const none = world(() => 501)
    none.q.noteMessage(said())
    none.q.note(task(), task({ status: 'done' }))
    await none.advance(MESSAGE_WAIT_MS)
    // a site that keeps no notices: nothing waiting ever will go, task or message
    expect(none.told).toHaveLength(1)
    expect(none.q.waitingMessages()).toEqual({})
    expect(none.q.waiting()).toEqual({})

    const late = world(() => 0)
    late.q.noteMessage(said())
    await late.advance(MAX_AGE_MS + 60_000)
    const tries = late.told.length
    expect(late.q.waitingMessages()).toEqual({})
    await late.advance(MAX_AGE_MS)
    expect(late.told).toHaveLength(tries)
  })

  it('goes ahead of a task waiting on a slow answer, and a task still goes after it', async () => {
    let release: (n: number) => void = () => {}
    const w = world(body => ('messageId' in body ? 200 : new Promise<number>(r => (release = r))))
    w.q.note(task(), task({ status: 'done' }))
    const m = said()
    w.q.noteMessage(m)
    await w.advance(MESSAGE_WAIT_MS)
    expect(w.told).toEqual([m.id])
    await w.advance(DEBOUNCE_MS)
    expect(w.sent.map(x => x.taskId)).toEqual(['bins'])
    release(200)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(w.q.waiting()).toEqual({})
  })
})

describe('where edits are noted', () => {
  const store = readFileSync(fileURLToPath(new URL('../store.ts', import.meta.url)), 'utf8')

  it('at the store’s own upsert and setStatus — the local edit path — and nowhere a pull goes', () => {
    expect(store.match(/noteTaskEdit\(/g)).toHaveLength(2)
    expect(store).toMatch(/const upsert = useCallback\([\s\S]{0,400}e\.upsert\(item\)\s*\n\s*noteTaskEdit\(before, item, myId\)/)
    expect(store).toMatch(/const change = e\.setStatus\(id, status\)[\s\S]{0,300}if \(change\) noteTaskEdit\(change\.prev, change\.next, myId\)/)
    // the views get the noting upsert, never the engine's own
    expect(store).toMatch(/\n\s*upsert,\n/)
    expect(store).not.toMatch(/upsert: e\.upsert/)
  })

  it('a household message at the chat’s Send alone, with somebody to tell: the one place one is written', () => {
    const planner = plannerSource()
    expect(planner.match(/noteMessageSent\(/g)).toHaveLength(1)
    expect(planner).toMatch(/onSendMessage=\{m => \{\s*upsert\(m\)[\s\S]{0,300}if \(p\.inHousehold\) noteMessageSent\(m, store\.myId\)/)
    // the store notes none: what a pull brings never passes the chat's Send
    expect(store).not.toMatch(/noteMessageSent/)
  })
})
