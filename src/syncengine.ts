import { Item, Note, Project, SOCIAL_PROJECT_ID, Task, TaskStatus } from './types'
import { KNOWN_KINDS, migrateStored, sanitizeItem, STORAGE_VERSION } from './schema'
import { applySync, duplicateSpawnPairs, mergeItems, newerStamp, nextOccurrence, pullSince, purgeTombstones, revokedPeerRows, type SyncConflict } from './itemops'
import { applyLocalChoice, sameContent } from '../shared/merge.mts'
import { withPaidDefault } from './bills'
import { uid } from './utils'
import { peerVisibleByKind, purgeTombstone, type SyncResult } from './sync'
import { NO_BOOKKEEPING, forgetLegacyBookkeeping, parseBookkeeping, readLegacyBookkeeping, type KV, type SyncBookkeeping, type SyncFailure } from './syncstate'

// The sync engine: everything that keeps this device's records and the
// server's in step, as a plain module with its world injected — the RPC, the
// clock, the storage and the timers — so every rule below runs under a test
// with fake timers and a fake server. It used to live inside the useItems hook,
// where the dirty set, the cursor and the round orchestration sat in React
// state and effects, side effects ran inside state updaters, and a ref could
// hand a round a stale list. store.ts is now only the React adapter over this.

const LEGACY_LS_KEY = 'drafter:v1' // pre-IndexedDB builds
/** Records a page going away had not written to IndexedDB yet (see writeJournal). A drafter:* key, so sign-out wipes it. */
export const JOURNAL_KEY = 'drafter:unsaved-journal'

interface Journal {
  /** 1: records only (the build before the bookkeeping moved beside them). 2: the bookkeeping too. */
  v: 1 | 2
  userId: string | null
  upserts: Item[]
  deletes: string[]
  /** v2: how many writes had been started when it was taken. A cache a later write reached is newer than all of it. */
  seq?: number
  /** v2: the merge base of every dirty record — a replayed edit without one would overwrite a partner's concurrent change. */
  shadows?: Item[]
  /** v2: the cursor, the dirty set and the refusals, as they were when the page went away. */
  sync?: SyncBookkeeping
}
/** The IndexedDB write waits this long after the last change, off the render hot path. */
const PERSIST_MS = 300
/** A cache write that failed is tried again this long after, if nothing else writes first. */
const PERSIST_RETRY_MS = 5_000
/** A local edit is pushed this long after the last one, so a burst of typing is one round. */
const PUSH_MS = 2000
/** The periodic round, while nothing tells this device that something changed. */
export const PERIODIC_MS = 60_000
/**
 * The periodic round while a live channel does (src/realtime.ts): a safety net
 * for what a channel cannot carry — a record withheld from this reader sends
 * them no change — not the way changes arrive.
 */
export const LIVE_PERIODIC_MS = 5 * 60_000
const BACKOFF_BASE_MS = 30_000
const BACKOFF_CAP_MS = 30 * 60_000
/** The kinds this build syncs, as the bookkeeping records them beside the cursor: when the stored list differs, boot does one full exchange. */
export const KINDS_EPOCH = [...KNOWN_KINDS].sort().join(',')

/** How long a row refused `attempts` times in a row waits before the next try: 30s, 1m, 2m … capped at 30 min. */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1))
}

export interface SyncInfo {
  online: boolean
  lastAt?: string
  /** The session is expired/invalid — the fix is signing in, not waiting. */
  authError: boolean
  /** Changes waiting to push (dirty set size, refused rows included). Never set in local mode. */
  pending?: number
  /** Ids the server rejected on the last round (validation/RLS) — still dirty, retried with backoff. */
  rejected?: string[]
}

export interface ImportSummary {
  added: number
  updated: number
  unchanged: number
  metricsRefreshed: number
}

export interface StatusChange {
  prev: Task
  /**
   * The task as it was stored, carrying the stamp the edit actually wrote.
   * A mirror (the GitHub Projects board) has to push *this*, not `prev` with a
   * status patched onto it: the board's freshness guard compares its row's
   * updatedAt against the task's, so pushing the pre-edit stamp makes every
   * push after the first one look stale and get dropped.
   */
  next: Task
  spawnedId?: string
}

/** A concurrent edit that beat one of ours, named for the toast that offers it back. */
export interface EngineConflict extends SyncConflict {
  /** The record as this device knew it: “Buy paint”. */
  label: string
}

/** The IndexedDB cache record. */
export interface CacheRecord {
  version: number
  userId?: string | null
  items: Item[]
  /** The merge base of each dirty record, written with the items so the two can never disagree. */
  shadows?: Item[]
  /**
   * The cursor, the dirty set and the refusals, written with the records they
   * cover. Absent in a cache an older build wrote: it kept them in localStorage.
   */
  sync?: SyncBookkeeping
  /** Which write this was, counting up from the first: orders the unload journal against the cache. */
  seq?: number
}

/**
 * One write of the per-record cache: what changed since the last one. The
 * storage applies it whole or not at all (one IndexedDB transaction), and
 * rejects when it did not — the engine then keeps every id for the next write.
 */
export interface CacheChanges {
  /** The account the records belong to, written beside them so another never adopts them. */
  userId: string | null
  version: number
  /** Records new or changed since the last write. */
  upserts: Item[]
  /** Ids this device no longer holds. */
  deletes: string[]
  /** The merge base of every dirty record — the whole set, each write, beside the records it belongs to. */
  shadows: Item[]
  /**
   * The cursor, the dirty set and the refusals, whole, each write. In the same
   * transaction as the records: a cursor saved ahead of the rows it moved past
   * skipped a partner's changes for good when the app was killed in between.
   */
  sync: SyncBookkeeping
  /** Counts up with every write: the journal a page going away leaves says which write it came after. */
  seq: number
  /** Remove the single value of an older build in the same transaction: set on the write that moves it over. */
  dropSnapshot?: boolean
}

export interface SyncStorage {
  /**
   * The single-value cache: every record in one value, rewritten whole. What
   * an older build left behind, and the whole cache for a storage without the
   * per-record calls below (the tests' own fakes).
   */
  readSnapshot(): Promise<unknown>
  writeSnapshot(record: CacheRecord): Promise<unknown>
  /**
   * The per-record cache as one CacheRecord (the shape readSnapshot gives), or
   * undefined when nothing was ever written to it — then the single value is
   * read, and the first write moves it over and removes it.
   */
  readAll?(): Promise<CacheRecord | undefined>
  /** Write only what changed; with readAll, replaces the single value as the cache. */
  writeChanges?(changes: CacheChanges): Promise<unknown>
  /** Wipe every trace of an account from this device (clearLocalData in the app). */
  clearAll(): Promise<void>
  /**
   * Small and synchronous (localStorage): the journal a page going away
   * leaves, and — read once, from a device an older build ran on — the
   * bookkeeping that build kept here.
   */
  kv: KV
}

/** What boot read, and where from (loadCache). */
interface LoadedCache {
  items: Item[]
  shadows: Item[]
  /** The cache belonged to another account and was wiped. */
  wiped: boolean
  from: 'records' | 'snapshot' | 'none'
  /** Every id the per-record cache holds (from 'records'). */
  ids: Set<string>
  /** The account the cache says it belongs to. */
  owner?: string | null
  /** The records came from the pre-IndexedDB localStorage cache. */
  legacy: boolean
  /** The bookkeeping written beside the records; null when the cache predates it (localStorage holds it then). */
  sync: SyncBookkeeping | null
  /** The last write that reached the cache (0: none counted). */
  seq: number
}

export interface SyncTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export interface SyncEngineDeps {
  /** The sync_posts round trip, or null in local mode — no backend, nothing to sync, nothing "unsynced". */
  rpc: ((outgoing: Item[], since: string | null) => Promise<SyncResult>) | null
  storage: SyncStorage
  /** Epoch ms; backoff, deletions and "last synced" read it. Stamps use newerStamp (Date.now). */
  now?: () => number
  timers?: SyncTimers
}

/** The records of each kind, in `items` order. */
export type KindLists = { readonly [K in Item['kind']]: readonly Extract<Item, { kind: K }>[] }

export interface EngineState {
  items: Item[]
  /**
   * `items` by kind. A kind's array is replaced only when a record of that
   * kind changed, so a list drawn from recipes (store.ts) is handed the same
   * array, and keeps its own identity, while tasks are edited and synced.
   */
  byKind: KindLists
  /** False until the local cache has been read (avoids empty-state flashes). */
  loaded: boolean
  /**
   * Why the local cache could not be read, after a few tries. Nothing is
   * shown, written, pushed or pulled until it can be: an empty planner over
   * a cache that is really there would be written over it, unsynced edits and
   * all. The planner says so, and offers another try (boot again).
   */
  loadError?: string
  syncInfo: SyncInfo
  /** Rows the server refused, oldest refusal first. */
  failures: SyncFailure[]
}

