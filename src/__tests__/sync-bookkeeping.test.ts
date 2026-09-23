import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JOURNAL_KEY, KINDS_EPOCH } from '../syncengine'
import { CURSOR_KEY, DIRTY_KEY, FAILURES_KEY, KINDS_KEY } from '../syncstate'
import type { Task } from '../types'
import { FakeDisk, editTask, recordDevice, settle } from './record-fakes'
import { FakeServer, last, task } from './sync-fakes'

// The sync bookkeeping — the cursor, the dirty set, the refusals, the merge
// bases — is written in the same IndexedDB transaction as the records it
// covers, and the journal a page going away leaves carries it too.
//
// Before, the cursor went to localStorage the moment a round moved it, while
// the rows it moved past reached IndexedDB 300 ms later: an iPhone app killed
// in between skipped the partner's changes for good, and the next edit of one
// of those records overwrote the change it never saw. And the journal carried
// records without their merge bases, so an edit replayed from it went out as
// if the server had not changed since, and overwrote a partner's concurrent
// rename of the same record.

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-10T10:00:00.000Z') })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the cursor goes to disk with the rows it moved past', () => {
  it('a device killed after a round, before the rows were saved, pulls them again — and keeps the partner’s change', async () => {
    const server = new FakeServer()
    server.seed(task('z'), ...Array.from({ length: 12 }, (_, i) => task('q' + i)))
    const d1 = recordDevice(server)
    await settle(d1)
    // the partner renames z; then enough other writes land to carry the
    // cursor well past the 10 s overlap a delta pull asks for
    server.patch('z', { title: 'partner', updatedAt: '2026-09-10T09:59:00.000Z' })
    for (let i = 0; i < 12; i++) server.patch('q' + i, { title: 'q' + i + '!', updatedAt: '2026-09-10T09:59:30.000Z' })
    // the round the app runs on its way to the background…
    await d1.engine.sync()
    expect(d1.item<Task>('z')!.title).toBe('partner')
    // …and it is killed before the rows it brought reach IndexedDB
    const disk = d1.disk.copy()
    const kv = new Map(d1.kv)
    d1.engine.stop()

    const d2 = recordDevice(server, { disk, kv })
    await settle(d2)
    expect(d2.item<Task>('z')!.title).toBe('partner')
    editTask(d2, 'z', { description: 'mine' })
    await d2.engine.sync()
    expect(server.row<Task>('z')).toMatchObject({ title: 'partner', description: 'mine' })
  })

  it('writes the cursor, the dirty mark and the refusals in the same write as the records, and never to localStorage', async () => {
    const server = new FakeServer()
    server.seed(task('a'))
    const d = recordDevice(server)
    await settle(d)
    server.refuse.set('a', 'status not allowed')
    editTask(d, 'a', { title: 'Refused' })
    await vi.advanceTimersByTimeAsync(300)
    const w = last(d.disk.landed())
    expect(w.upserts.map(i => i.id)).toEqual(['a'])
    expect(w.sync).toMatchObject({ cursor: d.engine.inspect().cursor, kinds: KINDS_EPOCH, dirty: ['a'] })
    await vi.advanceTimersByTimeAsync(2_000)
    await d.engine.sync()
    await vi.advanceTimersByTimeAsync(300)
    expect(d.disk.meta!.sync!.failures).toEqual([expect.objectContaining({ id: 'a', reason: 'status not allowed', attempts: 1 })])
    for (const key of [CURSOR_KEY, DIRTY_KEY, FAILURES_KEY, KINDS_KEY]) expect(d.kv.has(key), key).toBe(false)
  })

  it('moves what an older build kept in localStorage beside the records once, and reads localStorage no more', async () => {
    const server = new FakeServer()
    server.seed(task('a'))
    const edited = task('a', { title: 'Edited on the older build', updatedAt: '2026-09-09T00:00:00.000Z' })
    const disk = FakeDisk.withRecords('user-1', [edited])
    const kv = new Map([
      [DIRTY_KEY, '["a"]'],
      [CURSOR_KEY, '2026-09-10T11:00:00.000Z'],
      [KINDS_KEY, KINDS_EPOCH],
    ])
    server.offline = true
    const d = recordDevice(server, { disk, kv })
    await settle(d)
    // written beside the records, and the old keys gone
    expect(disk.meta!.sync).toMatchObject({ dirty: ['a'], cursor: '2026-09-10T11:00:00.000Z', kinds: KINDS_EPOCH })
    expect([...kv.keys()].filter(k => k !== JOURNAL_KEY)).toEqual([])
    // a stray key an older tab writes later is not read over the records' own
    kv.set(DIRTY_KEY, '[]')
    kv.set(CURSOR_KEY, '2026-09-10T14:00:00.000Z')
    server.offline = false
    const again = recordDevice(server, { disk, kv })
    await settle(again)
    expect(server.row<Task>('a')!.title).toBe('Edited on the older build')
  })
})

