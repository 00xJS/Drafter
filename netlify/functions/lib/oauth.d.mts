// Types for the OAuth binding helpers src/ imports in tests. The runtime is
// oauth.mjs; this exists only so tsc (which checks src/) does not see an
// implicit any. Netlify bundles the .mjs directly and never reads this file.

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
}): { ok: true } | { ok: false; reason: CompletionRefusal }

export declare function completionMessage(reason: string): string
