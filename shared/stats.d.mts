// Types for shared/stats.mjs: the day-key rules every Stats figure counts by.

export declare function daysBetween(from: string, to: string): number
export declare function inWindow(day: string, dayKey: string, window: number | 'all'): boolean
export declare function daysWithin(days: readonly string[], dayKey: string, window: number | 'all'): number
export declare function distinctDays(items: readonly { at: string }[] | null | undefined, dayKeyOf: (at: string) => string | null | undefined): string[]

/** Days in a row: the run reaching today (or yesterday, while today waits), and the longest there has been. */
export interface Streaks {
  current: number
  best: number
}
export declare function dayStreaks(days: Iterable<string>, today: string): Streaks

/** How topN ranks: what a row counts, its name for a tie, and a tie-break before the name. */
export interface RankBy<T> {
  count(row: T): number
  name(row: T): string
  tie?(a: T, b: T): number
}
export declare function topN<T>(rows: readonly T[], n: number, by: RankBy<T>): T[]
