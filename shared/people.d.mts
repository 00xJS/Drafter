import { CalendarEntry, Person, Task } from '../src/types.js'

export declare const DEFAULT_CADENCE_DAYS: number
export declare const DAY_MS: number

/** "No reminders" on a person or a place: `noReminders: true`, never a rhythm of 0. */
export declare function remindersOff(record: { noReminders?: unknown } | null | undefined): boolean
/** The rhythms the app offers, in days. */
export declare const RHYTHM_CHOICES: readonly number[]
/** A rhythm as the setup sheet holds it: days, No reminders, or none set. */
export type Rhythm = number | 'off' | null
export declare function rhythmOf(record: { cadenceDays?: unknown; noReminders?: unknown } | null | undefined): Rhythm
/** The record with this rhythm, the two fields kept from disagreeing; not stamped. */
export declare function withRhythm<T extends { cadenceDays?: number; noReminders?: boolean }>(record: T, rhythm: Rhythm): T
/** From distinct day keys seen and today's: one of RHYTHM_CHOICES, or null with nothing in a year. */
export declare function suggestRhythm(days: readonly string[] | null | undefined, todayKey: string): number | null

export interface Visit {
  task: Task
  at: string
}

export declare function visitsFor(personId: string, tasks: Task[]): Visit[]
export { distinctDays as visitDays } from './stats.mjs'
export declare function eventVisits(entries: CalendarEntry[], now?: Date | string | number): Task[]
export declare function ownVisit(row: { ownerId?: string; assigneeId?: string } | null | undefined, myId?: string | null): boolean
export declare function seenTasks(
  tasks: Task[],
  entries: CalendarEntry[] | undefined,
  now?: Date | string | number,
  myId?: string | null,
): Task[]
export declare function plannedVisit(personId: string, tasks: Task[]): Task | null
export declare function plannedGift(
  personId: string,
  kind: 'birthday' | 'anniversary',
  occasionAt: Date | string | number,
  tasks: Task[],
  windowDays?: number,
): Task | null
export declare function seenStatus(
  person: Person,
  tasks: Task[],
  now?: Date | string | number,
): {
  /** 'off' for someone on No reminders, whatever their visits say. */
  status: 'never' | 'overdue' | 'due' | 'ok' | 'off'
  reason: string
  lastSeen?: string
  daysSince?: number
  visits: Visit[]
  /** Null on No reminders: there is no rhythm to measure against. */
  effectiveCadenceDays: number | null
}
export declare function upcomingOccasions(
  people: Person[],
  days?: number,
  now?: Date | string | number,
  todayKey?: string,
): {
  person: Person
  kind: 'birthday' | 'anniversary'
  at: Date
  daysUntil: number
  years?: number
}[]
