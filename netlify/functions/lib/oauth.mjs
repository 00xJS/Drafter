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

function readCookie(req, name) {
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
