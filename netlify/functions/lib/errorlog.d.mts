import type { CleanReport } from '../../../shared/errorreport.mts'

type Rest = (path: string, init?: RequestInit) => Promise<unknown>

export interface StoredError {
  id: string
  message: string
  stack: string | null
  count: number
  firstAt: string | null
  lastAt: string | null
  build: string | null
  platform: string | null
  view: string | null
  path: string | null
}

export declare const MAX_REPORTS: number
export declare const LIST_LIMIT: number
export declare function cleanReports(list: unknown): CleanReport[]
/** `userId` is null for a report no account sent: a Content-Security-Policy violation's. */
export declare function storeReports(rest: Rest, userId: string | null, reports: CleanReport[]): Promise<number>
export declare function listErrors(rest: Rest, limit?: number): Promise<StoredError[]>
export declare function clearErrors(rest: Rest, id?: string | null): Promise<number>
