import { apiFetch } from './api'
import { getSupabase } from './supabase'

// What Settings asks of the calendars outside its Calendars group: the feed
// and the email-in address (Data → Email in, and the feed status Settings
// reads as it opens) and whether the calendar copies remind (Notifications).
// The rest — the mirrors' engine, connecting Google and Outlook — is
// calendars.ts, which comes with Settings → Calendars (loaded on its own, as
// Settings opens) rather than with Settings, which the app warms at launch.
// calendars.ts re-exports these, so the calendars still read as one API.

export interface CalendarFeedInfo {
  configured: boolean
  enabled: boolean
  url: string | null
  inboundUrl?: string | null
  missing: string[]
}

/** A refused call, with the status and — for a sign-in the provider no longer takes — `reason: 'reauth'`. */
export type ActionError = Error & { status?: number; reason?: string }

/** A calendar function's answer, or a throw with its error, status and reason. */
export async function actionJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { error?: string; reason?: string }) | null
  if (!res.ok || !body) throw Object.assign(new Error(body?.error ?? `HTTP ${res.status}`), { status: res.status, reason: body?.reason }) as ActionError
  return body
}

/**
 * The device's IANA zone, sent with every mirror push and with each email-in
 * address action (triage reads an emailed "Thursday 3pm" in it). The server decides
 * whether a task is untimed in the owner's zone, and an account that never
 * saved push prefs had none, so it judged in UTC and every untimed task reached
 * both calendars as a 00:00 event all summer. It is only ever adopted, never
 * used to overwrite a zone the owner chose.
 */
export function deviceTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

export function inboundAction(action: 'inbound-enable' | 'inbound-rotate' | 'inbound-disable'): Promise<{ inboundUrl: string | null }> {
  // the zone rides along so an emailed "Thursday 3pm" is read where you are
  return apiFetch('/api/feed.ics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, timezone: deviceTimeZone() }) }).then(actionJson<{ inboundUrl: string | null }>)
}

export function fetchFeedInfo(): Promise<CalendarFeedInfo> {
  return apiFetch('/api/feed.ics').then(actionJson<CalendarFeedInfo>)
}

export function feedAction(action: 'enable' | 'rotate' | 'disable'): Promise<CalendarFeedInfo> {
  return apiFetch('/api/feed.ics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) }).then(actionJson<CalendarFeedInfo>)
}

// ---- the copies' own reminders ----------------------------------------------------
//
// Drafter sends every reminder itself — the iPhone's own, and push — so the
// copies the mirrors write into Google and every Outlook account carry none.
// "Calendar copies remind me too" (Settings → Notifications, off by default) brings
// each calendar's own back. It lives in the account's sign-in metadata, which
// the mirror functions read with the session (COPY_REMINDERS_KEY in
// netlify/functions/lib/session.mjs), so every device agrees without a column
// of its own. A copy takes the setting the next time Drafter writes it: nothing
// rewrites the owner's calendars in bulk.

export const COPY_REMINDERS_KEY = 'calendar_copies_remind'

/** Whether the copies remind too; false with no account. Throws with the reason when it cannot be read. */
export async function copyRemindersOn(): Promise<boolean> {
  const sb = getSupabase()
  if (!sb) return false
  const { data, error } = await sb.auth.getUser()
  if (error) throw new Error(error.message)
  return data.user?.user_metadata?.[COPY_REMINDERS_KEY] === true
}

/** Turn the copies' own reminders on or off for the account. Throws with the reason when it cannot. */
export async function setCopyReminders(on: boolean): Promise<void> {
  const sb = getSupabase()
  if (!sb) throw new Error('Calendar copies need a signed-in account.')
  const { error } = await sb.auth.updateUser({ data: { [COPY_REMINDERS_KEY]: on } })
  if (error) throw new Error(error.message)
}
