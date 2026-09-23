// Types for the helpers src/ imports in tests. The runtime is reviewweek.mjs.

/** Epoch ms at which `dayKey` (YYYY-MM-DD) begins in `tz`; an unknown zone reads as UTC. */
export declare function zonedMidnight(dayKey: string, tz: string | null | undefined): number

export declare function shiftDayKey(key: string, days: number): string | null

/** Throws a RangeError for a Date that is no date. */
export declare function previousWeekIn(
  now: Date,
  tz: string | null | undefined,
): { key: string; label: string; startKey: string; endKey: string; start: Date; end: Date }

/** Whether Sunday's review is due for an account (its user_settings row, or {}) at `now`: its Sunday, from its digest hour. */
export declare function sundayDraftDue(settings: { timezone?: string | null; digest_hour?: number | null } | null | undefined, now: Date): boolean

/** How many hourly runs on a Sunday start the draft. */
export declare const DRAFT_TRIES: number

/** Whether this hourly run starts Sunday's draft for an account: the hour before its digest hour and the next DRAFT_TRIES - 1. */
export declare function sundayDraftStarts(settings: { timezone?: string | null; digest_hour?: number | null } | null | undefined, now: Date): boolean

export declare function firstSentence(text: string | null | undefined, max?: number): string

/** Sunday's digest line: the review's first sentence, or the invitation to look back. */
export declare function sundayLine(summary: string | null | undefined): string
