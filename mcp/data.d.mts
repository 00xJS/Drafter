// Types for mcp/data.mjs. Rows are loose records: the tools read many kinds.

export type Row = { user_id?: string | null; data?: Record<string, unknown> | null }
export type Item = Record<string, any>

export interface RestData {
  mode: 'user' | 'service'
  userId: string | null
  ownerId(): Promise<string | null>
  fetchAll(opts?: { kinds?: string[] }): Promise<Item[]>
  fetchItem(id: string, kind: string): Promise<Item>
  fetchJournal(): Promise<Item[]>
  syncWrite(items: Record<string, unknown>[]): Promise<Item[]>
  writeItem(item: Record<string, unknown>): Promise<Item>
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
