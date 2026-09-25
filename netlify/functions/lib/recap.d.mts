// Types for the helpers src/ imports in tests. The runtime is recap.mjs.
import type { Notice } from '../../../src/types.ts'
import type { Highlight } from '../../../shared/insights.mts'

/** The personal kinds the recap reads beyond the digest's own rows. */
export declare const RECAP_KINDS: readonly string[]
export declare const RECAP_LINES: number

/** The month an account's recap is for when this hour should send it (the 1st, from its digest hour, in its zone), or null. */
export declare function recapDue(u: { timezone?: string | null; digest_hour?: number | null } | null | undefined, now: Date): string | null

export declare function recapNoticeId(userId: string, month: string): string
export declare function recapPath(month: string): string

export declare function buildRecap(
  rows: readonly { user_id: string | null; data: unknown }[],
  userId: string,
  peerIds: Iterable<string> | null | undefined,
  ownerId: string | null,
  timezone: string | null | undefined,
  now: Date,
  month: string,
): {
  month: string
  title: string
  /** The notice's lines, for the bell: the first few highlights, names and all. */
  lines: string[]
  /** The push's body, for a lock screen: the household's counts alone (recapPushBody), never a name. */
  push: string
  cards: Highlight[]
}

export declare function recapNotice(userId: string, recap: { month: string; title: string; lines: string[] }, now: Date): Notice

/** A quiet month's mark: the recap notice's id as a content-free tombstone, so the month counts as done. */
export declare function recapQuietMark(userId: string, month: string, now: Date): Notice

export declare function keepWritten(existing: Notice | null | undefined, incoming: Notice): Notice
