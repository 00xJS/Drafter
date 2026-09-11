// Google Calendar via OAuth, server-side only and scoped per user: each
// signed-in user's refresh token lives in their own user_settings row
// (service role only), so nobody can read anyone else's calendars — and the
// browser never holds a Google token at all.

import { randomBytes } from 'node:crypto'
import { settingsGet, settingsSet, settingsStoreConfigured } from './session.mjs'
import { isUntimed, localDate } from '../../../shared/domain.mjs'

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

function eventBodyFor(task, projectName, site, tz) {
  const timed = !isUntimed(task.dueAt, tz)
  const start = new Date(task.dueAt)
  const dateOnly = localDate(task.dueAt, tz) ?? start.toISOString().slice(0, 10)
  const prefix = task.priority === 'urgent' ? '‼ ' : task.priority === 'high' ? '▲ ' : ''
  return {
    summary: `${prefix}${task.title || 'Untitled task'}`,
    description: [task.description, projectName ? `Project: ${projectName}` : '', `Status: ${task.status} · Priority: ${task.priority}`, site ? `Open in Drafter: ${site}` : '']
      .filter(Boolean)
      .join('\n\n'),
    start: timed ? { dateTime: start.toISOString() } : { date: dateOnly },
    end: timed
      ? { dateTime: new Date(start.getTime() + 3_600_000).toISOString() }
      : { date: (() => {
          const [y, m, d] = dateOnly.split('-').map(Number)
          const next = new Date(Date.UTC(y, m - 1, d + 1))
          return next.toISOString().slice(0, 10)
        })() },
    transparency: 'transparent',
    reminders: { useDefault: false, overrides: timed ? [{ method: 'popup', minutes: 30 }] : [{ method: 'popup', minutes: 9 * 60 }] },
    extendedProperties: { private: { drafter: '1', taskId: task.id } },
  }
}

/**
 * The copy that speaks for a record: the live event, or else the most recently
 * cancelled one. `items[0]` used to stand in for "the cancelled one", which is
 * arbitrary as soon as a record has been deleted and re-created more than once.
 */
export function newestCopy(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : []
  const live = list.find(ev => ev.status !== 'cancelled')
  if (live) return live
  return list.sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')))[0] ?? null
}

/**
 * A cancelled copy the Drafter record was edited AFTER: Drafter's own delete,
 * then a reopen, a new due date or a restore from Trash. The newer write wins,
 * so it comes back. A cancellation newer than the last Drafter edit is the
 * owner deleting it in Google on purpose, and stays gone.
 */
export function editedSinceCancelled(existing, record) {
  return !!existing && existing.status === 'cancelled' && Date.parse(record?.updatedAt) > Date.parse(existing.updated)
}

async function findMirrored(userId, calendarId, taskId) {
  // showDeleted so we don't recreate an event the user deleted in Google
  const page = await gapi(userId, `/calendars/${encodeURIComponent(calendarId)}/events?privateExtendedProperty=${encodeURIComponent(`taskId=${taskId}`)}&showDeleted=true&maxResults=5`)
  return newestCopy(page.items)
}

/** Mirror one task into the Drafter calendar: upsert when open with a due date, otherwise remove. */
export async function pushTask(userId, calendarId, task, projectName, site) {
  const wanted = task.kind === 'task' && !task.deletedAt && OPEN.includes(task.status) && !!task.dueAt
  const existing = await findMirrored(userId, calendarId, task.id)
  const evPath = id => `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`
  if (!wanted) {
    if (existing && existing.status !== 'cancelled') {
      await gapi(userId, evPath(existing.id), { method: 'DELETE' }).catch(e => {
        if (e.status !== 404 && e.status !== 410) throw e
      })
      return 'removed'
    }
    return 'skipped'
  }
  const live = existing && existing.status !== 'cancelled' ? existing : null
  if (!live && existing && !editedSinceCancelled(existing, task)) {
    // cancelled after Drafter last touched the task: the owner deleted it in
    // Google on purpose, so leave it gone. Treating EVERY cancellation this way
    // meant a task Drafter itself had removed (done, wishlist, date cleared)
    // could never come back to Google, even after it was reopened.
    return 'skipped'
  }
  const settings = await settingsGet(userId).catch(() => null)
  const tz = settings?.timezone ?? undefined
  const body = eventBodyFor(task, projectName, site, tz)
  if (live) {
    await gapi(userId, evPath(live.id), { method: 'PATCH', body: JSON.stringify(body) })
    return 'updated'
  }
  await gapi(userId, `/calendars/${encodeURIComponent(calendarId)}/events`, { method: 'POST', body: JSON.stringify(body) })
  return 'created'
}

