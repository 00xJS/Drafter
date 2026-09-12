import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newerStamp, pullSince } from '../itemops'
import { CURSOR_KEY, DIRTY_KEY } from '../syncstate'
import { Task } from '../types'
import { FakeServer, device, edit, idle, last, ready, task } from './sync-fakes'

// The engine, driven the way the app drives it, against an in-memory
// sync_posts and fake timers: the debounces, the rounds, the bookkeeping.

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-10T10:00:00.000Z') })
})
afterEach(() => {
  vi.useRealTimers()
})

const sentIds = (server: FakeServer, from = 0) => server.calls.slice(from).flatMap(c => c.outgoing.map(o => o.id))

describe('boot and the everyday round', () => {
  it('an empty device does a full exchange and adopts what the server has', async () => {
    const server = new FakeServer()
    server.seed(task('a'))
    const d = device(server)
    await ready(d)
    expect(server.calls[0].since).toBeNull()
    expect(d.item('a')).toBeDefined()
    expect(d.engine.getState()).toMatchObject({ loaded: true, syncInfo: { online: true, pending: 0 } })
    expect(d.kv.get(CURSOR_KEY)).toBeTruthy()
  })

  it('writes an edit to the cache after 300ms and pushes it after 2s, pulling with the 10s overlap', async () => {
    const server = new FakeServer()
    server.seed(task('a'))
    const d = device(server)
    await ready(d)
    const cursor = d.kv.get(CURSOR_KEY)!
    const calls = server.calls.length
    edit(d, 'a', { title: 'Buy paint' })
    expect(d.engine.inspect().dirty).toEqual(['a'])
    expect(JSON.parse(d.kv.get(DIRTY_KEY)!)).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(300)
    expect(d.snapshot()!.items.find(i => i.id === 'a')).toMatchObject({ title: 'Buy paint' })
    expect(server.calls.length).toBe(calls)
    await vi.advanceTimersByTimeAsync(1700)
    await idle(d)
    expect(last(server.calls)).toMatchObject({ since: pullSince(cursor) })
    expect(server.row<Task>('a')!.title).toBe('Buy paint')
    expect(d.engine.inspect()).toMatchObject({ dirty: [] })
    expect(d.engine.getState().syncInfo.pending).toBe(0)
  })

  it('offline keeps the edit on the device, and online sends it', async () => {
    const server = new FakeServer()
    server.seed(task('a'))
    const d = device(server)
    await ready(d)
    server.offline = true
    edit(d, 'a', { title: 'Offline edit' })
    d.engine.upsert(task('new', { title: 'Offline idea', updatedAt: newerStamp() }))
    await vi.advanceTimersByTimeAsync(2000)
    await idle(d)
    expect(d.engine.getState().syncInfo).toMatchObject({ online: false, pending: 2 })
    expect(JSON.parse(d.kv.get(DIRTY_KEY)!).sort()).toEqual(['a', 'new'])

    server.offline = false
    expect(await d.engine.sync()).toBe(true)
    expect(server.row<Task>('a')!.title).toBe('Offline edit')
    expect(server.row<Task>('new')!.title).toBe('Offline idea')
    expect(d.engine.getState().syncInfo).toMatchObject({ online: true, pending: 0 })
  })

  it('a restart while offline still sends what the last session left', async () => {
    const server = new FakeServer()
    const d = device(server)
    await ready(d)
    server.offline = true
    d.engine.upsert(task('new', { title: 'Before the restart', updatedAt: newerStamp() }))
    await vi.advanceTimersByTimeAsync(300)
    server.offline = false
    const again = device(server, { kv: d.kv, snapshot: d.snapshot() })
    await ready(again)
    expect(server.row<Task>('new')!.title).toBe('Before the restart')
    expect(again.engine.inspect().dirty).toEqual([])
  })

  it('an edit made while a round is in flight is pushed again, not lost', async () => {
    const server = new FakeServer()
    server.seed(task('a'))
    const d = device(server)
    await ready(d)
    let release: (() => void) | null = null
    server.beforeAnswer = n => {
      if (server.calls[n - 1].outgoing.length > 0) return new Promise<void>(r => (release = r))
    }
    edit(d, 'a', { title: 'first' })
    const round = d.engine.sync()
    await vi.advanceTimersByTimeAsync(0)
    expect(release).not.toBeNull()
    edit(d, 'a', { title: 'second' })
    server.beforeAnswer = null
    release!()
    await round
    expect(server.row<Task>('a')!.title).toBe('first')
    expect(d.item<Task>('a')!.title).toBe('second')
    expect(d.engine.inspect().dirty).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(2000)
    await idle(d)
    expect(server.row<Task>('a')!.title).toBe('second')
    expect(d.engine.inspect().dirty).toEqual([])
  })

  it('a second sync call joins the round in flight', async () => {
    const server = new FakeServer()
    const d = device(server)
    await ready(d)
    const calls = server.calls.length
    const a = d.engine.sync()
    const b = d.engine.sync()
    expect(b).toBe(a)
    await a
    expect(server.calls.length).toBe(calls + 1)
  })
})

