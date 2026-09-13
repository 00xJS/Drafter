// Types for the OAuth binding helpers the functions and src/'s tests import.
// The runtime is oauth.mjs; tsc (src/, and tsconfig.server.json for the
// functions) reads this. Netlify bundles the .mjs directly and never reads it.

/** Opaque value for the verifier cookie; only its HMAC travels in the URL. */
export declare function newVerifier(): string
/** Set-Cookie for the short-lived, HttpOnly verifier cookie. */
export declare function cookieHeader(name: string, verifier: string): string
export declare function clearCookieHeader(name: string): string
export declare function readCookie(req: Request, name: string): string | null

export declare const HANDOFF_TTL_MS: number
export declare function newHandoff(): string
/** Marks a browser the app opened, so the callback returns to it. */
export declare const RETURN_COOKIE: string
/** Where the callback sends the browser: back into the app, or to the site. */
export declare function returnTarget(req: Request, origin: string): string
/** True when a stored handoff is still fresh. */
export declare function handoffFresh(at: string | null | undefined): boolean

/** The `state` for a verifier cookie: an HMAC, so only its holder can produce it. */
export declare function stateFor(verifier: string): string
/** True when this browser's cookie produced the (browser half of the) state. */
export declare function verifyState(req: Request, name: string, state: string): boolean

/** base64url(SHA-256(verifier)): RFC 7636's S256 challenge. */
export declare function challengeFor(verifier: string): string
export declare function validChallenge(challenge: unknown): challenge is string
/** A one-time handoff carrying the app's challenge. */
export declare function nativeHandoff(challenge: string): string
/** The challenge a handoff or native state carries, or null. */
export declare function handoffChallenge(value: string | null | undefined): string | null
/** The state of a native flow: browser half, then app half. */
export declare function nativeState(verifierCookie: string, challenge: string): string
export declare function isNativeState(state: string | null | undefined): boolean
export declare const NATIVE_UPDATE_NEEDED: string

export type CompletionRefusal = 'missing_code' | 'state_mismatch' | 'bad_state' | 'expired' | 'verifier_mismatch'

/** Whether the signed-in account may finish a native flow with this verifier. */
export declare function checkNativeCompletion(input: {
  stored?: string | null
  storedAt?: string | null
  state: string
  verifier: string
  code: string
  now?: number
  ttlMs?: number
}): { ok: true; reason?: undefined } | { ok: false; reason: CompletionRefusal }

export declare function completionMessage(reason: string): string
