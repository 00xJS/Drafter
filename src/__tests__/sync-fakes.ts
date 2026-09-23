// Test doubles for the sync engine: a sync_posts that keeps rows in memory and
// answers in any of the shapes production has spoken, and a device (an
// engine plus its own storage). Not a test file itself — vitest collects only
// *.test.ts.
import { vi } from 'vitest'
import { PERSONAL_KINDS } from '../../shared/kinds.mts'
import { newerStamp } from '../itemops'
import { sanitizeItem } from '../schema'
import { parseSyncResponse, type SyncResult } from '../sync'
import { KINDS_EPOCH, createSyncEngine, type CacheRecord, type SyncStorage } from '../syncengine'
import { KINDS_KEY } from '../syncstate'
import { Item, Task } from '../types'

export type ServerShape = 'new' | 'v316' | 'old' | 'legacy'

/** The shapes that say what they refused: everything from v3.11 on. */
const reportsRejections = (shape: ServerShape) => shape === 'new' || shape === 'v316'

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
  /** Whose session is asking. Everything seeded without an owner is theirs. */
  caller = 'user-1'
  private rows = new Map<string, { data: Record<string, unknown>; updatedAt: string; syncedAt: string; owner: string }>()
  private tick = 0

  /**
   * RLS, as far as these tests need it: your own rows always, a household
   * peer's rows unless the record withholds itself — an unshared note (v3.16)
   * or a task marked private (v3.19). The real policy excludes the personal
   * kinds too; nothing here turns on that.
   */
  private visible(r: { data: Record<string, unknown>; owner: string }): boolean {
    if (r.owner === this.caller) return true
    if (r.data.kind === 'note') return r.data.shared === true
    if (r.data.kind === 'task' || r.data.kind === undefined) return r.data.shared !== false
    return true
  }

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
    this.seedAs(this.caller, ...items)
  }

  /** Seed rows belonging to somebody else — a household peer. */
  seedAs(owner: string, ...items: Item[]): void {
    for (const item of items) this.rows.set(item.id, { data: JSON.parse(JSON.stringify(item)), updatedAt: item.updatedAt, syncedAt: this.stamp(), owner })
  }

  /**
   * Hand a row to another account, as removing a household member does: the
   * leaver's shared work is re-attributed to the household's creator.
   */
  rehome(id: string, owner: string): void {
    const cur = this.rows.get(id)
    if (!cur) throw new Error(`rehome: no row ${id}`)
    this.rows.set(id, { ...cur, owner, syncedAt: this.stamp() })
  }

  /** Edit a stored row in place, as its owner would from another device. */
  patch(id: string, over: Record<string, unknown>): void {
    const cur = this.rows.get(id)
    if (!cur) throw new Error(`patch: no row ${id}`)
    const data = { ...cur.data, ...over }
    this.rows.set(id, { ...cur, data, updatedAt: (data.updatedAt as string) ?? cur.updatedAt, syncedAt: this.stamp() })
  }

  rpc = async (outgoing: Item[], since: string | null): Promise<SyncResult> => {
    const n = this.calls.push({ outgoing: JSON.parse(JSON.stringify(outgoing)), since })
    await this.beforeAnswer?.(n)
    if (this.offline) return { items: null, rejected: [], reasons: {}, stale: [], gone: [], peerShared: null, peerNotes: null, authError: false, reportsRejections: false }
    const rejected: unknown[] = []
    const stale: string[] = []
    const gone: string[] = []
    for (const raw of JSON.parse(JSON.stringify(outgoing)) as Record<string, unknown>[]) {
      const id = raw.id as string
      const why = this.refuse.get(id)
      if (why !== undefined) {
        rejected.push(reportsRejections(this.shape) ? { id, reason: why } : id)
        continue
      }
      if (this.purgedForGood.has(id) && reportsRejections(this.shape)) {
        gone.push(id)
        continue
      }
      delete raw.ownerId
      delete raw.syncedAt
      const cur = this.rows.get(id)
      // A row of a personal kind is its owner's alone: the policy hides it from
      // everyone else, so another account's write onto its id is refused, not merged.
      if (cur && cur.owner !== this.caller && PERSONAL_KINDS.has(String(cur.data.kind ?? 'task'))) {
        rejected.push(reportsRejections(this.shape) ? { id, reason: 'new row violates row-level security policy' } : id)
        continue
      }
      if (!cur || (raw.updatedAt as string) > cur.updatedAt) this.rows.set(id, { data: raw, updatedAt: raw.updatedAt as string, syncedAt: this.stamp(), owner: cur?.owner ?? this.caller })
      else stale.push(id)
    }
    const readable = [...this.rows.values()].filter(r => this.visible(r))
    const out = readable
      .filter(r => since === null || r.syncedAt > since || (reportsRejections(this.shape) && stale.includes(r.data.id as string)))
      .sort((a, b) => a.syncedAt.localeCompare(b.syncedAt))
      .map(r => ({ ...r.data, ownerId: r.owner, syncedAt: r.syncedAt }))
    // the whole visible set, cursor or no cursor — how withholding reaches a reader
    const peerVisible = (kinds: string[]) => readable.filter(r => r.owner !== this.caller && kinds.includes(String(r.data.kind ?? 'task'))).map(r => r.data.id as string)
    const peerNotes = peerVisible(['note'])
    const peerShared = peerVisible(['note', 'task'])
    // `shape: 'v316'` is a server that knows about notes and not tasks — the
    // window between the database being migrated and a phone being rebuilt
    const data =
      this.shape === 'legacy'
        ? out
        : this.shape === 'old'
          ? { items: out, rejected }
          : this.shape === 'v316'
            ? { items: out, rejected, stale, gone, peerNotes }
            : { items: out, rejected, stale, gone, peerNotes, peerShared }
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

/**
 * An engine with its own storage. Pass another device's kv and snapshot to "restart" it.
 *
 * The kv starts out holding this build's kinds list, as it would on any device
 * that has booted this build before, so a cursor handed in still means a delta
 * round. `kinds` overrides that: null for a device that never recorded one, or
 * an older build's list — either makes the first signed-in boot a full exchange.
 */
export function device(server: FakeServer | null, from?: { kv?: Map<string, string>; snapshot?: CacheRecord; kinds?: string | null }): Device {
  const kv = from?.kv ?? new Map<string, string>()
  if (from?.kinds === null) kv.delete(KINDS_KEY)
  else if (from?.kinds !== undefined) kv.set(KINDS_KEY, from.kinds)
  else if (!kv.has(KINDS_KEY)) kv.set(KINDS_KEY, KINDS_EPOCH)
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
