import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarEntry, CalendarSource, GroceryList, Habit, Item, JournalEntry, Meal, Person, Place, Project, Recipe, Review, Routine, SOCIAL_PROJECT_ID, Task, TaskStatus, Template } from './types'
import { migrateStored, sanitizeItem, STORAGE_VERSION } from './schema'
import { applySync, mergeItems, newerStamp, nextOccurrence, pullSince, purgeTombstones } from './itemops'
import { haptic } from './native'
import { uid } from './utils'
import { withPaidDefault } from './bills'
import { purgeRemote, syncNow } from './sync'
import { clearLocalData, idbGet, idbSet } from './idb'
import { clearSyncCursor, prepareFullResync, readCursor, readDirty, writeCursor, writeDirty } from './syncstate'
import { getSupabase } from './supabase'

const LEGACY_LS_KEY = 'drafter:v1' // pre-IndexedDB builds
/** Kinds the server used to drop silently — keep retrying so they survive a new session. */
const RETRY_KINDS = new Set(['place', 'recipe', 'meal', 'grocery', 'journal', 'event', 'habit', 'routine'])
/** Kinds that belong to one account even inside a household. */
const PERSONAL_KINDS = new Set(['journal', 'review', 'calendar', 'habit', 'routine'])

async function loadCache(myId: string | null): Promise<Item[]> {
  try {
    const cached = await idbGet<{ version: number; userId?: string | null; items?: unknown[]; posts?: unknown[] }>('posts', 'all')
    // a cache written by a different account must never be adopted or re-synced
    if (cached && myId && cached.userId && cached.userId !== myId) {
      await clearLocalData()
      return []
    }
    if (cached) {
      const migrated = migrateStored(cached)
      // an empty cache must not shadow a legacy localStorage store (e.g. an
      // interrupted first run of this version)
      if (migrated && migrated.length > 0) return purgeTombstones(migrated)
    }
    // migration from the old localStorage cache — non-destructive: the legacy
    // key is only removed after the IndexedDB cache has persisted real data
    // (the boot effect can run twice under StrictMode/remounts)
    const raw = localStorage.getItem(LEGACY_LS_KEY)
    if (raw !== null) {
      const migrated = migrateStored(JSON.parse(raw))
      if (migrated && migrated.length > 0) return purgeTombstones(migrated)
    }
  } catch (e) {
    console.error('Failed to load the local cache', e)
  }
  return []
}

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

