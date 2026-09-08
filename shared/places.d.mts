import { Place, Task } from '../src/types'

export declare function normalisePlaceText(s: string | null | undefined): string
export declare function matchPlace(text: string | null | undefined, places: Place[]): Place | null

export declare function outingsAt(placeId: string, tasks: Task[]): { task: Task; at: string }[]

export type PlaceCadenceState = 'none' | 'never' | 'ok' | 'due' | 'overdue'
export interface PlaceCadenceStatus {
  status: PlaceCadenceState
  /** Empty when no cadence is set. */
  reason: string
  lastAt?: string
  daysSince?: number
  cadenceDays?: number
}
/** Opt-in per place: no cadenceDays means 'none', never due or overdue. */
export declare function placeCadenceStatus(place: Place, tasks: Task[], now?: Date): PlaceCadenceStatus
