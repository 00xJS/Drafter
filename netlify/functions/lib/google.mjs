// Google Calendar via OAuth, server-side only and scoped per user: each
// signed-in user's refresh token lives in their own user_settings row
// (service role only), so nobody can read anyone else's calendars — and the
// browser never holds a Google token at all.

import { randomBytes } from 'node:crypto'
import { settingsGet, settingsSet, settingsStoreConfigured } from './session.mjs'

export const SCOPES = ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/userinfo.email']

const env = () => ({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET })

export function googleConfigured() {
  const e = env()
  return !!(e.clientId && e.clientSecret && settingsStoreConfigured())
}

export function missingGoogleEnv() {
  const e = env()
  return [!e.clientId && 'GOOGLE_CLIENT_ID', !e.clientSecret && 'GOOGLE_CLIENT_SECRET', !settingsStoreConfigured() && 'SUPABASE_SERVICE_KEY'].filter(Boolean)
}

// ---- tokens -------------------------------------------------------------------

const cache = new Map() // userId -> { token, exp }

export async function exchangeCode(code, redirectUri) {
  const e = env()
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: e.clientId, client_secret: e.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error_description ?? body.error ?? `token exchange failed (${res.status})`)
  return body
}

export async function accessToken(userId) {
  const hit = cache.get(userId)
  if (hit && Date.now() < hit.exp - 60_000) return hit.token
  const settings = await settingsGet(userId)
  const refresh = settings?.google_refresh_token
  if (!refresh) throw Object.assign(new Error('Google Calendar is not connected'), { status: 409 })
  const e = env()
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: refresh, client_id: e.clientId, client_secret: e.clientSecret, grant_type: 'refresh_token' }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (body.error === 'invalid_grant') {
      throw Object.assign(new Error('Google access was revoked or expired — reconnect Google Calendar in Settings.'), { status: 409 })
    }
    throw new Error(body.error_description ?? body.error ?? `token refresh failed (${res.status})`)
  }
  cache.set(userId, { token: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000 })
  return body.access_token
}

export async function revoke(userId) {
  const settings = await settingsGet(userId)
  const refresh = settings?.google_refresh_token
  if (refresh) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: 'POST' }).catch(() => {})
  cache.delete(userId)
  await settingsSet(userId, { google_refresh_token: null, google_email: null, google_drafter_calendar_id: null, google_oauth_state: null })
}

