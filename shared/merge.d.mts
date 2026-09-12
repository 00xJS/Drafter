/** One place this device's edit lost to a different edit of the same field on another device. */
export interface MergeConflict {
  /** `[field]`, or `[field, elementKey, subfield]` inside a keyed list. */
  path: string[]
  local: unknown
  remote: unknown
}

export interface MergeResult<T> {
  merged: T
  conflicts: MergeConflict[]
}

type SyncedRecord = { kind: string; id: string; purged?: boolean; ownerId?: string }

export declare const SET_FIELDS: ReadonlySet<string>
export declare function same(a: unknown, b: unknown): boolean
export declare function sameContent(a: object | null | undefined, b: object | null | undefined): boolean
export declare function elementKey(kind: string | undefined, field: string, el: unknown): string | null
export declare function mergeRecord<T extends SyncedRecord>(base: T | null | undefined, local: T, remote: T): MergeResult<T>
export declare function applyLocalChoice<T extends object>(record: T, conflicts: readonly MergeConflict[]): T
