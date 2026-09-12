export interface Clock {
  /** The IANA zone every day key is in. */
  tz: string
  now(): Date
  /** now() as an ISO string, for record stamps. */
  iso(): string
  /** Today's YYYY-MM-DD in the zone. */
  todayKey(): string
  /** The local day of an instant, or null when it is not a date. */
  dayKeyOf(value: string | number | Date | null | undefined): string | null
  shiftDay(key: string, n: number): string
  /** Epoch ms of the day's first instant in the zone (NaN for a bad key). */
  startOfDayMs(key: string): number
}

export declare function validZone(tz: unknown): string | null
export declare function machineTimeZone(): string
export declare function startOfDayMs(key: string, tz: string): number
export declare function makeClock(tz?: string | null, nowMs?: () => number): Clock