export async function gapi(userId, path, init = {}) {
  const token = await accessToken(userId)
  const res = await fetch(path.startsWith('http') ? path : `https://www.googleapis.com/calendar/v3${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  if (res.status === 204) return null
  const text = await res.text()
  const body = text ? JSON.parse(text) : null
  if (!res.ok) throw Object.assign(new Error(body?.error?.message ?? `Google API ${res.status}`), { status: res.status })
  return body
}

// ---- events -------------------------------------------------------------------

/** Google event → the app's CalendarEvent shape (null for cancelled or our own mirrored tasks). */
export function toEvent(item, sourceId) {
  if (!item || item.status === 'cancelled') return null
  if (item.extendedProperties?.private?.drafter === '1') return null
  const allDay = !!item.start?.date
  const start = allDay ? item.start.date : item.start?.dateTime
  const end = allDay ? (item.end?.date ?? item.start.date) : (item.end?.dateTime ?? start)
  if (!start) return null
  return {
    id: `${sourceId}:${item.id}`,
    sourceId,
    title: item.summary || '(untitled)',
    start: allDay ? start : new Date(start).toISOString(),
    end: allDay ? end : new Date(end).toISOString(),
    allDay,
    location: item.location || undefined,
  }
}

export async function listEvents(userId, calendarId, fromIso, toIso) {
  const out = []
  let pageToken
  do {
    const q = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', timeMin: fromIso, timeMax: toIso, maxResults: '2500', showDeleted: 'false' })
    if (pageToken) q.set('pageToken', pageToken)
    const page = await gapi(userId, `/calendars/${encodeURIComponent(calendarId)}/events?${q}`)
    for (const item of page.items ?? []) out.push(item)
    pageToken = page.nextPageToken
  } while (pageToken && out.length < 5000)
  return out
}

export async function listCalendars(userId) {
  const page = await gapi(userId, '/users/me/calendarList?minAccessRole=reader&showHidden=false')
  return (page.items ?? []).map(c => ({
    id: c.id,
    name: c.summaryOverride || c.summary,
    color: c.backgroundColor,
    primary: !!c.primary,
    writable: c.accessRole === 'owner' || c.accessRole === 'writer',
  }))
}

/** The "Drafter" calendar in the connected account, created on first use. */
export async function drafterCalendarId(userId) {
  const settings = await settingsGet(userId)
  const stored = settings?.google_drafter_calendar_id
  if (stored) {
    try {
      await gapi(userId, `/calendars/${encodeURIComponent(stored)}`)
      return stored
    } catch (e) {
      if (e.status !== 404 && e.status !== 410) throw e
    }
  }
  const existing = (await listCalendars(userId)).find(c => c.name === 'Drafter' && c.writable)
  const id =
    existing?.id ??
    (await gapi(userId, '/calendars', { method: 'POST', body: JSON.stringify({ summary: 'Drafter', description: 'Tasks mirrored from your Drafter planner. Edit them in Drafter.' }) })).id
  await settingsSet(userId, { google_drafter_calendar_id: id })
  return id
}

const OPEN = ['todo', 'doing', 'blocked']
const hasClock = iso => {
  const d = new Date(iso)
  return d.getUTCHours() + d.getUTCMinutes() > 0
}

function eventBodyFor(task, projectName, site) {
  const timed = hasClock(task.dueAt)
  const start = new Date(task.dueAt)
  const dateOnly = d => d.toISOString().slice(0, 10)
  const prefix = task.priority === 'urgent' ? '‼ ' : task.priority === 'high' ? '▲ ' : ''
  return {
    summary: `${prefix}${task.title || 'Untitled task'}`,
    description: [task.description, projectName ? `Project: ${projectName}` : '', `Status: ${task.status} · Priority: ${task.priority}`, site ? `Open in Drafter: ${site}` : '']
      .filter(Boolean)
      .join('\n\n'),
    start: timed ? { dateTime: start.toISOString() } : { date: dateOnly(start) },
    end: timed ? { dateTime: new Date(start.getTime() + 3_600_000).toISOString() } : { date: dateOnly(new Date(start.getTime() + 86_400_000)) },
    transparency: 'transparent',
    reminders: { useDefault: false, overrides: timed ? [{ method: 'popup', minutes: 30 }] : [{ method: 'popup', minutes: 9 * 60 }] },
    extendedProperties: { private: { drafter: '1', taskId: task.id } },
  }
}

async function findMirrored(userId, calendarId, taskId) {
  const page = await gapi(userId, `/calendars/${encodeURIComponent(calendarId)}/events?privateExtendedProperty=${encodeURIComponent(`taskId=${taskId}`)}&showDeleted=false&maxResults=5`)
  return page.items?.[0] ?? null
}

/** Mirror one task into the Drafter calendar: upsert when open with a due date, otherwise remove. */
export async function pushTask(userId, calendarId, task, projectName, site) {
  const wanted = task.kind === 'task' && !task.deletedAt && OPEN.includes(task.status) && !!task.dueAt
  const existing = await findMirrored(userId, calendarId, task.id)
  const evPath = id => `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`
  if (!wanted) {
    if (existing) {
      await gapi(userId, evPath(existing.id), { method: 'DELETE' }).catch(e => {
        if (e.status !== 404 && e.status !== 410) throw e
      })
      return 'removed'
    }
    return 'skipped'
  }
  const body = eventBodyFor(task, projectName, site)
  if (existing) {
    await gapi(userId, evPath(existing.id), { method: 'PATCH', body: JSON.stringify(body) })
    return 'updated'
  }
  await gapi(userId, `/calendars/${encodeURIComponent(calendarId)}/events`, { method: 'POST', body: JSON.stringify(body) })
  return 'created'
}

/**
 * A cryptographically random token. These guard the calendar feed, the
 * email-in webhook and the OAuth state, all of which are the ONLY thing
 * standing between an anonymous request and personal data — so they must come
 * from a CSPRNG, never from Date.now()/Math.random(), which an attacker who
 * knows roughly when a token was minted could search.
 */
export function randomToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url')
}
