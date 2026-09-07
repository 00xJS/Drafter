import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarSource, Item, Project, SOCIAL_PROJECT_ID, Task, TaskStatus } from './types'
import { migrateStored, sanitizeItem, STORAGE_VERSION } from './schema'
import { mergeItems, newerStamp, nextOccurrence, purgeTombstones } from './itemops'
import { uid } from './utils'
import { syncNow } from './sync'
import { idbGet, idbSet } from './idb'

const LEGACY_LS_KEY = 'drafter:v1' // pre-IndexedDB builds
const CURSOR_KEY = 'drafter:sync-cursor'

async function loadCache(): Promise<Item[]> {
  try {
    const cached = await idbGet<{ version: number; items?: unknown[]; posts?: unknown[] }>('posts', 'all')
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
}

export interface ImportSummary {
  added: number
  updated: number
  unchanged: number
  metricsRefreshed: number
}

export interface StatusChange {
  prev: Task
  spawnedId?: string
}

export interface Store {
  /** Live tasks (tombstoned ones filtered out) — what every view renders. */
  tasks: Task[]
  /** Live projects. */
  projects: Project[]
  /** Subscribed external calendars. */
  calendars: CalendarSource[]
  /** Everything including tombstones — for export and sync. */
  allItems: Item[]
  /** False until the local cache has been read (avoids empty-state flashes). */
  loaded: boolean
  syncInfo: SyncInfo
  upsert(item: Item): void
  remove(id: string): void
  restore(ids: string[]): void
  /** Returns what changed so the caller can offer Undo. */
  setStatus(id: string, status: TaskStatus): StatusChange | null
  importItems(incoming: unknown[]): ImportSummary
  syncNowManual(): Promise<boolean>
}

export function stampStatus(t: Task, status: TaskStatus): Task {
  const next: Task = { ...t, status, updatedAt: newerStamp(t.updatedAt) }
  if (status === 'done') next.completedAt = next.completedAt ?? new Date().toISOString()
  else next.completedAt = undefined
  return next
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

export function useItems(): Store {
  const [items, setItems] = useState<Item[]>([])
  const [loaded, setLoaded] = useState(false)
  const [syncInfo, setSyncInfo] = useState<SyncInfo>({ online: false, authError: false })
  const itemsRef = useRef(items)
  itemsRef.current = items
  const loadedRef = useRef(false)
  const pushTimer = useRef<number | undefined>(undefined)
  const persistTimer = useRef<number | undefined>(undefined)
  const syncBusy = useRef(false)

  const readCursor = () => {
    try {
      return localStorage.getItem(CURSOR_KEY)
    } catch {
      return null
    }
  }
  const writeCursor = (iso: string) => {
    try {
      localStorage.setItem(CURSOR_KEY, iso)
    } catch {
      /* ignore */
    }
  }

  const doSync = async (): Promise<boolean> => {
    if (syncBusy.current || !loadedRef.current) return false
    syncBusy.current = true
    try {
      const since = readCursor()
      // push only what's newer than the cursor; everything on a full sync
      const local = itemsRef.current
      const outgoing = since ? local.filter(p => p.updatedAt > since) : local
      const result = await syncNow(outgoing, since)
      if (result.items === null) {
        setSyncInfo(s => ({ online: false, lastAt: s.lastAt, authError: result.authError }))
        return false
      }
      setSyncInfo({ online: true, lastAt: new Date().toISOString(), authError: false })
      const combined = ensureProjects(purgeTombstones(mergeItems(local, result.items)))
      let maxSeen = since ?? ''
      for (const p of result.items) if (p.updatedAt > maxSeen) maxSeen = p.updatedAt
      for (const p of outgoing) if (p.updatedAt > maxSeen) maxSeen = p.updatedAt
      if (maxSeen) writeCursor(maxSeen)
      const signature = (list: Item[]) => list.map(p => p.id + '@' + p.updatedAt).sort().join('|')
      if (signature(combined) !== signature(local)) setItems(combined)
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
    loadCache().then(cached => {
      if (!live) return
      setItems(ensureProjects(cached))
      loadedRef.current = true
      setLoaded(true)
      doSyncRef.current()
    })
    return () => {
      live = false
    }
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
      idbSet('posts', 'all', { version: STORAGE_VERSION, items: snapshot })
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
  }, [items, loaded])

  const tasks = useMemo(() => items.filter((i): i is Task => i.kind === 'task' && !i.deletedAt), [items])
  const projects = useMemo(
    () =>
      items
        .filter((i): i is Project => i.kind === 'project' && !i.deletedAt)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [items],
  )
  const calendars = useMemo(
    () =>
      items
        .filter((i): i is CalendarSource => i.kind === 'calendar' && !i.deletedAt)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [items],
  )

  return {
    tasks,
    projects,
    calendars,
    allItems: items,
    loaded,
    syncInfo,
    upsert: item =>
      setItems(list => {
        const old = list.find(x => x.id === item.id)
        let next = old ? list.map(x => (x.id === item.id ? item : x)) : [...list, item]
        if (item.kind === 'task' && item.status === 'done' && old?.kind === 'task' && old.status !== 'done' && item.recurrence) {
          const spawn = nextOccurrence(item, uid)
          if (spawn) next = next.map(x => (x.id === item.id ? { ...item, recurrence: undefined } : x)).concat(spawn)
        }
        return ensureProjects(next)
      }),
    remove: id =>
      setItems(list =>
        list.map(p => (p.id === id ? { ...p, deletedAt: new Date().toISOString(), updatedAt: newerStamp(p.updatedAt) } : p)),
      ),
    restore: ids =>
      setItems(list => {
        const set = new Set(ids)
        return list.map(p => (set.has(p.id) ? { ...p, deletedAt: undefined, updatedAt: newerStamp(p.updatedAt) } : p))
      }),
    setStatus: (id, status) => {
      const old = itemsRef.current.find(x => x.id === id)
      if (!old || old.kind !== 'task' || old.status === status) return null
      const updated = stampStatus(old, status)
      let spawned: Task | null = null
      if (status === 'done' && old.status !== 'done' && updated.recurrence) {
        spawned = nextOccurrence(updated, uid)
      }
      setItems(list => {
        let next: Item[] = list.map(x => (x.id === id ? (spawned ? { ...updated, recurrence: undefined } : updated) : x))
        if (spawned) next = next.concat(spawned)
        return next
      })
      return { prev: old, spawnedId: spawned?.id }
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
          // a fresh archive re-import carries newer counts on an equal-or-older
          // timestamp: take per-field maxes and bump the stamp so it syncs
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
      if (toMerge.length > 0) setItems(list => ensureProjects(mergeItems(list, toMerge)))
      return { added, updated, unchanged, metricsRefreshed }
    },
    syncNowManual: () => doSyncRef.current(),
  }
}
