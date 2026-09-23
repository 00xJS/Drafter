import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newerStamp } from '../itemops'
import { createSyncEngine, type SyncStorage } from '../syncengine'
import { CURSOR_KEY, DIRTY_KEY } from '../syncstate'
import { Person, Recipe, Task } from '../types'
import { FakeDisk, editTask, recordDevice, settle } from './record-fakes'
import { FakeServer, device, last, ready, task } from './sync-fakes'

// The local cache as one row per record: an edit writes the record it changed
// and nothing else, whatever path changed it — an edit, a round's answer, a
// purge, a tombstone aged out — and every write carries the account and the
// merge bases beside the records, in one transaction. The single value an
// older build wrote is moved over once, and removed only by the write that
// copied it.

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-10T10:00:00.000Z') })
})
afterEach(() => {
  vi.useRealTimers()
})

const T = '2026-09-01T00:00:00.000Z'
const recipe = (id: string, name = id): Recipe => ({ kind: 'recipe', id, name, ingredients: [], tags: [], createdAt: T, updatedAt: T }) as Recipe
const person = (id: string, name = id): Person => ({ kind: 'person', id, name, color: '#3b82f6', group: 'family', createdAt: T, updatedAt: T })
const ids = (list: { id: string }[]) => list.map(i => i.id).sort()
const onDisk = (disk: FakeDisk) => [...disk.records.keys()].sort()