const NONE: readonly never[] = Object.freeze([])
const KINDS = [...KNOWN_KINDS] as Item['kind'][]
const NO_LISTS = Object.freeze(Object.fromEntries(KINDS.map(k => [k, NONE]))) as unknown as KindLists

/**
 * `prev` with the arrays of `kinds` drawn again from `items` (every kind when
 * null), in one pass. Every other kind keeps the very array it had.
 */
export function groupByKind(items: readonly Item[], kinds: ReadonlySet<Item['kind']> | null, prev: KindLists = NO_LISTS): KindLists {
  const fresh = new Map<Item['kind'], Item[]>()
  for (const k of kinds ?? KINDS) fresh.set(k, [])
  for (const i of items) fresh.get(i.kind)?.push(i)
  const next: Record<string, readonly Item[]> = { ...prev }
  for (const [k, list] of fresh) next[k] = list.length > 0 ? list : NONE
  return next as unknown as KindLists
}

const defaultTimers: SyncTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: h => globalThis.clearTimeout(h as number),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: h => globalThis.clearInterval(h as number),
}

/**
 * A blocked task moves to To do when the edit that takes its last blocker out
 * of the way lands — ticked off, or sent to the Trash — that edit and no
 * other. `completed` holds the tasks this edit did that to; a task none of
 * whose blockers is among them is left as it is.
 *
 * It used to run over every blocked task on every edit, and read a blocker
 * this device does not hold as out of the way. A housemate's private task is
 * exactly such a blocker: invisible on the other member's device, so any edit
 * there — a rename, a tick somewhere else — flipped the shared task to To do
 * under a new stamp, and the release went out to every device. A blocker this
 * device does not hold is not known to be done, so it still blocks; one it
 * holds in the Trash no longer does.
 */
function releaseBlocked(list: Item[], completed: readonly string[]): Item[] {
  if (completed.length === 0) return list
  const tasks = new Map<string, Task>()
  for (const i of list) if (i.kind === 'task') tasks.set(i.id, i)
  const blocks = (id: string) => {
    const t = tasks.get(id)
    return !t || (!t.deletedAt && t.status !== 'done')
  }
  let changed = false
  const next = list.map(i => {
    if (i.kind !== 'task' || i.status !== 'blocked' || !i.blockedBy?.length) return i
    if (!i.blockedBy.some(id => completed.includes(id)) || i.blockedBy.some(blocks)) return i
    changed = true
    return { ...i, status: 'todo' as TaskStatus, updatedAt: newerStamp(i.updatedAt) }
  })
  return changed ? next : list
}

/**
 * `list` with a repeat's next occurrence in it: in place of the record that
 * holds its id — only ever a tombstone it replaces (nextOccurrence) — or at the
 * end. Two records under one id are one too many: the cache and the server each
 * keep only one of them, and a chore ticked off, undone and ticked off again
 * used to leave its first next occurrence's tombstone beside the new one.
 */
function withOccurrence(list: Item[], spawn: Task): Item[] {
  return list.some(x => x.id === spawn.id) ? list.map(x => (x.id === spawn.id ? spawn : x)) : list.concat(spawn)
}

/** The task this edit ticks off, if it does: [] or its id, for releaseBlocked. */
const tickedOff = (next: Item, prev: Item | undefined): string[] =>
  next.kind === 'task' && next.status === 'done' && !(prev?.kind === 'task' && prev.status === 'done') ? [next.id] : []

export function stampStatus(t: Task, status: TaskStatus): Task {
  const next: Task = { ...t, status, updatedAt: newerStamp(t.updatedAt) }
  if (status === 'done') next.completedAt = next.completedAt ?? new Date().toISOString()
  else next.completedAt = undefined
  // a bill marked done with nothing typed under Paid was paid in full
  return withPaidDefault(next)
}

/** The project migrated social posts live in; created on demand so every device agrees on it. */
function socialProject(): Project {
  const now = new Date().toISOString()
  return {
    kind: 'project',
    id: SOCIAL_PROJECT_ID,
    name: 'Social media',
    emoji: '📣',
    color: '#0891b2',
    status: 'active',
    description: 'Posts, drafts and results across your social platforms.',
    createdAt: now,
    updatedAt: now,
  }
}

/** Make sure every referenced built-in project exists (the social project after a migration). */
function ensureProjects(items: Item[]): Item[] {
  const hasSocialTask = items.some(i => i.kind === 'task' && i.projectId === SOCIAL_PROJECT_ID && !i.deletedAt)
  const hasSocialProject = items.some(i => i.kind === 'project' && i.id === SOCIAL_PROJECT_ID)
  return hasSocialTask && !hasSocialProject ? [...items, socialProject()] : items
}

const PROVENANCE_TAGS = ['x-archive', 'ig-archive', 'imported']

/** Posts that came from an archive/CSV may have their metrics refreshed by a re-import. */
function isImported(t: Task): boolean {
  return t.tags.some(tag => PROVENANCE_TAGS.includes(tag))
}

type MetricsMap = NonNullable<NonNullable<Task['social']>['metrics']>

/** Per-field max: engagement counts only grow, so a refresh never lowers a manual fix. */
function maxMetrics(a: MetricsMap | undefined, b: MetricsMap | undefined): { merged: MetricsMap; changed: boolean } {
  const merged: MetricsMap = JSON.parse(JSON.stringify(a ?? {}))
  let changed = false
  for (const [pl, m] of Object.entries(b ?? {})) {
    if (!m) continue
    const target = (merged[pl as keyof MetricsMap] ??= {})
    for (const key of ['likes', 'comments', 'shares', 'impressions'] as const) {
      const incoming = m[key]
      if (incoming !== undefined && incoming > (target[key] ?? -1)) {
        target[key] = incoming
        changed = true
      }
    }
  }
  return { merged, changed }
}

/** What a person would call this record in a sentence: a toast, a Settings row. */
export function recordLabel(item: Item | undefined): string {
  if (!item) return 'A deleted item'
  switch (item.kind) {
    case 'task':
      return item.title || 'Untitled task'
    case 'meal':
      return item.title || 'A meal'
    case 'event':
      return item.title || 'Untitled event'
    case 'grocery':
      return item.weekKey ? `Grocery list ${item.weekKey}` : 'Grocery list'
    case 'journal':
      return item.date ? `Journal ${item.date}` : 'Journal entry'
    case 'review':
      return `${item.period === 'month' ? 'Month' : 'Week'} review ${item.key}`.trim()
    case 'note':
      return item.title || 'Untitled note'
    case 'wear':
      return `Outfit ${item.planned ? 'planned' : 'worn'}${item.date ? ` ${item.date}` : ''}`
    case 'outfit':
      return item.name || 'An outfit'
    case 'garment':
      return item.name || 'Untitled piece'
    case 'snooze':
      return 'A nudge put off'
    case 'message':
      return item.body ? `“${item.body.slice(0, 40)}”` : 'A message'
    case 'chat':
      return item.role === 'drafter' ? 'An answer from Drafter' : 'A question for Drafter'
    default:
      return item.name || 'Untitled'
  }
}

/** “Buy paint” changed on another device too — kept the newer edit. */
export function conflictMessage(conflicts: readonly { label: string }[]): string {
  const first = `“${conflicts[0]?.label ?? 'Something'}”`
  return conflicts.length > 1
    ? `${first} and ${conflicts.length - 1} more changed on another device too — kept the newer edits`
    : `${first} changed on another device too — kept the newer edit`
}

/** A next occurrence put in the Trash as another's duplicate, holding something the one kept does not. */
export interface RetiredSpawn {
  id: string
  /** The occurrence kept in its place. */
  keptId: string
  /** The chore as a person would call it: “Water the plants”. */
  label: string
}

/** “Water the plants” came round twice, ticked off on two devices — kept the later one, the other is in the Trash. */
export function retiredMessage(retired: readonly { label: string }[]): string {
  const first = `“${retired[0]?.label ?? 'A repeating task'}”`
  return retired.length > 1
    ? `${first} and ${retired.length - 1} more came round twice, ticked off on two devices — kept the later ones; the others, with what was changed on them, are in the Trash`
    : `${first} came round twice, ticked off on two devices — kept the later one; the other, with what was changed on it, is in the Trash`
}

/**
 * Two next occurrences of one chore that differ in nothing but their id and
 * when they fall due (and the bill day that follows from it): the owner loses
 * nothing with either, so the extra goes to the Trash without a word.
 */
function sameSpawn(a: Item | undefined, b: Item | undefined): boolean {
  if (a?.kind !== 'task' || b?.kind !== 'task') return false
  const bare = (t: Task) => ({ ...t, id: '', dueAt: '', createdAt: '', spawnedFrom: undefined, bill: t.bill && { ...t.bill, day: undefined } })
  return sameContent(bare(a), bare(b))
}

export type SyncEngine = ReturnType<typeof createSyncEngine>

