export function missingApnsEnv(): string[]
export function apnsConfigured(): boolean
export function apnsHostFor(env: 'sandbox' | 'production'): string
export function makeApnsJwt(key: { keyId: string; teamId: string; privateKey: string }, nowMs?: number): string
export function apnsPayload(p: {
  title?: string
  body?: string
  tag?: string
  url?: string
  badge?: number
}): { aps: { alert: { title: string; body: string }; sound: string; 'thread-id'?: string; badge?: number }; url?: string }
export function isGoneReason(status: number, reason: string): boolean
export function sendApns(
  deviceToken: string,
  payload: unknown,
  opts?: { topic?: string; collapseId?: string; ttlSeconds?: number; env?: 'sandbox' | 'production' },
): Promise<{ status: number; reason: string; env: string }>
export function sendApnsWithRetry(
  deviceToken: string,
  payload: unknown,
  opts?: { topic?: string; collapseId?: string; ttlSeconds?: number; env?: 'sandbox' | 'production' },
): Promise<{ status: number; reason: string; env: string; envUpdated: boolean }>
