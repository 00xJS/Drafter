import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newerStamp } from '../itemops'
import { watchLifecycle } from '../syncengine'
import { Task } from '../types'
import { FakeServer, device, edit, idle, last, ready, task } from './sync-fakes'

// iOS may suspend and then kill a backgrounded app inside the 300ms cache
// debounce or the 2s push debounce. Going to the background has to write and
// push at once.

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-10T10:00:00.000Z') })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('flush when the app goes to the background', () => {
  it('writes the cache and pushes at once, and the cancelled debounces never fire', async () => {
    const server = new FakeServer()
    server.seed(task('a'))
    const d = device(server)
    await ready(d)
    const writes = d.writes.length
    edit(d, 'a', { title: 'Edited just before switching away' })
    d.engine.flush()
    await idle(d)
    expect(d.writes.length).toBe(writes + 1)
    expect(last(d.writes).items.find(i => i.id === 'a')).toMatchObject({ title: 'Edited just before switching away' })
    expect(server.row<Task>('a')!.title).toBe('Edited just before switching away')
    const calls = server.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(server.calls.length).toBe(calls)
    expect(d.writes.length).toBe(writes + 1)
  })

  it('is safe to call again and again, and does nothing with nothing waiting', async () => {
    const server = new FakeServer()
    const d = device(server)
    await ready(d)
    const writes = d.writes.length
    const calls = server.calls.length
    d.engine.flush()
    d.engine.flush()
    await vi.advanceTimersByTimeAsync(0)
    expect(d.writes.length).toBe(writes)
    expect(server.calls.length).toBe(calls)

    d.engine.upsert(task('new', { updatedAt: newerStamp() }))
    d.engine.flush()
    d.engine.flush()
    d.engine.flush()
    await idle(d)
    expect(d.writes.length).toBe(writes + 1)
    expect(server.calls.length).toBe(calls + 1)
  })

  it('an edit flushed on the way out survives the app being killed, and goes out on the next launch', async () => {
    const server = new FakeServer()
    const d = device(server)
    await ready(d)
    server.offline = true
    d.engine.upsert(task('late', { title: 'Typed at the last moment', updatedAt: newerStamp() }))
    d.engine.flush()
    await vi.advanceTimersByTimeAsync(0)
    // killed here: no timer of this session ever runs again
    server.offline = false
    const next = device(server, { kv: d.kv, snapshot: d.snapshot() })
    await ready(next)
    expect(server.row<Task>('late')!.title).toBe('Typed at the last moment')
  })

  it('in local mode it still writes the cache, with nothing to push', async () => {
    const d = device(null)
    await ready(d, null)
    d.engine.upsert(task('a', { updatedAt: newerStamp() }))
    d.engine.flush()
    await vi.advanceTimersByTimeAsync(0)
    expect(d.snapshot()!.items.map(i => i.id)).toEqual(['a'])
  })
})

class FakeDocument extends EventTarget {
  visibilityState = 'visible'
}

describe('the page lifecycle wired to the engine', () => {
  it('flushes on hidden, pagehide and the shell’s pause; syncs on visible, focus and online; and lets go', async () => {
    const doc = new FakeDocument()
    const win = new EventTarget()
    let pause: (() => void) | null = null
    const engine = { sync: vi.fn(async () => true), flush: vi.fn() }
    const stop = watchLifecycle(engine, {
      document: doc,
      window: win,
      onPause: async cb => {
        pause = cb
        return () => {
          pause = null
        }
      },
    })
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    win.dispatchEvent(new Event('pagehide'))
    pause!()
    expect(engine.flush).toHaveBeenCalledTimes(3)
    expect(engine.sync).not.toHaveBeenCalled()
    // focus while hidden is not a return to the app
    win.dispatchEvent(new Event('focus'))
    expect(engine.sync).not.toHaveBeenCalled()

    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    win.dispatchEvent(new Event('focus'))
    win.dispatchEvent(new Event('online'))
    expect(engine.sync).toHaveBeenCalledTimes(3)

    await Promise.resolve()
    stop()
    expect(pause).toBeNull()
    doc.dispatchEvent(new Event('visibilitychange'))
    win.dispatchEvent(new Event('pagehide'))
    win.dispatchEvent(new Event('online'))
    expect(engine.flush).toHaveBeenCalledTimes(3)
    expect(engine.sync).toHaveBeenCalledTimes(3)
  })
})
