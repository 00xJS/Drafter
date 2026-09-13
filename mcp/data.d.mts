// Types for mcp/data.mjs. Rows are loose records: the tools read many kinds.

export type Row = { user_id?: string | null; data?: Record<string, unknown> | null }
/** A stored record of any kind. Loose, so a row passes to the shared helpers typed for one kind. */
export type Item = any
/** What a write sends: every record carries its kind and id, and whatever else it has. */
export type Writable = { id: string; kind: string }

export interface RestData {
  mode: 'user' | 'service'
  userId: string | null
  ownerId(): Promise<string | null>
  fetchAll(opts?: { kinds?: string[] }): Promise<Item[]>
  fetchItem(id: string, kind: string): Promise<Item>
  fetchJournal(): Promise<Item[]>
  syncWrite<T extends Writable>(items: T[]): Promise<Item[]>
  writeItem<T extends Writable>(item: T): Promise<Item>
}

export declare const PERSONAL_KINDS: ReadonlySet<string>
export declare const PAGE_SIZE: number
export declare const SINCE_WINDOW_MS: number
export declare function ownerMaySee(row: Row, owner: string | null | undefined): boolean
export declare class DataError extends Error {
  status: number
  constructor(message: string, status: number)
}
export declare function createRestData(opts: {
  baseUrl: string
  auth: () => Promise<{ apikey: string; bearer: string }>
  userId?: string | null
  mode?: 'user' | 'service'
  onUnauthorized?: (() => void) | null
}): RestData
