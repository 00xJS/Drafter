import { Person, Task } from '../src/types.js'

export declare const DEFAULT_CADENCE_DAYS: number
export declare const DAY_MS: number

export interface Visit {
  task: Task
  at: string
}

export declare function visitsFor(personId: string, tasks: Task[]): Visit[]
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
  status: 'never' | 'overdue' | 'due' | 'ok'
  reason: string
  lastSeen?: string
  daysSince?: number
  visits: Visit[]
  effectiveCadenceDays: number
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
