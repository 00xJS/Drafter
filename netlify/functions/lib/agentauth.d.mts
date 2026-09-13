// Types for the pieces of agentauth.mjs the tests and the other functions use.

export type Scope = 'read' | 'write' | 'journal'

export interface Connection {
  id: string
  kind: 'token' | 'oauth'
  name: string
  redirectHost: string | null
  scopes: Scope[]
  tokenPrefix: string | null
  createdAt: string
  lastUsedAt: string | null
}

export interface Grant {
  grantId: string
  userId: string
  scopes: Scope[]
  kind: 'token' | 'oauth'
}

export declare const PREFIX: { readonly manual: 'drft_'; readonly access: 'drft_at_'; readonly refresh: 'drft_rt_' }
export declare const SCOPES: readonly Scope[]
export declare const MAX_LIVE_CONNECTIONS: number
export declare function newSecret(prefix?: string): string
export declare function hashToken(token: string): string
export declare function normalizeScopes(scopes: unknown): Scope[]
export declare function supabaseEnv(): { url: string; anonKey: string; serviceKey: string }
export declare function agentAuthConfigured(): boolean
export declare function serviceRest<T = any>(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<T>
/**
 * A live grant, or why the bearer was refused. Each side names the other's
 * fields as absent, so the functions (plain JavaScript) can test `.error` and
 * then read the grant.
 */
export type BearerCheck =
  | (Grant & { error?: undefined })
  | { error: 'invalid' | 'rate_limited'; grantId?: undefined; userId?: undefined; scopes?: undefined; kind?: undefined }
export declare function checkBearer(bearer: string | null | undefined, opts?: { limit?: number }): Promise<BearerCheck>
export declare function userAccessToken(userId: string): Promise<string>
export declare function dropSession(userId: string): void
export declare function forgetAllSessions(): void
export declare function cleanName(name: unknown, max?: number): string
export declare function listConnections(userId: string): Promise<Connection[]>
export declare function createManualToken(userId: string, input?: { name?: unknown; scopes?: unknown }): Promise<{ token: string; connection: Connection }>
export declare function revokeConnection(userId: string, id: unknown): Promise<boolean>
export declare function renameConnection(userId: string, id: unknown, name: unknown): Promise<boolean>
export declare function agentsHandler(req: Request): Promise<Response>
