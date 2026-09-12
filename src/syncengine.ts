import { Item, Project, SOCIAL_PROJECT_ID, Task, TaskStatus } from './types'
import { migrateStored, sanitizeItem, STORAGE_VERSION } from './schema'
import { applySync, mergeItems, newerStamp, nextOccurrence, pullSince, purgeTombstones } from './itemops'
import { withPaidDefault } from './bills'
import { uid } from './utils'
import { purgeRemote, type SyncResult } from './sync'
import { clearSyncCursor, prepareFullResync, readCursor, readDirty, writeCursor, writeDirty, type KV } from './syncstate'

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
/** Kinds the server used to drop silently — keep retrying so they survive a new session. */
const RETRY_KINDS = new Set(['place', 'recipe', 'meal', 'grocery', 'journal', 'event', 'habit', 'routine'])

export interface SyncInfo {
  online: boolean
  lastAt?: string
  /** The session is expired/invalid — the fix is signing in, not waiting. */
  authError: boolean
  /** Changes waiting to push (dirty set size). */
  pending?: number
  /** Ids the server rejected on the last round (validation/RLS) — no longer retried. */
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

/** The IndexedDB cache record. */
export interface CacheRecord {
  version: number
  userId?: string | null
  items: Item[]
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
  /** Epoch ms; deletions and "last synced" read it. Stamps use newerStamp (Date.now). */
  now?: () => number
  timers?: SyncTimers
}

export interface EngineState {
  items: Item[]
  /** False until the local cache has been read (avoids empty-state flashes). */
  loaded: boolean
  syncInfo: SyncInfo
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

export type SyncEngine = ReturnType<typeof createSyncEngine>

export function createSyncEngine(deps: SyncEngineDeps) {
  const rpc = deps.rpc
  /** Local mode has no server: nothing is dirty, nothing is pending, nothing is shadowed. */
  const remote = rpc !== null
  const { storage } = deps
  const kv = storage.kv
  const now = deps.now ?? (() => Date.now())
  const timers = deps.timers ?? defaultTimers

  let state: EngineState = { items: [], loaded: false, syncInfo: { online: false, authError: false } }
  const listeners = new Set<() => void>()

  /** The account the cache on disk belongs to (null until known, and in local mode). */
  let account: string | null = null
  let bootGen = 0
  let dirty = new Set<string>()

  let persistTimer: unknown = undefined
  let pushTimer: unknown = undefined
  let periodic: unknown = undefined
  // the round in flight, if any: a second call joins it instead of starting
  // another, so a pull-down during the foreground sync waits for that sync
  let inflight: Promise<boolean> | null = null
  /** A local edit landed while a round was in flight: it missed that round's snapshot and gets its own push. */
  let editedMidRound = false
  /** The next successful round is a full exchange, whatever the stored cursor says. */
  let forceFull = false

  function publish(patch: Partial<EngineState>): void {
    state = { ...state, ...patch }
    for (const l of [...listeners]) l()
  }

  function pendingCount(): number {
    return remote ? dirty.size : 0
  }

  function saveBookkeeping(): void {
    writeDirty(dirty, kv)
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

  async function loadCache(myId: string | null): Promise<{ items: Item[]; wiped: boolean }> {
    try {
      const cached = (await storage.readSnapshot()) as { userId?: string | null } | undefined
      // a cache written by a different account must never be adopted or re-synced
      if (cached && myId && cached.userId && cached.userId !== myId) {
        await storage.clearAll()
        return { items: [], wiped: true }
      }
      if (cached) {
        const migrated = migrateStored(cached)
        // an empty cache must not shadow a legacy localStorage store (e.g. an
        // interrupted first run of this version)
        if (migrated && migrated.length > 0) return { items: purgeTombstones(migrated, now()), wiped: false }
      }
      // migration from the old localStorage cache — non-destructive: the legacy
      // key is only removed after the IndexedDB cache has persisted real data
      const raw = kv.getItem(LEGACY_LS_KEY)
      if (raw !== null) {
        const migrated = migrateStored(JSON.parse(raw))
        if (migrated && migrated.length > 0) return { items: purgeTombstones(migrated, now()), wiped: false }
      }
    } catch (e) {
      console.error('Failed to load the local cache', e)
    }
    return { items: [], wiped: false }
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
    // Empty local + cloud: a leftover cursor would delta-pull nothing → blank UI
    // while the server still has data (stuck after wipe / sign-out race).
    if (myId && cached.items.length === 0) {
      prepareFullResync({ clearDirty: true }, kv)
      dirty = new Set()
    }
    // No blanket re-push of whole kinds on boot: a rejected id of a retried kind stays in
    // the persisted dirty set, so a new session pushes it again on its own. The
    // blanket version re-sent every place, recipe, meal, grocery list, journal
    // entry and event on every load — none of which the server echoed back,
    // so none could ever be confirmed, and all of them read as "n unsynced".
    publish({ items: ensureProjects(cached.items), loaded: true })
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
    saveBookkeeping()
    publish({ items: [], syncInfo: { online: false, authError: false } })
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
   * spawn), becomes dirty.
   */
  function commit(next: Item[], touched: Iterable<string> = []): void {
    const prev = state.items
    if (next === prev) return
    if (remote) {
      const before = new Map(prev.map(i => [i.id, i]))
      const ids = new Set(touched)
      for (const i of next) if (before.get(i.id) !== i) ids.add(i.id)
      const present = new Set(next.map(i => i.id))
      for (const id of ids) if (present.has(id)) dirty.add(id)
      saveBookkeeping()
      if (inflight) editedMidRound = true
    }
    publish({ items: next })
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

  /** Hard-delete: gone from this device and from the database, no undo. */
  async function purge(ids: string[]): Promise<void> {
    const snapshot = state.items
    const set = new Set(ids)
    for (const id of ids) dirty.delete(id)
    saveBookkeeping()
    replaceItems(snapshot.filter(p => !set.has(p.id)))
    await purgeRemote(ids, snapshot)
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

  /** What goes out: the dirty set (not "updatedAt > cursor") so late/offline stamps still go out; everything in a full exchange. */
  function outgoingFor(since: string | null): Item[] {
    return since ? state.items.filter(p => dirty.has(p.id)) : state.items
  }

  /** One round of push-and-pull; sync() is the only caller and serialises it. */
  async function runRound(): Promise<boolean> {
    const full = forceFull
    const since = full ? null : readCursor(kv)
    const clock = now()
    pruneBookkeeping()
    editedMidRound = false
    const outgoing = outgoingFor(since)
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
    const decision = applySync(current, outgoing, result.items!, since, result.rejected, result.reportsRejections)
    const next = ensureProjects(purgeTombstones(decision.merged, clock))
    if (decision.cursor) writeCursor(decision.cursor, kv)

    // What still has to go out: anything unconfirmed. Places,
    // kitchen and the newer kinds used to be dropped by an older sync_posts
    // allow-list — a rejected id of those kinds stays dirty so the next
    // session pushes it again; any other rejected id is dropped.
    const retryIds = new Set(decision.unconfirmed)
    const keepRejected = new Set(
      decision.rejected.filter(id => {
        const row = outgoing.find(i => i.id === id) ?? current.find(i => i.id === id)
        return row != null && RETRY_KINDS.has(row.kind)
      }),
    )
    for (const o of outgoing) if (!retryIds.has(o.id) && !keepRejected.has(o.id)) dirty.delete(o.id)
    for (const id of keepRejected) dirty.add(id)
    for (const id of decision.rejected) if (!keepRejected.has(id)) dirty.delete(id)

    saveBookkeeping()

    const signature = (list: Item[]) => list.map(p => p.id + '@' + p.updatedAt).sort().join('|')
    const changed = signature(next) !== signature(current)
    const items = changed ? next : current
    publish({
      items,
      syncInfo: {
        online: true,
        lastAt: new Date(clock).toISOString(),
        authError: false,
        pending: pendingCount(),
        rejected: decision.rejected.length ? decision.rejected : undefined,
      },
    })
    if (items !== current) schedulePersist()
  }

  function sync(): Promise<boolean> {
    if (!state.loaded || !rpc) return Promise.resolve(false)
    if (inflight) return inflight
    inflight = runRound().finally(() => {
      inflight = null
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
    boot,
    signedIn,
    start,
    stop,
    sync,
    fullResync,
    upsert,
    remove,
    restore,
    purge,
    setStatus,
    importItems,
    retainMine,
    /** What the engine holds for the next round — for tests and diagnostics. */
    inspect: () => ({ dirty: [...dirty].sort(), cursor: readCursor(kv), syncing: inflight !== null }),
  }
}

interface Listenable {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

export interface LifecycleEnv {
  document: Listenable & { readonly visibilityState: string }
  window: Listenable
}

/** The periodic round's partner: a round whenever the app comes back to the foreground. Returns a disposer. */
export function watchLifecycle(engine: Pick<SyncEngine, 'sync'>, env: LifecycleEnv): () => void {
  const onVisible = () => {
    if (env.document.visibilityState === 'visible') void engine.sync()
  }
  env.document.addEventListener('visibilitychange', onVisible)
  env.window.addEventListener('focus', onVisible)
  env.window.addEventListener('online', onVisible)
  return () => {
    env.document.removeEventListener('visibilitychange', onVisible)
    env.window.removeEventListener('focus', onVisible)
    env.window.removeEventListener('online', onVisible)
  }
}
