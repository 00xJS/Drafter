import { Item, Project, SOCIAL_PROJECT_ID, Task, TaskStatus } from './types'
import { migrateStored, sanitizeItem, STORAGE_VERSION } from './schema'
import { applySync, mergeItems, newerStamp, nextOccurrence, pullSince, purgeTombstones, type SyncConflict } from './itemops'
import { applyLocalChoice } from '../shared/merge.mjs'
import { withPaidDefault } from './bills'
import { uid } from './utils'
import { purgeTombstone, type SyncResult } from './sync'
import {
  clearSyncCursor,
  prepareFullResync,
  readCursor,
  readDirty,
  readFailures,
  writeCursor,
  writeDirty,
  writeFailures,
  type KV,
  type SyncFailure,
} from './syncstate'

// The sync engine: everything that keeps this device's records and the
// server's in step, as a plain module with its world injected — the RPC, the
// clock, the storage and the timers — so every rule below runs under a test
// with fake timers and a fake server. It used to live inside the useItems hook,
// where the dirty set, the cursor and the round orchestration sat in React
// state and effects, side effects ran inside state updaters, and a ref could
// hand a round a stale list. store.ts is now only the React adapter over this.

const LEGACY_LS_KEY = 'drafter:v1' // pre-IndexedDB builds
/** The IndexedDB write waits this long after the last change, off the render hot path. */
const PERSIST_MS = 300
/** A local edit is pushed this long after the last one, so a burst of typing is one round. */
const PUSH_MS = 2000
const PERIODIC_MS = 60_000
const BACKOFF_BASE_MS = 30_000
const BACKOFF_CAP_MS = 30 * 60_000

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
}

export interface SyncStorage {
  readSnapshot(): Promise<unknown>
  writeSnapshot(record: CacheRecord): Promise<unknown>
  /** Wipe every trace of an account from this device (clearLocalData in the app). */
  clearAll(): Promise<void>
  /** The dirty set, the cursor and the refusals: small, synchronous, written as they change. */
  kv: KV
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

export interface EngineState {
  items: Item[]
  /** False until the local cache has been read (avoids empty-state flashes). */
  loaded: boolean
  syncInfo: SyncInfo
  /** Rows the server refused, oldest refusal first. */
  failures: SyncFailure[]
}

const defaultTimers: SyncTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: h => globalThis.clearTimeout(h as number),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: h => globalThis.clearInterval(h as number),
}

/** Tasks blocked only by done tasks move to To do once their last blocker completes. */
function releaseBlocked(list: Item[]): Item[] {
  const doneIds = new Set(list.filter(i => i.kind === 'task' && i.status === 'done').map(i => i.id))
  const live = new Set(list.filter(i => i.kind === 'task' && !i.deletedAt).map(i => i.id))
  let changed = false
  const next = list.map(i => {
    if (i.kind !== 'task' || i.status !== 'blocked' || !i.blockedBy?.length) return i
    const stillBlocked = i.blockedBy.some(id => live.has(id) && !doneIds.has(id))
    if (stillBlocked) return i
    changed = true
    return { ...i, status: 'todo' as TaskStatus, updatedAt: newerStamp(i.updatedAt) }
  })
  return changed ? next : list
}

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

export type SyncEngine = ReturnType<typeof createSyncEngine>

