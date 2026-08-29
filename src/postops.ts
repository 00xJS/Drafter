import { Post } from './types'

/** Last-write-wins merge by post id, using updatedAt (ISO strings compare lexically). */
export function mergePosts(a: Post[], b: Post[]): Post[] {
  const byId = new Map<string, Post>()
  for (const p of a) byId.set(p.id, p)
  for (const p of b) {
    const cur = byId.get(p.id)
    if (!cur || p.updatedAt > cur.updatedAt) byId.set(p.id, p)
  }
  return [...byId.values()]
}

const TOMBSTONE_TTL_MS = 90 * 86_400_000

/** Drop tombstones old enough that every device has surely seen the deletion. */
export function purgeTombstones(posts: Post[], now = Date.now()): Post[] {
  return posts.filter(p => !p.deletedAt || now - new Date(p.deletedAt).getTime() < TOMBSTONE_TTL_MS)
}

/** The next scheduled occurrence of a recurring post, cloned from the one just completed. */
export function nextOccurrence(p: Post, uidFn: () => string): Post | null {
  if (!p.recurrence) return null
  const baseIso = p.postedAt ?? p.scheduledFor
  const next = baseIso ? new Date(baseIso) : new Date()
  if (isNaN(next.getTime())) return null
  if (p.recurrence.freq === 'weekly') next.setDate(next.getDate() + 7)
  else if (p.recurrence.freq === 'biweekly') next.setDate(next.getDate() + 14)
  else next.setMonth(next.getMonth() + 1)
  const now = new Date().toISOString()
  return {
    id: uidFn(),
    title: p.title,
    body: p.body,
    platforms: [...p.platforms],
    status: 'scheduled',
    createdAt: now,
    updatedAt: now,
    scheduledFor: next.toISOString(),
    tags: [...p.tags],
    notes: p.notes,
    link: undefined,
    variants: p.variants ? { ...p.variants } : undefined,
    recurrence: { ...p.recurrence },
  }
}

/** Demo posts from the pre-cloud builds are scrubbed at every entry point. */
export function scrubSamples(posts: Post[]): Post[] {
  return posts.filter(p => !p.sample)
}

/** Small stable hash for building deterministic import ids (djb2). */
export function hashId(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}
