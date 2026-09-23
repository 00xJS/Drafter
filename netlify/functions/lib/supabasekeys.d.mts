// Types for the helpers src/ imports in tests. The runtime is supabasekeys.mjs.

/** Whether the key is a legacy anon or service_role key: a JWT, which begins "eyJ". */
export declare function legacyKey(key: unknown): boolean

/** apikey (left off when the host has no key); Authorization: Bearer as well only while the key is a legacy JWT. */
export declare function keyHeaders(key: string | undefined, extra?: Record<string, string>): Record<string, string>

/** The key on apikey (left off when the host has none) and the person's own token on Authorization: Bearer, whatever shape the key has. */
export declare function userHeaders(key: string | undefined, accessToken: string, extra?: Record<string, string>): Record<string, string>
