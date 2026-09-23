// Types for sundaydraft.mjs. The runtime is sundaydraft.mjs.

export declare const DRAFT_KINDS: readonly string[]
export declare const DRAFT_MS: number
export declare const JOB_MS: number

export declare function draftIdOf(key: string, userId: string): string
export declare function ownReviews<T extends Record<string, any>>(items: readonly T[] | null | undefined, userId: string, key: string): T[]
/** The account's review of the week before `now`, from the records given; null when it has none. */
export declare function weekReviewOf(items: readonly Record<string, any>[] | null | undefined, userId: string, now: Date, tz: string | null | undefined): Record<string, any> | null
/** Whether a week's review still wants a draft. */
export declare function wantsDraft(review: { summary?: string; reflections?: string; draftedAt?: string } | null | undefined): boolean
export declare function disabledAccounts(now: Date, ms?: number): Promise<Set<string>>
export declare function draftPrompt(items: readonly Record<string, any>[], userId: string, meta: ReturnType<typeof import('./reviewweek.mjs').previousWeekIn>, now: Date, opts?: { tz?: string; journal?: boolean }): string

export type DraftOutcome =
  | { state: 'drafted'; id: string; summary: string }
  | { state: 'had one' | 'stepped aside' }
  | { state: 'no answer' | 'failed'; why: string }

export declare function draftSundayReview(
  userId: string,
  items: readonly Record<string, any>[],
  now: Date,
  opts?: { timezone?: string; journal?: boolean; ownerId?: string | null; deadline?: number },
): Promise<DraftOutcome>

export declare function runSundayDrafts(job: Record<string, unknown>): Promise<{ counts: Record<string, number>; failures: string[] }>
