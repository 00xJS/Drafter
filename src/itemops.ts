import { Item } from './types'

export { newerStamp, nextOccurrence } from '../shared/domain.mjs'

/** Last-write-wins merge by id, using updatedAt (ISO strings compare lexically). */
export function mergeItems<T extends Item>(a: T[], b: T[]): T[] {
  const byId = new Map<string, T>()
  for (const p of a) byId.set(p.id, p)
  for (const p of b) {
    const cur = byId.get(p.id)
    if (!cur || p.updatedAt > cur.updatedAt) byId.set(p.id, p)
  }
  return [...byId.values()]
}

const TOMBSTONE_TTL_MS = 90 * 86_400_000

/** Drop tombstones old enough that every device has surely seen the deletion. */
export function purgeTombstones<T extends Item>(items: T[], now = Date.now()): T[] {
  return items.filter(p => !p.deletedAt || now - new Date(p.deletedAt).getTime() < TOMBSTONE_TTL_MS)
}

/** Small stable hash for building deterministic import ids (djb2). */
export function hashId(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

export interface SyncDecision {
  /** What local state should become. */
  merged: Item[]
  /** The cursor to store, or null to leave it where it is. */
  cursor: string | null
  /** Ids we sent that the server did not confirm — these must be sent again. */
  unconfirmed: string[]
}

/** One millisecond earlier, so an unconfirmed record is included in the next push. */
function justBefore(iso: string): string {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? new Date(t - 1).toISOString() : iso
}

/**
 * Decide the outcome of one sync round.
 *
 * Two rules earn their keep here, both learned the hard way:
 *
 * 1. `current` is the state as it is NOW, not a snapshot taken before the
 *    request. Merging onto a stale snapshot silently erases any edit made
 *    while the request was in flight — and because that edit was not in the
 *    push either, it is gone from memory, from IndexedDB and from the server.
 *
 * 2. The cursor advances ONLY over records the server actually sent back.
 *    Advancing it over what we merely *sent* is what makes a device go quiet:
 *    the server skips records it cannot store, and clamps stamps more than
 *    five minutes in the future, so a cursor set from our own optimistic
 *    stamps can jump past rows we never received. Those rows are then never
 *    requested again, and the device looks up to date while missing data —
 *    until a sign-out clears the cursor and a full exchange repairs it.
 */
export function applySync(current: Item[], sent: Item[], remote: Item[], since: string | null): SyncDecision {
  const merged = mergeItems(current, remote)

  let cursor = since
  for (const r of remote) if (!cursor || r.updatedAt > cursor) cursor = r.updatedAt

  // anything we pushed that did not come back at least as new as we sent it
  const returned = new Map(remote.map(r => [r.id, r.updatedAt]))
  const unconfirmed = sent.filter(s => (returned.get(s.id) ?? '') < s.updatedAt)

  if (unconfirmed.length > 0 && cursor) {
    let earliest = unconfirmed[0].updatedAt
    for (const u of unconfirmed) if (u.updatedAt < earliest) earliest = u.updatedAt
    // never let the cursor pass an unsent change, or it is never offered again
    if (cursor >= earliest) cursor = justBefore(earliest)
  }

  return { merged, cursor: cursor === since ? null : cursor, unconfirmed: unconfirmed.map(u => u.id) }
}
