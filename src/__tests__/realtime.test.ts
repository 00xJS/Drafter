import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NUDGE_MAX_MS, NUDGE_MS, REOPEN_MS, watchRealtime, type LiveChannel, type LiveClient, type PostsRow } from '../realtime'
import { LIVE_PERIODIC_MS, PERIODIC_MS } from '../syncengine'
import { Task } from '../types'
import { FakeServer, device, idle, last, ready, task } from './sync-fakes'

// Live updates: a change the channel reports is a nudge to run the ordinary
// round, debounced, and never a record to apply. While the channel is live the
// minute poll slows to five; when it errors, times out or closes it is back to
// a minute while supabase-js (or, for a closed one, this) opens it again.

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-10T10:00:00.000Z') })
})
afterEach(() => {
  vi.useRealTimers()
})

type Binding = { type: string; filter: { event?: string; schema?: string; table?: string }; callback: (payload: any) => void }

/** A Realtime channel the test drives: its status, the server's word on the subscription, and the changes. */
class FakeChannel implements LiveChannel {
  bindings: Binding[] = []
  onStatus: ((status: string) => void) | null = null
  removed = false
  constructor(readonly name: string) {}
  on(type: string, filter: Binding['filter'], callback: (payload: any) => void): this {
    this.bindings.push({ type, filter, callback })
    return this
  }
  subscribe(callback: (status: string) => void): this {
    this.onStatus = callback
    return this
  }
  status(status: 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED'): void {
    this.onStatus?.(status)
  }
  system(status: 'ok' | 'error'): void {
    for (const b of this.bindings) if (b.type === 'system') b.callback({ extension: 'postgres_changes', status, message: status === 'ok' ? 'Subscribed to PostgreSQL' : 'Unable to subscribe to changes with given parameters' })
  }
  /** SUBSCRIBED, and the server's subscription to the table on. */
  up(): void {
    this.status('SUBSCRIBED')
    this.system('ok')
  }
  change(event: 'INSERT' | 'UPDATE', row: PostsRow): void {
    for (const b of this.bindings) if (b.type === 'postgres_changes' && b.filter.event === event) b.callback({ eventType: event, new: row, old: {} })
  }
}

class FakeClient implements LiveClient {
  channels: FakeChannel[] = []
  channel(name: string): FakeChannel {
    const ch = new FakeChannel(name)
    this.channels.push(ch)
    return ch
  }
  async removeChannel(channel: LiveChannel): Promise<string> {
    ;(channel as FakeChannel).removed = true
    return 'ok'
  }
  get current(): FakeChannel {
    return last(this.channels)
  }
}

/** An engine stand-in that records what it is told. */
const fakeEngine = (holds: (id: string, updatedAt: string, ownerId?: string | null) => boolean = () => false) => ({
  nudge: vi.fn(async () => true),
  setLive: vi.fn(),
  holds: vi.fn(holds),
})

const row = (id: string, updatedAt: string, over: Record<string, unknown> = {}): PostsRow => ({
  id,
  user_id: 'user-2',
  updated_at: updatedAt,
  data: { kind: 'task', id, title: id, updatedAt },
  ...over,
})

describe('what it listens for', () => {
  it('INSERT and UPDATE on public.posts, and the server’s word on its subscription — never DELETE', () => {
    const client = new FakeClient()
    watchRealtime({ client, engine: fakeEngine() })
    const ch = client.current
    expect(ch.bindings.map(b => [b.type, b.filter.event, b.filter.schema, b.filter.table])).toEqual([
      ['postgres_changes', 'INSERT', 'public', 'posts'],
      ['postgres_changes', 'UPDATE', 'public', 'posts'],
      ['system', undefined, undefined, undefined],
    ])
    expect(ch.onStatus).not.toBeNull()
  })

  it('gives every channel a topic of its own, so a closing one is never handed back', () => {
    const client = new FakeClient()
    const a = watchRealtime({ client, engine: fakeEngine() })
    a.stop()
    watchRealtime({ client, engine: fakeEngine() })
    expect(client.channels[0].name).not.toBe(client.channels[1].name)
  })
})

