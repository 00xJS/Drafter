import type { Scope } from './agentauth.mjs'

export type EndpointResult = { status: number; json?: Record<string, any>; headers?: Record<string, string> }

export type AuthorizeFailure = {
  ok: false
  error: 'unknown_client' | 'redirect_mismatch' | 'redirect_not_allowed' | 'unsupported_response_type' | 'pkce_required' | 'invalid_resource' | 'limit'
  message: string
}

export type AuthorizeDescription =
  | { ok: true; clientName: string; redirectHost: string; loopback: boolean; requestedScopes: Scope[]; existingConnectionId: string | null }
  | AuthorizeFailure

export declare const DEFAULT_SITE: string
export declare const DEFAULT_REDIRECT_ALLOWLIST: string
export declare const CODE_TTL_MS: number
export declare const ACCESS_TTL_S: number
export declare const REGISTRATIONS_PER_HOUR: number
export declare const TOKEN_REQUESTS_PER_MINUTE: number
export declare function issuer(): string
export declare function resourceUrl(): string
export declare function protectedResourceMetadata(): Record<string, any>
export declare function authorizationServerMetadata(): Record<string, any>
export declare function redirectAllowed(uri: unknown, allowlist?: string): boolean
export declare function sameRedirect(registered: string, given: string): boolean
export declare function pkceS256Matches(verifier: unknown, challenge: unknown): boolean
export declare function registerClient(body: unknown): Promise<EndpointResult>
export declare function describeAuthorizeRequest(userId: string, params: unknown): Promise<AuthorizeDescription>
export declare function approve(
  userId: string,
  params: unknown,
  answer?: { decision?: unknown; scopes?: unknown; timezone?: unknown },
): Promise<{ ok: true; redirect: string } | AuthorizeFailure>
export declare function tokenEndpoint(input: unknown): Promise<EndpointResult>
export declare function revokeEndpoint(input: unknown): Promise<EndpointResult>
export declare function routeOf(pathname: string): 'prm' | 'as' | 'register' | 'token' | 'revoke' | 'request' | 'approve' | null
export declare function oauthHandler(req: Request, context?: unknown): Promise<Response>
