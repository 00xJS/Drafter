import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIVE_PERIODIC_MS, PERIODIC_MS, watchLifecycle } from '../syncengine'
import { Task } from '../types'
import { FakeServer, device, idle, ready, task } from './sync-fakes'

// The periodic round: every minute, every five while a live channel carries
// the changes, and not at all while the page is hidden — coming back to it
// syncs, so a tab left in the background asks for nothing meanwhile.

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-10T10:00:00.000Z') })
})
afterEach(() => {
  vi.useRealTimers()
})

class FakeDocument extends EventTarget {
  visibilityState = 'visible'
}

const show = (doc: FakeDocument, state: 'visible' | 'hidden') => {
  doc.visibilityState = state
  doc.dispatchEvent(new Event('visibilitychange'))
}

describe('the periodic round', () => {
  it('runs every minute; not at all while hidden; every five minutes while live', async () => {
    const server = new FakeServer()
    server.seed(task('a'))
    const d = device(server)
    await ready(d)
    d.engine.start()
    expect(d.engine.inspect().pollMs).toBe(PERIODIC_MS)
    let calls = server.calls.length
    await vi.advanceTimersByTimeAsync(PERIODIC_MS)
    await idle(d)
    expect(server.calls.length).toBe(calls + 1)

    d.engine.setHidden(true)
    expect(d.engine.inspect().pollMs).toBeNull()
    calls = server.calls.length
    await vi.advanceTimersByTimeAsync(10 * PERIODIC_MS)
    expect(server.calls.length).toBe(calls)

    d.engine.setHidden(false)
    d.engine.setLive(true)
    expect(d.engine.inspect().pollMs).toBe(LIVE_PERIODIC_MS)
    calls = server.calls.length
    await vi.advanceTimersByTimeAsync(LIVE_PERIODIC_MS - 1)
    expect(server.calls.length).toBe(calls)
    await vi.advanceTimersByTimeAsync(1)
    await idle(d)
    expect(server.calls.length).toBe(calls + 1)

    d.engine.setLive(false)
    expect(d.engine.inspect().pollMs).toBe(PERIODIC_MS)
    d.engine.stop()
    expect(d.engine.inspect().pollMs).toBeNull()
  })

  it('stays hidden-paused when the channel comes up meanwhile, and live-paced when the page returns', async () => {
    const d = device(new FakeServer())
    await ready(d)
    d.engine.start()
    d.engine.setHidden(true)
    d.engine.setLive(true)
    expect(d.engine.inspect().pollMs).toBeNull()
    d.engine.setHidden(false)
    expect(d.engine.inspect().pollMs).toBe(LIVE_PERIODIC_MS)
  })

  it('never runs in local mode', async () => {
    const d = device(null)
    await ready(d, null)
    d.engine.start()
    expect(d.engine.inspect().pollMs).toBeNull()
  })
})

describe('the page lifecycle pauses it', () => {
  it('hidden stops the round and flushes; visible starts it again and syncs', async () => {
    const server = new FakeServer()
    server.seed(task('a'))
    const d = device(server)
    await ready(d)
    d.engine.start()
    const doc = new FakeDocument()
    const stop = watchLifecycle(d.engine, { document: doc, window: new EventTarget() })
    expect(d.engine.inspect().pollMs).toBe(PERIODIC_MS)

    d.engine.upsert({ ...d.item<Task>('a')!, title: 'Typed before switching away', updatedAt: '2026-09-10T10:00:01.000Z' })
    show(doc, 'hidden')
    expect(d.engine.inspect().pollMs).toBeNull()
    await idle(d)
    // the flush still wrote and pushed what was waiting
    expect(server.row<Task>('a')!.title).toBe('Typed before switching away')
    let calls = server.calls.length
    await vi.advanceTimersByTimeAsync(10 * PERIODIC_MS)
    expect(server.calls.length).toBe(calls)

    show(doc, 'visible')
    expect(d.engine.inspect().pollMs).toBe(PERIODIC_MS)
    await idle(d)
    expect(server.calls.length).toBe(calls + 1)
    calls = server.calls.length
    await vi.advanceTimersByTimeAsync(PERIODIC_MS)
    await idle(d)
    expect(server.calls.length).toBe(calls + 1)
    stop()
  })

  it('a page opened in a background tab starts without the round', async () => {
    const d = device(new FakeServer())
    await ready(d)
    d.engine.start()
    const doc = new FakeDocument()
    doc.visibilityState = 'hidden'
    const stop = watchLifecycle(d.engine, { document: doc, window: new EventTarget() })
    expect(d.engine.inspect().pollMs).toBeNull()
    show(doc, 'visible')
    expect(d.engine.inspect().pollMs).toBe(PERIODIC_MS)
    stop()
  })
})

describe('a nudge from another device', () => {
  it('runs a round that starts after the one in flight, which may have asked before the change landed', async () => {
    const server = new FakeServer()
    server.seed(task('a'))
    const d = device(server)
    await ready(d)
    let release = () => {}
    server.beforeAnswer = () => new Promise<void>(r => (release = r))
    const calls = server.calls.length
    const round = d.engine.sync()
    await vi.advanceTimersByTimeAsync(0)
    // the change lands after that round asked
    server.patch('a', { title: 'Renamed elsewhere', updatedAt: '2026-09-10T09:00:00.000Z' })
    const nudged = d.engine.nudge()
    server.beforeAnswer = null
    release()
    await round
    await nudged
    expect(server.calls.length).toBe(calls + 2)
    expect(d.item<Task>('a')!.title).toBe('Renamed elsewhere')
  })

  it('does nothing while the page is hidden: coming back syncs anyway', async () => {
    const server = new FakeServer()
    const d = device(server)
    await ready(d)
    d.engine.setHidden(true)
    const calls = server.calls.length
    expect(await d.engine.nudge()).toBe(false)
    expect(server.calls.length).toBe(calls)
  })
})
