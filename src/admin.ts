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
