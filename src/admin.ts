import { apiFetch } from './api'

export interface AdminUser {
  id: string
  email: string
  createdAt: string | null
  lastSignInAt: string | null
  confirmedAt: string | null
  disabled: boolean
  bannedUntil: string | null
}

export interface IntegrationPiece {
  configured: boolean
  missing: string[]
  redirectUri?: string
  nvidia?: boolean
  /** How many NVIDIA keys the host has (NVIDIA_API_KEY, NVIDIA_API_KEY_2): 0, 1 or 2. Never their values. */
  nvidiaKeys?: number
  anthropic?: boolean
}

export interface AdminStatus {
  google: IntegrationPiece
  microsoft: IntegrationPiece
  vapid: IntegrationPiece
  apns: IntegrationPiece
  ai: IntegrationPiece
  github: IntegrationPiece
  resend: IntegrationPiece
  /** Owner bootstrap: app_config.owner_email. */
  owner: { configured: boolean; email: string | null }
}

export interface DataStats {
  total: number
  live: number
  tombstones: number
  purged: number
  unowned: number
  kinds: Record<string, number>
  newestSyncedAt: string | null
  users: { userId: string | null; email: string | null; live: number; deleted: number }[]
  historyRows: number | null
  households: number | null
  householdMembers: number | null
}

export interface BackupFile {
  name: string
  path: string
  date: string
  size: number
  updatedAt: string | null
}

export interface BackupList {
  users: { userId: string; email: string | null; bytes: number; files: BackupFile[] }[]
  totalFiles: number
  totalBytes: number
  lastBackupAt: string | null
  keep: number
}

export interface BackupReport {
  date: string
  users: { userId: string; path: string; items: number; bytes: number; kept: number; dropped: number; encrypted?: boolean }[]
  /** Whether this host holds BACKUP_PASSPHRASE, so the snapshots it writes are encrypted (v3.25). */
  encrypted?: boolean
  failures: string[]
  unowned: number
  historyPurged: number | null
  /** Wardrobe photos no piece pointed at any more, deleted; null when the sweep could not run. */
  photosDeleted?: number | null
  /** Rows past their 90 days in the Trash emptied of their content; null when that could not run. */
  trashEmptied?: number | null
  tombstonesPurged: number | null
}

export interface AiTest {
  ok: boolean
  provider: string | null
  latencyMs: number
  sample: string
  error: string | null
  /** With two NVIDIA keys, each one asked on its own as well, by its name (never its value). */
  keys?: { name: string; ok: boolean; latencyMs: number; error: string | null }[]
}

export interface PushTest {
  ok: boolean
  latencyMs?: number
  dropped?: number
  results?: { endpoint: string; ok: boolean; status: number; error: string | null }[]
  error: string | null
}

export interface DigestTest {
  ok: boolean
  sent: boolean
  timezone: string
  digestHour: number
  lastDigestDay: string | null
  lines: string[]
  counts: { overdue: number; dueToday: number; occasions: number; peopleDue: number }
  pushed?: number
  emailed?: boolean
  error: string | null
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok || !body) throw new Error(body?.error ?? `HTTP ${res.status}`)
  return body
}

export function adminAction<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  return apiFetch('/api/admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  }).then(json<T>)
}

export function fetchAdminMe(): Promise<{ isOwner: boolean }> {
  return adminAction('me')
}

/** Admin's sections, in its own order; Users is where it opens unless another is asked for. */
/**
 * Admin's tabs. Integration health is no longer one of them (v3.25): it is a
 * page of read-outs about the host that the owner sets up once and then never
 * touches, and it was a third of this dialog. It folds away inside Data now,
 * where "is the server all right" already lives.
 */
export type AdminGroup = 'users' | 'data' | 'backups'

/** The latest sync check (public.sync_canary), as admin.mjs reports it: one sentence and the stored record. */
export interface SyncCheck {
  sentence: string
  record: {
    ok: boolean
    checked: number
    failures: { kind: string | null; reason: string }[]
    error: string | null
    at: string
    failingSince: string | null
    alertedAt: string | null
  } | null
}

/** The latest sync check on its own, as Admin → Data reads it: Today's banner for the owner. */
export function fetchSyncCheck(): Promise<SyncCheck> {
  return adminAction('syncCheck')
}
