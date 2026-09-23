// Which headers a Supabase key is sent on.
//
// Supabase is retiring the legacy anon and service_role keys — JWTs, so they
// begin "eyJ" — in favour of publishable and secret keys ("sb_publishable_…",
// "sb_secret_…"). Those are opaque strings, not tokens the platform can parse:
// send one on Authorization: Bearer as well and the gateway reads it as a JWT,
// fails, and refuses the whole request with "Invalid JWT". So a new-style key
// goes on the apikey header alone.
//
// A legacy key goes on both, exactly as every call site sent it before this
// file existed, so nothing changes for the key in production today. The test
// lives here and nowhere else: a call site that keeps its own copy is a call
// site that can drift.

/** A legacy anon or service_role key: a JWT, so it begins with a base64url-encoded '{"'. */
export function legacyKey(key) {
  return typeof key === 'string' && key.startsWith('eyJ')
}

/**
 * The apikey header, when there is a key to put on it. A key the host has not
 * set is left off rather than sent as the word "undefined": Supabase refuses
 * the call either way, and every header left is a string, as fetch expects.
 */
const apikey = key => (typeof key === 'string' ? { apikey: key } : {})

/**
 * Headers for a call the key itself is the credential for: the service key's
 * reads and writes, the admin auth API, the storage API. `extra` — a content
 * type, a `prefer`, a caller's own headers — is merged last, as each call site
 * merged its own.
 */
export function keyHeaders(key, extra = {}) {
  return legacyKey(key) ? { ...apikey(key), authorization: `Bearer ${key}`, ...extra } : { ...apikey(key), ...extra }
}

/**
 * Headers for a call made as a signed-in person: their own access token is the
 * credential, and the key (anon today, publishable one day) only names the
 * project. The token is sent whatever shape the key has — dropping it would
 * quietly turn the call into an anonymous one.
 */
export function userHeaders(key, accessToken, extra = {}) {
  return { ...apikey(key), authorization: `Bearer ${accessToken}`, ...extra }
}
