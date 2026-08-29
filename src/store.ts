import { useEffect, useMemo, useRef, useState } from 'react'
import { Post, Status } from './types'
import { migrateStored, sanitizePost, STORAGE_VERSION } from './schema'
import { mergePosts, newerStamp, nextOccurrence, purgeTombstones } from './postops'
import { uid } from './utils'
import { syncNow } from './sync'
import { idbGet, idbSet } from './idb'

const LEGACY_LS_KEY = 'drafter:v1' // pre-IndexedDB builds
const CURSOR_KEY = 'drafter:sync-cursor'

async function loadCache(): Promise<Post[]> {
  try {
    const cached = await idbGet<{ version: number; posts: unknown[] }>('posts', 'all')
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
  prev: Post
  spawnedId?: string
}

export interface Store {
  /** Live posts (tombstoned ones filtered out) — what every view renders. */
  posts: Post[]
  /** Everything including tombstones — for export and sync. */
  allPosts: Post[]
  /** False until the local cache has been read (avoids empty-state flashes). */
  loaded: boolean
  syncInfo: SyncInfo
  upsert(p: Post): void
  remove(id: string): void
  restore(ids: string[]): void
  /** Returns what changed so the caller can offer Undo. */
  setStatus(id: string, status: Status): StatusChange | null
  importPosts(incoming: unknown[]): ImportSummary
  syncNowManual(): Promise<boolean>
}

function stampStatus(p: Post, status: Status): Post {
  const next: Post = { ...p, status, updatedAt: newerStamp(p.updatedAt) }
  if (status === 'posted') next.postedAt = next.postedAt ?? next.scheduledFor ?? new Date().toISOString()
  else next.postedAt = undefined
  return next
}

const PROVENANCE_TAGS = ['x-archive', 'ig-archive', 'imported']

/** Posts that came from an archive/CSV may have their metrics refreshed by a re-import. */
function isImported(p: Post): boolean {
  return p.tags.some(t => PROVENANCE_TAGS.includes(t))
}

/** Per-field max: engagement counts only grow, so a refresh never lowers a manual fix. */
function maxMetrics(a: Post['metrics'], b: Post['metrics']): { merged: NonNullable<Post['metrics']>; changed: boolean } {
  const merged: NonNullable<Post['metrics']> = JSON.parse(JSON.stringify(a ?? {}))
  let changed = false
  for (const [pl, m] of Object.entries(b ?? {})) {
    if (!m) continue
    const target = (merged[pl as keyof typeof merged] ??= {})
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

export function usePosts(): Store {
  const [posts, setPosts] = useState<Post[]>([])
  const [loaded, setLoaded] = useState(false)
  const [syncInfo, setSyncInfo] = useState<SyncInfo>({ online: false, authError: false })
  const postsRef = useRef(posts)
  postsRef.current = posts
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
      const local = postsRef.current
      const outgoing = since ? local.filter(p => p.updatedAt > since) : local
      const result = await syncNow(outgoing, since)
      if (result.posts === null) {
        setSyncInfo(s => ({ online: false, lastAt: s.lastAt, authError: result.authError }))
        return false
      }
      setSyncInfo({ online: true, lastAt: new Date().toISOString(), authError: false })
      const combined = purgeTombstones(mergePosts(local, result.posts))
      let maxSeen = since ?? ''
      for (const p of result.posts) if (p.updatedAt > maxSeen) maxSeen = p.updatedAt
      for (const p of outgoing) if (p.updatedAt > maxSeen) maxSeen = p.updatedAt
      if (maxSeen) writeCursor(maxSeen)
      const signature = (list: Post[]) => list.map(p => p.id + '@' + p.updatedAt).sort().join('|')
      if (signature(combined) !== signature(local)) setPosts(combined)
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
      setPosts(cached)
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
      const snapshot = postsRef.current
      idbSet('posts', 'all', { version: STORAGE_VERSION, posts: snapshot })
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
  }, [posts, loaded])

  const live = useMemo(() => posts.filter(p => !p.deletedAt), [posts])

  return {
    posts: live,
    allPosts: posts,
    loaded,
    syncInfo,
    upsert: p =>
      setPosts(ps => {
        const old = ps.find(x => x.id === p.id)
        let next = old ? ps.map(x => (x.id === p.id ? p : x)) : [...ps, p]
        if (p.status === 'posted' && old?.status !== 'posted' && p.recurrence) {
          const spawn = nextOccurrence(p, uid)
          if (spawn) next = next.map(x => (x.id === p.id ? { ...p, recurrence: undefined } : x)).concat(spawn)
        }
        return next
      }),
    remove: id =>
      setPosts(ps =>
        ps.map(p => (p.id === id ? { ...p, deletedAt: new Date().toISOString(), updatedAt: newerStamp(p.updatedAt) } : p)),
      ),
    restore: ids =>
      setPosts(ps => {
        const set = new Set(ids)
        return ps.map(p => (set.has(p.id) ? { ...p, deletedAt: undefined, updatedAt: newerStamp(p.updatedAt) } : p))
      }),
    setStatus: (id, status) => {
      const old = postsRef.current.find(x => x.id === id)
      if (!old || old.status === status) return null
      const updated = stampStatus(old, status)
      let spawned: Post | null = null
      if (status === 'posted' && old.status !== 'posted' && updated.recurrence) {
        spawned = nextOccurrence(updated, uid)
      }
      setPosts(ps => {
        let next = ps.map(x => (x.id === id ? (spawned ? { ...updated, recurrence: undefined } : updated) : x))
        if (spawned) next = next.concat(spawned)
        return next
      })
      return { prev: old, spawnedId: spawned?.id }
    },
    importPosts: incoming => {
      const clean = incoming.map(sanitizePost).filter((p): p is Post => p !== null)
      const byId = new Map(postsRef.current.map(p => [p.id, p]))
      let added = 0
      let updated = 0
      let unchanged = 0
      let metricsRefreshed = 0
      const toMerge: Post[] = []
      for (const p of clean) {
        const existing = byId.get(p.id)
        if (!existing) {
          added++
          toMerge.push(p)
        } else if (p.updatedAt > existing.updatedAt) {
          updated++
          toMerge.push(p)
        } else if (isImported(existing) && p.metrics) {
          // a fresh archive re-import carries newer counts on an equal-or-older
          // timestamp: take per-field maxes and bump the stamp so it syncs
          const { merged, changed } = maxMetrics(existing.metrics, p.metrics)
          if (changed) {
            metricsRefreshed++
            toMerge.push({ ...existing, metrics: merged, updatedAt: newerStamp(existing.updatedAt) })
          } else {
            unchanged++
          }
        } else {
          unchanged++
        }
      }
      if (toMerge.length > 0) setPosts(ps => mergePosts(ps, toMerge))
      return { added, updated, unchanged, metricsRefreshed }
    },
    syncNowManual: () => doSyncRef.current(),
  }
}
