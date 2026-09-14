// Types for the batch runner src/ imports in tests. The runtime is mirror.mjs;
// this exists only so tsc (which checks src/) does not see an implicit any.
// Netlify bundles the .mjs directly and never reads this file.

export declare const MIRROR_BUDGET_MS: number
export declare const MIRROR_MAX_RECORDS: number
export declare function isFatalStatus(status: unknown): boolean

export interface MirrorBatchResult {
  created: number
  updated: number
  removed: number
  skipped: number
  /** Accepted by the provider (including "nothing to do"). */
  done: string[]
  /** Refused by the provider. */
  errors: { id: string; error: string; status?: number }[]
  /** Never attempted: past the budget, past `max`, or after a fatal refusal. */
  left: string[]
  /** The account refused outright (revoked, not connected); the rest were not tried. */
  fatal: boolean
}

// R falls back to any: the functions pass records straight from a request body.
export declare function runMirrorBatch<R extends { id: string } = any>(
  records: R[],
  push: (record: R) => Promise<string>,
  opts?: { budgetMs?: number; max?: number; now?: () => number; startedAt?: number },
): Promise<MirrorBatchResult>

/** A copy's description as plain text: Google's own editor saves HTML. */
export declare function copyText(text: unknown): string
/** The owner's own notes in a copy's description, Drafter's footer taken off (`task` for a task's longer one). */
export declare function ownNotes(text: unknown, opts?: { task?: boolean }): string
/** A task copy's title without Drafter's priority mark. */
export declare function ownTitle(summary: unknown): string
