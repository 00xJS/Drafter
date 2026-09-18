import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSnapshot } from '../../netlify/functions/lib/backup.mjs'
import { feedFor, readableItems } from '../../netlify/functions/lib/feedrows.mjs'
import { buildDigest, visibleItemsFor } from '../../shared/digest.mjs'
import { summarizeTask } from '../../mcp/tools.mjs'
import { nextOccurrence } from '../../shared/domain.mjs'
import { sanitizeTask } from '../schema'
import { duplicateTask } from '../taskutils'
import { formValues, initForm, mergeOnto } from '../taskform'
import { Item, Task } from '../types'
import { FakeServer, device, idle, ready } from './sync-fakes'

// A task can be kept to yourself (v3.19), which is the same mechanism as a
// shared note (v3.16) with the default the other way round: a note is private
// until shared, a task is the household's until withheld. Household work is
// what a task is for, and the 54 tasks written before this were written to be
// seen, so an absent flag means shared and only `shared: false` withholds one.
//
// What is covered here is everything the database cannot enforce for itself:
// the readers that hold the service key and so bypass RLS (the ICS feed, the
// nightly backup, the morning digest, the MCP server), and the client's own
// handling of the flag — which is where a private task would otherwise be made
// public by an ordinary save.

const ME = '00000000-0000-0000-0000-00000000000a'
const PEER = '00000000-0000-0000-0000-00000000000b'
const SITE = 'https://drafter.example.test'
const at = '2026-09-01T00:00:00.000Z'

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  kind: 'task',
  id,
  title: 'Bins out',
  description: '',
  status: 'todo',
  priority: 'normal',
  tags: [],
  dueAt: '2026-09-12T09:00:00.000Z',
  createdAt: at,
  updatedAt: at,
  ...extra,
})

describe('a private task never leaves its owner, through the readers that bypass the policy', () => {
  it('reaches a household peer while nobody has withheld it', () => {
    const rows = [{ user_id: PEER, data: task('peer-open') }]
    expect((visibleItemsFor(rows, ME, [PEER], ME) as { id: string }[]).map(i => i.id)).toEqual(['peer-open'])
    expect(readableItems(rows, ME).map(i => i.id)).toEqual(['peer-open'])
  })

  it('and stops reaching them the moment it is', () => {
    const rows = [
      { user_id: PEER, data: task('peer-open') },
      { user_id: PEER, data: task('peer-shut', { shared: false }) },
      { user_id: ME, data: task('mine-shut', { shared: false }) },
    ]
    // their private one is gone; my own is mine to read however it is marked
    expect((visibleItemsFor(rows, ME, [PEER], ME) as { id: string }[]).map(i => i.id)).toEqual(['peer-open', 'mine-shut'])
    expect(readableItems(rows, ME).map(i => i.id)).toEqual(['peer-open', 'mine-shut'])
  })

  it('never rides in a peer’s backup: the snapshot is the one file a stranger could be handed', () => {
    const rows = [
      { user_id: PEER, data: task('peer-open') },
      { user_id: PEER, data: task('peer-shut', { shared: false }) },
      { user_id: ME, data: task('mine') },
    ]
    expect(buildSnapshot(ME, rows, new Date(at)).items.map(i => (i as { id: string }).id)).toEqual(['peer-open', 'mine'])
  })

  it('never reaches the calendar feed, which publishes tasks by the hour to whoever holds the URL', () => {
    // The feed only carries tasks that are the reader's to do, so the case
    // that matters is a peer's task assigned to the reader and then withheld.
    // readableItems is what the feed is built from, and it has to drop the row
    // before feedFor ever sees a due date it would publish.
    const rows = [
      { user_id: ME, data: task('t1') },
      { user_id: PEER, data: task('peer-open', { assigneeId: ME }) },
      { user_id: PEER, data: task('peer-shut', { assigneeId: ME, shared: false }) },
    ]
    expect(feedFor(readableItems(rows, ME), SITE, 'Europe/London', ME).map(e => e.uid)).toEqual(['task-t1@drafter', 'task-peer-open@drafter'])
    // and it is readableItems that did it, not a filter further down
    expect(readableItems(rows, ME).map(i => i.id)).toEqual(['t1', 'peer-open'])
  })

  it('never reaches the morning digest', () => {
    const now = new Date('2026-09-12T07:00:00.000Z')
    const rows = [
      { user_id: PEER, data: task('peer-open') },
      { user_id: PEER, data: task('peer-shut', { shared: false }) },
    ]
    const visible = visibleItemsFor(rows, ME, [PEER], ME)
    expect(buildDigest(visible, 'UTC', now).dueToday.map(t => t.id)).toEqual(['peer-open'])
  })

  it('says which it is over MCP, so an agent can answer the question too', () => {
    expect(summarizeTask(task('t'))).toMatchObject({ shared: true })
    expect(summarizeTask(task('t', { shared: false }))).toMatchObject({ shared: false })
  })
})

describe('the flag survives the round trip', () => {
  it('sanitizeTask keeps `false`, so an ordinary save never quietly shares a private task', () => {
    // sync_posts overwrites `data` wholesale, and the sanitizers are
    // whitelists: a build that dropped the flag would push the task back
    // without it, and an absent flag on a task reads as SHARED. This is the
    // one direction where losing a field discloses something.
    expect(sanitizeTask(task('t', { shared: false }))!.shared).toBe(false)
    expect(sanitizeTask(task('t'))!.shared).toBeUndefined()
    // `true` is the default, so it is not carried: a task nobody has withheld
    // looks exactly like every task written before v3.19
    expect(sanitizeTask(task('t', { shared: true }))!.shared).toBeUndefined()
    // and a stray value is not the boolean
    expect(sanitizeTask(task('t', { shared: 'false' }))!.shared).toBeUndefined()
  })
})

