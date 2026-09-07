// Binding an OAuth flow to the BROWSER that started it.
//
// Resolving the `state` to a user row alone is not enough: the callback runs
// without a session, so an attacker can mint a state on their own account,
// send the resulting consent URL to the victim, and have the VICTIM's tokens
// stored against the ATTACKER's account. A short-lived HttpOnly cookie set
// when the flow starts, and required to match at the callback, ties the two
// halves to one browser.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const MAX_AGE = 600 // seconds

const secret = () => process.env.SUPABASE_SERVICE_KEY ?? process.env.MICROSOFT_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET ?? 'drafter'

/** Opaque value for the cookie; only its HMAC travels in the URL. */
export const newVerifier = () => randomBytes(24).toString('base64url')

/** The `state` to put in the authorize URL, derived from the verifier. */
export const stateFor = verifier => createHmac('sha256', secret()).update(verifier).digest('base64url')

export function cookieHeader(name, verifier) {
  return `${name}=${verifier}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`
}

export function clearCookieHeader(name) {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
}

export function readCookie(req, name) {
  const raw = req.headers.get('cookie') ?? ''
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return rest.join('=')
  }
  return null
}

/** True when this browser is the one that started the flow. */
export function verifyState(req, name, state) {
  const verifier = readCookie(req, name)
  if (!verifier || !state) return false
  const expected = Buffer.from(stateFor(verifier))
  const got = Buffer.from(String(state))
  return expected.length === got.length && timingSafeEqual(expected, got)
}

// ---- native app handoff -------------------------------------------------------
//
// The iOS app cannot complete consent inside its web view: the callback lands
// in Safari, which has its own cookie jar. So the app asks for a one-time
// handoff token (session-gated), opens /start?h=<token> in Safari, and /start
// mints the verifier cookie THERE before forwarding to the provider. The token
// is single-use and short-lived; the cookie binding then works as on the web.

export const HANDOFF_TTL_MS = 2 * 60_000
export const newHandoff = () => randomBytes(24).toString('base64url')

/** Marks the browser as having been opened by the app, so the callback returns to it. */
export const RETURN_COOKIE = 'drafter_return'

/** Where the callback should send the browser: back into the app, or to the site. */
export function returnTarget(req, origin) {
  return readCookie(req, RETURN_COOKIE) === 'native' ? 'drafter://oauth' : `${origin}/`
}

/** True when a stored handoff is still fresh. */
export const handoffFresh = at => Number.isFinite(Date.parse(at ?? '')) && Date.now() - Date.parse(at) < HANDOFF_TTL_MS