describe('the three shapes the server answers in', () => {
  // a row pushed unchanged: the server keeps its copy and, delta-wise, says nothing
  const setUp = async (shape: 'new' | 'old' | 'legacy') => {
    const server = new FakeServer()
    server.shape = shape
    const a = task('a')
    server.seed(a)
    const d = device(server, {
      snapshot: { version: 3, userId: 'user-1', items: [a] },
      kv: new Map([
        [DIRTY_KEY, '["a"]'],
        [CURSOR_KEY, '2026-09-10T13:00:00.000Z'],
      ]),
    })
    await ready(d)
    return d
  }

  it('{ items, rejected }: a sent row it neither refused nor echoed is confirmed', async () => {
    const d = await setUp('old')
    expect(d.engine.getState().syncInfo.pending).toBe(0)
  })

  it('{ items, rejected, stale, gone }: a stale row identical to ours is confirmed too', async () => {
    const d = await setUp('new')
    expect(d.engine.getState().syncInfo.pending).toBe(0)
  })

  it('the legacy bare array: only an echo proves it, so it stays unsynced', async () => {
    const d = await setUp('legacy')
    expect(d.engine.getState().syncInfo.pending).toBe(1)
    expect(d.engine.inspect().dirty).toEqual(['a'])
  })

})

describe('accounts, local mode and full resync', () => {
  it('wipes a cache another account left, pushes none of it, and starts with a full exchange', async () => {
    const server = new FakeServer()
    server.seed(task('mine'))
    const d = device(server, {
      snapshot: { version: 3, userId: 'someone-else', items: [task('theirs')] },
      kv: new Map([
        [DIRTY_KEY, '["theirs"]'],
        [CURSOR_KEY, '2026-09-09T00:00:00.000Z'],
      ]),
    })
    await ready(d, 'user-1')
    expect(d.cleared()).toBe(1)
    expect(d.item('theirs')).toBeUndefined()
    expect(server.row('theirs')).toBeUndefined()
    expect(server.calls[0].since).toBeNull()
    expect(d.item('mine')).toBeDefined()
    expect(d.snapshot()!.userId).toBe('user-1')
  })

  it('drops another account’s records still in memory when a different one signs in', async () => {
    const server = new FakeServer()
    const d = device(server)
    await ready(d, 'user-1')
    server.offline = true
    d.engine.upsert(task('draft', { updatedAt: newerStamp() }))
    d.engine.signedIn('user-2')
    expect(d.engine.getState().items).toEqual([])
    server.offline = false
    await vi.advanceTimersByTimeAsync(5000)
    await idle(d)
    expect(sentIds(server)).not.toContain('draft')
  })

  it('full resync sends everything with no cursor, even when asked mid-round', async () => {
    const server = new FakeServer()
    server.seed(task('a'), task('b'))
    const d = device(server)
    await ready(d)
    let release: (() => void) | null = null
    server.beforeAnswer = () => new Promise<void>(r => (release = r))
    const round = d.engine.sync()
    await vi.advanceTimersByTimeAsync(0)
    const full = d.engine.fullResync()
    server.beforeAnswer = null
    release!()
    await round
    await full
    const final = last(server.calls)
    expect(final.since).toBeNull()
    expect(final.outgoing.map(o => o.id).sort()).toEqual(['a', 'b'])
  })
})