export interface Store {
  /** Live tasks (tombstoned ones filtered out) — what every view renders. */
  tasks: Task[]
  /** Live projects. */
  projects: Project[]
  /** Subscribed external calendars. */
  calendars: CalendarSource[]
  /** People you track visits with. */
  people: Person[]
  /** Places you track outings at. */
  places: Place[]
  recipes: Recipe[]
  meals: Meal[]
  /** Calendar entries you wrote yourself (start AND end), oldest first. */
  events: CalendarEntry[]
  groceries: GroceryList[]
  /** Your journal entries (personal, newest day first). */
  journal: JournalEntry[]
  reviews: Review[]
  /** Your habits (personal), in card order. */
  habits: Habit[]
  /** Your routines (personal), in card order. */
  routines: Routine[]
  templates: Template[]
  /** Everything including tombstones — for sync only. */
  allItems: Item[]
  /**
   * Everything I may see: allItems minus other household members' personal
   * records (journal, review, calendar). Trash, JSON export and counts use this
   * so a peer's deleted diary never shows up in my bin.
   */
  visibleItems: Item[]
  /** False until the local cache has been read (avoids empty-state flashes). */
  loaded: boolean
  syncInfo: SyncInfo
  upsert(item: Item): void
  remove(id: string): void
  restore(ids: string[]): void
  /** Hard-delete: gone from this device and from the database, no undo. */
  purge(ids: string[]): Promise<void>
  /** Returns what changed so the caller can offer Undo. */
  setStatus(id: string, status: TaskStatus): StatusChange | null
  importItems(incoming: unknown[]): ImportSummary
  syncNowManual(): Promise<boolean>
  /** Forget the delta cursor so the next sync is a full exchange. */
  fullResync(): Promise<boolean>
  /** Drop peer-owned rows after leaving a household (keeps unowned + mine). */
  retainMine(myId: string | null): void
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

export function useItems(myId: string | null = null): Store {
  const [items, setItems] = useState<Item[]>([])
  const [loaded, setLoaded] = useState(false)
  const [syncInfo, setSyncInfo] = useState<SyncInfo>({ online: false, authError: false })
  const itemsRef = useRef(items)
  itemsRef.current = items
  const loadedRef = useRef(false)
  const pushTimer = useRef<number | undefined>(undefined)
  const persistTimer = useRef<number | undefined>(undefined)
  const syncBusy = useRef(false)

  const markDirty = (ids: string | string[]) => {
    const dirty = readDirty()
    for (const id of Array.isArray(ids) ? ids : [ids]) dirty.add(id)
    writeDirty(dirty)
  }

  const doSync = async (): Promise<boolean> => {
    if (syncBusy.current || !loadedRef.current) return false
    syncBusy.current = true
    try {
      const since = readCursor()
      const dirty = readDirty()
      const local = itemsRef.current
      // push the dirty set (not "updatedAt > cursor") so late/offline stamps still go out
      const outgoing = since ? local.filter(p => dirty.has(p.id)) : local
      const result = await syncNow(outgoing, pullSince(since))
      if (result.items === null) {
        setSyncInfo(s => ({ online: false, lastAt: s.lastAt, authError: result.authError, pending: dirty.size, rejected: s.rejected }))
        return false
      }
      let decision: ReturnType<typeof applySync> | null = null
      setItems(cur => {
        decision = applySync(cur, outgoing, result.items!, since, result.rejected)
        const next = ensureProjects(purgeTombstones(decision.merged))
        const signature = (list: Item[]) => list.map(p => p.id + '@' + p.updatedAt).sort().join('|')
        return signature(next) === signature(cur) ? cur : next
      })
      // React does not promise the updater above ran synchronously; without a
      // fallback the bookkeeping below would treat every pushed id as confirmed
      // and drop it from the dirty set.
      const applied =
        (decision as ReturnType<typeof applySync> | null) ??
        applySync(itemsRef.current, outgoing, result.items, since, result.rejected)
      if (applied.cursor) writeCursor(applied.cursor)
      // clear confirmed + rejected from dirty; keep unconfirmed for retry.
      // Places/kitchen used to be dropped by an older sync_posts allow-list —
      // leave those ids dirty so the next session pushes them again.
      const still = readDirty()
      const retry = new Set(applied.unconfirmed)
      const keepRejected = new Set(
        applied.rejected.filter(id => {
          const row = outgoing.find(i => i.id === id) ?? itemsRef.current.find(i => i.id === id)
          return row != null && RETRY_KINDS.has(row.kind)
        }),
      )
      for (const o of outgoing) {
        if (retry.has(o.id) || keepRejected.has(o.id)) continue
        still.delete(o.id)
      }
      for (const id of keepRejected) still.add(id)
      for (const id of applied.rejected) {
        if (!keepRejected.has(id)) still.delete(id)
      }
      writeDirty(still)
      setSyncInfo({
        online: true,
        lastAt: new Date().toISOString(),
        authError: false,
        pending: still.size,
        rejected: applied.rejected.length ? applied.rejected : undefined,
      })
      return true
    } finally {
      syncBusy.current = false
    }
  }
  const doSyncRef = useRef(doSync)
  doSyncRef.current = doSync

  // boot: read the IndexedDB cache, then do a first sync
  useEffect(() => {
    let live = true
    loadCache(myId).then(cached => {
      if (!live) return
      // Empty local + cloud: a leftover cursor would delta-pull nothing → blank UI
      // while the server still has data (stuck after wipe / sign-out race).
      if (myId && cached.length === 0) prepareFullResync({ clearDirty: true })
      setItems(ensureProjects(cached))
      const heal = cached.filter(i => RETRY_KINDS.has(i.kind)).map(i => i.id)
      if (heal.length) markDirty(heal)
      loadedRef.current = true
      setLoaded(true)
      doSyncRef.current()
    })
    return () => {
      live = false
    }
  }, [myId])

  // Sign-in: force a full exchange only when this device has nothing locally —
  // a leftover cursor would delta-pull nothing into an empty UI. With rows
  // present the cursor is still good, and supabase re-emits SIGNED_IN on every
  // tab focus: resetting there would re-send the whole store each time and, in
  // doing so, clear the dirty flag of anything edited mid-round.
  useEffect(() => {
    const sb = getSupabase()
    if (!sb) return
    const { data: sub } = sb.auth.onAuthStateChange(event => {
      if (event !== 'SIGNED_IN') return
      if (itemsRef.current.length === 0) prepareFullResync({ clearDirty: true })
      if (loadedRef.current) void doSyncRef.current()
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  // periodic sync + sync when the app returns to the foreground
  useEffect(() => {
    const t = window.setInterval(() => doSyncRef.current(), 60_000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') doSyncRef.current()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    window.addEventListener('online', onVisible)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      window.removeEventListener('online', onVisible)
    }
  }, [])

  // persist (debounced, off the render hot path) + schedule a push
  useEffect(() => {
    if (!loaded) return
    window.clearTimeout(persistTimer.current)
    persistTimer.current = window.setTimeout(() => {
      const snapshot = itemsRef.current
      idbSet('posts', 'all', { version: STORAGE_VERSION, userId: myId, items: snapshot })
        .then(() => {
          // legacy cache retired only once the new cache holds real data
          if (snapshot.length > 0) localStorage.removeItem(LEGACY_LS_KEY)
        })
        .catch(e => console.error('Failed to save the local cache', e))
    }, 300)
    window.clearTimeout(pushTimer.current)
    pushTimer.current = window.setTimeout(() => doSyncRef.current(), 2000)
    return () => {
      window.clearTimeout(persistTimer.current)
      window.clearTimeout(pushTimer.current)
    }
  }, [items, loaded, myId])

  // Calendar subscriptions and reviews are personal: only mine (or unowned,
  // pre-household rows) show. Declared BEFORE every memo that calls it — a
  // const used above its declaration throws once the list is non-empty, which
  // took down the whole app the first time a review was saved.
  const isMine = (i: Item) => !i.ownerId || !myId || i.ownerId === myId

  const tasks = useMemo(() => items.filter((i): i is Task => i.kind === 'task' && !i.deletedAt), [items])
  const projects = useMemo(
    () =>
      items
        .filter((i): i is Project => i.kind === 'project' && !i.deletedAt)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [items],
  )
  const people = useMemo(
    () =>
      items
        .filter((i): i is Person => i.kind === 'person' && !i.deletedAt)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [items],
  )
  const places = useMemo(
    () =>
      items
        .filter((i): i is Place => i.kind === 'place' && !i.deletedAt)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [items],
  )
  const recipes = useMemo(
    () =>
      items
        .filter((i): i is Recipe => i.kind === 'recipe' && !i.deletedAt)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [items],
  )
  const meals = useMemo(
    () => items.filter((i): i is Meal => i.kind === 'meal' && !i.deletedAt).sort((a, b) => a.date.localeCompare(b.date)),
    [items],
  )
  const groceries = useMemo(
    () => items.filter((i): i is GroceryList => i.kind === 'grocery' && !i.deletedAt),
    [items],
  )
  // Entries you wrote yourself. Household-visible like tasks: a block of time
  // on a family calendar is meant to be seen, unlike a `calendar` subscription.
  const events = useMemo(
    () => items.filter((i): i is CalendarEntry => i.kind === 'event' && !i.deletedAt).sort((a, b) => a.start.localeCompare(b.start)),
    [items],
  )
  const visibleItems = useMemo(
    () => items.filter(i => !PERSONAL_KINDS.has(i.kind) || isMine(i)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, myId],
  )
  // Journal entries are personal, like reviews: only mine (or unowned, local-mode rows).
  const journal = useMemo(
    () =>
      items
        .filter((i): i is JournalEntry => i.kind === 'journal' && !i.deletedAt && isMine(i))
        .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, myId],
  )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reviews = useMemo(() => items.filter((i): i is Review => i.kind === 'review' && !i.deletedAt && isMine(i)), [items, myId])
  const habits = useMemo(
    () =>
      items
        .filter((i): i is Habit => i.kind === 'habit' && !i.deletedAt && !i.archivedAt && isMine(i))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt.localeCompare(b.createdAt)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, myId],
  )
  const routines = useMemo(
    () =>
      items
        .filter((i): i is Routine => i.kind === 'routine' && !i.deletedAt && !i.archivedAt && isMine(i))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt.localeCompare(b.createdAt)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, myId],
  )
  const templates = useMemo(
    () => items.filter((i): i is Template => i.kind === 'template' && !i.deletedAt).sort((a, b) => a.name.localeCompare(b.name)),
    [items],
  )
  const calendars = useMemo(
    () =>
      items
        .filter((i): i is CalendarSource => i.kind === 'calendar' && !i.deletedAt && isMine(i))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, myId],
  )

  return {
    tasks,
    projects,
    calendars,
    people,
    places,
    recipes,
    meals,
    events,
    groceries,
    journal,
    reviews,
    habits,
    routines,
    templates,
    allItems: items,
    visibleItems,
    loaded,
    syncInfo,
    upsert: item =>
      setItems(list => {
        markDirty(item.id)
        const old = list.find(x => x.id === item.id)
        if (item.kind === 'task' && item.status === 'done' && !(old?.kind === 'task' && old.status === 'done')) item = withPaidDefault(item)
        let next = old ? list.map(x => (x.id === item.id ? item : x)) : [...list, item]
        if (item.kind === 'task' && item.status === 'done' && old?.kind === 'task' && old.status !== 'done' && item.recurrence) {
          const spawn = nextOccurrence(item, uid)
          if (spawn) {
            markDirty(spawn.id)
            next = next.map(x => (x.id === item.id ? { ...item, recurrence: undefined } : x)).concat(spawn)
          }
        }
        return ensureProjects(releaseBlocked(next))
      }),
    remove: id =>
      setItems(list => {
        markDirty(id)
        return list.map(p => (p.id === id ? { ...p, deletedAt: new Date().toISOString(), updatedAt: newerStamp(p.updatedAt) } : p))
      }),
    restore: ids =>
      setItems(list => {
        // a purged tombstone has nothing left to bring back
        const set = new Set(ids.filter(id => !list.find(p => p.id === id)?.purged))
        if (set.size === 0) return list
        markDirty([...set])
        return list.map(p => (set.has(p.id) ? { ...p, deletedAt: undefined, updatedAt: newerStamp(p.updatedAt) } : p))
      }),
    purge: async ids => {
      const snapshot = itemsRef.current
      const set = new Set(ids)
      setItems(list => list.filter(p => !set.has(p.id)))
      const dirty = readDirty()
      for (const id of ids) dirty.delete(id)
      writeDirty(dirty)
      await purgeRemote(ids, snapshot)
    },
    setStatus: (id, status) => {
      const old = itemsRef.current.find(x => x.id === id)
      if (!old || old.kind !== 'task' || old.status === status) return null
      const updated = stampStatus(old, status)
      if (status === 'done' && old.status !== 'done') void haptic('success')
      let spawned: Task | null = null
      if (status === 'done' && old.status !== 'done' && updated.recurrence) {
        spawned = nextOccurrence(updated, uid)
      }
      markDirty(id)
      if (spawned) markDirty(spawned.id)
      const stored: Task = spawned ? { ...updated, recurrence: undefined } : updated
      setItems(list => {
        let next: Item[] = list.map(x => (x.id === id ? stored : x))
        if (spawned) next = next.concat(spawned)
        return releaseBlocked(next)
      })
      return { prev: old, next: stored, spawnedId: spawned?.id }
    },
    importItems: incoming => {
      const clean = incoming.map(sanitizeItem).filter((p): p is Item => p !== null)
      const byId = new Map(itemsRef.current.map(p => [p.id, p]))
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
        markDirty(toMerge.map(p => p.id))
        setItems(list => ensureProjects(mergeItems(list, toMerge)))
      }
      return { added, updated, unchanged, metricsRefreshed }
    },
    syncNowManual: () => doSyncRef.current(),
    fullResync: () => {
      clearSyncCursor()
      return doSyncRef.current()
    },
    retainMine: (uid: string | null) => {
      if (!uid) return
      setItems(list => {
        const next = list.filter(i => !i.ownerId || i.ownerId === uid)
        return next.length === list.length ? list : next
      })
    },
  }
}
