// Types for shared/wardrobe.mjs: the wardrobe's rules the app and the MCP server share.

import type { Garment, GarmentType, Outfit, Wear } from '../src/types.js'

export declare const GARMENT_TYPES: GarmentType[]
export declare const CORE_TYPES: GarmentType[]
export declare const MAX_PIECES: number

export declare function wearId(day: string, rand?: () => string): string
export declare function cleanIds(ids: readonly string[]): string[]
export declare function newWear(day: string, garmentIds: readonly string[], now?: string, rand?: () => string): Wear
export declare function withPieces(w: Wear, garmentIds: readonly string[]): Wear
export declare function looksOn(wears: readonly Wear[], day: string): Wear[]

export declare function liveById(garments: readonly Garment[]): Map<string, Garment>
export declare function orderPieces(ids: readonly string[], byId: ReadonlyMap<string, Garment>): string[]

/** A log: the look to write, and what its Undo puts back — that look as it was, stamped newer again, or the new one to remove. */
export interface LookLog {
  write: Wear
  undo: Wear | { remove: string }
}
export declare function logLook(
  wears: readonly Wear[],
  day: string,
  pieces: readonly string[],
  records: readonly Garment[],
  opts?: { another?: boolean; shown?: ReadonlySet<string>; now?: string; rand?: () => string },
): LookLog

export declare function pieceKey(ids: readonly string[]): string
export declare function coreKey(ids: readonly string[], byId: ReadonlyMap<string, Garment>): string | null
export declare function canDress(garments: readonly Garment[]): boolean
export declare function wearable(ids: readonly string[], byId: ReadonlyMap<string, Garment>): boolean
export declare function notInUse(ids: readonly string[], byId: ReadonlyMap<string, Garment>): string
export declare function unwearable(ids: readonly string[], byId: ReadonlyMap<string, Garment>): string | null
export declare function outfitLabel(ids: readonly string[], byId: ReadonlyMap<string, Garment>): string

export interface WearIndex {
  dayKey: string
  /** garment id → distinct days worn, newest first; never after dayKey. */
  days: ReadonlyMap<string, readonly string[]>
  /** Every day with a live, non-empty look, newest first. */
  logged: readonly string[]
  /** day → its live, non-empty looks, oldest first. */
  looks: ReadonlyMap<string, readonly Wear[]>
}
export declare function wearIndex(wears: readonly Wear[], dayKey: string): WearIndex
export declare function daysWithin(days: readonly string[], dayKey: string, window: number): number

/**
 * A window in day keys. A day filed at midday would cross visitSummary's
 * millisecond 30-day line during the afternoon, and the list would change
 * between the morning and the evening.
 */
export type WearWindow = 30 | 365 | 'all'
export declare function mostWorn(garments: readonly Garment[], ix: WearIndex, window?: WearWindow, limit?: number): { garment: Garment; count: number; lastWorn: string }[]
export declare const NOT_WORN_DAYS: number
export declare function notWornLately(garments: readonly Garment[], ix: WearIndex, days?: number): Garment[]
export declare const NEVER_WORN_GRACE_DAYS: number
export declare function neverWorn(garments: readonly Garment[], ix: WearIndex, grace?: number, dayOf?: (iso: string) => string): Garment[]
export declare function outfitDays(o: Outfit, ix: WearIndex, byId: ReadonlyMap<string, Garment>): string[]