describe('a change is a nudge', () => {
  it('a burst is one round, 750ms after the last of it', async () => {
    const client = new FakeClient()
    const engine = fakeEngine()
    watchRealtime({ client, engine })
    client.current.up()
    // going live catches up once: what changed while it came up was never sent
    await vi.advanceTimersByTimeAsync(NUDGE_MS)
    expect(engine.nudge).toHaveBeenCalledTimes(1)

    client.current.change('INSERT', row('a', '2026-09-10T10:00:01.000Z'))
    await vi.advanceTimersByTimeAsync(300)
    client.current.change('UPDATE', row('b', '2026-09-10T10:00:02.000Z'))
    await vi.advanceTimersByTimeAsync(300)
    client.current.change('UPDATE', row('a', '2026-09-10T10:00:03.000Z'))
    await vi.advanceTimersByTimeAsync(NUDGE_MS - 1)
    expect(engine.nudge).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(engine.nudge).toHaveBeenCalledTimes(2)
  })

  it('a steady stream still gets a round every five seconds', async () => {
    const client = new FakeClient()
    const engine = fakeEngine()
    watchRealtime({ client, engine })
    client.current.up()
    await vi.advanceTimersByTimeAsync(NUDGE_MS)
    engine.nudge.mockClear()
    for (let i = 0; i < 24; i++) {
      client.current.change('UPDATE', row('a', new Date(Date.now()).toISOString()))
      await vi.advanceTimersByTimeAsync(500)
    }
    // 12 seconds of changes every half second: never 750ms of quiet, still two rounds
    expect(engine.nudge.mock.calls.length).toBeGreaterThanOrEqual(Math.floor(12_000 / NUDGE_MAX_MS))
  })

  it('this device’s own push coming back is no round', async () => {
    const client = new FakeClient()
    const engine = fakeEngine((id, updatedAt) => id === 'a' && updatedAt === '2026-09-10T10:00:01.000Z')
    watchRealtime({ client, engine })
    client.current.up()
    await vi.advanceTimersByTimeAsync(NUDGE_MS)
    engine.nudge.mockClear()
    client.current.change('UPDATE', row('a', '2026-09-10T10:00:01.000Z', { user_id: 'user-1' }))
    await vi.advanceTimersByTimeAsync(NUDGE_MS)
    expect(engine.holds).toHaveBeenCalledWith('a', '2026-09-10T10:00:01.000Z', 'user-1')
    expect(engine.nudge).not.toHaveBeenCalled()
    // a change it does not hold is one
    client.current.change('UPDATE', row('a', '2026-09-10T10:00:09.000Z'))
    await vi.advanceTimersByTimeAsync(NUDGE_MS)
    expect(engine.nudge).toHaveBeenCalledTimes(1)
  })

  it('a change it cannot read — no id, no stamp — is still a round, never skipped', async () => {
    const client = new FakeClient()
    const engine = fakeEngine(() => true)
    watchRealtime({ client, engine })
    client.current.up()
    await vi.advanceTimersByTimeAsync(NUDGE_MS)
    engine.nudge.mockClear()
    client.current.change('UPDATE', {})
    await vi.advanceTimersByTimeAsync(NUDGE_MS)
    expect(engine.nudge).toHaveBeenCalledTimes(1)
  })

  it('is never applied: the round brings the server’s copy, whatever the message said', async () => {
    const server = new FakeServer()
    server.seed(task('a', { title: 'Before' }))
    const d = device(server)
    await ready(d)
    const client = new FakeClient()
    watchRealtime({ client, engine: d.engine })
    client.current.up()
    await vi.advanceTimersByTimeAsync(NUDGE_MS)
    await idle(d)

    server.patch('a', { title: 'On the server', updatedAt: '2026-09-10T09:00:00.000Z' })
    client.current.change('UPDATE', row('a', '2026-09-10T09:00:00.000Z', { data: { kind: 'task', id: 'a', title: 'In the message', updatedAt: '2026-09-10T09:00:00.000Z' } }))
    // nothing until the round
    expect(d.item<Task>('a')!.title).toBe('Before')
    await vi.advanceTimersByTimeAsync(NUDGE_MS)
    await idle(d)
    expect(d.item<Task>('a')!.title).toBe('On the server')
  })

  it('this device’s own edit, pushed and coming back, runs no second round', async () => {
    const server = new FakeServer()
    server.seed(task('a'))
    const d = device(server)
    await ready(d)
    const client = new FakeClient()
    watchRealtime({ client, engine: d.engine })
    client.current.up()
    await vi.advanceTimersByTimeAsync(NUDGE_MS)
    await idle(d)
    d.engine.upsert({ ...d.item<Task>('a')!, title: 'Mine', updatedAt: '2026-09-10T10:00:05.000Z' })
    await vi.advanceTimersByTimeAsync(2000)
    await idle(d)
    const calls = server.calls.length
    // what the server now holds, as the channel reports it
    client.current.change('UPDATE', { id: 'a', user_id: 'user-1', data: { ...server.row<Task>('a')! } })
    await vi.advanceTimersByTimeAsync(NUDGE_MS)
    await idle(d)
    expect(server.calls.length).toBe(calls)
  })

  it('runs no round while the page is hidden', async () => {
    const server = new FakeServer()
    const d = device(server)
    await ready(d)
    const client = new FakeClient()
    watchRealtime({ client, engine: d.engine })
    client.current.up()
    await vi.advanceTimersByTimeAsync(NUDGE_MS)
    await idle(d)
    d.engine.setHidden(true)
    const calls = server.calls.length
    client.current.change('INSERT', row('b', '2026-09-10T10:00:01.000Z'))
    await vi.advanceTimersByTimeAsync(NUDGE_MS)
    expect(server.calls.length).toBe(calls)
  })
})