describe('a task made from a task', () => {
  // Every other writer builds a NEW task, where the household's default is the
  // right one. These two copy an existing one field by field, and a field left
  // off the list is a field the copy does not have — which for `shared` means
  // public. Notes never hit this: nothing duplicates or repeats a note.
  it('a duplicate of a private task is private', () => {
    const copy = duplicateTask(sanitizeTask(task('t', { shared: false }))!)
    expect(copy.shared).toBe(false)
    expect(copy.title).toBe('Bins out')
  })

  it('and a duplicate of the household’s task is still the household’s', () => {
    expect(duplicateTask(sanitizeTask(task('t'))!).shared).toBeUndefined()
  })

  it('the next occurrence of a private repeating task is private', () => {
    // the spawn is a NEW row, so the flag has to travel on it: the trigger that
    // keeps a stored `false` only guards a row that already exists
    const source = sanitizeTask(task('t', { shared: false, recurrence: { freq: 'weekly' }, status: 'done', completedAt: '2026-09-12T09:00:00.000Z' }))!
    const next = nextOccurrence(source, () => 'spawn-id')
    expect(next).not.toBeNull()
    expect(next!.shared).toBe(false)
  })

  it('and the next occurrence of the household’s is still the household’s', () => {
    const source = sanitizeTask(task('t', { recurrence: { freq: 'weekly' }, status: 'done', completedAt: '2026-09-12T09:00:00.000Z' }))!
    expect(nextOccurrence(source, () => 'spawn-id')!.shared).toBeUndefined()
  })
})

describe('what the editor writes', () => {
  const base = (over: Partial<Task> = {}): Task => sanitizeTask(task('t', over))!

  it('writes nothing at all while the task is shared, which is what most tasks are', () => {
    const t = base()
    expect(formValues(initForm(t), t, true).shared).toBeUndefined()
  })

  it('writes `false` to withhold one', () => {
    const t = base()
    const form = { ...initForm(t), shared: false }
    expect(formValues(form, t, true).shared).toBe(false)
    expect(mergeOnto(t, form, t, true).shared).toBe(false)
  })

  it('writes `true` out loud to overturn a stored `false` — silence would be read as "keep it private"', () => {
    // v3.19's posts_private_flag keeps a stored `false` when a write does not
    // mention the flag, which is what stops an older build from making a
    // private task public. Sharing again therefore has to SAY so.
    const t = base({ shared: false })
    const form = { ...initForm(t), shared: true }
    expect(initForm(t).shared).toBe(false)
    expect(formValues(form, t, true).shared).toBe(true)
    expect(mergeOnto(t, form, t, true).shared).toBe(true)
  })

  it('leaves a task alone that the editor never touched, however another device marked it', () => {
    // the freshest copy wins for fields the user did not edit: opening a task
    // and saving a new title must not undo a private mark made on the phone
    const opened = base()
    const current = base({ shared: false })
    const form = { ...initForm(opened), title: 'Bins out, Thursday' }
    const saved = mergeOnto(current, form, opened, true)
    expect(saved.title).toBe('Bins out, Thursday')
    expect(saved.shared).toBe(false)
  })
})

describe('withholding one, through the engine', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-09-10T10:00:00.000Z') })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const peerTask = (id: string, over: Record<string, unknown> = {}) => task(id, { ...over }) as unknown as Item

  /** A server answering this account, so "whose row is this" means what it means here. */
  const serverFor = (me: string) => {
    const s = new FakeServer()
    s.caller = me
    return s
  }

  it('a peer’s task leaves the list and the cache when they make it private', async () => {
    // The half a policy cannot do: the reader is holding a copy, and the row
    // they may no longer select is simply absent from their next delta —
    // indistinguishable from "nothing changed". peerShared states the whole
    // visible set each round, so the leftover can be found and dropped.
    const server = serverFor(ME)
    server.seedAs(PEER, peerTask('peer-open'))
    const d = device(server)
    await ready(d, ME)
    expect(d.item('peer-open')).toBeDefined()

    server.patch('peer-open', { shared: false, updatedAt: '2026-09-10T11:00:00.000Z' })
    await d.engine.sync()
    await idle(d)
    await vi.advanceTimersByTimeAsync(300)

    expect(d.item('peer-open')).toBeUndefined()
    expect(d.snapshot()!.items.map(i => i.id)).not.toContain('peer-open')
  })

  it('keeps every task of this account’s own through the same round, private or not', async () => {
    const server = serverFor(ME)
    server.seed(peerTask('mine-open'), peerTask('mine-shut', { shared: false }))
    server.seedAs(PEER, peerTask('peer-open'))
    const d = device(server)
    await ready(d, ME)

    server.patch('peer-open', { shared: false, updatedAt: '2026-09-10T11:00:00.000Z' })
    await d.engine.sync()
    await idle(d)

    expect(d.item('mine-open')).toBeDefined()
    expect(d.item('mine-shut')).toBeDefined()
    expect(d.item('peer-open')).toBeUndefined()
  })

  it('drops not one task of a peer’s against a server that speaks only of notes', async () => {
    // The window between the migration and the next iOS build, and the reason
    // peerNotes is still answered beside peerShared: a v3.16 server says
    // nothing about tasks, and silence must not be read as "none are visible".
    const server = serverFor(ME)
    server.shape = 'v316'
    server.seedAs(PEER, peerTask('peer-open'), peerTask('peer-two'))
    const d = device(server)
    await ready(d, ME)

    await d.engine.sync()
    await idle(d)

    expect(d.item('peer-open')).toBeDefined()
    expect(d.item('peer-two')).toBeDefined()
  })
})