export function createSyncEngine(deps: SyncEngineDeps) {
  const rpc = deps.rpc
  /** Local mode has no server: nothing is dirty, nothing is pending, nothing is shadowed. */
  const remote = rpc !== null
  const { storage } = deps
  const kv = storage.kv
  const now = deps.now ?? (() => Date.now())
  const timers = deps.timers ?? defaultTimers
  /** One row per record (the app's IndexedDB), or the single value rewritten whole (a storage without the per-record calls). */
  const perRecord = typeof storage.readAll === 'function' && typeof storage.writeChanges === 'function'

  let state: EngineState = { items: [], byKind: NO_LISTS, loaded: false, syncInfo: { online: false, authError: false }, failures: [] }
  const listeners = new Set<() => void>()
  const conflictListeners = new Set<(conflicts: EngineConflict[]) => void>()
  const retiredListeners = new Set<(retired: RetiredSpawn[]) => void>()

  /** The account the cache on disk belongs to (null until known, and in local mode). */
  let account: string | null = null
  let bootGen = 0
  let dirty = new Set<string>()
  /** The last version the server confirmed of each dirty record: the base a concurrent edit merges against. */
  let shadows = new Map<string, Item>()
  let failures = new Map<string, SyncFailure>()
  /** The delta cursor: where the last answer got to. Null: the next round is a full exchange. */
  let cursor: string | null = null
  /** The kinds list the cursor was reached under (see SyncBookkeeping.kinds). */
  let cursorKinds: string | null = null
  /**
   * Bumped by every change of the bookkeeping above. Every write carries the
   * whole of it; this says whether the one on disk is behind.
   */
  let metaGen = 0
  /** Writes started, counting on from the one the cache was read at: orders the journal against the cache. */
  let seq = 0
  /** The bookkeeping came from localStorage, where an older build kept it: its keys go once a write has put it beside the records. */
  let legacyKeys = false

  let persistTimer: unknown = undefined
  let pushTimer: unknown = undefined
  let periodic: unknown = undefined
  /** The periodic round runs between start and stop… */
  let started = false
  /** …every PERIODIC_MS, or every LIVE_PERIODIC_MS while a live channel is up (setLive)… */
  let live = false
  /** …and not at all while the page is hidden (setHidden): the return to it syncs. */
  let hidden = false
  // the round in flight, if any: a second call joins it instead of starting
  // another, so a pull-down during the foreground sync waits for that sync
  let inflight: Promise<boolean> | null = null
  /** A local edit landed while a round was in flight: it missed that round's snapshot and gets its own push. */
  let editedMidRound = false
  /** Ids discarded outright while a round was in flight: its answer must not bring the local copy back. */
  const removedMidRound = new Set<string>()
  /** The next successful round is a full exchange, whatever the stored cursor says. */
  let forceFull = false

  // What the per-record cache needs to write only what changed. Every change
  // of the list goes through publish, which compares it with `index`, record by
  // record, by identity: whatever path changed a record — an edit, a round's
  // answer, retainMine, an import, a tombstone aged out — it is noted here.
  /** Every record in `state.items`, by id: kept in step with every change of the list. */
  let index = new Map<string, Item>()
  /** Ids whose copy on disk may differ from the one in memory: the next write puts or deletes each. */
  const unsaved = new Set<string>()
  /** Ids the write in progress carries: not on disk until it lands, so a journal taken meanwhile holds them too. */
  let inflightIds: ReadonlySet<string> = new Set()
  /** An older build's single value is still on disk: the next write moves it over and removes it. */
  let snapshotLeft = false
  /** The account and bookkeeping generation the last write put beside the records; null when unknown. */
  let written: { userId: string | null; gen: number } | null = null
  /** The cursor the cache on disk holds: what a journal too big to keep whole falls back to. */
  let savedCursor: string | null = null
  /** The write in progress. Writes run one after another, so an older one can never land last. */
  let writing: Promise<void> | null = null

  /**
   * Bring `index` in step with a new list. Each record that is new, changed (a
   * different object) or gone is noted for the next write, and its kind for a
   * rebuilt list; returns those kinds. One pass, and a second only when the
   * sizes say something left.
   */
  function reindex(next: Item[]): Set<Item['kind']> {
    const kinds = new Set<Item['kind']>()
    for (const item of next) {
      const was = index.get(item.id)
      if (was === item) continue
      if (was) kinds.add(was.kind)
      kinds.add(item.kind)
      index.set(item.id, item)
      unsaved.add(item.id)
    }
    if (index.size !== next.length) {
      const present = new Set<string>()
      for (const item of next) present.add(item.id)
      for (const [id, was] of index) {
        if (present.has(id)) continue
        index.delete(id)
        kinds.add(was.kind)
        unsaved.add(id)
      }
    }
    return kinds
  }

  function publish(patch: Partial<EngineState>): void {
    if (patch.items && patch.items !== state.items && !patch.byKind) {
      const kinds = reindex(patch.items)
      if (kinds.size > 0) patch = { ...patch, byKind: groupByKind(patch.items, kinds, state.byKind) }
    }
    state = { ...state, ...patch }
    for (const l of [...listeners]) l()
  }

  function failureList(): SyncFailure[] {
    return [...failures.values()].sort((a, b) => a.firstAt - b.firstAt || a.id.localeCompare(b.id))
  }

  function pendingCount(): number {
    return remote ? dirty.size : 0
  }

  /**
   * The bookkeeping changed: the next write carries it, beside the records it
   * covers — never on its own ahead of them, which is how a cursor once moved
   * past rows the device had not saved.
   */
  function saveBookkeeping(): void {
    metaGen++
    schedulePersist()
  }

  /** The bookkeeping as a write carries it. */
  function bookkeeping(): SyncBookkeeping {
    return { cursor, kinds: cursorKinds, dirty: [...dirty], failures: failureList() }
  }

  /** The bookkeeping in one string, to tell whether a round changed any of it. */
  function bookSignature(): string {
    const marks = [...shadows.values()].map(s => `${s.id}@${s.updatedAt}`)
    return JSON.stringify([cursor, cursorKinds, [...dirty], failureList(), marks])
  }

  /** Drop bookkeeping for ids with nothing left to push (removed by retainMine, a wipe, an old purge). */
  function pruneBookkeeping(): void {
    let changed = false
    for (const id of [...dirty]) {
      if (index.has(id)) continue
      dirty.delete(id)
      changed = true
    }
    for (const id of [...shadows.keys()]) if (!dirty.has(id)) shadows.delete(id)
    for (const id of [...failures.keys()]) {
      if (dirty.has(id)) continue
      failures.delete(id)
      changed = true
    }
    if (changed) saveBookkeeping()
  }

  // ---- persistence -----------------------------------------------------------

  /**
   * Write the cache now. A write already under way finishes first — each
   * write works out what to write when it starts, so it never lands older data
   * over newer. With nothing under way the write starts at once, inside this
   * call, as a flush on the way to the background needs.
   */
  function persistNow(): Promise<void> {
    if (persistTimer !== undefined) {
      timers.clearTimeout(persistTimer)
      persistTimer = undefined
    }
    // after the last write however it ended: one that threw must not stop every write after it
    const run: Promise<void> = writing ? writing.then(writeCache, writeCache) : writeCache()
    writing = run
    run
      .finally(() => {
        if (writing === run) writing = null
      })
      .catch(() => {})
    return run
  }

  /** Whether the account or the bookkeeping differ from what the last write put beside the records. */
  function metaMoved(): boolean {
    return !written || written.userId !== account || written.gen !== metaGen
  }

  /** A write landed carrying the bookkeeping as it was at `gen`. */
  function landed(userId: string | null, gen: number, sync: SyncBookkeeping): void {
    written = { userId, gen }
    savedCursor = sync.cursor
    // the bookkeeping an older build kept in localStorage is beside the records now
    if (legacyKeys) {
      forgetLegacyBookkeeping(kv)
      legacyKeys = false
    }
  }

  async function writeCache(): Promise<void> {
    // never overwrite the cache with the empty state from before it was read
    if (!state.loaded) return
    if (!perRecord) {
      unsaved.clear()
      const snapshot = state.items
      const gen = metaGen
      const sync = bookkeeping()
      const record: CacheRecord = { version: STORAGE_VERSION, userId: account, items: snapshot, sync, seq: ++seq }
      if (remote && shadows.size > 0) record.shadows = [...shadows.values()]
      try {
        await storage.writeSnapshot(record)
        landed(record.userId ?? null, gen, sync)
        // legacy cache retired only once the new cache holds real data
        if (snapshot.length > 0) kv.removeItem(LEGACY_LS_KEY)
      } catch (e) {
        console.error('Failed to save the local cache', e)
      }
      return
    }
    const ids = [...unsaved]
    if (ids.length === 0 && !snapshotLeft && !metaMoved()) return
    unsaved.clear()
    const gen = metaGen
    const change: CacheChanges = {
      userId: account,
      version: STORAGE_VERSION,
      upserts: [],
      deletes: [],
      shadows: remote ? [...shadows.values()] : [],
      sync: bookkeeping(),
      seq: ++seq,
    }
    for (const id of ids) {
      const item = index.get(id)
      if (item) change.upserts.push(item)
      else change.deletes.push(id)
    }
    if (snapshotLeft) change.dropSnapshot = true
    inflightIds = new Set(ids)
    try {
      await storage.writeChanges!(change)
      landed(change.userId, gen, change.sync)
      if (change.dropSnapshot) snapshotLeft = false
      // what a page going away journalled is on disk now
      if (unsaved.size === 0 && !metaMoved()) clearJournal()
      // legacy cache retired only once the new cache holds real data
      if (index.size > 0) kv.removeItem(LEGACY_LS_KEY)
    } catch (e) {
      // nothing of it was written: every id waits for the next write, which a
      // later change or this retry brings, whichever comes first
      for (const id of ids) unsaved.add(id)
      console.error('Failed to save the local cache', e)
      if (persistTimer === undefined) schedulePersist(PERSIST_RETRY_MS)
    } finally {
      inflightIds = new Set()
    }
  }

  function schedulePersist(ms = PERSIST_MS): void {
    if (persistTimer !== undefined) timers.clearTimeout(persistTimer)
    persistTimer = timers.setTimeout(() => {
      persistTimer = undefined
      void persistNow()
    }, ms)
  }

  /** Something is waiting to be written: a debounce not yet run, or a write that failed. */
  function persistPending(): boolean {
    return persistTimer !== undefined || (perRecord && state.loaded && (unsaved.size > 0 || metaMoved()))
  }

  // ---- the journal: what a page going away had not written yet ----------------------
  //
  // An IndexedDB write is asynchronous, and a page that is closing — a reload,
  // the app swiped away — may be gone before it commits: an edit made in the
  // last moments before that was lost from the device, and, not pushed yet
  // either, lost altogether (the dirty set, in synchronous storage, survived
  // and pointed at a record the cache still held in its older form). So when
  // the page goes away the records still unwritten are also put in synchronous
  // storage, and the next boot lays them over what IndexedDB read. The next
  // write that leaves nothing unwritten removes it.
  //
  // It carries the bookkeeping too — the dirty set, each dirty record's merge
  // base, the cursor — as the page held it. Without the merge base a replayed
  // edit went out as if nothing had changed on the server since, and
  // overwrote a partner's concurrent edit of the same record whole. And it
  // says how many writes had been started (`seq`): a cache that a later write
  // reached is newer than everything in it.

  /** A journal bigger than this is not written whole: localStorage is small, and the IndexedDB write is still under way. */
  const JOURNAL_MAX_CHARS = 1_500_000

  function writeJournal(): void {
    if (!perRecord || !state.loaded) return
    // the write in progress is not on disk until it lands: what it carries goes in too
    const ids = new Set([...unsaved, ...inflightIds])
    if (ids.size === 0 && !metaMoved()) return
    const upserts: Item[] = []
    const deletes: string[] = []
    for (const id of ids) {
      const item = index.get(id)
      if (item) upserts.push(item)
      else deletes.push(id)
    }
    const whole: Journal = { v: 2, userId: account, seq, upserts, deletes, shadows: remote ? [...shadows.values()] : [], sync: bookkeeping() }
    try {
      let text = JSON.stringify(whole)
      // Too big to keep whole (a first full exchange, say): the edits alone,
      // with the cursor the cache already holds, so what was pulled since is
      // pulled again rather than skipped.
      if (text.length > JOURNAL_MAX_CHARS) text = JSON.stringify({ ...whole, upserts: upserts.filter(i => dirty.has(i.id)), deletes: [], sync: { ...whole.sync!, cursor: savedCursor } })
      if (text.length <= JOURNAL_MAX_CHARS) kv.setItem(JOURNAL_KEY, text)
    } catch {
      /* storage full or blocked: the IndexedDB write is still on its way */
    }
  }

  function clearJournal(): void {
    try {
      kv.removeItem(JOURNAL_KEY)
    } catch {
      /* nothing to do: the next boot reads it, finds it older, and changes nothing */
    }
  }

  /** The journal a page going away left for this account, taken out of storage; another account's is thrown away. */
  function takeJournal(myId: string | null): Journal | null {
    let raw: string | null = null
    try {
      raw = kv.getItem(JOURNAL_KEY)
    } catch {
      return null
    }
    if (raw === null) return null
    try {
      const j = JSON.parse(raw) as Partial<Journal>
      if ((j?.v !== 1 && j?.v !== 2) || !Array.isArray(j.upserts) || !Array.isArray(j.deletes) || (j.userId ?? null) !== myId) {
        clearJournal()
        return null
      }
      const upserts = (migrateStored(j.upserts) ?? []).filter(i => typeof i?.id === 'string')
      const deletes = j.deletes.filter((d): d is string => typeof d === 'string')
      if (j.v === 1) return { v: 1, userId: myId, upserts, deletes }
      const sync = parseBookkeeping(j.sync)
      // a v2 journal without its bookkeeping is not one this build wrote
      if (!sync || typeof j.seq !== 'number') {
        clearJournal()
        return null
      }
      const shadowList = (migrateStored(Array.isArray(j.shadows) ? j.shadows : []) ?? []).filter(i => typeof i?.id === 'string')
      return { v: 2, userId: myId, seq: j.seq, upserts, deletes, shadows: shadowList, sync }
    } catch {
      clearJournal()
      return null
    }
  }

  /**
   * The cache as IndexedDB read it, with the journal laid over it. A v2
   * journal is newer than the cache whole (boot checks its `seq`); from a v1
   * journal, which cannot say, a record wins unless the cache holds a newer one.
   */
  function withJournal(items: Item[], j: Journal): Item[] {
    const byId = new Map(items.map(i => [i.id, i]))
    for (const item of j.upserts) {
      const had = byId.get(item.id)
      if (j.v === 2 || !had || !(Date.parse(had.updatedAt) > Date.parse(item.updatedAt))) byId.set(item.id, item)
    }
    for (const id of j.deletes) byId.delete(id)
    return [...byId.values()]
  }

  function schedulePush(): void {
    if (!remote) return
    if (pushTimer !== undefined) timers.clearTimeout(pushTimer)
    pushTimer = timers.setTimeout(() => {
      pushTimer = undefined
      void sync()
    }, PUSH_MS)
  }

  /**
   * Read the cache for this account. `from` is what the per-record cache needs
   * to know about the disk: the records came from it ('records', with `ids`,
   * every id stored there), from an older build's single value ('snapshot', to
   * be moved over), or there was nothing ('none'). `legacy` says they came from
   * localStorage instead.
   *
   * A read that fails THROWS. It used to come back as an empty cache, and boot
   * took it for one: the dirty set was cleared for a full exchange and the next
   * write emptied the records store, so an edit made offline — on the device
   * and nowhere else — was gone the moment IndexedDB had one bad launch.
   */
  async function loadCache(myId: string | null): Promise<LoadedCache> {
    let cached: { userId?: string | null; shadows?: unknown; items?: unknown; sync?: unknown; seq?: unknown } | undefined = perRecord ? await storage.readAll!() : undefined
    let from: LoadedCache['from'] = cached !== undefined ? 'records' : 'none'
    const ids = new Set<string>()
    if (cached !== undefined) {
      for (const raw of Array.isArray(cached.items) ? cached.items : []) {
        const id = (raw as { id?: unknown } | null)?.id
        if (typeof id === 'string') ids.add(id)
      }
    } else {
      cached = (await storage.readSnapshot()) as typeof cached
      if (cached) from = 'snapshot'
    }
    // a cache written by a different account must never be adopted or re-synced
    if (cached && myId && cached.userId && cached.userId !== myId) {
      await storage.clearAll()
      return { items: [], shadows: [], wiped: true, from: 'none', ids: new Set(), legacy: false, sync: null, seq: 0 }
    }
    const owner = cached?.userId
    const sync = parseBookkeeping(cached?.sync)
    const seqRead = typeof cached?.seq === 'number' && Number.isFinite(cached.seq) ? cached.seq : 0
    const shadowList = (cached && migrateStored(Array.isArray(cached.shadows) ? cached.shadows : [])) || []
    if (cached) {
      const migrated = migrateStored(cached)
      // an empty cache must not shadow a legacy localStorage store (e.g. an
      // interrupted first run of this version)
      if (migrated && migrated.length > 0) return { items: purgeTombstones(migrated, now()), shadows: shadowList, wiped: false, from, ids, owner, legacy: false, sync, seq: seqRead }
    }
    // migration from the old localStorage cache — non-destructive: the legacy
    // key is only removed after the IndexedDB cache has persisted real data.
    // One that does not parse is no cache at all, not a failed read.
    let legacy: Item[] | null = null
    try {
      const raw = kv.getItem(LEGACY_LS_KEY)
      legacy = raw === null ? null : migrateStored(JSON.parse(raw))
    } catch {
      legacy = null
    }
    if (legacy && legacy.length > 0) return { items: purgeTombstones(legacy, now()), shadows: [], wiped: false, from, ids, owner, legacy: true, sync, seq: seqRead }
    return { items: [], shadows: shadowList, wiped: false, from, ids, owner, legacy: false, sync, seq: seqRead }
  }

  /** How long boot waits before each try again at a cache that would not read. */
  const READ_RETRY_MS = [250, 1_000, 3_000]

  const pause = (ms: number) => new Promise<void>(resolve => void timers.setTimeout(resolve, ms))

  /**
   * loadCache, tried again a few times: IndexedDB in WebKit can fail a read
   * once and answer the next ("Connection to Indexed Database server lost").
   * Throws the last failure; resolves null when a later boot took over.
   */
  async function readCache(myId: string | null, gen: number): Promise<LoadedCache | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        const cached = await loadCache(myId)
        return gen === bootGen ? cached : null
      } catch (e) {
        console.error('Failed to load the local cache', e)
        if (gen !== bootGen) return null
        if (attempt >= READ_RETRY_MS.length) throw e
        await pause(READ_RETRY_MS[attempt])
        if (gen !== bootGen) return null
      }
    }
  }

  /**
   * Start the per-record bookkeeping from what boot just read: the records in
   * memory are the index, and the ids to write are the ones memory and disk
   * disagree about — tombstones aged out and rows that no longer read (to
   * delete), a project boot added (to put). Records from anywhere but the
   * per-record cache are all to be written.
   */
  function rebase(items: Item[], cached: LoadedCache): void {
    index = new Map(items.map(i => [i.id, i]))
    unsaved.clear()
    snapshotLeft = cached.from === 'snapshot'
    if (!perRecord) return
    const onDisk = cached.from === 'records' ? cached.ids : new Set<string>()
    for (const id of onDisk) if (!index.has(id)) unsaved.add(id)
    for (const id of index.keys()) if (!onDisk.has(id)) unsaved.add(id)
  }

  // ---- boot and accounts -------------------------------------------------------

  /**
   * Read the cache for this account, then run a first round. Called again
   * whenever the account id changes; a later call supersedes an earlier one
   * still reading (StrictMode mounts twice).
   */
  async function boot(myId: string | null): Promise<void> {
    const gen = ++bootGen
    const before = account
    // an edit still waiting on the debounce is written first, under the account it was made in
    if (persistPending()) await persistNow()
    account = myId
    const wasLoaded = state.loaded
    let cached: LoadedCache | null
    try {
      cached = await readCache(myId, gen)
    } catch (e) {
      if (gen !== bootGen) return
      if (wasLoaded && before === myId) {
        // the same account again (a remount): memory is the newest copy there is
        void sync()
        return
      }
      // Nothing is known about what is on disk, so nothing may be shown as
      // if it were all there is, nor written over it, pushed from it or
      // pulled into it. The planner says so and offers another try.
      if (wasLoaded) resetMemory(myId)
      publish({ loaded: false, loadError: e instanceof Error ? e.message || e.name : String(e) })
      return
    }
    if (!cached) return
    if (wasLoaded && !cached.wiped && before === myId) {
      // the same account again (a remount): memory is at least as new as the cache just written
      void sync()
      return
    }
    // The bookkeeping belongs to whoever the cache belongs to: beside the
    // records, or — in a cache an older build wrote — in localStorage, read
    // once here and moved over by the next write.
    let book = cached.sync
    legacyKeys = false
    if (!book && remote) {
      book = readLegacyBookkeeping(kv)
      legacyKeys = book !== null
    }
    book ??= NO_BOOKKEEPING
    savedCursor = book.cursor
    seq = cached.seq
    // What a page going away left unwritten (writeJournal). A v2 journal that
    // a later write overtook is stale, all of it; a newer one is the page as
    // it last was, bookkeeping and merge bases included.
    let journal = perRecord ? takeJournal(myId) : null
    if (journal?.v === 2 && journal.seq! < cached.seq) {
      clearJournal()
      journal = null
    }
    let shadowList = cached.shadows
    if (journal?.v === 2) {
      book = journal.sync!
      shadowList = journal.shadows!
      seq = Math.max(seq, journal.seq!)
    }
    // whether the bookkeeping on disk is the one about to be held, so the first write need not carry it
    let fresh = cached.from === 'records' && cached.sync !== null && !journal
    dirty = remote ? new Set(book.dirty) : new Set()
    failures = remote ? new Map(book.failures.map(f => [f.id, f])) : new Map()
    cursor = remote ? book.cursor : null
    cursorKinds = book.kinds
    const loadedItems = journal ? withJournal(cached.items, journal) : cached.items
    // Empty local + cloud: a leftover cursor would delta-pull nothing → blank UI
    // while the server still has data (stuck after wipe / sign-out race). Only
    // for a cache that READ as empty: one that could not be read never gets here.
    if (myId && loadedItems.length === 0 && (cursor !== null || dirty.size > 0 || failures.size > 0)) {
      cursor = null
      dirty = new Set()
      failures = new Map()
      fresh = false
    }
    // A build that did not know a kind dropped its rows on pull (sanitizeItem →
    // null) and applySync still moved the cursor past them, so they would never
    // arrive. The first boot of a build with a different kinds list forgets the
    // cursor once — one full exchange, as Settings → Full resync does. The
    // dirty set stays.
    if (remote && myId && cursorKinds !== KINDS_EPOCH) {
      cursor = null
      cursorKinds = KINDS_EPOCH
      forceFull = true
      fresh = false
    }
    shadows = new Map(shadowList.filter(s => dirty.has(s.id)).map(s => [s.id, s]))
    // No blanket re-push of whole kinds on boot: a rejected id stays in the
    // persisted dirty set, so a new session pushes it again on its own. The
    // blanket version re-sent every place, recipe, meal, grocery list, journal
    // entry and event on every load — none of which the server echoed back,
    // so none could ever be confirmed, and all of them read as "n unsynced".
    const items = ensureProjects(loadedItems)
    rebase(items, cached)
    // what the journal held is written to IndexedDB on this boot's first write
    if (journal) for (const id of [...journal.upserts.map(i => i.id), ...journal.deletes]) unsaved.add(id)
    metaGen++
    written = fresh ? { userId: cached.owner ?? null, gen: metaGen } : null
    publish({ items, byKind: groupByKind(items, null), loaded: true, loadError: undefined, failures: failureList() })
    // a cache still in an older build's shape moves over now, not after the debounce
    if (perRecord && (snapshotLeft || cached.legacy)) void persistNow()
    else schedulePersist()
    void sync()
  }

  /** Forget everything held in memory for the last account, without writing any of it anywhere. */
  function resetMemory(nextAccount: string | null): void {
    for (const t of [persistTimer, pushTimer]) if (t !== undefined) timers.clearTimeout(t)
    persistTimer = undefined
    pushTimer = undefined
    account = nextAccount
    dirty = new Set()
    shadows = new Map()
    failures = new Map()
    cursor = null
    saveBookkeeping()
    publish({ items: [], failures: [], syncInfo: { online: false, authError: false } })
  }

  /**
   * Supabase said SIGNED_IN — which it also re-emits on every tab focus. Force
   * a full exchange only when this device has nothing locally: a leftover
   * cursor would delta-pull nothing into an empty UI. With rows present the
   * cursor is still good, and resetting it on every focus would re-send the
   * whole store each time and, in doing so, clear the dirty flag of anything
   * edited mid-round.
   */
  function signedIn(userId: string | null): void {
    if (userId && account && userId !== account) {
      // another account on a device still holding the last one's records in
      // memory (the planner stays mounted under the login overlay): not one of
      // them may be pushed into this account
      resetMemory(userId)
    }
    // nothing read yet: boot decides from what it reads — an empty list here
    // is not an empty cache, and clearing the dirty set on it lost edits
    if (!state.loaded) return
    if (state.items.length === 0 && (cursor !== null || dirty.size > 0)) {
      cursor = null
      dirty = new Set()
      saveBookkeeping()
    }
    void sync()
  }

  // ---- local edits -------------------------------------------------------------

  /** Adopt a list without calling it a local edit (a sync result, retainMine, a discard). */
  function replaceItems(next: Item[]): void {
    if (next === state.items) return
    publish({ items: next })
    schedulePersist()
  }

  /**
   * Adopt a list the user changed. Every id named in `touched`, and every
   * record whose object changed (a task releaseBlocked moved, a recurrence
   * spawn), becomes dirty; the first time a record becomes dirty, the copy it
   * replaced — the server's last word on it — is kept as its shadow.
   */
  function commit(next: Item[], touched: Iterable<string> = []): void {
    const prev = state.items
    if (next === prev) return
    if (remote) {
      // `index` is still `prev` by id: publish below moves it on
      const ids = new Set<string>()
      for (const i of next) if (index.get(i.id) !== i) ids.add(i.id)
      // a touched record left unchanged still counts, unless it is gone from the list
      for (const id of touched) if (!ids.has(id) && next.some(i => i.id === id)) ids.add(id)
      for (const id of ids) {
        if (!dirty.has(id)) {
          const base = index.get(id)
          if (base) shadows.set(id, base)
        }
        dirty.add(id)
        // a new version deserves a prompt push, whatever the last one's backoff was
        failures.delete(id)
      }
      saveBookkeeping()
      if (inflight) editedMidRound = true
    }
    publish({ items: next, failures: remote ? failureList() : state.failures })
    schedulePersist()
    schedulePush()
  }

  /** What this device holds under an id, tombstones included: where a repeat's next occurrence may not go. */
  const held = (id: string): Item | undefined => index.get(id)

  function upsert(item: Item): void {
    const list = state.items
    const old = list.find(x => x.id === item.id)
    if (item.kind === 'task' && item.status === 'done' && !(old?.kind === 'task' && old.status === 'done')) item = withPaidDefault(item)
    let next = old ? list.map(x => (x.id === item.id ? item : x)) : [...list, item]
    const touched = [item.id]
    if (item.kind === 'task' && item.status === 'done' && old?.kind === 'task' && old.status !== 'done' && item.recurrence) {
      const spawn = nextOccurrence(item, uid, held)
      if (spawn) {
        touched.push(spawn.id)
        const done = item
        next = withOccurrence(
          next.map(x => (x.id === done.id ? { ...done, recurrence: undefined } : x)),
          spawn,
        )
      }
    }
    commit(ensureProjects(releaseBlocked(next, tickedOff(item, old))), touched)
  }

  function remove(id: string): void {
    const list = state.items
    const gone = list.find(p => p.id === id)
    if (!gone) return
    const deletedAt = new Date(now()).toISOString()
    const next = list.map(p => (p.id === id ? { ...p, deletedAt, updatedAt: newerStamp(p.updatedAt) } : p))
    // a blocker sent to the Trash is out of the way as surely as one ticked
    // off, and this is the edit that moved it: what it alone held is released
    commit(gone.kind === 'task' && !gone.deletedAt ? releaseBlocked(next, [id]) : next, [id])
  }

  function restore(ids: string[]): void {
    const list = state.items
    // a purged tombstone has nothing left to bring back
    const set = new Set(ids.filter(id => list.some(p => p.id === id && !p.purged)))
    if (set.size === 0) return
    commit(
      list.map(p => (set.has(p.id) ? { ...p, deletedAt: undefined, updatedAt: newerStamp(p.updatedAt) } : p)),
      set,
    )
  }

  /**
   * A repeating chore ticked off on two devices on different days, before
   * they synced, spawned its next occurrence twice under two ids. Once a round
   * brings both here, the extra ones go to the Trash — the same ones on every
   * device (duplicateSpawnPairs) — as an ordinary edit, dirty and pushed like any
   * other. They lose their repeat on the way, so one restored from the Trash
   * comes back as a one-off and is never put there again.
   *
   * The one kept is picked by its due day alone, so an extra may hold what was
   * done on it before the two met — a ticked step, a note, a comment. Then the
   * listeners hear of it (onRetired) and the toast offers Restore, so nothing
   * vanishes unseen; a copy identical but for its due day goes quietly.
   */
  function retireDuplicateSpawns(): void {
    const pairs = duplicateSpawnPairs(state.items)
    if (pairs.length === 0) return
    const byId = new Map(state.items.map(i => [i.id, i]))
    const extra = new Set(pairs.map(p => p.id))
    const told: RetiredSpawn[] = pairs.filter(p => !sameSpawn(byId.get(p.id), byId.get(p.keptId))).map(p => ({ ...p, label: recordLabel(byId.get(p.id)) }))
    const deletedAt = new Date(now()).toISOString()
    commit(
      state.items.map(p => (extra.has(p.id) && p.kind === 'task' ? { ...p, recurrence: undefined, deletedAt, updatedAt: newerStamp(p.updatedAt) } : p)),
      extra,
    )
    if (told.length > 0) for (const l of [...retiredListeners]) l(told)
  }

  function setStatus(id: string, status: TaskStatus): StatusChange | null {
    const old = state.items.find(x => x.id === id)
    if (!old || old.kind !== 'task' || old.status === status) return null
    const updated = stampStatus(old, status)
    let spawned: Task | null = null
    if (status === 'done' && old.status !== 'done' && updated.recurrence) spawned = nextOccurrence(updated, uid, held)
    const stored: Task = spawned ? { ...updated, recurrence: undefined } : updated
    let next: Item[] = state.items.map(x => (x.id === id ? stored : x))
    if (spawned) next = withOccurrence(next, spawned)
    commit(releaseBlocked(next, tickedOff(stored, old)), spawned ? [id, spawned.id] : [id])
    return { prev: old, next: stored, spawnedId: spawned?.id }
  }

  function importItems(incoming: unknown[]): ImportSummary {
    const clean = incoming.map(sanitizeItem).filter((p): p is Item => p !== null)
    const byId = new Map(state.items.map(p => [p.id, p]))
    let added = 0
    let updated = 0
    let unchanged = 0
    let metricsRefreshed = 0
    const toMerge: Item[] = []
    for (const p of clean) {
      const existing = byId.get(p.id)
      if (!existing) {
        added++
        toMerge.push(p)
      } else if (p.updatedAt > existing.updatedAt) {
        updated++
        toMerge.push(p)
      } else if (existing.kind === 'task' && p.kind === 'task' && isImported(existing) && p.social?.metrics) {
        const { merged, changed } = maxMetrics(existing.social?.metrics, p.social.metrics)
        if (changed) {
          metricsRefreshed++
          toMerge.push({
            ...existing,
            social: { platforms: existing.social?.platforms ?? p.social.platforms, variants: existing.social?.variants, metrics: merged },
            updatedAt: newerStamp(existing.updatedAt),
          })
        } else {
          unchanged++
        }
      } else {
        unchanged++
      }
    }
    if (toMerge.length > 0) {
      commit(
        ensureProjects(mergeItems(state.items, toMerge)),
        toMerge.map(p => p.id),
      )
    }
    return { added, updated, unchanged, metricsRefreshed }
  }

  /** Drop peer-owned rows after leaving a household (keeps unowned + mine). */
  function retainMine(me: string | null): void {
    if (!me) return
    const list = state.items
    const next = list.filter(i => !i.ownerId || i.ownerId === me)
    if (next.length === list.length) return
    replaceItems(next)
    pruneBookkeeping()
  }

  /**
   * "Delete forever": the record becomes a content-free tombstone stamped
   * newer than it, and that tombstone is an ordinary dirty row — written to
   * the cache at once, retried like any other push (backoff included when
   * refused), and dropped from the queue only when the server takes it.
   * Resolves true once the server has every one of them.
   */
  async function purge(ids: string[]): Promise<boolean> {
    const set = new Set(ids)
    const list = state.items
    if (!remote) {
      // no server to tell: gone from this device is gone
      commit(list.filter(p => !set.has(p.id)))
      await persistNow()
      return true
    }
    const deletedAt = new Date(now()).toISOString()
    const next = list.map(p => {
      if (!set.has(p.id) || p.purged) return p
      // A tombstone is content-free by design, which for a note meant it
      // carried no `shared` — and v3.16's `with check` refuses a write onto
      // somebody else's note that does not leave it shared. So "Delete
      // forever" on a note a housemate shared was refused every round and sat
      // dirty for good. The flag is not content: it is who the row is for, and
      // the tombstone has to say the same thing the row it replaces said.
      const raw = purgeTombstone(p.kind, p.id, newerStamp(p.updatedAt), deletedAt)
      // a private task says the same thing the other way round: the tombstone
      // carries `false` so the server does not have to put it back (v3.19's
      // posts_private_flag would), and the row we hold matches the row it holds
      const tomb = sanitizeItem(
        p.kind === 'note' && (p as Note).shared
          ? { ...raw, shared: true }
          : p.kind === 'task' && (p as Task).shared === false
            ? { ...raw, shared: false }
            : raw,
      )
      return tomb ? { ...tomb, ownerId: p.ownerId } : p
    })
    commit(next, [...set].filter(id => next.some(p => p.id === id)))
    // the purge must survive the app being killed before the debounce fires
    await persistNow()
    await syncAfterFlight()
    return ids.every(id => !dirty.has(id))
  }

  /** "Keep mine" on a conflict toast: put this device's values back, as a new edit stamped newer than the merge. */
  function keepMine(conflicts: readonly SyncConflict[]): void {
    const byId = new Map(conflicts.map(c => [c.id, c]))
    const touched: string[] = []
    const next = state.items.map(i => {
      const c = byId.get(i.id)
      if (!c || i.purged) return i
      const back = sanitizeItem(applyLocalChoice(i, c.fields))
      if (!back) return i
      touched.push(i.id)
      return { ...back, updatedAt: newerStamp(i.updatedAt) }
    })
    if (touched.length > 0) commit(next, touched)
  }

  /** Push a refused row now rather than when its backoff runs out. */
  function retry(id: string): Promise<boolean> {
    const f = failures.get(id)
    if (f) {
      failures.set(id, { ...f, nextAt: 0 })
      saveBookkeeping()
      publish({ failures: failureList() })
    }
    return syncAfterFlight()
  }

  /**
   * "Discard my copy" of a refused row: this device's version goes. With a
   * shadow it is replaced by the server's copy as last confirmed (a delta
   * round brings anything newer); without one there is no server copy here,
   * so the row is removed and the next round is a full exchange, which
   * brings back the server's version if it has one.
   */
  function discard(id: string): void {
    const base = shadows.get(id)
    dirty.delete(id)
    shadows.delete(id)
    failures.delete(id)
    saveBookkeeping()
    const list = state.items
    if (base) {
      replaceItems(list.map(i => (i.id === id ? base : i)))
    } else {
      if (inflight) removedMidRound.add(id)
      forceFull = true
      cursor = null
      saveBookkeeping()
      replaceItems(list.filter(i => i.id !== id))
    }
    publish({ failures: failureList() })
    void persistNow()
    void syncAfterFlight()
  }

  // ---- the round ---------------------------------------------------------------

  /** The RPC; a throw reads as offline, and an offline answer is published. Null when there was no answer. */
  async function call(outgoing: Item[], since: string | null): Promise<SyncResult | null> {
    let result: SyncResult
    try {
      result = await rpc!(outgoing, pullSince(since))
    } catch (e) {
      console.error('Sync failed', e)
      result = { items: null, rejected: [], reasons: {}, stale: [], gone: [], peerShared: null, peerNotes: null, authError: false, reportsRejections: false }
    }
    if (result.items !== null) return result
    publish({ syncInfo: { online: false, lastAt: state.syncInfo.lastAt, authError: result.authError, pending: pendingCount(), rejected: state.syncInfo.rejected } })
    return null
  }

  /**
   * What goes out: the dirty set (not "updatedAt > cursor") so late/offline
   * stamps still go out. A refused row waits out its backoff — except in a
   * full exchange, which sends everything this account may write.
   *
   * "May write" is the part that had to be said. A full exchange used to offer
   * the WHOLE cache, household peers' rows included, and a device only drops
   * those when Settings → Household is opened on it (retainMine). So a second
   * device of an account that had left a household — the phone, another
   * browser — still held the peers' rows, and its next Full resync (or the one
   * a KINDS_EPOCH change triggers) pushed them all. The server refuses each
   * one, and a refusal pins the row dirty: "n unsynced" forever, retried every
   * round, for rows the account never touched and cannot write.
   *
   * A row that was never edited here has nothing to offer the server anyway.
   */
  function outgoingFor(since: string | null, clock: number): Item[] {
    if (!since) return state.items.filter(p => !p.ownerId || !account || p.ownerId === account || dirty.has(p.id))
    return state.items.filter(p => dirty.has(p.id) && (failures.get(p.id)?.nextAt ?? 0) <= clock)
  }

  /** One round of push-and-pull; sync() is the only caller and serialises it. */
  async function runRound(): Promise<boolean> {
    const full = forceFull
    let since = full ? null : cursor
    const clock = now()
    pruneBookkeeping()
    // Pull before pushing an edit of a record the server already had. If
    // another device changed it meanwhile, that change is merged in first:
    // pushed blind, this device's newer stamp would win last-write-wins and
    // erase the other edit wholesale — the server reports `stale` only when
    // ours is the older one.
    if (since && outgoingFor(since, clock).some(p => shadows.has(p.id))) {
      const pulled = await call([], since)
      if (!pulled) return false
      settle(pulled, [], since, clock)
      since = cursor
    }
    editedMidRound = false
    const outgoing = outgoingFor(since, clock)
    const result = await call(outgoing, since)
    if (!result) return false
    settle(result, outgoing, since, clock)
    if (full) forceFull = false
    return true
  }

  /** Apply one answer: merge, move the cursor, and settle what is still waiting to go out. */
  function settle(result: SyncResult, outgoing: Item[], since: string | null, clock: number): void {
    // Merge onto the list as it is NOW, not the snapshot the request was built
    // from: an edit made while the request was in flight must survive it.
    const current = state.items
    const gone = new Set(result.gone)
    const bookBefore = bookSignature()
    // Rows of other people's that this account can no longer read: a note they
    // un-shared, a task they made private, or the household changed. They
    // cannot arrive as items — an invisible row is indistinguishable from an
    // unchanged one — so the server states the whole visible set and
    // revokedPeerRows works out what is left over. Which set covers which kind
    // is peerVisibleByKind's to say: a v3.16 server speaks for notes only.
    // `result.rejected` is passed as well: a row the server refused in the same
    // breath that left it out is not a pending edit, it is a row this account
    // cannot write because it cannot read it. Holding it would deadlock — see
    // revokedPeerRows.
    const decision = applySync(current, outgoing, result.items!, since, result.rejected, result.reportsRejections, {
      dirty,
      shadows,
      stale: result.stale,
    })
    // Judged on the MERGED list, not the one this round started from: whose a
    // row is can change in the same answer that lists what is visible. When a
    // member leaves, their shared work is re-attributed to the household's
    // creator — so the corrected copy arrives in `items` saying the row is now
    // yours, while the stale copy still says it is theirs and the visible set,
    // which lists only OTHER people's rows, rightly leaves it out. Read the
    // stale one and every re-homed task and note is dropped off the device,
    // with no delta left to bring them back.
    const revoked = revokedPeerRows(decision.merged, peerVisibleByKind(result), dirty, account, new Set(result.rejected))
    let next = decision.merged
    // purged for good on the server: removed here, never pushed again
    if (gone.size > 0 || removedMidRound.size > 0) next = next.filter(i => !gone.has(i.id) && !removedMidRound.has(i.id))
    // dropped, not tombstoned: the row is alive and well, just not ours to read
    if (revoked.size > 0) next = next.filter(i => !revoked.has(i.id))
    next = ensureProjects(purgeTombstones(next, clock))
    // The cursor reaches the disk in the same write as the rows it moved past
    // (saveBookkeeping below), never ahead of them: saved on its own, then
    // killed before the rows were, the device skipped them for good — and its
    // next edit of one of them overwrote the partner's change it never saw.
    if (decision.cursor) cursor = decision.cursor

    // What still has to go out: anything unconfirmed, merged anew, or refused.
    const retryIds = new Set(decision.unconfirmed)
    const refused = new Set(decision.rejected)
    for (const o of outgoing) if (!retryIds.has(o.id) && !refused.has(o.id)) dirty.delete(o.id)
    for (const id of decision.settled) dirty.delete(id)
    for (const id of decision.remerged) {
      dirty.add(id)
      failures.delete(id)
    }
    // A refused row is never dropped: it stays dirty, waits out a growing
    // backoff, and is listed in Settings until it lands or is discarded.
    // Dropping them is how edits lived on one device only in September.
    for (const id of refused) {
      dirty.add(id)
      const prev = failures.get(id)
      const attempts = (prev?.attempts ?? 0) + 1
      failures.set(id, { id, reason: result.reasons[id] ?? prev?.reason, attempts, nextAt: clock + backoffMs(attempts), firstAt: prev?.firstAt ?? clock })
    }
    for (const id of gone) dirty.delete(id)
    // A revoked note leaves no bookkeeping behind. Usually there is none to
    // clear, but a note revoked WHILE an edit of it was waiting has just been
    // put back in `dirty` by the loop above, with a failure to show in
    // Settings — for a record that is no longer in the list. Left there it
    // would count towards "n unsynced" for good and, worse, suppress the very
    // drop that got us here on every later round.
    for (const id of revoked) {
      dirty.delete(id)
      failures.delete(id)
      shadows.delete(id)
    }

    // The server now holds what we sent: that is the base for any edit still waiting.
    const remoteById = new Map(result.items!.map(r => [r.id, r]))
    const sentById = new Map(outgoing.map(o => [o.id, o]))
    for (const id of decision.accepted) {
      const held = remoteById.get(id) ?? sentById.get(id)
      if (dirty.has(id) && held) shadows.set(id, held)
    }
    for (const id of decision.remerged) {
      const r = remoteById.get(id)
      if (r) shadows.set(id, r)
    }
    for (const id of [...shadows.keys()]) if (!dirty.has(id)) shadows.delete(id)
    for (const id of [...failures.keys()]) if (!dirty.has(id)) failures.delete(id)
    // an everyday round that moved nothing has nothing to write
    if (bookSignature() !== bookBefore) saveBookkeeping()

    // Whose a row is belongs in here beside its stamp. Re-attributing a
    // departing member's work changes `user_id` and touches neither `data` nor
    // `updated_at`, so a signature of id and stamp alone called the round
    // unchanged and published the list this device already had — throwing the
    // merged copy, and the corrected owner with it, away. The device went on
    // believing the row was the member's who left; since v3.19 the revocation
    // pass reads that field, so it would then drop the row on the next round.
    const signature = (list: Item[]) => list.map(p => p.id + '@' + p.updatedAt + '@' + (p.ownerId ?? '')).sort().join('|')
    // The same records, object for object, is the same list — the everyday
    // round that brought nothing — and needs no signature, which sorts and
    // joins every id. `index` is still `current` by id.
    const moved = next.length !== current.length || next.some(i => index.get(i.id) !== i)
    const changed =
      decision.remerged.length > 0 ||
      decision.settled.length > 0 ||
      gone.size > 0 ||
      revoked.size > 0 ||
      removedMidRound.size > 0 ||
      (moved && signature(next) !== signature(current))
    const items = changed ? next : current
    publish({
      items,
      failures: failureList(),
      syncInfo: {
        online: true,
        lastAt: new Date(clock).toISOString(),
        authError: false,
        pending: pendingCount(),
        rejected: decision.rejected.length ? decision.rejected : undefined,
      },
    })
    if (items !== current) schedulePersist()
    if (decision.remerged.length > 0) schedulePush()
    if (decision.conflicts.length > 0) {
      const before = new Map(current.map(i => [i.id, i]))
      const found = decision.conflicts.map(c => ({ ...c, label: recordLabel(before.get(c.id)) }))
      for (const l of [...conflictListeners]) l(found)
    }
    // what the round brought may be another device's next occurrence of a chore ticked here too
    retireDuplicateSpawns()
  }

  function sync(): Promise<boolean> {
    if (!state.loaded || !rpc) return Promise.resolve(false)
    if (inflight) return inflight
    inflight = runRound().finally(() => {
      inflight = null
      removedMidRound.clear()
      if (editedMidRound) {
        editedMidRound = false
        schedulePush()
      }
    })
    return inflight
  }

  /** One more round after the one in flight (if any), for a change that round's snapshot missed. */
  function syncAfterFlight(): Promise<boolean> {
    return inflight ? inflight.then(sync, sync) : sync()
  }

  /** Forget the delta cursor so the next round is a full exchange. */
  function fullResync(): Promise<boolean> {
    forceFull = true
    cursor = null
    saveBookkeeping()
    return syncAfterFlight()
  }

  /**
   * The app is going to the background (or the page away): cancel the
   * debounces, write the cache now and push what is dirty, once, best effort
   * — iOS may kill a suspended app inside either debounce. Safe to call
   * repeatedly; with nothing waiting it does nothing.
   */
  function flush(): void {
    // before anything asynchronous: the page may be gone before the write below commits
    writeJournal()
    if (pushTimer !== undefined) {
      timers.clearTimeout(pushTimer)
      pushTimer = undefined
    }
    if (persistPending()) void persistNow()
    if (remote && state.loaded && dirty.size > 0) void sync()
  }

  /**
   * Another device changed something this account can read (src/realtime.ts
   * says so). A round that STARTS after this moment — the one in flight may
   * have asked before the change landed — and none while the page is hidden,
   * since coming back to it runs one anyway.
   */
  function nudge(): Promise<boolean> {
    if (hidden) return Promise.resolve(false)
    return syncAfterFlight()
  }

  /** (Re)start the periodic round at the pace the page's state calls for, or not at all. */
  function arm(): void {
    if (periodic !== undefined) {
      timers.clearInterval(periodic)
      periodic = undefined
    }
    if (started && remote && !hidden) periodic = timers.setInterval(() => void sync(), live ? LIVE_PERIODIC_MS : PERIODIC_MS)
  }

  /** Start the periodic round. Returns stop. */
  function start(): () => void {
    if (!started) {
      started = true
      arm()
    }
    return stop
  }

  function stop(): void {
    started = false
    arm()
    if (pushTimer !== undefined) {
      timers.clearTimeout(pushTimer)
      pushTimer = undefined
    }
    // an edit still waiting on the debounce is written, not dropped
    if (persistPending()) void persistNow()
  }

  /** A live channel is up (true) or down (false): the periodic round slows to a safety net, or picks up again. */
  function setLive(on: boolean): void {
    if (live === on) return
    live = on
    arm()
  }

  /** The page is hidden: no periodic round until it shows again (watchLifecycle syncs then). */
  function setHidden(on: boolean): void {
    if (hidden === on) return
    hidden = on
    arm()
  }

  return {
    getState: (): EngineState => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    onConflict(listener: (conflicts: EngineConflict[]) => void): () => void {
      conflictListeners.add(listener)
      return () => {
        conflictListeners.delete(listener)
      }
    },
    /** Called when a round put in the Trash an extra next occurrence that held something the one kept does not. */
    onRetired(listener: (retired: RetiredSpawn[]) => void): () => void {
      retiredListeners.add(listener)
      return () => {
        retiredListeners.delete(listener)
      }
    },
    boot,
    signedIn,
    start,
    stop,
    sync,
    nudge,
    setLive,
    setHidden,
    fullResync,
    flush,
    upsert,
    remove,
    restore,
    purge,
    setStatus,
    importItems,
    retainMine,
    keepMine,
    retry,
    discard,
    /**
     * What the server has not confirmed yet: the records with an edit still to
     * push, and its last confirmed copy of each it already had. A photo swapped
     * out of a piece of clothing waits on both (src/media.ts retireMedia).
     */
    unconfirmed: (): { ids: ReadonlySet<string>; shadows: Item[] } => ({ ids: new Set(dirty), shadows: [...shadows.values()] }),
    /**
     * Whether this device holds exactly this version of a record — the same
     * stamp and, when given, the same owner. A change that says so is this
     * device's own push coming back (src/realtime.ts), and needs no round.
     */
    holds(id: string, updatedAt: string, ownerId?: string | null): boolean {
      const cur = index.get(id)
      if (!cur || cur.updatedAt !== updatedAt) return false
      return ownerId == null || (cur.ownerId ?? account) === ownerId
    },
    /** What the engine holds for the next round — for tests and diagnostics. */
    inspect: () => ({
      dirty: [...dirty].sort(),
      shadows: new Map(shadows),
      failures: failureList(),
      cursor,
      syncing: inflight !== null,
      /** How often the periodic round runs now, or null while it is off (stopped, hidden, local mode). */
      pollMs: periodic === undefined ? null : live ? LIVE_PERIODIC_MS : PERIODIC_MS,
      /** Ids the next cache write will put or delete. */
      unsaved: [...unsaved].sort(),
    }),
  }
}

