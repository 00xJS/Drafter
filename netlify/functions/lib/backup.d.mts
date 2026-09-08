export const KEEP_BACKUPS: number
export const HISTORY_TTL_MS: number
export const TOMBSTONE_TTL_MS: number
export const BUCKET: string
export const PREFIX: string

export interface PostRow {
  user_id?: string | null
  data?: unknown
}

export interface Snapshot {
  exportedAt: string
  userId: string
  items: unknown[]
}

export interface SnapshotFile {
  name: string
  path: string
  date: string
  size: number
  updatedAt: string | null
}

export interface BackupWrite {
  userId: string
  path: string
  items: number
  bytes: number
  kept: number
  dropped: number
}

export interface BackupReport {
  date: string
  users: BackupWrite[]
  failures: string[]
  unowned: number
  historyPurged: number | null
  tombstonesPurged: number | null
}

export function baseUrl(): string | undefined
export function rest(path: string, init?: RequestInit): Promise<unknown>
export function storage(path: string, init?: RequestInit): Promise<unknown>
export function dayKey(d?: Date | string | number): string
export function groupRowsByUser(rows: PostRow[] | null | undefined): Map<string, PostRow[]>
export function backupPath(userId: string, date?: string): string
export function isSnapshotPath(path: unknown): boolean
export function buildSnapshot(userId: string, rows: PostRow[] | null | undefined, exportedAt?: Date | string | number): Snapshot
export function snapshotsToDrop(names: (string | undefined)[] | null | undefined, keep?: number): { kept: string[]; drop: string[] }
export function listUserSnapshots(userId: string): Promise<SnapshotFile[]>
export function listAllSnapshots(): Promise<{ userId: string; files: SnapshotFile[] }[]>
export function signSnapshotUrl(objectPath: string, expiresIn?: number): Promise<string>
export function backupUser(userId: string, rows: PostRow[], date?: string, exportedAt?: Date): Promise<BackupWrite>
export function purgeHistory(now?: Date): Promise<number | null>
export function purgeTombstones(now?: Date): Promise<number | null>
export function runBackup(now?: Date): Promise<BackupReport>
