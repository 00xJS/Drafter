export function missingApnsEnv(): string[]
export function apnsConfigured(): boolean
export function makeApnsJwt(key: { keyId: string; teamId: string; privateKey: string }, nowMs?: number): string
export function apnsPayload(p: { title?: string; body?: string; tag?: string; url?: string }): { aps: { alert: { title: string; body: string }; sound: string; 'thread-id'?: string }; url?: string }
export function isGoneReason(status: number, reason: string): boolean
export function sendApns(deviceToken: string, payload: unknown, opts?: { topic?: string; collapseId?: string; ttlSeconds?: number }): Promise<{ status: number; reason: string }>
