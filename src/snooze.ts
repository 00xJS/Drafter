import { SNOOZE_OPTIONS, Snooze, SnoozeTarget } from './types'

// Putting a nudge off. Today asks you about people you have not seen, places
// you meant to go back to and what is coming up; sometimes the honest answer
// is "not now", and the only two answers on offer were "done" and leaving it
// there to ask again tomorrow.
//
// A snooze is never forever. Every option has a day it comes back, so nothing
// is quietly dropped: the row simply stops counting once `until` has passed.
// It is PERSONAL (shared/kinds.mts), because whose nudge it is decides whose
// snooze it is.

/** One row per thing, so putting the same nudge off again overwrites it. */
export const snoozeId = (target: SnoozeTarget, targetId: string): string => `snooze~${target}~${targetId}`

/** The row that puts `targetId` off until `until`, ready to upsert. */
export function makeSnooze(target: SnoozeTarget, targetId: string, until: Date | string, now = new Date()): Snooze {
  const stamp = now.toISOString()
  return {
    kind: 'snooze',
    id: snoozeId(target, targetId),
    target,
    targetId,
    until: typeof until === 'string' ? until : until.toISOString(),
    createdAt: stamp,
    updatedAt: stamp,
  }
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

/** When this one comes back, or null if it is not being put off. */
export function snoozedUntil(snoozes: readonly Snooze[], target: SnoozeTarget, targetId: string, now = new Date()): string | null {
  const row = (snoozes ?? []).find(s => !s.deletedAt && s.id === snoozeId(target, targetId))
  if (!row) return null
  const until = Date.parse(row.until)
  return Number.isFinite(until) && until > now.getTime() ? row.until : null
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
