import { Habit, Person, Task } from '../src/types.js'

export interface ReviewSpan {
  start: Date | number
  /** Exclusive. */
  end: Date | number
}

/** One habit over a review period: due days kept and missed, and the streak it ended the period on. */
export interface HabitKept<H> {
  habit: H
  done: number
  due: number
  missed: number
  streak: number
}

export interface HabitsKept<H> {
  rows: HabitKept<H>[]
  done: number
  due: number
  /** 0–100, rounded; 0 when nothing was due. */
  pct: number
}

type HabitShape = Pick<Habit, 'name' | 'done' | 'createdAt'> & Partial<Pick<Habit, 'days' | 'deletedAt' | 'archivedAt'>>

export declare function isVisit(task: { tags?: readonly string[] } | null | undefined): boolean
export declare function inRange(iso: string | null | undefined, start: Date | number, end: Date | number): boolean
export declare function reviewLists<T extends Task>(tasks: readonly T[], range: ReviewSpan, now?: Date | number): { done: T[]; visitsDone: T[]; slipped: T[] }
export declare function peopleSeen<P extends Person>(
  people: readonly P[],
  seen: Task[],
  range: ReviewSpan,
  dayKeyOf: (at: string) => string | null | undefined,
): { person: P; visits: Task[]; days: number }[]
export declare function habitStreak(habit: Partial<Pick<Habit, 'days' | 'done'>> | null | undefined, lastKey: string, todayKey?: string): number
export declare function habitsKept<H extends HabitShape>(
  habits: readonly H[] | null | undefined,
  range: ReviewSpan,
  now: Date | number,
  dayKeyOf: (at: string) => string | null | undefined,
): HabitsKept<H>
export declare function habitLines(kept: HabitsKept<{ name: string }> | null | undefined): string[]
