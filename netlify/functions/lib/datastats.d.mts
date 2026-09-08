export const KINDS: string[]
export const UNKNOWN_KIND: string

export interface StatsRow {
  user_id?: string | null
  deleted?: boolean | null
  kind?: string | null
  purged?: string | null
  synced_at?: string | null
}

export interface UserRowCount {
  userId: string | null
  email: string | null
  live: number
  deleted: number
}

export interface DataStats {
  total: number
  live: number
  tombstones: number
  purged: number
  unowned: number
  kinds: Record<string, number>
  newestSyncedAt: string | null
  users: UserRowCount[]
}

export function shapeDataStats(rows: StatsRow[] | null | undefined, opts?: { emails?: Record<string, string> }): DataStats
