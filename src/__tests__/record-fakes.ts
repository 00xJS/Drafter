// A stand-in for the app's per-record IndexedDB cache (src/idb.ts): records by
// id, the meta row beside them, and the single value an older build left. A
// write lands whole or not at all, as one IndexedDB transaction does. Not a
// test file itself — vitest collects only *.test.ts.
import { vi } from 'vitest'
import { newerStamp } from '../itemops'
import { KINDS_EPOCH, createSyncEngine, type CacheChanges, type CacheRecord, type Handoff, type SyncStorage } from '../syncengine'
import { createLeadership, type Leadership } from '../synclead'
import { KINDS_KEY, type SyncBookkeeping } from '../syncstate'
import { Item, Task } from '../types'
import type { Device, FakeServer } from './sync-fakes'

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T))

export class FakeDisk {
  records = new Map<string, Item>()
  meta: { version: number; userId: string | null; shadows: Item[]; sync?: SyncBookkeeping; seq?: number } | null = null
  /** The single value (posts/'all') of a build before the per-record cache. */
  snapshot: CacheRecord | undefined = undefined
  /** Edits a tab that does not sync handed over, by record id (meta's handoff:<id> rows). */
  outbox = new Map<string, Handoff>()
  /** Every write asked for, in order — the ones that failed included. */
  writes: CacheChanges[] = []
  /** Refuse this many writes from now on, as a full disk does. */
  failWrites = 0
  /** Writes from now on never finish: the page is gone before IndexedDB commits. */
  hangWrites = false
  /** Throw on the next read, as a broken database does. */
  failRead = false
  /** Throw on this many reads from now on. */
  failReads = 0
  /** Every read asked for, the ones that failed included. */
  reads = 0
  cleared = 0

  /** The v2 value an older build left, and nothing in the per-record stores. */
  static withSnapshot(snapshot: CacheRecord): FakeDisk {
    const disk = new FakeDisk()
    disk.snapshot = clone(snapshot)
    return disk
  }

  /** Records already moved over, under this account (with no bookkeeping beside them, as an older build left it, unless given). */
  static withRecords(userId: string | null, items: Item[], shadows: Item[] = [], sync?: SyncBookkeeping, seq?: number): FakeDisk {
    const disk = new FakeDisk()
    for (const item of items) disk.records.set(item.id, clone(item))
    disk.meta = { version: 3, userId, shadows: clone(shadows), sync: clone(sync), seq }
    return disk
  }

  /** A copy of this disk as it is now: what a page killed at this moment leaves behind. */
  copy(): FakeDisk {
    const disk = new FakeDisk()
    for (const [id, item] of this.records) disk.records.set(id, clone(item))
    disk.meta = clone(this.meta)
    disk.snapshot = clone(this.snapshot)
    for (const [id, h] of this.outbox) disk.outbox.set(id, clone(h))
    return disk
  }

  /** The writes that landed. */
  landed(): CacheChanges[] {
    return this.writes.filter(w => !(w as { failed?: boolean }).failed)
  }

  record<T extends Item = Item>(id: string): T | undefined {
    return this.records.get(id) as T | undefined
  }

  storage(kv: Map<string, string>): SyncStorage {
    return {
      readAll: async () => {
        this.reads++
        if (this.failRead || this.failReads > 0) {
          if (this.failRead) this.failRead = false
          else this.failReads--
          throw new Error('UnknownError: the database is broken')
        }
        if (this.records.size === 0 && !this.meta && this.outbox.size === 0) return undefined
        return {
          version: this.meta?.version ?? 0,
          userId: this.meta ? this.meta.userId : undefined,
          items: clone([...this.records.values()]),
          shadows: clone(this.meta?.shadows ?? []),
          sync: clone(this.meta?.sync),
          seq: this.meta?.seq,
          outbox: clone([...this.outbox.values()]),
        }
      },
      writeChanges: async change => {
        const copy = clone(change)
        this.writes.push(copy)
        if (this.hangWrites) {
          ;(copy as { failed?: boolean }).failed = true
          return new Promise<void>(() => {})
        }
        if (this.failWrites > 0) {
          this.failWrites--
          ;(copy as { failed?: boolean }).failed = true
          throw new Error('QuotaExceededError')
        }
        for (const id of change.deletes) this.records.delete(id)
        for (const item of change.upserts) this.records.set(item.id, clone(item))
        this.meta = { version: change.version, userId: change.userId, shadows: clone(change.shadows), sync: clone(change.sync), seq: change.seq }
        for (const done of change.handoffsDone ?? []) if (this.outbox.get(done.id)?.hid === done.hid) this.outbox.delete(done.id)
        if (change.dropSnapshot) this.snapshot = undefined
      },
      readRecords: async ids => clone(ids.map(id => this.records.get(id)).filter((i): i is Item => !!i)),
      readSeq: async () => this.meta?.seq ?? null,
      writeHandoffs: async entries => {
        if (this.failWrites > 0) {
          this.failWrites--
          throw new Error('QuotaExceededError')
        }
        for (const h of entries) this.outbox.set(h.id, clone(h))
      },
      readOutbox: async () => {
        const entries = clone([...this.outbox.values()])
        return { entries, records: clone(entries.map(h => this.records.get(h.id)).filter((i): i is Item => !!i)) }
      },
      readSnapshot: async () => clone(this.snapshot),
      writeSnapshot: async () => {
        throw new Error('the per-record cache never writes the single value')
      },
      clearAll: async () => {
        this.records.clear()
        this.meta = null
        this.snapshot = undefined
        kv.clear()
        this.cleared++
      },
      kv: {
        getItem: k => kv.get(k) ?? null,
        setItem: (k, v) => void kv.set(k, v),
        removeItem: k => void kv.delete(k),
      },
    }
  }
}

