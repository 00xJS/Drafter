import { Post } from './types'

export { newerStamp, nextOccurrence } from '../shared/domain.mjs'

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

/** Small stable hash for building deterministic import ids (djb2). */
export function hashId(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}