describe('the poll follows the channel', () => {
  it('five minutes while live; a minute again on an error, a timeout or a close', async () => {
    const server = new FakeServer()
    const d = device(server)
    await ready(d)
    d.engine.start()
    const client = new FakeClient()
    watchRealtime({ client, engine: d.engine })
    const poll = () => d.engine.inspect().pollMs
    expect(poll()).toBe(PERIODIC_MS)

    client.current.status('SUBSCRIBED')
    // joined, but the server has not said its subscription to the table is on
    expect(poll()).toBe(PERIODIC_MS)
    client.current.system('ok')
    expect(poll()).toBe(LIVE_PERIODIC_MS)

    for (const status of ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'] as const) {
      client.current.up()
      expect(poll()).toBe(LIVE_PERIODIC_MS)
      client.current.status(status)
      expect(poll()).toBe(PERIODIC_MS)
    }
  })

  it('a table missing from the publication — joined, and deaf — keeps the minute poll', async () => {
    const d = device(new FakeServer())
    await ready(d)
    d.engine.start()
    const client = new FakeClient()
    watchRealtime({ client, engine: d.engine })
    client.current.status('SUBSCRIBED')
    client.current.system('error')
    expect(d.engine.inspect().pollMs).toBe(PERIODIC_MS)
    // the server keeps trying; once the table is published it says so
    client.current.system('ok')
    expect(d.engine.inspect().pollMs).toBe(LIVE_PERIODIC_MS)
  })

  it('an error or a timeout is left to supabase-js to rejoin: a SUBSCRIBED on the same channel is live again', async () => {
    const client = new FakeClient()
    const engine = fakeEngine()
    const live = watchRealtime({ client, engine })
    client.current.up()
    client.current.status('CHANNEL_ERROR')
    expect(live.state()).toBe('down')
    expect(client.channels).toHaveLength(1)
    client.current.up()
    expect(live.state()).toBe('live')
    expect(engine.setLive.mock.calls.map(c => c[0])).toEqual([true, false, true])
  })

  it('a closed channel is opened again after 30 seconds, and later again if it keeps closing', async () => {
    const client = new FakeClient()
    watchRealtime({ client, engine: fakeEngine() })
    client.current.up()
    client.current.status('CLOSED')
    await vi.advanceTimersByTimeAsync(REOPEN_MS - 1)
    expect(client.channels).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(client.channels).toHaveLength(2)
    expect(client.channels[0].removed).toBe(true)
    client.current.status('CLOSED')
    await vi.advanceTimersByTimeAsync(REOPEN_MS)
    expect(client.channels).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(REOPEN_MS)
    expect(client.channels).toHaveLength(3)
  })
})

describe('coming and going', () => {
  it('on a return to the app, a channel that is down is opened afresh; one that is up, or coming up, is left alone', () => {
    const client = new FakeClient()
    const engine = fakeEngine()
    const live = watchRealtime({ client, engine })
    live.resume()
    expect(client.channels).toHaveLength(1)
    client.current.up()
    live.resume()
    expect(client.channels).toHaveLength(1)
    client.current.status('TIMED_OUT')
    live.resume()
    expect(client.channels).toHaveLength(2)
    expect(client.channels[0].removed).toBe(true)
    // the old channel's news is no longer news
    engine.setLive.mockClear()
    client.channels[0].up()
    expect(engine.setLive).not.toHaveBeenCalled()
    client.current.up()
    expect(engine.setLive).toHaveBeenCalledWith(true)
  })

  it('signing out closes the channel and slows nothing; signing in opens a new one', async () => {
    const client = new FakeClient()
    const engine = fakeEngine()
    const live = watchRealtime({ client, engine })
    client.current.up()
    await vi.advanceTimersByTimeAsync(NUDGE_MS)
    engine.nudge.mockClear()
    const first = client.current
    live.pause()
    expect(first.removed).toBe(true)
    expect(live.state()).toBe('paused')
    expect(last(engine.setLive.mock.calls)[0]).toBe(false)
    first.change('UPDATE', row('a', '2026-09-10T10:00:01.000Z'))
    await vi.advanceTimersByTimeAsync(NUDGE_MS)
    expect(engine.nudge).not.toHaveBeenCalled()

    live.resume()
    expect(client.channels).toHaveLength(2)
    client.current.up()
    expect(live.state()).toBe('live')
  })

  it('stopping — a new account, or the planner gone — closes it for good', async () => {
    const client = new FakeClient()
    const engine = fakeEngine()
    const live = watchRealtime({ client, engine })
    const ch = client.current
    live.stop()
    expect(ch.removed).toBe(true)
    ch.up()
    ch.change('UPDATE', row('a', '2026-09-10T10:00:01.000Z'))
    await vi.advanceTimersByTimeAsync(REOPEN_MS)
    live.resume()
    expect(engine.setLive).not.toHaveBeenCalled()
    expect(engine.nudge).not.toHaveBeenCalled()
    expect(client.channels).toHaveLength(1)
    expect(live.state()).toBe('stopped')
  })

  it('a browser with no socket to give keeps the minute poll, and says why', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const engine = fakeEngine()
    const client: LiveClient = {
      channel: () => {
        throw new Error('WebSocket not available')
      },
      removeChannel: async () => 'ok',
    }
    const live = watchRealtime({ client, engine })
    expect(live.state()).toBe('down')
    expect(engine.setLive).not.toHaveBeenCalled()
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
  })
})