export interface RecordDevice extends Omit<Device, 'writes' | 'snapshot' | 'cleared'> {
  disk: FakeDisk
}

/** An engine over a FakeDisk. Pass another device's disk and kv to "restart" it; pass a tab's leadership to share them. */
export function recordDevice(server: FakeServer | null, from?: { disk?: FakeDisk; kv?: Map<string, string>; leadership?: Leadership }): RecordDevice {
  const kv = from?.kv ?? new Map<string, string>()
  if (!kv.has(KINDS_KEY)) kv.set(KINDS_KEY, KINDS_EPOCH)
  const disk = from?.disk ?? new FakeDisk()
  const engine = createSyncEngine({ rpc: server ? server.rpc : null, storage: disk.storage(kv), leadership: from?.leadership })
  return {
    engine,
    kv,
    disk,
    item: <T extends Item = Item>(id: string) => engine.getState().items.find(i => i.id === id) as T | undefined,
  }
}

/** Boot, finish the first round, and let the cache writes land (needs fake timers). */
export async function settle(d: Pick<RecordDevice, 'engine'>, userId: string | null = 'user-1'): Promise<void> {
  await d.engine.boot(userId)
  if (d.engine.inspect().syncing) await d.engine.sync()
  await vi.advanceTimersByTimeAsync(300)
}

/** A user's edit of a task, stamped newer than the copy it was made on. */
export function editTask(d: Pick<RecordDevice, 'engine' | 'item'>, id: string, over: Partial<Task>): void {
  const cur = d.item<Task>(id)!
  d.engine.upsert({ ...cur, ...over, updatedAt: newerStamp(cur.updatedAt) })
}

/**
 * The browser's tabs of one origin, as far as the syncing tab needs them: one
 * Web Lock and one BroadcastChannel, shared. A message reaches every other
 * tab a moment later, cloned; a tab that closes lets go of the lock and its
 * place in line, and the next one waiting gets it.
 */
export class FakeTabs {
  private holder: string | null = null
  private line: { tab: string; grant: () => void }[] = []
  private hears = new Map<string, ((e: { data: unknown }) => void)[]>()
  private shown = new Map<string, boolean>()
  /** Every message sent, in order. */
  sent: { type: string; from: string }[] = []

  /** A tab's own leadership. Starts in view unless told otherwise. */
  tab(id: string, visible = true): Leadership {
    this.shown.set(id, visible)
    this.hears.set(id, [])
    return createLeadership({
      id,
      visible: () => this.shown.get(id) ?? false,
      channel: {
        postMessage: msg => {
          this.sent.push(msg as { type: string; from: string })
          const copy = JSON.parse(JSON.stringify(msg))
          for (const [other, listeners] of this.hears) {
            if (other === id) continue
            for (const l of listeners) void Promise.resolve().then(() => l({ data: copy }))
          }
        },
        addEventListener: (_type, cb) => void this.hears.get(id)?.push(cb),
      },
      locks: {
        request: (_name, opts, cb) =>
          new Promise((resolve, reject) => {
            // as a browser does, the callback runs a moment after the lock is granted
            const run = () => {
              this.holder = id
              void Promise.resolve()
                .then(() => cb({ name: 'drafter-sync' }))
                .then(v => {
                  if (this.holder === id) {
                    this.holder = null
                    this.next()
                  }
                  resolve(v)
                })
            }
            if (opts.ifAvailable) {
              if (this.holder === null) run()
              else
                void Promise.resolve()
                  .then(() => cb(null))
                  .then(resolve)
              return
            }
            if (this.holder === null) return run()
            const entry = { tab: id, grant: run }
            this.line.push(entry)
            opts.signal?.addEventListener('abort', () => {
              this.line = this.line.filter(e => e !== entry)
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            })
          }),
        query: async () => ({ held: this.holder ? [{ name: 'drafter-sync' }] : [], pending: this.line.map(() => ({ name: 'drafter-sync' })) }),
      },
    })
  }

  private next(): void {
    const entry = this.line.shift()
    if (entry) entry.grant()
  }

  /** Who holds the lock. */
  leader(): string | null {
    return this.holder
  }

  setVisible(id: string, visible: boolean): void {
    this.shown.set(id, visible)
  }

  /** The tab went away: its lock is let go, it waits in line no more, and it hears nothing. */
  close(id: string): void {
    this.hears.delete(id)
    this.line = this.line.filter(e => e.tab !== id)
    if (this.holder === id) {
      this.holder = null
      this.next()
    }
  }
}
