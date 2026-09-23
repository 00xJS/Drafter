import { SNOOZE_OPTIONS, Snooze, SnoozeTarget } from './types'
import { newerStamp } from '../shared/domain.mts'

// Putting a nudge off. Today asks you about people you have not seen, places
// you meant to go back to and what is coming up; sometimes the honest answer
// is "not now", and the only two answers on offer were "done" and leaving it
// there to ask again tomorrow.
//
// A snooze is never forever. Every option has a day it comes back, so nothing
// is quietly dropped: the row simply stops counting once `until` has passed.
// It is PERSONAL (shared/kinds.mts), because whose nudge it is decides whose
// snooze it is.

/**
 * One row per member and thing, so putting the same nudge off again overwrites
 * it, and two people putting off the same person never write one row.
 *
 * It was `snooze~<target>~<targetId>`, with nobody in it, and `posts` is keyed
 * on the id alone. The second member to put off someone the first already had
 * wrote the first member's row — personal, so invisible to them — and the
 * policy refused it: "1 unsynced" for good, and the snooze never reached their
 * other devices. With the member in the id each has a row of their own, as
 * meals and grocery lists got theirs in v3.21 (shared/kitchen.mts).
 *
 * `userId` is null in local mode, where there is one member and the id is what
 * it always was. A row already written under the old id is never renamed; the
 * writers find it by what it is about (snoozeFor) and keep its id.
 */
export const snoozeId = (target: SnoozeTarget, targetId: string, userId?: string | null): string =>
  userId ? `snooze~${target}~${targetId}~${userId}` : `snooze~${target}~${targetId}`

/** The row that puts `targetId` off until `until`, ready to upsert; `userId` is whose it is (null in local mode). */
export function makeSnooze(target: SnoozeTarget, targetId: string, until: Date | string, now = new Date(), userId: string | null = null): Snooze {
  const stamp = now.toISOString()
  return {
    kind: 'snooze',
    id: snoozeId(target, targetId, userId),
    target,
    targetId,
    until: typeof until === 'string' ? until : until.toISOString(),
    createdAt: stamp,
    updatedAt: stamp,
  }
}

/**
 * The live row `userId` puts this thing off with, under either id, or null: the
 * most recently written, should a device hold both.
 *
 * A row under the old, member-less id counts only once the server has said it
 * is theirs (`ownerId`). One this device wrote that never landed may be the
 * very row the other member holds — the write the policy refused — and building
 * on it would only be refused again. With no `userId` (local mode) every row is
 * the one member's.
 */
export function snoozeFor(snoozes: readonly Snooze[], target: SnoozeTarget, targetId: string, userId?: string | null): Snooze | null {
  const mine = snoozeId(target, targetId, userId)
  const legacy = snoozeId(target, targetId)
  let found: Snooze | null = null
  for (const s of snoozes ?? []) {
    if (s.deletedAt || s.target !== target || s.targetId !== targetId) continue
    if (userId && s.id !== mine && !(s.id === legacy && s.ownerId === userId)) continue
    if (!found || s.updatedAt > found.updatedAt) found = s
  }
  return found
}

/**
 * What putting `targetId` off until `until` writes for `userId`, and what its
 * Undo writes back: the row this member already has for it keeps its id — the
 * old member-less one included — and is stamped newer than itself; otherwise a
 * new row under the member's id. `undo` is that earlier row stamped newer again,
 * or null when there was none and the new row is simply removed.
 */
export function snoozeWrite(
  snoozes: readonly Snooze[],
  target: SnoozeTarget,
  targetId: string,
  until: Date | string,
  userId: string | null,
  now = new Date(),
): { row: Snooze; undo: Snooze | null } {
  const fresh = makeSnooze(target, targetId, until, now, userId)
  const had = snoozeFor(snoozes, target, targetId, userId)
  if (!had) return { row: fresh, undo: null }
  // whatever else the row carries (its owner, a newer build's fields) rides along
  const row: Snooze = { ...had, ...fresh, id: had.id, createdAt: had.createdAt, updatedAt: newerStamp(had.updatedAt) }
  return { row, undo: { ...had, updatedAt: newerStamp(row.updatedAt) } }
}

/** `days` from now, at this moment of the day: "a fortnight" means a fortnight, not "the 14th". */
export function snoozeUntil(days: number, now = new Date()): string {
  const d = new Date(now)
  d.setDate(d.getDate() + days)
  return d.toISOString()
}

/**
 * The ids still being put off, by target kind. A row whose `until` has passed
 * is spent and left out — nothing sweeps it, because writing the same id again
 * is how the next snooze is made.
 */
export function snoozedIds(snoozes: readonly Snooze[], target: SnoozeTarget, now = new Date()): Set<string> {
  const nowMs = now.getTime()
  const out = new Set<string>()
  for (const s of snoozes ?? []) {
    if (s.deletedAt || s.target !== target) continue
    const until = Date.parse(s.until)
    if (Number.isFinite(until) && until > nowMs) out.add(s.targetId)
  }
  return out
}

/**
 * When this one comes back, or null if it is not being put off. Read off what
 * each row is about rather than a computed id, which differs by member and by
 * build; the latest day any live row gives, as snoozedIds counts every one.
 */
export function snoozedUntil(snoozes: readonly Snooze[], target: SnoozeTarget, targetId: string, now = new Date()): string | null {
  let back: string | null = null
  for (const s of snoozes ?? []) {
    if (s.deletedAt || s.target !== target || s.targetId !== targetId) continue
    const until = Date.parse(s.until)
    if (Number.isFinite(until) && until > now.getTime() && (!back || until > Date.parse(back))) back = s.until
  }
  return back
}

/** "back in 3 days", "back tomorrow" — what the undo line says after a snooze. */
export function snoozeBackLabel(until: string, now = new Date()): string {
  const days = Math.round((Date.parse(until) - now.getTime()) / 86_400_000)
  if (!Number.isFinite(days)) return 'back later'
  if (days <= 0) return 'back today'
  if (days === 1) return 'back tomorrow'
  return `back in ${days} days`
}

export { SNOOZE_OPTIONS }