/**
 * Mirror one calendar entry the user wrote into the Drafter calendar.
 *
 * Keyed on its own `eventId` private property, never `taskId` — the pull path
 * filters on taskId to map Google moves back onto tasks, so an entry tagged
 * that way would be read back as a task that does not exist.
 *
 * Unlike a mirrored task these are `opaque`: a task in the calendar is a
 * reminder that something is due, but an entry is a block of time, and the
 * whole reason for writing one is to show the slot as busy.
 */
/**
 * What pushEntry must do for one entry, given what Google already holds.
 *
 * Pure, so the Undo subtlety is testable without a live account. A cancelled
 * event normally means "deleted in Google on purpose, leave it gone" — but
 * Drafter's own DELETE also leaves one cancelled, so Undo passes `revive` and
 * gets a fresh event instead of a silent skip.
 */
export function googleEntryPlan(existing, entry, opts = {}) {
  const live = existing && existing.status !== 'cancelled' ? existing : null
  if (entry.deletedAt) return live ? { op: 'delete', id: live.id } : { op: 'skip' }
  // left gone unless Drafter's record is newer than the cancellation (a restore,
  // a re-save) or this is Drafter's own Undo, whose record predates its delete
  if (!live && existing && !opts.revive && !editedSinceCancelled(existing, entry)) return { op: 'skip' }
  return live ? { op: 'patch', id: live.id } : { op: 'create' }
}

/** The Google Calendar body for one entry: busy, and keyed on eventId so the pull never reads it as a task. */
export function googleEntryBody(entry, site) {
  return {
    summary: entry.title || 'Untitled event',
    description: [entry.notes, site ? `Open in Drafter: ${site}` : ''].filter(Boolean).join('\n\n') || undefined,
    location: entry.location || undefined,
    start: entry.allDay ? { date: entry.start } : { dateTime: new Date(entry.start).toISOString() },
    end: entry.allDay ? { date: entry.end } : { dateTime: new Date(entry.end).toISOString() },
    // a work day is working hours, not a meeting: you are available, so it is free time
    transparency: entry.work ? 'transparent' : 'opaque',
    extendedProperties: { private: { drafter: '1', eventId: entry.id } },
  }
}

export async function pushEntry(userId, calendarId, entry, site, opts = {}) {
  const evPath = id => `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`
  const page = await gapi(
    userId,
    `/calendars/${encodeURIComponent(calendarId)}/events?privateExtendedProperty=${encodeURIComponent(`eventId=${entry.id}`)}&showDeleted=true&maxResults=5`,
  )
  const existing = newestCopy(page.items)
  const plan = googleEntryPlan(existing, entry, opts)
  if (plan.op === 'skip') return 'skipped'
  if (plan.op === 'delete') {
    await gapi(userId, evPath(plan.id), { method: 'DELETE' }).catch(e => {
      if (e.status !== 404 && e.status !== 410) throw e
    })
    return 'removed'
  }
  const body = JSON.stringify(googleEntryBody(entry, site))
  if (plan.op === 'patch') {
    await gapi(userId, evPath(plan.id), { method: 'PATCH', body })
    return 'updated'
  }
  await gapi(userId, `/calendars/${encodeURIComponent(calendarId)}/events`, { method: 'POST', body })
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
