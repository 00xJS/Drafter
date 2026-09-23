// Calendar sign-ins that stopped working, as the morning digest says them.
//
// When Google or Microsoft refuses the grant Drafter holds for an account
// (revoked, expired, a password change), lib/google.mjs and lib/microsoft.mjs
// let the grant go and keep the account's address: Google's as google_email
// with no refresh token, an Outlook account with authFailedAt. That is the
// record, kept in user_settings with no column of its own, and it lasts until
// the account is signed in again or disconnected. The app says it on Today;
// the digest says it each morning, since a mirror that has stopped is quiet.

import { googleNeedsSignIn } from './google.mjs'
import { outlookNeedsSignIn } from './microsoft.mjs'

/** The calendars in an account's settings row whose sign-in has stopped working, by name. */
export function calendarsNeedingSignIn(settings) {
  const out = []
  if (googleNeedsSignIn(settings)) out.push('Google Calendar')
  for (const a of Array.isArray(settings?.microsoft_accounts) ? settings.microsoft_accounts : []) {
    if (outlookNeedsSignIn(a)) out.push(`Outlook (${a.email || a.name || 'an account'})`)
  }
  return out
}

/** The digest's line for them, or null when every calendar is signed in. */
export function signInLine(settings) {
  const names = calendarsNeedingSignIn(settings)
  if (!names.length) return null
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `${list} ${names.length === 1 ? 'needs' : 'need'} you to sign in again (Settings → Calendars): nothing reaches ${names.length === 1 ? 'it' : 'them'} until then.`
}
