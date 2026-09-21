import { Item } from './types'
import { sanitizeItem } from './schema'
import { newerStamp } from '../shared/domain.mjs'
import { mergeRecord, sameContent, type MergeConflict } from '../shared/merge.mjs'

export { duplicateSpawnPairs, duplicateSpawns, newerStamp, nextOccurrence, spawnId, isUntimed, localDate, localMidnightIso } from '../shared/domain.mjs'

/** Last-write-wins merge by id, using updatedAt (ISO strings compare lexically). */
export function mergeItems<T extends Item>(a: T[], b: T[]): T[] {
  const byId = new Map<string, T>()
  for (const p of a) byId.set(p.id, p)
  for (const p of b) {
    const cur = byId.get(p.id)
    if (!cur || p.updatedAt > cur.updatedAt) byId.set(p.id, p)
    // Whose a row is comes from the server (`user_id`), not from its content,
    // so it can change without the stamp moving: removing a household member
    // re-attributes their shared work to the creator, touching no `data` and
    // no `updatedAt`. Keeping the older copy whole meant the device went on
    // believing the row was the departed member's — and once a row's audience
    // is decided per record (v3.19), a stale owner is not cosmetic: the
    // revocation pass reads it, finds the row missing from the peer-visible
    // set, and drops a row that is now the reader's own.
    else if (cur.ownerId !== p.ownerId && p.ownerId !== undefined) byId.set(p.id, { ...cur, ownerId: p.ownerId })
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

/** A record whose local edit lost, field by field, to a concurrent edit on another device. */
export interface SyncConflict {
  id: string
  kind: Item['kind']
  /** Each place this device's value lost, with both values — what Keep mine puts back. */
  fields: MergeConflict[]
}

/** What applySync needs to merge concurrent edits instead of letting one side vanish. */
export interface SyncMergeContext {
  /** Ids with a local change the server has not confirmed, as the response lands. */
  dirty?: ReadonlySet<string>
  /** For each dirty record, the last version the server confirmed: the merge base. */
  shadows?: ReadonlyMap<string, Item>
  /** Ids we pushed that lost last-write-wins; the server sent its row for each. */
  stale?: readonly string[]
}

export interface SyncDecision {
  /** What local state should become. */
  merged: Item[]
  /** The cursor to store, or null to leave it where it is. */
  cursor: string | null
  /**
   * Ids that must go out again: the server did not confirm them, the local
   * copy moved on after `sent` was snapshotted (an edit made mid-round), or a
   * three-way merge produced a version the server does not have yet.
   */
  unconfirmed: string[]
  /** Ids the server rejected (validation/RLS). The caller keeps them dirty; they never clamp the cursor. */
  rejected: string[]
  /** Dirty records merged with a concurrent server copy that still differ from it: stamped newer, in `unconfirmed`. */
  remerged: string[]
  /** Dirty records whose merge came out identical to the server's copy: nothing left to push. */
  settled: string[]
  /** Sent ids the server now holds as sent — the new merge base for any that are still dirty. */
  accepted: string[]
  /** Local edits that lost to a concurrent edit of the same field on another device. */
  conflicts: SyncConflict[]
}

/** A comparable copy: sanitized, so a trim or a default the server's sanitizer adds is not a "change". */
function norm(item: Item | undefined): Item | undefined {
  return item ? (sanitizeItem(item) ?? item) : undefined
}

/**
 * Is the server's copy of a dirty record an edit made somewhere else, rather
 * than our own push coming back or the base resent by the cursor overlap?
 * Without a base, only a copy that would win last-write-wins anyway is
 * merged, so a record dirty from before shadows existed behaves as it did.
 */
function isConcurrent(remote: Item, local: Item, sent: Item | undefined, base: Item | undefined, stale: boolean): boolean {
  if (sameContent(remote, local)) return false
  if (stale) return true
  if (sent && sameContent(remote, sent)) return false
  if (base && sameContent(remote, base)) return false
  return !!base || remote.updatedAt >= local.updatedAt
}

/**
 * The cached rows this account may no longer read, given the full list of
 * peer-owned ids the server just said it can see, per kind (`peerVisibleByKind`).
 *
 * Two kinds decide their audience per record: a note is private until its
 * owner shares it (v3.16), a task is the household's until its owner withholds
 * it (v3.19). Either way the withholding has to reach the person holding a
 * copy, and nothing else in sync can tell them: a row they cannot select is
 * simply absent from the answer, which is exactly what "nothing changed since
 * your cursor" looks like. So the server states the whole set each round and
 * anything of someone else's missing from it goes.
 *
 * Four guards, each of which is the difference between this and data loss:
 *
 * - A kind whose list is null is left alone. Null means the server did not say
 *   — an older sync_posts, the legacy array shape, or a v3.16 server that
 *   knows about notes and not tasks. Never read null as "none visible".
 * - Only rows whose `ownerId` is another account. Your own are yours to read
 *   whatever the flag says, and a row created here has no ownerId yet.
 * - Never a dirty row, UNLESS the server just refused that very push. An edit
 *   that has not landed is not a ghost. But a refusal is not a delay: the same
 *   answer that refused the write is the one that left the row out of the
 *   list, and a row you cannot read is a row you can never write. So holding
 *   it costs the reader the revocation and gains them nothing.
 *
 *   Without the `refused` half this deadlocks, and the round trip sustains it:
 *   the refusal puts the id back in `dirty`, `dirty` suppresses the drop, the
 *   undropped row is pushed again, and it is refused again. Nothing breaks
 *   the loop — pruneBookkeeping only forgets ids whose record has left the
 *   list, and the record cannot leave while it is dirty. A reader who had
 *   pinned a note offline kept it, body and all, for good.
 */
export function revokedPeerRows(
  current: Item[],
  visible: { note: string[] | null; task: string[] | null },
  dirty: Set<string>,
  account: string | null,
  refused: ReadonlySet<string> = new Set(),
): Set<string> {
  const out = new Set<string>()
  if (!account) return out
  const seen: Partial<Record<string, Set<string>>> = {}
  for (const [kind, list] of Object.entries(visible)) if (list) seen[kind] = new Set(list)
  for (const i of current) {
    const allowed = seen[i.kind]
    if (!allowed) continue
    if (dirty.has(i.id) && !refused.has(i.id)) continue
    if (i.ownerId && i.ownerId !== account && !allowed.has(i.id)) out.add(i.id)
  }
  return out
}

/**
 * Decide the outcome of one sync round.
 *
 * Cursor advances over `syncedAt` (server arrival) when the server provides it,
 * otherwise falls back to `updatedAt`. Only what came back moves it, and
 * nothing sent holds it back: a rejected or unconfirmed (not rejected, not
 * returned) id stays dirty and the caller sends it again. Once the server
 * reports rejections, "not returned" is no longer "unconfirmed": an accepted
 * row that did not change is simply not echoed.
 *
 * `sent` is a snapshot taken before the request; anything the user changed while
 * it was in flight has a newer local copy than the version the server echoed
 * back. Those ids count as unconfirmed (not confirmed-and-clean) and, when the
 * server rejected the version we sent, keep their local copy — the rejection
 * was about the copy we sent, not the one the user is now looking at. A
 * rejected write the user has not touched since is kept too: it stays dirty
 * and is retried until it lands or the user discards it, because dropping it
 * is exactly how edits vanished in September.
 *
 * Given `ctx`, a dirty record the server holds a concurrent copy of — one it
 * reports `stale`, or any copy that is neither our push echoed nor the base
 * resent — is merged three-way (base = its shadow) instead of one side
 * winning whole. A merge that differs from the server's copy is stamped newer
 * than both and goes out again; one that matches it is simply adopted.
 */
export function applySync(
  current: Item[],
  sent: Item[],
  remote: SyncRemote[],
  since: string | null,
  rejected: string[] = [],
  serverReportsRejections = false,
  ctx: SyncMergeContext = {},
): SyncDecision {
  const rejectedSet = new Set(rejected)
  const staleSet = new Set(ctx.stale ?? [])
  const dirty = ctx.dirty ?? new Set<string>()
  const localById = new Map(current.map(c => [c.id, c]))
  const remoteById = new Map((remote as Item[]).map(r => [r.id, r]))
  const superseded = new Set(sent.filter(s => (localById.get(s.id)?.updatedAt ?? '') > s.updatedAt).map(s => s.id))

  // Concurrent edits first: each decides the final version of its record.
  const resolved = new Map<string, Item>()
  const remerged = new Set<string>()
  const settled = new Set<string>()
  const conflicts: SyncConflict[] = []
  if (dirty.size > 0) {
    const sentById = new Map(sent.map(s => [s.id, s]))
    for (const r of remote as Item[]) {
      const c = localById.get(r.id)
      if (!c || !dirty.has(r.id)) continue
      const R = norm(r)!
      const L = norm(c)!
      const B = norm(ctx.shadows?.get(r.id))
      if (!isConcurrent(R, L, norm(sentById.get(r.id)), B, staleSet.has(r.id))) continue
      const out = mergeRecord(B, L, R)
      const clean = sanitizeItem(out.merged) ?? R
      if (sameContent(clean, R)) {
        resolved.set(r.id, r)
        settled.add(r.id)
      } else {
        // strictly newer than both copies, so it wins the server's upsert and never steps back locally
        resolved.set(r.id, { ...clean, updatedAt: newerStamp(r.updatedAt > c.updatedAt ? r.updatedAt : c.updatedAt) })
        remerged.add(r.id)
      }
      if (out.conflicts.length) conflicts.push({ id: r.id, kind: r.kind, fields: out.conflicts })
    }
  }

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
      const r = byId.get(c.id)
      if (r) {
        if (c.updatedAt > r.updatedAt) byId.set(c.id, c)
      } else if (sentIds.has(c.id) || rejectedSet.has(c.id) || dirty.has(c.id)) {
        // A write the server never stored (refused, or still waiting out its
        // backoff) is a pending change, not a ghost: dropping it here made
        // places vanish after a full resync.
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
  if (resolved.size > 0) merged = merged.map(i => resolved.get(i.id) ?? i)

  /**
   * A stamp the server rewrote is the server's, not ours.
   *
   * sync_posts refuses an updatedAt more than five minutes ahead of its own
   * clock and stores `now()` instead. The echo then comes back with an EARLIER
   * stamp than the copy we are still holding, so the merge — which keeps
   * whichever is newer — keeps ours, and the two diverge permanently.
   *
   * That is not a cosmetic difference. A device whose clock runs fast writes
   * 10:20 at 10:00, the server stores 10:00, and the device goes on believing
   * 10:20. Another device edits the same record at 10:02 and wins on the
   * server, quite correctly. When the fast device pulls that edit, 10:02 is
   * not newer than 10:20, so it is dropped — and the cursor has already moved
   * past it, so it is never offered again. The next edit here then overwrites
   * the server with content that never contained it. Every peer edit made
   * inside the skew window is lost, silently, for as long as the clock is out.
   *
   * So: when the server echoes back the row we sent, unchanged in content but
   * under a stamp of its own, take its version. Only when nothing has been
   * typed here since (`superseded`), and never over a row a concurrent-edit
   * merge has already decided.
   */
  const clamped = new Map<string, Item>()
  for (const s of sent) {
    if (superseded.has(s.id) || resolved.has(s.id)) continue
    const r = remoteById.get(s.id)
    if (r && r.updatedAt < s.updatedAt && sameContent(norm(r), norm(s))) clamped.set(s.id, r)
  }
  if (clamped.size > 0) merged = merged.map(i => clamped.get(i.id) ?? i)

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
  const unconfirmed = sent
    .filter(s => {
      if (settled.has(s.id)) return false
      if (remerged.has(s.id) || superseded.has(s.id)) return true
      // lost last-write-wins, but the server did not say what it holds: never call that confirmed
      if (staleSet.has(s.id) && !returned.has(s.id)) return true
      return !serverReportsRejections && !rejectedSet.has(s.id) && (returned.get(s.id) ?? '') < s.updatedAt
    })
    .map(s => s.id)
  const accepted = sent
    .filter(s => !rejectedSet.has(s.id) && !staleSet.has(s.id) && !remerged.has(s.id) && !settled.has(s.id))
    .filter(s => serverReportsRejections || (returned.get(s.id) ?? '') >= s.updatedAt)
    .map(s => s.id)

  // rejected rows must NOT pin the cursor (that was the old bug)
  return {
    merged,
    cursor: cursor === since ? null : cursor,
    unconfirmed: [...new Set([...unconfirmed, ...remerged])],
    rejected: [...rejectedSet].filter(id => !superseded.has(id) && !remerged.has(id) && !settled.has(id)),
    remerged: [...remerged],
    settled: [...settled],
    accepted,
    conflicts,
  }
}

/** Pull overlap: ask for records from 10s before the cursor to cover commit-order skew. */
export function pullSince(cursor: string | null): string | null {
  if (!cursor) return null
  const t = Date.parse(cursor)
  if (!Number.isFinite(t)) return cursor
  return new Date(t - 10_000).toISOString()
}

/**
 * Whether a deleted row belongs in the Trash — the ONE rule, read by the Trash
 * itself and by the count on its button (TasksScreen). They disagreed once:
 * the badge said two while the list said empty.
 *
 * Here rather than beside the view, because the count is drawn in the first
 * load and the Trash is a lazy chunk; importing the component for a predicate
 * would pull the whole dialog into the launch (lazyload.test.ts).
 *
 * A purged tombstone has no content left to restore. A snooze and a chat turn
 * are states rather than records — nobody came here to put a nudge back off.
 */
export const inTrash = (i: Item): boolean => !!i.deletedAt && !i.purged && i.kind !== 'snooze' && i.kind !== 'chat'
