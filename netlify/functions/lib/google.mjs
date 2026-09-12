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

// userId -> { token, exp, refresh }. `refresh` is the grant the token came
// from, so a request that reads the settings anyway can see a grant replaced
// since (a reconnect, a disconnect — often handled by another warm instance)
// and drop the token instead of using it for up to an hour.
const cache = new Map()

/** Drop a cached access token that no longer belongs to the stored grant. */
function checkCachedToken(userId, settings) {
  const hit = cache.get(userId)
  if (hit && hit.refresh !== (settings?.google_refresh_token ?? null)) cache.delete(userId)
}

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
    cache.delete(userId)
    if (body.error === 'invalid_grant') {
      throw Object.assign(new Error('Google access was revoked or expired — reconnect Google Calendar in Settings.'), { status: 409 })
    }
    throw new Error(body.error_description ?? body.error ?? `token refresh failed (${res.status})`)
  }
  cache.set(userId, { token: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000, refresh })
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
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(userId)
    const res = await fetch(path.startsWith('http') ? path : `https://www.googleapis.com/calendar/v3${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    })
    // Google refused the token this warm function holds: the grant was revoked
    // or replaced. Kept, it would be tried for up to an hour. Drop it and ask
    // once more; a revoked grant then fails at the refresh, as "reconnect".
    if (res.status === 401) {
      if (cache.get(userId)?.token === token) cache.delete(userId)
      if (attempt === 0) continue
    }
    if (res.status === 204) return null
    const text = await res.text()
    const body = text ? JSON.parse(text) : null
    if (!res.ok) throw Object.assign(new Error(body?.error?.message ?? `Google API ${res.status}`), { status: res.status })
    return body
  }
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

/** What Drafter writes on the calendar it makes, and one way it recognises it again. */
export const DRAFTER_DESCRIPTION = 'Tasks mirrored from your Drafter planner. Edit them in Drafter.'

/**
 * Which of the account's calendars is Drafter's: one the account owns, titled
 * "Drafter" (its real title, not the owner's display rename) or carrying the
 * description Drafter gave it, hidden or not. The old lookup went by the
 * display name and skipped hidden calendars, so a reconnect could miss the
 * calendar and make a second. The stored id wins when it is among them;
 * otherwise the lowest id, so every device and warm function picks the same one.
 */
export function pickDrafterCalendar(items, storedId) {
  const ours = (Array.isArray(items) ? items : []).filter(
    c => c && !c.deleted && c.accessRole === 'owner' && (c.summary === 'Drafter' || String(c.description ?? '').startsWith(DRAFTER_DESCRIPTION)),
  )
  if (ours.length === 0) return null
  if (storedId && ours.some(c => c.id === storedId)) return storedId
  return ours.map(c => c.id).sort()[0]
}

async function listOwnedCalendars(userId) {
  const out = []
  let pageToken
  do {
    const q = new URLSearchParams({ minAccessRole: 'owner', showHidden: 'true', maxResults: '250' })
    if (pageToken) q.set('pageToken', pageToken)
    const page = await gapi(userId, `/users/me/calendarList?${q}`)
    for (const c of page?.items ?? []) out.push(c)
    pageToken = page?.nextPageToken
  } while (pageToken && out.length < 1000)
  return out
}

// userId -> the lookup in flight. Right after a reconnect the sweep and a
// saved entry each found no calendar and each made one; on one warm function
// they now share a single lookup.
const resolving = new Map()

/**
 * The "Drafter" calendar in the connected account: the stored one while it
 * exists, else the one already there, else a new one. `replaced` says the
 * stored one had gone (the owner deleted it), so nothing confirmed into it is
 * there any more — the app writes everything again, and says so.
 */
export function resolveDrafterCalendar(userId) {
  const inflight = resolving.get(userId)
  if (inflight) return inflight
  const run = (async () => {
    const settings = await settingsGet(userId)
    checkCachedToken(userId, settings)
    const stored = settings?.google_drafter_calendar_id ?? null
    if (stored) {
      try {
        await gapi(userId, `/calendars/${encodeURIComponent(stored)}`)
        return { id: stored, replaced: false, created: false }
      } catch (e) {
        if (e.status !== 404 && e.status !== 410) throw e
      }
    }
    const found = pickDrafterCalendar(await listOwnedCalendars(userId), null)
    const id = found ?? (await gapi(userId, '/calendars', { method: 'POST', body: JSON.stringify({ summary: 'Drafter', description: DRAFTER_DESCRIPTION }) })).id
    await settingsSet(userId, { google_drafter_calendar_id: id })
    return { id, replaced: !!stored && id !== stored, created: !found }
  })()
  resolving.set(userId, run)
  void run.finally(() => resolving.delete(userId)).catch(() => {})
  return run
}

/** The Drafter calendar's id (see resolveDrafterCalendar). */
export async function drafterCalendarId(userId) {
  return (await resolveDrafterCalendar(userId)).id
}

/**
 * What a completed connect writes. The same Google account coming back keeps
 * its Drafter calendar; another account starts from its own, found or made on
 * first use, so nothing is written into the old account's calendar.
 */
export function reconnectPatch(row, refreshToken, email) {
  const same = !!email && !!row?.google_email && email === row.google_email
  return { google_refresh_token: refreshToken, google_email: email, ...(same ? {} : { google_drafter_calendar_id: null }) }
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

/**
 * Mirror one task into the Drafter calendar: upsert when open with a due date, otherwise remove.
 * A batch passes the owner's zone as `opts.tz` (null for none), rather than one settings read per task.
 */
export async function pushTask(userId, calendarId, task, projectName, site, opts = {}) {
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
  const tz = 'tz' in opts ? (opts.tz ?? undefined) : ((await settingsGet(userId).catch(() => null))?.timezone ?? undefined)
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

// ---- what moved in Google ---------------------------------------------------------

/**
 * One of our entries as Google now holds it, in the CalendarEntry convention:
 * an ISO instant when timed, YYYY-MM-DD with an exclusive end when all-day.
 * Google answers a timed event in the calendar's own offset
 * ("15:00:00+01:00"), so it is read back as the instant — otherwise an entry
 * nobody touched would look moved on every pull.
 */
export function googleEntryChange(ev) {
  const eventId = ev?.extendedProperties?.private?.eventId
  if (!eventId) return null
  const allDay = !!ev.start?.date
  const instant = v => {
    const ms = Date.parse(v ?? '')
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null
  }
  return {
    eventId,
    deleted: ev.status === 'cancelled',
    title: typeof ev.summary === 'string' ? ev.summary : '',
    start: allDay ? (ev.start.date ?? null) : instant(ev.start?.dateTime),
    end: allDay ? (ev.end?.date ?? null) : instant(ev.end?.dateTime),
    allDay,
    updated: ev.updated ?? '',
  }
}

/** Changed Drafter events, split into task moves (keyed on taskId) and entry edits (keyed on eventId). */
export function googlePullRows(items) {
  const changes = []
  const entries = []
  for (const ev of Array.isArray(items) ? items : []) {
    const p = ev?.extendedProperties?.private
    if (p?.taskId) {
      changes.push({
        taskId: p.taskId,
        deleted: ev.status === 'cancelled',
        // date-only for all-day; client writes local midnight
        start: ev.start?.dateTime ?? ev.start?.date ?? null,
        allDay: !!ev.start?.date,
        updated: ev.updated,
      })
      continue
    }
    const entry = googleEntryChange(ev)
    if (entry) entries.push(entry)
  }
  return { changes, entries }
}

/**
 * Every Drafter event changed since `sinceIso`, deleted ones included. Paged:
 * a backfill leaves hundreds of fresh `updated` stamps behind it, and a single
 * page of 250 dropped the rest while the pull cursor moved past them.
 */
export async function listChangedMirrors(userId, calendarId, sinceIso) {
  const out = []
  let pageToken
  do {
    const q = new URLSearchParams({ updatedMin: sinceIso, singleEvents: 'true', showDeleted: 'true', maxResults: '250', privateExtendedProperty: 'drafter=1' })
    if (pageToken) q.set('pageToken', pageToken)
    const page = await gapi(userId, `/calendars/${encodeURIComponent(calendarId)}/events?${q}`)
    for (const item of page?.items ?? []) out.push(item)
    pageToken = page?.nextPageToken
  } while (pageToken && out.length < 2500)
  return out
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
