import { useEffect, useMemo, useRef, useState } from 'react'
import { Post, Status } from './types'
import { migrateStored, sanitizePost, STORAGE_VERSION } from './schema'
import { mergePosts, nextOccurrence, purgeTombstones, scrubSamples } from './postops'
import { uid } from './utils'
import { syncNow } from './sync'
import { scheduleBackup } from './backup'

const KEY = 'drafter:v1'
const LEGACY_KEY = 'post-pilot:v1' // pre-rename builds; migrated on first load

function load(): Post[] {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY)
    if (raw === null) return []
    const migrated = migrateStored(JSON.parse(raw))
    if (migrated) {
      localStorage.removeItem(LEGACY_KEY)
      return scrubSamples(purgeTombstones(migrated))
    }
  } catch (e) {
    console.error('Failed to load saved posts', e)
  }
  // Unreadable data: stash it aside instead of letting the next save overwrite it.
  if (raw !== null) {
    try {
      localStorage.setItem(`${KEY}:corrupt-${Date.now()}`, raw)
    } catch {
      /* storage full — nothing more we can do */
    }
  }
  return []
}

export interface SyncInfo {
  online: boolean
  lastAt?: string
}

export interface ImportSummary {
  added: number
  updated: number
  unchanged: number
}

export interface Store {
  /** Live posts (tombstoned ones filtered out) — what every view renders. */
  posts: Post[]
  /** Everything including tombstones — for export and sync. */
  allPosts: Post[]
  syncInfo: SyncInfo
  upsert(p: Post): void
  remove(id: string): void
  restore(ids: string[]): void
  setStatus(id: string, status: Status): void
  importPosts(incoming: unknown[]): ImportSummary
  markNotified(id: string): void
  syncNowManual(): Promise<boolean>
}

function signature(posts: Post[]): string {
  return posts
    .map(p => p.id + '@' + p.updatedAt)
    .sort()
    .join('|')
}

function stampStatus(p: Post, status: Status): Post {
  const next: Post = { ...p, status, updatedAt: new Date().toISOString() }
  if (status === 'posted') next.postedAt = next.postedAt ?? next.scheduledFor ?? new Date().toISOString()
  else next.postedAt = undefined
  return next
}

/** When a recurring post is first marked posted, spawn its next occurrence. */
function withRecurrenceSpawn(list: Post[], updated: Post, wasPosted: boolean): Post[] {
  if (updated.status !== 'posted' || wasPosted || !updated.recurrence) return list
  const spawn = nextOccurrence(updated, uid)
  if (!spawn) return list
  return list.map(p => (p.id === updated.id ? { ...updated, recurrence: undefined } : p)).concat(spawn)
}

export function usePosts(): Store {
  const [posts, setPosts] = useState<Post[]>(load)
  const [syncInfo, setSyncInfo] = useState<SyncInfo>({ online: false })
  const postsRef = useRef(posts)
  postsRef.current = posts
  const pushTimer = useRef<number | undefined>(undefined)
  const syncBusy = useRef(false)

  const doSync = async (): Promise<boolean> => {
    if (syncBusy.current) return false
    syncBusy.current = true
    try {
      const remote = await syncNow(postsRef.current)
      if (remote === null) {
        setSyncInfo(s => (s.online ? { online: false, lastAt: s.lastAt } : s))
        return false
      }
      setSyncInfo({ online: true, lastAt: new Date().toISOString() })
      const combined = scrubSamples(purgeTombstones(mergePosts(postsRef.current, remote)))
      if (signature(combined) !== signature(postsRef.current)) setPosts(combined)
      return true
    } finally {
      syncBusy.current = false
    }
  }
  const doSyncRef = useRef(doSync)
  doSyncRef.current = doSync

  useEffect(() => {
    doSyncRef.current()
    const t = window.setInterval(() => doSyncRef.current(), 60_000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ version: STORAGE_VERSION, posts }))
    } catch (e) {
      console.error('Failed to save posts', e)
    }
    scheduleBackup(posts)
    window.clearTimeout(pushTimer.current)
    pushTimer.current = window.setTimeout(() => doSyncRef.current(), 2500)
    return () => window.clearTimeout(pushTimer.current)
  }, [posts])

  const live = useMemo(() => posts.filter(p => !p.deletedAt), [posts])

  return {
    posts: live,
    allPosts: posts,
    syncInfo,
    upsert: p =>
      setPosts(ps => {
        const old = ps.find(x => x.id === p.id)
        const next = old ? ps.map(x => (x.id === p.id ? p : x)) : [...ps, p]
        return withRecurrenceSpawn(next, p, old?.status === 'posted')
      }),
    remove: id =>
      setPosts(ps => {
        const now = new Date().toISOString()
        return ps.map(p => (p.id === id ? { ...p, deletedAt: now, updatedAt: now } : p))
      }),
    restore: ids =>
      setPosts(ps => {
        const now = new Date().toISOString()
        const set = new Set(ids)
        return ps.map(p => (set.has(p.id) ? { ...p, deletedAt: undefined, updatedAt: now } : p))
      }),
    setStatus: (id, status) =>
      setPosts(ps => {
        const old = ps.find(x => x.id === id)
        if (!old) return ps
        const updated = stampStatus(old, status)
        const next = ps.map(x => (x.id === id ? updated : x))
        return withRecurrenceSpawn(next, updated, old.status === 'posted')
      }),
    importPosts: incoming => {
      const clean = scrubSamples(incoming.map(sanitizePost).filter((p): p is Post => p !== null))
      const byId = new Map(postsRef.current.map(p => [p.id, p]))
      let added = 0
      let updated = 0
      let unchanged = 0
      for (const p of clean) {
        const existing = byId.get(p.id)
        if (!existing) added++
        else if (p.updatedAt > existing.updatedAt) updated++
        else unchanged++
      }
      setPosts(ps => mergePosts(ps, clean))
      return { added, updated, unchanged }
    },
    markNotified: id =>
      setPosts(ps => {
        const now = new Date().toISOString()
        return ps.map(p => (p.id === id ? { ...p, notifiedAt: now, updatedAt: now } : p))
      }),
    syncNowManual: () => doSyncRef.current(),
  }
}
