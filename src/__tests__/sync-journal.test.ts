import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JOURNAL_KEY, type CacheChanges } from '../syncengine'
import type { Task } from '../types'
import { FakeDisk, editTask, recordDevice, settle } from './record-fakes'

// An edit made in the last moments before the page went away — a reload, the
// app swiped closed — was lost: the IndexedDB write the page started never
// committed. The records still unwritten now go into synchronous storage when
// the page goes away (flush), and the next boot lays them over the cache.

const STAMP = '2026-09-22T09:00:00.000Z'
const task = (id: string, title: string): Task => ({ kind: 'task', id, title, description: '', status: 'todo', priority: 'normal', tags: [], createdAt: STAMP, updatedAt: STAMP })

/** A disk whose writes never finish: the page is gone before IndexedDB commits. */
function dyingDisk(from: FakeDisk): FakeDisk {
  const disk = from
  const real = disk.storage.bind(disk)
  disk.storage = kv => ({ ...real(kv), writeChanges: (change: CacheChanges) => new Promise<void>(() => void disk.writes.push(change)) })
  return disk
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('an edit made just before the page goes away', () => {
  it('comes back on the next boot, though the IndexedDB write never committed', async () => {
    const disk = FakeDisk.withRecords('user-1', [task('t1', 'Buy paint')])
    const first = recordDevice(null, { disk })
    await settle(first)
    // from here on nothing reaches the disk: the page is about to die
    dyingDisk(disk)
    const dying = recordDevice(null, { disk, kv: first.kv })
    await settle(dying)
    editTask(dying, 't1', { title: 'Buy blue paint' })
    // the page hides and goes: flush runs, the write it starts never lands
    dying.engine.flush()
    expect(disk.record<Task>('t1')?.title).toBe('Buy paint')
    expect(first.kv.get(JOURNAL_KEY)).toContain('Buy blue paint')

    // a new page, a working disk
    const healed = new FakeDisk()
    healed.records = disk.records
    healed.meta = disk.meta
    const next = recordDevice(null, { disk: healed, kv: first.kv })
    await settle(next)
    expect(next.item<Task>('t1')?.title).toBe('Buy blue paint')
    // and it is written to the disk on this boot, which removes the journal
    expect(healed.record<Task>('t1')?.title).toBe('Buy blue paint')
    expect(first.kv.has(JOURNAL_KEY)).toBe(false)
  })

  it('never lets an older journal record win over a newer one on disk', async () => {
    const newer = { ...task('t1', 'Newer on disk'), updatedAt: '2026-09-22T10:00:00.000Z' }
    const disk = FakeDisk.withRecords('user-1', [newer])
    const kv = new Map<string, string>([[JOURNAL_KEY, JSON.stringify({ v: 1, userId: 'user-1', upserts: [task('t1', 'Older in journal')], deletes: [] })]])
    const d = recordDevice(null, { disk, kv })
    await settle(d)
    expect(d.item<Task>('t1')?.title).toBe('Newer on disk')
  })

  it('throws away a journal another account left, and one it cannot read', async () => {
    const disk = FakeDisk.withRecords('user-1', [task('t1', 'Mine')])
    const theirs = new Map<string, string>([[JOURNAL_KEY, JSON.stringify({ v: 1, userId: 'someone-else', upserts: [task('t1', 'Not mine')], deletes: [] })]])
    const d = recordDevice(null, { disk, kv: theirs })
    await settle(d)
    expect(d.item<Task>('t1')?.title).toBe('Mine')
    expect(theirs.has(JOURNAL_KEY)).toBe(false)

    const broken = new Map<string, string>([[JOURNAL_KEY, '{not json']])
    const e = recordDevice(null, { disk: FakeDisk.withRecords('user-1', [task('t1', 'Mine')]), kv: broken })
    await settle(e)
    expect(e.item<Task>('t1')?.title).toBe('Mine')
    expect(broken.has(JOURNAL_KEY)).toBe(false)
  })

  it('carries a deletion too', async () => {
    const disk = FakeDisk.withRecords('user-1', [task('t1', 'Keep'), task('t2', 'Purged')])
    const kv = new Map<string, string>([[JOURNAL_KEY, JSON.stringify({ v: 1, userId: 'user-1', upserts: [], deletes: ['t2'] })]])
    const d = recordDevice(null, { disk, kv })
    await settle(d)
    expect(d.item('t2')).toBeUndefined()
    expect(disk.record('t2')).toBeUndefined()
  })

  it('writes nothing when nothing is waiting', async () => {
    const d = recordDevice(null, { disk: FakeDisk.withRecords('user-1', [task('t1', 'Quiet')]) })
    await settle(d)
    d.engine.flush()
    expect(d.kv.has(JOURNAL_KEY)).toBe(false)
  })
})