describe('the journal a page going away leaves carries the merge bases', () => {
  it('an edit replayed from it is merged with the partner’s concurrent change, not written over it', async () => {
    const server = new FakeServer()
    server.seed(task('j'))
    const d1 = recordDevice(server)
    await settle(d1)
    // the partner renames it; this device has not pulled that yet
    server.patch('j', { title: 'partner', updatedAt: '2026-09-10T09:59:00.000Z' })
    server.offline = true
    editTask(d1, 'j', { description: 'mine' })
    // the page goes away: the journal is written at once, the IndexedDB write never lands
    d1.disk.hangWrites = true
    const disk = d1.disk.copy()
    d1.engine.flush()
    const kv = new Map(d1.kv)
    expect(JSON.parse(kv.get(JOURNAL_KEY)!)).toMatchObject({ v: 2, shadows: [expect.objectContaining({ id: 'j', title: 'j' })], sync: { dirty: ['j'] } })

    server.offline = false
    const d2 = recordDevice(server, { disk, kv })
    await settle(d2)
    await vi.advanceTimersByTimeAsync(2_500)
    await d2.engine.sync()
    expect(server.row<Task>('j')).toMatchObject({ title: 'partner', description: 'mine' })
    expect(d2.item<Task>('j')).toMatchObject({ title: 'partner', description: 'mine' })
  })

  it('holds what the write in progress carries, too: that is not on disk until it lands', async () => {
    const server = new FakeServer()
    server.seed(task('a'))
    const d = recordDevice(server)
    await settle(d)
    server.offline = true
    d.disk.hangWrites = true
    editTask(d, 'a', { title: 'Mid-write' })
    // the debounce starts the write; it is still under way when the page goes
    await vi.advanceTimersByTimeAsync(300)
    expect(d.engine.inspect().unsaved).toEqual([])
    d.engine.flush()
    const journal = JSON.parse(d.kv.get(JOURNAL_KEY)!)
    expect(journal.upserts).toEqual([expect.objectContaining({ id: 'a', title: 'Mid-write' })])
  })

  it('is thrown away whole once a later write has reached the cache', async () => {
    const server = new FakeServer()
    server.seed(task('a'), task('b'))
    const d = recordDevice(server)
    await settle(d)
    server.offline = true
    editTask(d, 'a', { title: 'Journalled' })
    d.engine.flush()
    const stale = d.kv.get(JOURNAL_KEY)!
    await vi.advanceTimersByTimeAsync(0)
    // the write landed and the journal went; then another edit, written too
    expect(d.kv.has(JOURNAL_KEY)).toBe(false)
    editTask(d, 'a', { title: 'Newer' })
    await vi.advanceTimersByTimeAsync(300)
    expect(d.disk.record<Task>('a')!.title).toBe('Newer')
    // an old journal turning up again (another tab's, a restore) changes nothing
    d.kv.set(JOURNAL_KEY, stale)
    d.engine.stop()
    const again = recordDevice(null, { disk: d.disk, kv: d.kv })
    await settle(again)
    expect(again.item<Task>('a')!.title).toBe('Newer')
    expect(again.kv.has(JOURNAL_KEY)).toBe(false)
  })

  it('too big to keep whole, keeps the edits and the cursor the cache already has, so nothing pulled is skipped', async () => {
    const server = new FakeServer()
    const long = 'x'.repeat(1_000)
    server.seed(task('mine'), ...Array.from({ length: 1_600 }, (_, i) => task('p' + i, { description: long })))
    const d1 = recordDevice(server)
    await settle(d1)
    const savedCursor = d1.disk.meta!.sync!.cursor
    // the partner changed all of them; the next round pulls them
    for (let i = 0; i < 1_600; i++) server.patch('p' + i, { title: 'p' + i + '!', updatedAt: '2026-09-10T09:59:00.000Z' })
    d1.disk.hangWrites = true
    await d1.engine.sync()
    editTask(d1, 'mine', { title: 'My edit' })
    const disk = d1.disk.copy()
    d1.engine.flush()
    const journal = JSON.parse(d1.kv.get(JOURNAL_KEY)!)
    expect(journal.upserts.map((i: Task) => i.id)).toEqual(['mine'])
    expect(journal.sync.cursor).toBe(savedCursor)

    const d2 = recordDevice(server, { disk, kv: new Map(d1.kv) })
    await settle(d2)
    await vi.advanceTimersByTimeAsync(2_500)
    await d2.engine.sync()
    expect(d2.item<Task>('p7')!.title).toBe('p7!')
    expect(server.row<Task>('mine')!.title).toBe('My edit')
  })
})
