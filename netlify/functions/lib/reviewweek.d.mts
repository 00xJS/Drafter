// Types for the helpers src/ imports in tests. The runtime is reviewweek.mjs.

/** Epoch ms at which `dayKey` (YYYY-MM-DD) begins in `tz`; an unknown zone reads as UTC. */
export declare function zonedMidnight(dayKey: string, tz: string | null | undefined): number

export declare function shiftDayKey(key: string, days: number): string | null

export declare function previousWeekIn(
  now: Date,
  tz: string | null | undefined,
): { key: string | null; label: string; startKey: string | null; endKey: string | null; start: Date; end: Date }