export function createSyncEngine(deps: SyncEngineDeps) {
  const rpc = deps.rpc
  /** Local mode has no server: nothing is dirty, nothing is pending, nothing is shadowed. */
  const remote = rpc !== null
  const { storage } = deps
  const kv = storage.kv
  const now = deps.now ?? (() => Date.now())
  const timers = deps.timers ?? defaultTimers

  let state: EngineState = { items: [], loaded: false, syncInfo: { online: false, authError: false }, failures: [] }
  const listeners = new Set<() => void>()
  const conflictListeners = new Set<(conflicts: EngineConflict[]) => void>()

  /** The account the cache on disk belongs to (null until known, and in local mode). */
  let account: string | null = null
  let bootGen = 0
  let dirty = new Set<string>()
  /** The last version the server confirmed of each dirty record: the base a concurrent edit merges against. */
  let shadows = new Map<string, Item>()
  let failures = new Map<string, SyncFailure>()

  let persistTimer: unknown = undefined
  let pushTimer: unknown = undefined
  let periodic: unknown = undefined
  // the round in flight, if any: a second call joins it instead of starting
  // another, so a pull-down during the foreground sync waits for that sync
  let inflight: Promise<boolean> | null = null
  /** A local edit landed while a round was in flight: it missed that round's snapshot and gets its own push. */
  let editedMidRound = false
  /** Ids discarded outright while a round was in flight: its answer must not bring the local copy back. */
  const removedMidRound = new Set<string>()
  /** The next successful round is a full exchange, whatever the stored cursor says. */
  let forceFull = false

  function publish(patch: Partial<EngineState>): void {
    state = { ...state, ...patch }
    for (const l of [...listeners]) l()
  }

  function failureList(): SyncFailure[] {
    return [...failures.values()].sort((a, b) => a.firstAt - b.firstAt || a.id.localeCompare(b.id))
  }

  function pendingCount(): number {
    return remote ? dirty.size : 0
  }

  function saveBookkeeping(): void {
    writeDirty(dirty, kv)
    writeFailures(failures, kv)
  }

  /** Drop bookkeeping for ids with nothing left to push (removed by retainMine, a wipe, an old purge). */
  function pruneBookkeeping(): void {
    const ids = new Set(state.items.map(i => i.id))
    let changed = false
    for (const id of [...dirty]) {
      if (ids.has(id)) continue
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

  async function persistNow(): Promise<void> {
    if (persistTimer !== undefined) {
      timers.clearTimeout(persistTimer)
      persistTimer = undefined
    }
    // never overwrite the cache with the empty state from before it was read
    if (!state.loaded) return
    const snapshot = state.items
    const record: CacheRecord = { version: STORAGE_VERSION, userId: account, items: snapshot }
    if (remote && shadows.size > 0) record.shadows = [...shadows.values()]
    try {
      await storage.writeSnapshot(record)
      // legacy cache retired only once the new cache holds real data
      if (snapshot.length > 0) kv.removeItem(LEGACY_LS_KEY)
    } catch (e) {
      console.error('Failed to save the local cache', e)
    }
  }

  function schedulePersist(): void {
    if (persistTimer !== undefined) timers.clearTimeout(persistTimer)
    persistTimer = timers.setTimeout(() => {
      persistTimer = undefined
      void persistNow()
    }, PERSIST_MS)
  }

  function schedulePush(): void {
    if (!remote) return
    if (pushTimer !== undefined) timers.clearTimeout(pushTimer)
    pushTimer = timers.setTimeout(() => {
      pushTimer = undefined
      void sync()
    }, PUSH_MS)
  }

  async function loadCache(myId: string | null): Promise<{ items: Item[]; shadows: Item[]; wiped: boolean }> {
    try {
      const cached = (await storage.readSnapshot()) as { userId?: string | null; shadows?: unknown } | undefined
      // a cache written by a different account must never be adopted or re-synced
      if (cached && myId && cached.userId && cached.userId !== myId) {
        await storage.clearAll()
        return { items: [], shadows: [], wiped: true }
      }
      if (cached) {
        const migrated = migrateStored(cached)
        // an empty cache must not shadow a legacy localStorage store (e.g. an
        // interrupted first run of this version)
        if (migrated && migrated.length > 0) {
          return { items: purgeTombstones(migrated, now()), shadows: migrateStored(Array.isArray(cached.shadows) ? cached.shadows : []) ?? [], wiped: false }
        }
      }
      // migration from the old localStorage cache — non-destructive: the legacy
      // key is only removed after the IndexedDB cache has persisted real data
      const raw = kv.getItem(LEGACY_LS_KEY)
      if (raw !== null) {
        const migrated = migrateStored(JSON.parse(raw))
        if (migrated && migrated.length > 0) return { items: purgeTombstones(migrated, now()), shadows: [], wiped: false }
      }
    } catch (e) {
      console.error('Failed to load the local cache', e)
    }
    return { items: [], shadows: [], wiped: false }
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
    if (persistTimer !== undefined) await persistNow()
    account = myId
    const wasLoaded = state.loaded
    const cached = await loadCache(myId)
    if (gen !== bootGen) return
    if (wasLoaded && !cached.wiped && before === myId) {
      // the same account again (a remount): memory is at least as new as the cache just written
      void sync()
      return
    }
    // reread after a possible wipe: the bookkeeping belongs to whoever the cache belongs to
    dirty = remote ? readDirty(kv) : new Set()
    failures = remote ? readFailures(kv) : new Map()
    // Empty local + cloud: a leftover cursor would delta-pull nothing → blank UI
    // while the server still has data (stuck after wipe / sign-out race).
    if (myId && cached.items.length === 0) {
      prepareFullResync({ clearDirty: true }, kv)
      dirty = new Set()
      failures = new Map()
      writeFailures(failures, kv)
    }
    shadows = new Map(cached.shadows.filter(s => dirty.has(s.id)).map(s => [s.id, s]))
    // No blanket re-push of whole kinds on boot: a rejected id stays in the
    // persisted dirty set, so a new session pushes it again on its own. The
    // blanket version re-sent every place, recipe, meal, grocery list, journal
    // entry and event on every load — none of which the server echoed back,
    // so none could ever be confirmed, and all of them read as "n unsynced".
    publish({ items: ensureProjects(cached.items), loaded: true, failures: failureList() })
    schedulePersist()
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
    if (state.items.length === 0) {
      prepareFullResync({ clearDirty: true }, kv)
      dirty = new Set()
    }
    if (state.loaded) void sync()
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
      const before = new Map(prev.map(i => [i.id, i]))
      const ids = new Set(touched)
      for (const i of next) if (before.get(i.id) !== i) ids.add(i.id)
      const present = new Set(next.map(i => i.id))
      for (const id of ids) {
        if (!present.has(id)) continue
        if (!dirty.has(id)) {
          const base = before.get(id)
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

  function upsert(item: Item): void {
    const list = state.items
    const old = list.find(x => x.id === item.id)
    if (item.kind === 'task' && item.status === 'done' && !(old?.kind === 'task' && old.status === 'done')) item = withPaidDefault(item)
    let next = old ? list.map(x => (x.id === item.id ? item : x)) : [...list, item]
    const touched = [item.id]
    if (item.kind === 'task' && item.status === 'done' && old?.kind === 'task' && old.status !== 'done' && item.recurrence) {
      const spawn = nextOccurrence(item, uid)
      if (spawn) {
        touched.push(spawn.id)
        const done = item
        next = next.map(x => (x.id === done.id ? { ...done, recurrence: undefined } : x)).concat(spawn)
      }
    }
    commit(ensureProjects(releaseBlocked(next)), touched)
  }

  function remove(id: string): void {
    const list = state.items
    if (!list.some(p => p.id === id)) return
    const deletedAt = new Date(now()).toISOString()
    commit(
      list.map(p => (p.id === id ? { ...p, deletedAt, updatedAt: newerStamp(p.updatedAt) } : p)),
      [id],
    )
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

  function setStatus(id: string, status: TaskStatus): StatusChange | null {
    const old = state.items.find(x => x.id === id)
    if (!old || old.kind !== 'task' || old.status === status) return null
    const updated = stampStatus(old, status)
    let spawned: Task | null = null
    if (status === 'done' && old.status !== 'done' && updated.recurrence) spawned = nextOccurrence(updated, uid)
    const stored: Task = spawned ? { ...updated, recurrence: undefined } : updated
    let next: Item[] = state.items.map(x => (x.id === id ? stored : x))
    if (spawned) next = next.concat(spawned)
    commit(releaseBlocked(next), spawned ? [id, spawned.id] : [id])
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
      const tomb = sanitizeItem(purgeTombstone(p.kind, p.id, newerStamp(p.updatedAt), deletedAt))
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
      clearSyncCursor(kv)
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
      result = { items: null, rejected: [], reasons: {}, stale: [], gone: [], authError: false, reportsRejections: false }
    }
    if (result.items !== null) return result
    publish({ syncInfo: { online: false, lastAt: state.syncInfo.lastAt, authError: result.authError, pending: pendingCount(), rejected: state.syncInfo.rejected } })
    return null
  }

  /**
   * What goes out: the dirty set (not "updatedAt > cursor") so late/offline
   * stamps still go out. A refused row waits out its backoff — except in a
   * full exchange, which sends everything.
   */
  function outgoingFor(since: string | null, clock: number): Item[] {
    if (!since) return state.items
    return state.items.filter(p => dirty.has(p.id) && (failures.get(p.id)?.nextAt ?? 0) <= clock)
  }

  /** One round of push-and-pull; sync() is the only caller and serialises it. */
  async function runRound(): Promise<boolean> {
    const full = forceFull
    let since = full ? null : readCursor(kv)
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
      since = readCursor(kv)
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
    const decision = applySync(current, outgoing, result.items!, since, result.rejected, result.reportsRejections, {
      dirty,
      shadows,
      stale: result.stale,
    })
    let next = decision.merged
    // purged for good on the server: removed here, never pushed again
    if (gone.size > 0 || removedMidRound.size > 0) next = next.filter(i => !gone.has(i.id) && !removedMidRound.has(i.id))
    next = ensureProjects(purgeTombstones(next, clock))
    if (decision.cursor) writeCursor(decision.cursor, kv)

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
    saveBookkeeping()

    const signature = (list: Item[]) => list.map(p => p.id + '@' + p.updatedAt).sort().join('|')
    const changed =
      decision.remerged.length > 0 || decision.settled.length > 0 || gone.size > 0 || removedMidRound.size > 0 || signature(next) !== signature(current)
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
    clearSyncCursor(kv)
    return syncAfterFlight()
  }

  /**
   * The app is going to the background (or the page away): cancel the
   * debounces, write the cache now and push what is dirty, once, best effort
   * — iOS may kill a suspended app inside either debounce. Safe to call
   * repeatedly; with nothing waiting it does nothing.
   */
  function flush(): void {
    if (pushTimer !== undefined) {
      timers.clearTimeout(pushTimer)
      pushTimer = undefined
    }
    if (persistTimer !== undefined) void persistNow()
    if (remote && state.loaded && dirty.size > 0) void sync()
  }

  /** Start the periodic round. Returns stop. */
  function start(): () => void {
    if (periodic === undefined && remote) periodic = timers.setInterval(() => void sync(), PERIODIC_MS)
    return stop
  }

  function stop(): void {
    if (periodic !== undefined) {
      timers.clearInterval(periodic)
      periodic = undefined
    }
    if (pushTimer !== undefined) {
      timers.clearTimeout(pushTimer)
      pushTimer = undefined
    }
    // an edit still waiting on the debounce is written, not dropped
    if (persistTimer !== undefined) void persistNow()
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
    boot,
    signedIn,
    start,
    stop,
    sync,
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
    /** What the engine holds for the next round — for tests and diagnostics. */
    inspect: () => ({ dirty: [...dirty].sort(), shadows: new Map(shadows), failures: failureList(), cursor: readCursor(kv), syncing: inflight !== null }),
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
 * shell's pause). Returns a disposer.
 */
export function watchLifecycle(engine: Pick<SyncEngine, 'sync' | 'flush'>, env: LifecycleEnv): () => void {
  const onVisible = () => {
    if (env.document.visibilityState === 'visible') void engine.sync()
  }
  const onVisibility = () => {
    if (env.document.visibilityState === 'hidden') engine.flush()
    else onVisible()
  }
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
