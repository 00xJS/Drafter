import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KINDS_EPOCH } from '../syncengine'
import type { Task } from '../types'
import { FakeDisk, editTask, recordDevice, settle, type RecordDevice } from './record-fakes'
import { FakeServer, task } from './sync-fakes'

// A launch whose IndexedDB read failed came back as an empty cache, and boot
// took it for one: the dirty set was cleared for a full exchange and the next
// write emptied the records store. An edit made offline — on this device and
// nowhere else — was gone after one bad launch. A read that fails is now tried
// again, and until one succeeds nothing is shown, written, pushed or pulled:
// the planner says it cannot open the saved copy, and offers another try.

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-10T10:00:00.000Z') })
})
afterEach(() => {
  vi.useRealTimers()
})

/** Boot with the retries' waits run out. */
async function bootThrough(d: RecordDevice, userId: string | null = 'user-1'): Promise<void> {
  const booting = d.engine.boot(userId)
  await vi.advanceTimersByTimeAsync(10_000)
  await booting
  if (d.engine.inspect().syncing) await d.engine.sync()
  await vi.advanceTimersByTimeAsync(300)
}

/** A device that made an edit offline, then was closed: the disk and kv it leaves. */
async function editedOffline(server: FakeServer): Promise<{ disk: FakeDisk; kv: Map<string, string> }> {
  const d = recordDevice(server)
  await settle(d)
  server.offline = true
  editTask(d, 'a', { title: 'Offline edit' })
  await vi.advanceTimersByTimeAsync(300)
  expect(d.disk.record<Task>('a')!.title).toBe('Offline edit')
  d.engine.stop()
  return { disk: d.disk.copy(), kv: new Map(d.kv) }
}

describe('a launch whose cache read fails', () => {
  it('reads again, and the offline edit on the device still goes out', async () => {
    const server = new FakeServer()
    server.seed(task('a'), task('b'))
    const { disk, kv } = await editedOffline(server)
    // the relaunch: the first read throws (transient), the network is back
    disk.failRead = true
    server.offline = false
    const d = recordDevice(server, { disk, kv })
    await bootThrough(d)
    expect(disk.reads).toBe(2)
    expect(d.item<Task>('a')!.title).toBe('Offline edit')
    expect(server.row<Task>('a')!.title).toBe('Offline edit')
    expect(disk.record<Task>('a')!.title).toBe('Offline edit')
    expect(disk.record('b')).toBeDefined()
    expect(d.engine.inspect().dirty).toEqual([])
  })

  it('that keeps failing shows nothing and touches nothing — no write, no round — and says why', async () => {
    const server = new FakeServer()
    server.seed(task('a'), task('b'))
    const { disk, kv } = await editedOffline(server)
    server.offline = false
    disk.failReads = 100
    const writes = disk.writes.length
    const calls = server.calls.length
    const d = recordDevice(server, { disk, kv })
    await bootThrough(d)
    expect(d.engine.getState()).toMatchObject({ loaded: false, items: [], loadError: expect.stringMatching(/database is broken/) })
    // tried a few times, a moment apart, then stopped
    expect(disk.reads).toBe(4)
    // SIGNED_IN arrives on every tab focus: with nothing read, it decides nothing
    d.engine.signedIn('user-1')
    d.engine.flush()
    await d.engine.sync()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(disk.writes.length).toBe(writes)
    expect(server.calls.length).toBe(calls)
    expect(disk.record<Task>('a')!.title).toBe('Offline edit')
    expect(disk.meta!.sync!.dirty).toEqual(['a'])

    // Try again, once the database answers: everything is there, and goes out
    disk.failReads = 0
    await bootThrough(d)
    expect(d.engine.getState()).toMatchObject({ loaded: true, loadError: undefined })
    expect(server.row<Task>('a')!.title).toBe('Offline edit')
  })

  it('a failed read of an older build’s cache keeps the dirty set it left in localStorage too', async () => {
    const server = new FakeServer()
    server.seed(task('a'))
    // an older build: the edit on disk, its dirty mark and cursor in localStorage
    const disk = FakeDisk.withRecords('user-1', [task('a', { title: 'Edited on an older build', updatedAt: '2026-09-09T00:00:00.000Z' })])
    const kv = new Map([
      ['drafter:dirty-ids', '["a"]'],
      ['drafter:sync-cursor', '2026-09-10T13:00:00.000Z'],
      ['drafter:sync-kinds', KINDS_EPOCH],
    ])
    disk.failReads = 100
    const d = recordDevice(server, { disk, kv })
    await bootThrough(d)
    expect(d.engine.getState().loaded).toBe(false)
    expect(kv.get('drafter:dirty-ids')).toBe('["a"]')
    disk.failReads = 0
    await bootThrough(d)
    expect(server.row<Task>('a')!.title).toBe('Edited on an older build')
    // moved beside the records, and the old keys gone
    expect(kv.has('drafter:dirty-ids')).toBe(false)
    expect(disk.meta!.sync).toMatchObject({ dirty: [] })
  })
})
