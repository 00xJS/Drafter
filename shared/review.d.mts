import { Person, Task } from '../src/types.js'

export interface ReviewSpan {
  start: Date | number
  /** Exclusive. */
  end: Date | number
}

export declare function isVisit(task: { tags?: readonly string[] } | null | undefined): boolean
export declare function inRange(iso: string | null | undefined, start: Date | number, end: Date | number): boolean
export declare function reviewLists<T extends Task>(tasks: readonly T[], range: ReviewSpan, now?: Date | number): { done: T[]; visitsDone: T[]; slipped: T[] }
export declare function peopleSeen<P extends Person>(
  people: readonly P[],
  seen: Task[],
  range: ReviewSpan,
  dayKeyOf: (at: string) => string | null | undefined,
): { person: P; visits: Task[]; days: number }[]
