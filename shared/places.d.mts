import { Meal, Place, Task } from '../src/types.js'

export type PlaceCategory = 'restaurant' | 'fastfood' | 'cafe' | 'bar' | 'outdoors' | 'venue' | 'shop' | 'home' | 'other'
/** In the order the app offers them. The MCP server's category enum is this list. */
export declare const PLACE_CATEGORIES: PlaceCategory[]
export declare const PLACE_CATEGORY_META: Record<PlaceCategory, { label: string; emoji: string }>

export declare function normalisePlaceText(s: string | null | undefined): string
export declare function matchPlace(text: string | null | undefined, places: Place[]): Place | null

/** A done task at the place, or a past meal you marked as eaten out there. */
export type Outing = { kind: 'task'; task: Task; at: string } | { kind: 'meal'; meal: Meal; at: string }
/** Newest first. Future meals are plans, not visits, so they are excluded. */
export declare function outingsAt(placeId: string, tasks: Task[], meals?: Meal[], now?: Date): Outing[]

export type PlaceCadenceState = 'none' | 'never' | 'ok' | 'due' | 'overdue'
export interface PlaceCadenceStatus {
  status: PlaceCadenceState
  /** Empty when no cadence is set. */
  reason: string
  lastAt?: string
  daysSince?: number
  cadenceDays?: number
}
/**
 * Opt-in per place: no cadenceDays means 'none', never due or overdue. Meals
 * are required so every caller decides: one that leaves them out says "been a
 * while" about the place you ate at last night.
 */
export declare function placeCadenceStatus(place: Place, tasks: Task[], now: Date, meals: Meal[]): PlaceCadenceStatus