describe('one edit, one record', () => {
  it('writes the record an edit changed, and nothing else', async () => {
    const server = new FakeServer()
    server.seed(task('a'), task('b'), task('c'), recipe('pasta'), person('mum'))
    const d = recordDevice(server)
    await settle(d)
    expect(onDisk(d.disk)).toEqual(['a', 'b', 'c', 'mum', 'pasta'])
    const writes = d.disk.writes.length

    editTask(d, 'b', { title: 'Buy paint' })
    await vi.advanceTimersByTimeAsync(300)
    expect(d.disk.writes.length).toBe(writes + 1)
    const w = last(d.disk.writes)
    expect(ids(w.upserts)).toEqual(['b'])
    expect(w.deletes).toEqual([])
    // the merge base goes in the same write as the edit it belongs to
    expect(w.shadows).toEqual([expect.objectContaining({ id: 'b', title: 'b' })])
    expect(d.disk.record<Task>('b')!.title).toBe('Buy paint')
    expect(d.disk.record<Task>('a')!.title).toBe('a')
  })

  it('a burst of typing is one write of that record', async () => {
    const server = new FakeServer()
    server.seed(task('a'), task('b'))
    const d = recordDevice(server)
    await settle(d)
    const writes = d.disk.writes.length
    for (const title of ['B', 'Bu', 'Buy', 'Buy p', 'Buy paint']) {
      editTask(d, 'a', { title })
      await vi.advanceTimersByTimeAsync(100)
    }
    await vi.advanceTimersByTimeAsync(300)
    expect(d.disk.writes.length).toBe(writes + 1)
    expect(ids(last(d.disk.writes).upserts)).toEqual(['a'])
    expect(d.disk.record<Task>('a')!.title).toBe('Buy paint')
  })

  it('a round that brings nothing writes nothing; one that brings a record writes that record', async () => {
    const server = new FakeServer()
    server.seed(task('a'), task('b'), recipe('pasta'))
    const d = recordDevice(server)
    await settle(d)
    const writes = d.disk.writes.length
    await d.engine.sync()
    await vi.advanceTimersByTimeAsync(300)
    expect(d.disk.writes.length).toBe(writes)

    // another device renames the recipe
    server.patch('pasta', { name: 'Pasta bake', updatedAt: '2026-09-10T09:00:00.000Z' })
    await d.engine.sync()
    await vi.advanceTimersByTimeAsync(300)
    expect(d.disk.writes.length).toBe(writes + 1)
    expect(ids(last(d.disk.writes).upserts)).toEqual(['pasta'])
    expect(d.disk.record<Recipe>('pasta')!.name).toBe('Pasta bake')
  })

  it('a record moved to the Trash is one record rewritten; Delete forever with no server is one record removed', async () => {
    const d = recordDevice(null)
    await settle(d, null)
    d.engine.upsert(task('a', { updatedAt: newerStamp() }))
    d.engine.upsert(task('b', { updatedAt: newerStamp() }))
    await vi.advanceTimersByTimeAsync(300)
    expect(onDisk(d.disk)).toEqual(['a', 'b'])

    d.engine.remove('a')
    await vi.advanceTimersByTimeAsync(300)
    expect(ids(last(d.disk.writes).upserts)).toEqual(['a'])
    expect(d.disk.record<Task>('a')!.deletedAt).toBeTruthy()

    const writes = d.disk.writes.length
    // written at once: a purge must survive the app being killed before the debounce
    expect(await d.engine.purge(['a'])).toBe(true)
    expect(d.disk.writes.length).toBe(writes + 1)
    expect(last(d.disk.writes)).toMatchObject({ upserts: [], deletes: ['a'] })
    expect(onDisk(d.disk)).toEqual(['b'])
  })

  it('Delete forever with a server writes the tombstone at once, as one record', async () => {
    const server = new FakeServer()
    server.seed(task('a'), task('b'))
    const d = recordDevice(server)
    await settle(d)
    server.offline = true
    const writes = d.disk.writes.length
    expect(await d.engine.purge(['a'])).toBe(false)
    expect(ids(d.disk.writes[writes].upserts)).toEqual(['a'])
    expect(d.disk.record<Task>('a')).toMatchObject({ purged: true, title: '' })
  })

  it('deletes the tombstones that aged out, and a row the server purged for good', async () => {
    const server = new FakeServer()
    server.purgedForGood.add('ancient')
    const old = task('old', { deletedAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' })
    const disk = FakeDisk.withRecords('user-1', [task('a'), old, task('ancient', { deletedAt: '2026-09-01T00:00:00.000Z' })])
    const d = recordDevice(server, {
      disk,
      kv: new Map([
        [DIRTY_KEY, '["ancient"]'],
        [CURSOR_KEY, '2026-09-10T13:00:00.000Z'],
      ]),
    })
    await settle(d)
    expect(d.item('old')).toBeUndefined()
    expect(d.item('ancient')).toBeUndefined()
    expect(onDisk(disk)).toEqual(['a'])
    // nothing but the deletions was written: the record that stayed is as it was
    expect(disk.landed().flatMap(w => w.upserts)).toEqual([])
  })
})

describe('the single value an older build left', () => {
  // an edit of `a` still waiting to go out, and the server's copy it was made on
  const OLD = { version: 3, userId: 'user-1', items: [task('a', { title: 'Paint the fence', updatedAt: '2026-09-02T00:00:00.000Z' }), task('b'), recipe('pasta')], shadows: [task('a')] }

  it('is moved over record by record on the first load, and removed by the same write', async () => {
    const server = new FakeServer()
    server.seed(task('a'), task('b'), recipe('pasta'))
    const disk = FakeDisk.withSnapshot(OLD)
    const kv = new Map([
      [DIRTY_KEY, '["a"]'],
      [CURSOR_KEY, '2026-09-10T13:00:00.000Z'],
    ])
    server.offline = true
    const d = recordDevice(server, { disk, kv })
    await d.engine.boot('user-1')
    await vi.advanceTimersByTimeAsync(0)
    // at once, not after the debounce
    expect(disk.snapshot).toBeUndefined()
    expect(onDisk(disk)).toEqual(['a', 'b', 'pasta'])
    const move = disk.landed()[0]
    expect(move).toMatchObject({ dropSnapshot: true, userId: 'user-1', deletes: [] })
    expect(ids(move.upserts)).toEqual(['a', 'b', 'pasta'])
    // the edit waiting to go out came across with its merge base
    expect(disk.record<Task>('a')!.title).toBe('Paint the fence')
    expect(disk.meta!.shadows).toEqual([expect.objectContaining({ id: 'a', title: 'a' })])

    // the next launch reads the records, and still pushes the edit
    server.offline = false
    const again = recordDevice(server, { disk, kv })
    await settle(again)
    expect(again.item<Task>('a')!.title).toBe('Paint the fence')
    expect(server.row<Task>('a')!.title).toBe('Paint the fence')
    expect(again.engine.inspect().dirty).toEqual([])
  })

  it('stays where it was when the move fails, and moves on the next try', async () => {
    const server = new FakeServer()
    server.seed(task('a'), task('b'), recipe('pasta'))
    const disk = FakeDisk.withSnapshot(OLD)
    disk.failWrites = 1
    const kv = new Map<string, string>()
    const d = recordDevice(server, { disk, kv })
    await d.engine.boot('user-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(disk.snapshot).toBeDefined()
    expect(disk.records.size).toBe(0)

    // killed here: the next launch reads the old value again, and moves it
    const again = recordDevice(server, { disk, kv })
    await settle(again)
    expect(disk.snapshot).toBeUndefined()
    expect(onDisk(disk)).toEqual(['a', 'b', 'pasta'])
  })

  it('a failed move is tried again in the same session, too', async () => {
    const server = new FakeServer()
    const disk = FakeDisk.withSnapshot(OLD)
    disk.failWrites = 1
    const d = recordDevice(server, { disk })
    await d.engine.boot('user-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(disk.snapshot).toBeDefined()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(disk.snapshot).toBeUndefined()
    expect(onDisk(disk)).toEqual(['a', 'b', 'pasta'])
  })

  it('from another account is wiped, never moved over or adopted', async () => {
    const server = new FakeServer()
    server.seed(task('mine'))
    const disk = FakeDisk.withSnapshot({ version: 3, userId: 'someone-else', items: [task('theirs')] })
    const d = recordDevice(server, { disk })
    await settle(d, 'user-1')
    expect(disk.cleared).toBe(1)
    expect(d.item('theirs')).toBeUndefined()
    expect(server.row('theirs')).toBeUndefined()
    expect(onDisk(disk)).toEqual(['mine'])
    expect(disk.meta!.userId).toBe('user-1')
  })

  it('the localStorage cache of the build before that moves over too, and its key goes once the records are written', async () => {
    const d = recordDevice(null, { kv: new Map([['drafter:v1', JSON.stringify([task('a'), task('b')])]]) })
    await d.engine.boot(null)
    await vi.advanceTimersByTimeAsync(0)
    expect(onDisk(d.disk)).toEqual(['a', 'b'])
    expect(d.kv.has('drafter:v1')).toBe(false)
  })
})

describe('accounts and a torn write', () => {
  it('a cache another account left is wiped, none of it pushed, and the new one is written under the new account', async () => {
    const server = new FakeServer()
    server.seed(task('mine'))
    const disk = FakeDisk.withRecords('someone-else', [task('theirs')], [task('theirs')])
    const d = recordDevice(server, {
      disk,
      kv: new Map([
        [DIRTY_KEY, '["theirs"]'],
        [CURSOR_KEY, '2026-09-09T00:00:00.000Z'],
      ]),
    })
    await settle(d, 'user-1')
    expect(disk.cleared).toBe(1)
    expect(server.row('theirs')).toBeUndefined()
    expect(onDisk(disk)).toEqual(['mine'])
    expect(disk.meta).toMatchObject({ userId: 'user-1', shadows: [] })
  })

  it('another account signing in on a running device: the next write removes every record of the last one, under the new account', async () => {
    const server = new FakeServer()
    // kept to user-1, so user-2's round cannot bring them back
    server.seed(task('a', { shared: false }), task('b', { shared: false }))
    const d = recordDevice(server)
    await settle(d, 'user-1')
    expect(onDisk(d.disk)).toEqual(['a', 'b'])
    server.caller = 'user-2'
    server.seedAs('user-2', task('theirs'))
    const from = d.disk.writes.length
    d.engine.signedIn('user-2')
    await vi.advanceTimersByTimeAsync(0)
    if (d.engine.inspect().syncing) await d.engine.sync()
    await vi.advanceTimersByTimeAsync(300)
    // every write since carries the new account; nothing of user-1 is left
    expect(onDisk(d.disk)).toEqual(['theirs'])
    expect(d.disk.meta!.userId).toBe('user-2')
    const after = d.disk.writes.slice(from)
    expect(after.length).toBeGreaterThan(0)
    expect(after.every(w => w.userId === 'user-2')).toBe(true)
    expect(after.flatMap(w => w.deletes).sort()).toEqual(['a', 'b'])
  })

  it('every write carries the account, and the merge base of every edit still to push', async () => {
    const server = new FakeServer()
    server.seed(task('a'), task('b'))
    const d = recordDevice(server)
    await settle(d)
    server.offline = true
    editTask(d, 'a', { title: 'Offline one' })
    await vi.advanceTimersByTimeAsync(300)
    editTask(d, 'b', { title: 'Offline two' })
    await vi.advanceTimersByTimeAsync(300)
    for (const w of d.disk.landed()) expect(w.userId).toBe('user-1')
    // the second write names only b, and still carries a's base beside it
    expect(ids(last(d.disk.writes).upserts)).toEqual(['b'])
    expect(ids(last(d.disk.writes).shadows)).toEqual(['a', 'b'])

    // a restart from this disk merges and pushes both
    server.offline = false
    const again = recordDevice(server, { disk: d.disk, kv: d.kv })
    await settle(again)
    expect(server.row<Task>('a')!.title).toBe('Offline one')
    expect(server.row<Task>('b')!.title).toBe('Offline two')
  })

  it('a write that fails loses nothing: the next one carries every record it had', async () => {
    const d = recordDevice(null)
    await settle(d, null)
    d.engine.upsert(task('a', { updatedAt: newerStamp() }))
    d.disk.failWrites = 1
    await vi.advanceTimersByTimeAsync(300)
    expect(d.disk.records.size).toBe(0)
    d.engine.upsert(task('b', { updatedAt: newerStamp() }))
    await vi.advanceTimersByTimeAsync(300)
    expect(ids(last(d.disk.writes).upserts)).toEqual(['a', 'b'])
    expect(onDisk(d.disk)).toEqual(['a', 'b'])
  })

  it('going to the background writes what a failed write left, even with no debounce waiting', async () => {
    const d = recordDevice(null)
    await settle(d, null)
    d.engine.upsert(task('a', { updatedAt: newerStamp() }))
    d.disk.failWrites = 1
    await vi.advanceTimersByTimeAsync(300)
    expect(d.disk.records.size).toBe(0)
    d.engine.flush()
    await vi.advanceTimersByTimeAsync(0)
    expect(onDisk(d.disk)).toEqual(['a'])
  })

  it('a cache whose read failed is replaced whole by the next write, so nothing stale outlives it', async () => {
    const server = new FakeServer()
    server.seed(task('a'))
    const disk = FakeDisk.withRecords('user-1', [task('stale')])
    disk.failRead = true
    const d = recordDevice(server, { disk })
    await settle(d)
    expect(disk.landed()[0]).toMatchObject({ replace: true })
    expect(onDisk(disk)).toEqual(['a'])
  })

  it('writes run one after another: an older write never lands over a newer one', async () => {
    const disk = new FakeDisk()
    const base = disk.storage(new Map())
    let hold = false
    let release = () => {}
    // a disk that keeps the first write it is handed waiting
    const storage: SyncStorage = {
      ...base,
      writeChanges: async change => {
        if (hold) {
          hold = false
          await new Promise<void>(r => (release = r))
        }
        return base.writeChanges!(change)
      },
    }
    const engine = createSyncEngine({ rpc: null, storage })
    await engine.boot(null)
    await vi.advanceTimersByTimeAsync(300)
    const from = disk.writes.length
    engine.upsert(task('a', { title: 'first', updatedAt: newerStamp() }))
    hold = true
    engine.flush()
    const a = engine.getState().items.find(i => i.id === 'a') as Task
    engine.upsert({ ...a, title: 'second', updatedAt: newerStamp(a.updatedAt) })
    engine.flush()
    await vi.advanceTimersByTimeAsync(0)
    // the second waits for the first, rather than landing under it
    expect(disk.writes.length).toBe(from)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(disk.writes.slice(from).map(w => w.upserts.map(u => (u as Task).title))).toEqual([['first'], ['second']])
    expect(disk.record<Task>('a')!.title).toBe('second')
  })
})

describe('the single-value storage still works', () => {
  it('a storage without the per-record calls gets the whole cache, rewritten, every time', async () => {
    const server = new FakeServer()
    server.seed(task('a'), task('b'), task('c'))
    const d = device(server)
    await ready(d)
    const writes = d.writes.length
    d.engine.upsert({ ...d.item<Task>('b')!, title: 'Buy paint', updatedAt: newerStamp(d.item<Task>('b')!.updatedAt) })
    await vi.advanceTimersByTimeAsync(300)
    expect(d.writes.length).toBe(writes + 1)
    expect(ids(last(d.writes).items)).toEqual(['a', 'b', 'c'])
    expect(last(d.writes).items.find(i => i.id === 'b')).toMatchObject({ title: 'Buy paint' })
  })
})
