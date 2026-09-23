import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifySyncFailure, syncNow, type SyncResult } from '../sync'
import { createSyncEngine } from '../syncengine'
import { FakeDisk } from './record-fakes'
import { FakeServer, task } from './sync-fakes'
import type { Item } from '../types'

// Any sync_posts error but an expired token read as "Offline — tap to retry":
// a statement timeout on a full exchange, a 500, said the connection was down
// while it worked. Network, server and session are told apart now, the
// server's own words reach Settings → Sync, and a local cache that will not
// write reaches the client error log instead of the console alone.

const rpcAnswer = vi.hoisted(() => ({ value: {} as { data?: unknown; error?: { message: string; code?: string } | null; status?: number } }))
vi.mock('../supabase', async importOriginal => ({
  ...(await importOriginal<typeof import('../supabase')>()),
  getSupabase: () => ({ rpc: async () => rpcAnswer.value }),
}))

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-10T10:00:00.000Z') })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('classifySyncFailure', () => {
  it('no answer at all, or a browser that knows it is offline, is the network', () => {
    expect(classifySyncFailure({ message: 'TypeError: Failed to fetch' }, 0)).toEqual({ problem: 'offline' })
    expect(classifySyncFailure({ message: 'boom' }, 500, false)).toEqual({ problem: 'offline' })
  })

  it('a 401 or a token PostgREST calls expired is the session', () => {
    expect(classifySyncFailure({ message: 'JWT expired', code: 'PGRST301' }, 401)).toEqual({ problem: 'auth' })
    expect(classifySyncFailure({ message: 'permission denied for function sync_posts', code: '42501' }, 401)).toEqual({ problem: 'auth' })
  })

  it('anything else is the server, with its own words', () => {
    expect(classifySyncFailure({ message: 'canceling statement due to statement timeout', code: '57014' }, 500)).toEqual({
      problem: 'server',
      message: 'canceling statement due to statement timeout',
    })
    expect(classifySyncFailure({ message: '' }, 503)).toEqual({ problem: 'server', message: 'The server answered 503' })
  })
})

describe('syncNow says which it was', () => {
  const offline = (r: SyncResult) => ({ items: r.items, authError: r.authError, problem: r.problem, message: r.message })

  it('a statement timeout is a server problem, not the session and not the network', async () => {
    rpcAnswer.value = { data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' }, status: 500 }
    expect(offline(await syncNow([], null))).toEqual({ items: null, authError: false, problem: 'server', message: 'canceling statement due to statement timeout' })
  })

  it('a failed fetch is the network; an expired token is the session', async () => {
    rpcAnswer.value = { data: null, error: { message: 'TypeError: Load failed' }, status: 0 }
    expect(offline(await syncNow([], null))).toMatchObject({ authError: false, problem: 'offline' })
    rpcAnswer.value = { data: null, error: { message: 'JWT expired', code: 'PGRST301' }, status: 401 }
    expect(offline(await syncNow([], null))).toMatchObject({ authError: true, problem: 'auth' })
  })

  it('an answer it cannot read is the server’s doing too', async () => {
    rpcAnswer.value = { data: 'nonsense', error: null, status: 200 }
    expect(offline(await syncNow([], null))).toMatchObject({ problem: 'server' })
  })
})

describe('the engine keeps what went wrong until a round goes through', () => {
  it('shows the server’s problem and message, and clears them on the next answer', async () => {
    const server = new FakeServer()
    server.seed(task('a'))
    let failing = true
    const rpc = async (outgoing: Item[], since: string | null): Promise<SyncResult> =>
      failing
        ? { items: null, rejected: [], reasons: {}, stale: [], gone: [], peerShared: null, peerNotes: null, authError: false, reportsRejections: false, problem: 'server', message: 'canceling statement due to statement timeout' }
        : server.rpc(outgoing, since)
    const disk = new FakeDisk()
    const engine = createSyncEngine({ rpc, storage: disk.storage(new Map()) })
    await engine.boot('user-1')
    await engine.sync()
    expect(engine.getState().syncInfo).toMatchObject({ online: false, authError: false, problem: 'server', message: 'canceling statement due to statement timeout' })
    failing = false
    await engine.sync()
    expect(engine.getState().syncInfo.online).toBe(true)
    expect(engine.getState().syncInfo.problem).toBeUndefined()
    expect(engine.getState().syncInfo.message).toBeUndefined()
  })

  it('a local cache that will not write is reported, not only logged', async () => {
    const reported: [string, string][] = []
    const disk = new FakeDisk()
    const engine = createSyncEngine({ rpc: null, storage: disk.storage(new Map()), report: (e, where) => void reported.push([String((e as Error).message), where]) })
    await engine.boot(null)
    disk.failWrites = 1
    engine.upsert(task('a', { updatedAt: '2026-09-10T10:00:00.001Z' }))
    await vi.advanceTimersByTimeAsync(300)
    expect(reported).toEqual([['QuotaExceededError', 'local cache']])
  })

  it('so is a cache that will not read, after its tries', async () => {
    const reported: string[] = []
    const disk = new FakeDisk()
    disk.failReads = 10
    const engine = createSyncEngine({ rpc: null, storage: disk.storage(new Map()), report: (_e, where) => void reported.push(where) })
    const booting = engine.boot(null)
    await vi.advanceTimersByTimeAsync(10_000)
    await booting
    expect(reported).toEqual(['local cache'])
    expect(engine.getState()).toMatchObject({ loaded: false, loadError: expect.stringMatching(/database is broken/) })
  })
})
