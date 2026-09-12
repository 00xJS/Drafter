// Binding an OAuth flow to the BROWSER that started it.
//
// Resolving the `state` to a user row alone is not enough: the callback runs
// without a session, so an attacker can mint a state on their own account,
// send the resulting consent URL to the victim, and have the VICTIM's tokens
// stored against the ATTACKER's account. A short-lived HttpOnly cookie set
// when the flow starts, and required to match at the callback, ties the two
// halves to one browser.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

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

/** Constant-time equality of two non-empty strings. */
function same(a, b) {
  const x = Buffer.from(String(a ?? ''))
  const y = Buffer.from(String(b ?? ''))
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y)
}

/**
 * True when this browser is the one that started the flow. A native state
 * (see nativeState) is checked here on its browser half only; its app half is
 * checked when the app finishes the flow.
 */
export function verifyState(req, name, state) {
  const verifier = readCookie(req, name)
  if (!verifier || !state) return false
  return same(stateFor(verifier), String(state).split('.')[0])
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

// ---- binding a native flow to the app that started it --------------------------
//
// The handoff token alone was a bearer: whoever opened /start?h= within its
// two minutes had the cookie minted in THEIR browser, consented with THEIR
// account, and the callback attached that calendar to the account that started
// the flow. So the app now keeps a random verifier in memory and sends only
// its challenge (RFC 7636's S256). The challenge rides inside the handoff and
// the state; the callback hands the code back to the app instead of finishing;
// and the flow completes only for the signed-in account that started it,
// presenting that verifier. The code is delivered to the device the consent
// happened on, so a link opened by anyone else leads nowhere.

/** base64url(SHA-256(verifier)): RFC 7636's S256 challenge. */
export const challengeFor = verifier => createHash('sha256').update(String(verifier)).digest('base64url')

/** A challenge is exactly what challengeFor produces: 43 base64url characters. */
export const validChallenge = c => typeof c === 'string' && /^[A-Za-z0-9_-]{43}$/.test(c)

/** A one-time handoff carrying the app's challenge. /start looks the whole string up, so the challenge cannot be swapped. */
export const nativeHandoff = challenge => `${newHandoff()}.${challenge}`

/** The challenge a handoff or a native state carries, or null (a web state, or an old app's handoff). */
export function handoffChallenge(value) {
  const s = String(value ?? '')
  const dot = s.indexOf('.')
  const c = dot === -1 ? '' : s.slice(dot + 1)
  return validChallenge(c) ? c : null
}

/** The state of a native flow: the browser half, matched to Safari's cookie at the callback, then the app half. */
export const nativeState = (verifierCookie, challenge) => `${stateFor(verifierCookie)}.${challenge}`

/** True for a flow started in the app, whose callback hands the code back rather than finishing. */
export const isNativeState = state => handoffChallenge(state) !== null

/** What an app build from before the verifier is told: its flow cannot be bound, so none is started. */
export const NATIVE_UPDATE_NEEDED = 'This version of the Drafter app cannot connect a calendar safely. Update the app, then connect again.'

/**
 * Whether the app may finish a native flow. `stored` and `storedAt` come from
 * the SIGNED-IN user's own row, so a state minted for another account never
 * matches; and the verifier has to be the one whose challenge began the flow.
 */
export function checkNativeCompletion({ stored, storedAt, state, verifier, code, now = Date.now(), ttlMs = 10 * 60_000 }) {
  if (!code) return { ok: false, reason: 'missing_code' }
  // not this account's flow, or one already finished
  if (!state || !same(stored, state)) return { ok: false, reason: 'state_mismatch' }
  const challenge = handoffChallenge(state)
  // a web flow is finished by its own callback, in the browser that started it
  if (!challenge) return { ok: false, reason: 'bad_state' }
  const at = Date.parse(storedAt ?? '')
  if (!Number.isFinite(at) || now - at > ttlMs) return { ok: false, reason: 'expired' }
  if (!verifier || !same(challengeFor(verifier), challenge)) return { ok: false, reason: 'verifier_mismatch' }
  return { ok: true }
}

/** What the app shows when finishing a flow is refused. */
export function completionMessage(reason) {
  if (reason === 'expired') return 'That sign-in took too long. Start again from Settings.'
  if (reason === 'verifier_mismatch') return 'That sign-in was started somewhere else. Start again from Settings on this device.'
  if (reason === 'state_mismatch') return 'That sign-in was not started from this account, or was already finished. Start again from Settings.'
  return 'That sign-in could not be finished. Start again from Settings.'
}
