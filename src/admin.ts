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
  users: { userId: string; path: string; items: number; bytes: number; kept: number; dropped: number }[]
  failures: string[]
  unowned: number
  historyPurged: number | null
  tombstonesPurged: number | null
}

export interface AiTest {
  ok: boolean
  provider: string | null
  latencyMs: number
  sample: string
  error: string | null
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