interface Listenable {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

export interface LifecycleEnv {
  document: Listenable & { readonly visibilityState: string }
  window: Listenable
  /** The shell's background event (Capacitor App `pause`); resolves to its disposer. */
  onPause?: (cb: () => void) => Promise<() => void>
}

/**
 * The page's comings and goings, wired to the engine: sync when the app comes
 * back (visible, focus, online), flush when it goes (hidden, pagehide, the
 * shell's pause), and no periodic round while it is hidden — a tab left in the
 * background polled every minute for nobody. Returns a disposer.
 */
export function watchLifecycle(engine: Pick<SyncEngine, 'sync' | 'flush'> & Partial<Pick<SyncEngine, 'setHidden'>>, env: LifecycleEnv): () => void {
  const onVisible = () => {
    if (env.document.visibilityState === 'visible') void engine.sync()
  }
  const onVisibility = () => {
    const away = env.document.visibilityState === 'hidden'
    engine.setHidden?.(away)
    if (away) engine.flush()
    else onVisible()
  }
  // a page opened in a background tab starts without the round
  engine.setHidden?.(env.document.visibilityState === 'hidden')
  const onLeave = () => engine.flush()
  env.document.addEventListener('visibilitychange', onVisibility)
  env.window.addEventListener('focus', onVisible)
  env.window.addEventListener('online', onVisible)
  env.window.addEventListener('pagehide', onLeave)
  let disposed = false
  let stopPause: (() => void) | null = null
  void env.onPause?.(onLeave).then(stop => {
    if (disposed) stop()
    else stopPause = stop
  })
  return () => {
    disposed = true
    env.document.removeEventListener('visibilitychange', onVisibility)
    env.window.removeEventListener('focus', onVisible)
    env.window.removeEventListener('online', onVisible)
    env.window.removeEventListener('pagehide', onLeave)
    stopPause?.()
  }
}
