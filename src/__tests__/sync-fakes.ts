// Test doubles for the sync engine: a sync_posts that keeps rows in memory and
// answers in any of the three shapes production has spoken, and a device (an
// engine plus its own storage). Not a test file itself — vitest collects only
// *.test.ts.
import { vi } from 'vitest'
import { newerStamp } from '../itemops'
import { sanitizeItem } from '../schema'
import { parseSyncResponse, type SyncResult } from '../sync'
import { createSyncEngine, type CacheRecord, type SyncStorage } from '../syncengine'
import { Item, Task } from '../types'

export type ServerShape = 'new' | 'old' | 'legacy'

/**
 * sync_posts in memory, with the real rule: a row changes only when the
 * incoming updatedAt is strictly newer; an unchanged row keeps its synced_at
 * and is not echoed; rows newer than `since` come back.
 */
export class FakeServer {
  shape: ServerShape = 'new'
  offline = false
  /** Ids to refuse, with the reason the new shape reports. The legacy server drops them silently. */
  refuse = new Map<string, string>()
  /** Ids hard-deleted after their tombstone aged out (the new shape reports them as gone). */
  purgedForGood = new Set<string>()
  calls: { outgoing: Item[]; since: string | null }[] = []
  /** Runs before each call is answered: where another device writes mid-round. */
  beforeAnswer: ((callNumber: number) => void | Promise<void>) | null = null
  private rows = new Map<string, { data: Record<string, unknown>; updatedAt: string; syncedAt: string }>()
  private tick = 0

  private stamp(): string {
    this.tick++
    return new Date(Date.UTC(2026, 8, 10, 12, 0, 0) + this.tick * 1000).toISOString()
  }

  /** The row as the server holds it, sanitized the way a client would read it. */
  row<T extends Item = Item>(id: string): T | undefined {
    const r = this.rows.get(id)
    return r ? ((sanitizeItem(r.data) ?? undefined) as T | undefined) : undefined
  }

  seed(...items: Item[]): void {
    for (const item of items) this.rows.set(item.id, { data: JSON.parse(JSON.stringify(item)), updatedAt: item.updatedAt, syncedAt: this.stamp() })
  }

  rpc = async (outgoing: Item[], since: string | null): Promise<SyncResult> => {
    const n = this.calls.push({ outgoing: JSON.parse(JSON.stringify(outgoing)), since })
    await this.beforeAnswer?.(n)
    if (this.offline) return { items: null, rejected: [], reasons: {}, stale: [], gone: [], authError: false, reportsRejections: false }
    const rejected: unknown[] = []
    const stale: string[] = []
    const gone: string[] = []
    for (const raw of JSON.parse(JSON.stringify(outgoing)) as Record<string, unknown>[]) {
      const id = raw.id as string
      const why = this.refuse.get(id)
      if (why !== undefined) {
        rejected.push(this.shape === 'new' ? { id, reason: why } : id)
        continue
      }
      if (this.purgedForGood.has(id) && this.shape === 'new') {
        gone.push(id)
        continue
      }
      delete raw.ownerId
      delete raw.syncedAt
      const cur = this.rows.get(id)
      if (!cur || (raw.updatedAt as string) > cur.updatedAt) this.rows.set(id, { data: raw, updatedAt: raw.updatedAt as string, syncedAt: this.stamp() })
      else stale.push(id)
    }
    const out = [...this.rows.values()]
      .filter(r => since === null || r.syncedAt > since || (this.shape === 'new' && stale.includes(r.data.id as string)))
      .sort((a, b) => a.syncedAt.localeCompare(b.syncedAt))
      .map(r => ({ ...r.data, ownerId: 'user-1', syncedAt: r.syncedAt }))
    const data = this.shape === 'legacy' ? out : this.shape === 'old' ? { items: out, rejected } : { items: out, rejected, stale, gone }
    return { ...parseSyncResponse(data)!, authError: false }
  }
}

export interface Device {
  engine: ReturnType<typeof createSyncEngine>
  kv: Map<string, string>
  /** Every snapshot written to the fake IndexedDB, in order. */
  writes: CacheRecord[]
  snapshot(): CacheRecord | undefined
  cleared(): number
  item<T extends Item = Item>(id: string): T | undefined
}

/** An engine with its own storage. Pass another device's kv and snapshot to "restart" it. */
export function device(server: FakeServer | null, from?: { kv?: Map<string, string>; snapshot?: CacheRecord }): Device {
  const kv = from?.kv ?? new Map<string, string>()
  let snapshot: CacheRecord | undefined = from?.snapshot
  const writes: CacheRecord[] = []
  let cleared = 0
  const storage: SyncStorage = {
    readSnapshot: async () => snapshot,
    writeSnapshot: async record => {
      snapshot = JSON.parse(JSON.stringify(record))
      writes.push(snapshot!)
    },
    clearAll: async () => {
      snapshot = undefined
      kv.clear()
      cleared++
    },
    kv: {
      getItem: k => kv.get(k) ?? null,
      setItem: (k, v) => void kv.set(k, v),
      removeItem: k => void kv.delete(k),
    },
  }
  const engine = createSyncEngine({ rpc: server ? server.rpc : null, storage })
  return {
    engine,
    kv,
    writes,
    snapshot: () => snapshot,
    cleared: () => cleared,
    item: <T extends Item = Item>(id: string) => engine.getState().items.find(i => i.id === id) as T | undefined,
  }
}

/** The last element (the lib is ES2020, so no Array.prototype.at). */
export function last<T>(list: T[]): T {
  return list[list.length - 1]
}

/** Wait for the round in flight, if any, without starting one. */
export async function idle(d: Device): Promise<void> {
  if (d.engine.inspect().syncing) await d.engine.sync()
}

/** Boot, finish the first round, and let the boot's cache write land (needs fake timers). */
export async function ready(d: Device, userId: string | null = 'user-1'): Promise<void> {
  await d.engine.boot(userId)
  await idle(d)
  await vi.advanceTimersByTimeAsync(300)
}

/** A user's edit of a task: the fields, stamped newer than the copy it was made on. */
export function edit(d: Device, id: string, over: Partial<Task>): void {
  const cur = d.item<Task>(id)!
  d.engine.upsert({ ...cur, ...over, updatedAt: newerStamp(cur.updatedAt) })
}

export function task(id: string, over: Partial<Task> = {}): Task {
  return {
    kind: 'task',
    id,
    title: id,
    description: '',
    status: 'todo',
    priority: 'normal',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    tags: [],
    ...over,
  }
}
