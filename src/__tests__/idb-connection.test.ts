import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeIndexedDB, type FakeIndexedDB } from './idb-fake'

// Every read and write opened a connection of its own, and one whose request
// failed was never closed. The page now keeps one connection, and lets it go
// whenever it cannot be trusted: sign-out's delete (or another tab's) wants
// the database, the browser closed it underneath the page, or a request on it
// failed. Each time, the next call opens a fresh one.

let fake: FakeIndexedDB
let idb: typeof import('../idb')

beforeEach(async () => {
  fake = installFakeIndexedDB()
  // the kept connection is the module's own: each test starts from none
  vi.resetModules()
  idb = await import('../idb')
})

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>
  delete g.indexedDB
  delete g.IDBKeyRange
})

describe('one IndexedDB connection for the page', () => {
  it('opens one connection for every read and write, however many and however close together', async () => {
    await idb.idbSet('media', 'a', { n: 1 })
    await Promise.all([idb.idbSet('media', 'b', { n: 2 }), idb.idbGet('media', 'a'), idb.idbAll('media')])
    await idb.idbDel('media', 'b')
    expect(await idb.idbGet('media', 'a')).toEqual({ n: 1 })
    expect(await idb.idbAll('media')).toEqual([{ n: 1 }])
    expect(fake.opened).toBe(1)
    expect(fake.connections.size).toBe(1)
  })

  it('opens once for reads that start together, before the first open has answered', async () => {
    await Promise.all([idb.idbGet('media', 'x'), idb.idbGet('meta', 'cache'), idb.readCacheSeq()])
    expect(fake.opened).toBe(1)
  })

  it('lets go of a connection the browser closed, and the next call opens another', async () => {
    await idb.idbSet('media', 'a', { n: 1 })
    fake.closeUnderneath()
    expect(await idb.idbGet('media', 'a')).toEqual({ n: 1 })
    expect(fake.opened).toBe(2)
  })

  it('replaces, once, a connection the browser closed without a word', async () => {
    await idb.idbSet('media', 'a', { n: 1 })
    // no close event: the next transaction is refused, and asked of a fresh connection
    fake.closeUnderneath({ silently: true })
    expect(await idb.idbGet('media', 'a')).toEqual({ n: 1 })
    expect(fake.opened).toBe(2)
  })

  it('closes a connection whose request failed, and the next call opens another', async () => {
    await idb.idbSet('media', 'a', { n: 1 })
    fake.failNextRequest()
    await expect(idb.idbGet('media', 'a')).rejects.toThrow(/Connection to Indexed Database server lost/)
    // the failed connection is closed, not left open
    await vi.waitFor(() => expect([...fake.connections].filter(db => !db.closing)).toHaveLength(0))
    expect(await idb.idbGet('media', 'a')).toEqual({ n: 1 })
    expect(fake.opened).toBe(2)
  })

  it('closes a connection whose transaction failed, as the cache writes it', async () => {
    await idb.idbSet('meta', 'cache', { version: 1, userId: 'u', shadows: [], seq: 4 })
    fake.failNextRequest()
    await expect(idb.writeHandoffs([{ id: 't1', hid: 'h1' } as never])).rejects.toThrow()
    expect(await idb.readCacheSeq()).toBe(4)
    expect(fake.opened).toBe(2)
  })

  it('opens again after an open that failed', async () => {
    const real = fake.open.bind(fake)
    let refuse = true
    fake.open = (name: string, version: number) => {
      if (!refuse) return real(name, version)
      refuse = false
      throw new Error('refused')
    }
    await expect(idb.idbGet('media', 'a')).rejects.toThrow('refused')
    await idb.idbSet('media', 'a', { n: 1 })
    expect(await idb.idbGet('media', 'a')).toEqual({ n: 1 })
    expect(fake.opened).toBe(1)
  })
})

describe('the database can still be deleted while the page holds it open', () => {
  it('sign-out deletes it past the page’s own connection, and what is written after lands in a fresh one', async () => {
    await idb.idbSet('media', 'photo', { n: 1 })
    await idb.idbSet('records', 't1', { id: 't1' })
    expect(fake.connections.size).toBe(1)
    await idb.clearLocalData()
    // the delete never waited on this page
    expect(fake.blocked).toBe(0)
    expect(fake.connections.size).toBe(0)
    expect(await idb.idbGet('media', 'photo')).toBeUndefined()
    expect(await idb.idbGet('records', 't1')).toBeUndefined()
    await idb.idbSet('media', 'next', { n: 2 })
    expect(await idb.idbAll('media')).toEqual([{ n: 2 }])
  })

  it('another tab’s delete (or upgrade) is not held up: the connection closes when asked', async () => {
    await idb.idbSet('media', 'photo', { n: 1 })
    await new Promise<void>((resolve, reject) => {
      const req = fake.deleteDatabase('drafter')
      req.onsuccess = () => resolve()
      req.onblocked = () => reject(new Error('the delete was blocked by the page’s connection'))
    })
    expect(fake.connections.size).toBe(0)
    expect(await idb.idbGet('media', 'photo')).toBeUndefined()
    expect(fake.opened).toBe(2)
  })

  it('a delete that lands while a read is opening does not leave that read on a dead connection', async () => {
    const reading = idb.idbGet('media', 'photo')
    const wiping = idb.clearLocalData()
    await expect(reading).resolves.toBeUndefined()
    await wiping
    expect(await idb.idbGet('media', 'photo')).toBeUndefined()
  })
})
