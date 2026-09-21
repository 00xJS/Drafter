export const KEEP_BACKUPS: number
export const HISTORY_TTL_MS: number
export const TOMBSTONE_TTL_MS: number
export const PHOTO_GRACE_MS: number
export const TRASH_KEEPS_PHOTOS_MS: number
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
  /** Written through BACKUP_PASSPHRASE rather than in the clear (v3.25). */
  encrypted: boolean
}

export interface BackupReport {
  date: string
  users: BackupWrite[]
  failures: string[]
  /** Whether this host encrypts what it writes: BACKUP_PASSPHRASE is set. */
  encrypted: boolean
  unowned: number
  historyPurged: number | null
  /** Wardrobe photos no piece of clothing pointed at, deleted; null when the sweep could not run. */
  photosDeleted: number | null
  tombstonesPurged: number | null
}

/** One entry of a storage list: a folder has a null id. */
export interface ListedObject {
  name?: string
  id?: string | null
  updated_at?: string | null
  created_at?: string | null
}

export function baseUrl(): string | undefined
export function rest(path: string, init?: RequestInit): Promise<unknown>
/** Every row a select matches (it must select `id`), or a throw: never a list cut short at max_rows. */
export function restAll(path: string, pageSize?: number): Promise<Record<string, unknown>[]>
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
/** The paths in an account's personal/ folder that may go: its own photos, pointed at by no piece, older than `olderThan` (null: any age). */
export function photosToSweep(userId: string, listed: readonly (ListedObject | null | undefined)[] | null | undefined, inUse: ReadonlySet<string>, olderThan: string | null): string[]
export function sweepPersonalPhotos(now?: Date): Promise<{ deleted: number; failures: string[] }>
export function removePersonalPhotos(userId: string): Promise<number>
export function runBackup(now?: Date): Promise<BackupReport>
