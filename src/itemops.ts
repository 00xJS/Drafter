import { Item } from './types'

export { newerStamp, nextOccurrence, spawnId, isUntimed, localDate, localMidnightIso } from '../shared/domain.mjs'

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

export const TOMBSTONE_TTL_MS = 90 * 86_400_000

/** Drop tombstones old enough that every device has surely seen the deletion. */
export function purgeTombstones<T extends Item>(items: T[], now = Date.now()): T[] {
  return items.filter(p => {
    if (!p.deletedAt) return true
    // purged tombstones stay until the server daily job hard-deletes them;
    // locally we still drop anything past the TTL so caches stay bounded
    return now - new Date(p.deletedAt).getTime() < TOMBSTONE_TTL_MS
  })
}

/** Small stable hash for building deterministic import ids (djb2). */
export function hashId(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

export interface SyncRemote {
  id: string
  updatedAt: string
  /** Server arrival time — the delta cursor keys on this when present. */
  syncedAt?: string
}

export interface SyncDecision {
  /** What local state should become. */
  merged: Item[]
  /** The cursor to store, or null to leave it where it is. */
  cursor: string | null
  /**
   * Ids that must go out again: the server did not confirm them, or the local
   * copy moved on after `sent` was snapshotted (an edit made mid-round).
   */
  unconfirmed: string[]
  /** Ids the server rejected (validation/RLS) — drop from the dirty set; do not clamp. */
  rejected: string[]
}

/**
 * Decide the outcome of one sync round.
 *
 * Cursor advances over `syncedAt` (server arrival) when the server provides it,
 * otherwise falls back to `updatedAt`. Rejected ids never clamp the cursor —
 * they are dead writes. Unconfirmed (not rejected, not returned) still hold the
 * cursor only when we have no dirty-set (legacy path); with a dirty set the
 * caller clears confirmed ids and retries the rest. Once the server reports
 * rejections, "not returned" is no longer "unconfirmed": an accepted row that
 * did not change is simply not echoed.
 *
 * `sent` is a snapshot taken before the request; anything the user changed while
 * it was in flight has a newer local copy than the version the server echoed
 * back. Those ids count as unconfirmed (not confirmed-and-clean) and, when the
 * server rejected the version we sent, keep their local copy — the rejection
 * was about the copy we sent, not the one the user is now looking at.
 */
export function applySync(
  current: Item[],
  sent: Item[],
  remote: SyncRemote[],
  since: string | null,
  rejected: string[] = [],
  serverReportsRejections = false,
): SyncDecision {
  const rejectedSet = new Set(rejected)
  const localStamp = new Map(current.map(c => [c.id, c.updatedAt]))
  const superseded = new Set(sent.filter(s => (localStamp.get(s.id) ?? '') > s.updatedAt).map(s => s.id))
  let merged: Item[]
  if (since === null) {
    // Full exchange is authoritative for ids the server still returns. Keep
    // local creates that were pushed but not echoed, and prefer a current edit
    // that raced ahead of the request snapshot — but drop ghosts that are
    // neither on the server nor in this push (e.g. after retainMine + resync).
    const byId = new Map<string, Item>()
    for (const r of remote as Item[]) byId.set(r.id, r)
    const sentIds = new Set(sent.map(s => s.id))
    for (const c of current) {
      // Rejected write the server already has: keep the server copy (unless the
      // user edited after we sent). Rejected write the server never stored: keep
      // the local row even if it was not in this push — dropping it here made
      // places vanish after a full resync.
      if (rejectedSet.has(c.id) && !superseded.has(c.id) && byId.has(c.id)) continue
      const r = byId.get(c.id)
      if (r) {
        if (c.updatedAt > r.updatedAt) byId.set(c.id, c)
      } else if (sentIds.has(c.id) || rejectedSet.has(c.id)) {
        byId.set(c.id, c)
      }
    }
    for (const s of sent) {
      if (rejectedSet.has(s.id) || byId.has(s.id)) continue
      byId.set(s.id, s)
    }
    merged = [...byId.values()]
  } else {
    merged = mergeItems(current, remote as Item[])
  }

  let cursor = since
  for (const r of remote) {
    const stamp = r.syncedAt ?? r.updatedAt
    if (!cursor || stamp > cursor) cursor = stamp
  }

  const returned = new Map(remote.map(r => [r.id, r.updatedAt]))
  // A server that reports rejections has accepted every sent row it did not
  // reject; when the row was unchanged it is not echoed (nothing new since the
  // cursor), and treating that silence as "unconfirmed" kept every place,
  // recipe, meal, grocery list, journal entry and event dirty forever — pushed
  // again every minute, counted in "n unsynced", never confirmable. Only a
  // legacy server, which dropped kinds it did not know without saying so, still
  // needs the echo as proof.
  const unconfirmed = sent.filter(
    s => superseded.has(s.id) || (!serverReportsRejections && !rejectedSet.has(s.id) && (returned.get(s.id) ?? '') < s.updatedAt),
  )

  // rejected rows must NOT pin the cursor (that was the old bug)
  return {
    merged,
    cursor: cursor === since ? null : cursor,
    unconfirmed: [...new Set(unconfirmed.map(u => u.id))],
    rejected: [...rejectedSet].filter(id => !superseded.has(id)),
  }
}

/** Pull overlap: ask for records from 10s before the cursor to cover commit-order skew. */
export function pullSince(cursor: string | null): string | null {
  if (!cursor) return null
  const t = Date.parse(cursor)
  if (!Number.isFinite(t)) return cursor
  return new Date(t - 10_000).toISOString()
}
