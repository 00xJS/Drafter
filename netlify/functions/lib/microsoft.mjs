// Outlook / Microsoft 365 calendars via Microsoft Graph, server-side only and
// scoped per user. Several accounts can be connected at once (personal and
// work): each one's refresh token lives in that user's own user_settings row,
// which only the service role can read, so the browser never holds a token.

import { randomBytes } from 'node:crypto'
import { settingsGet, settingsSet, settingsStoreConfigured } from './session.mjs'

const GRAPH = 'https://graph.microsoft.com/v1.0'
/** "common" accepts both personal Microsoft accounts and work/school accounts. */
const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0'

export const SCOPES = ['offline_access', 'openid', 'email', 'profile', 'User.Read', 'Calendars.ReadWrite']

/** Namespace for the marker that identifies events this app owns. */
const TASK_PROP = 'String {66f5a359-4659-4830-9070-00047ec6ac6e} Name drafterTaskId'

/**
 * OData string literals are single-quoted and escape a quote by doubling it.
 * Task ids are usually ours, but a record synced from a household member could
 * carry anything, so never interpolate one raw into a filter.
 */
const odataLiteral = v => `'${String(v).replace(/'/g, "''")}'`


const env = () => ({ clientId: process.env.MICROSOFT_CLIENT_ID, clientSecret: process.env.MICROSOFT_CLIENT_SECRET })

export function microsoftConfigured() {
  const e = env()
  return !!(e.clientId && e.clientSecret && settingsStoreConfigured())
}

export function missingMicrosoftEnv() {
  const e = env()
  return [!e.clientId && 'MICROSOFT_CLIENT_ID', !e.clientSecret && 'MICROSOFT_CLIENT_SECRET', !settingsStoreConfigured() && 'SUPABASE_SERVICE_KEY'].filter(Boolean)
}

export const randomState = () => randomBytes(30).toString('base64url')

// ---------------------------------------------------------------- accounts

export async function listAccounts(userId) {
  const s = await settingsGet(userId)
  return Array.isArray(s?.microsoft_accounts) ? s.microsoft_accounts : []
}

async function saveAccounts(userId, accounts) {
  await settingsSet(userId, { microsoft_accounts: accounts })
}

/** Public shape — never leaks a token to the client. */
export const publicAccount = a => ({ id: a.id, email: a.email, name: a.name, hasMirror: !!a.drafterCalendarId })

// ------------------------------------------------------------------ tokens

export async function exchangeCode(code, redirectUri) {
  const e = env()
  const res = await fetch(`${AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: e.clientId, client_secret: e.clientSecret, code, redirect_uri: redirectUri, grant_type: 'authorization_code', scope: SCOPES.join(' ') }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error_description ?? body.error ?? `token exchange failed (${res.status})`)
  return body
}

const cache = new Map() // `${userId}:${accountId}` -> { token, exp }

/**
 * A live access token for one connected account. Microsoft rotates refresh
 * tokens on every use, so the new one must be written back or the connection
 * silently dies after the old token expires.
 */
export async function accessToken(userId, accountId) {
  const key = `${userId}:${accountId}`
  const hit = cache.get(key)
  if (hit && Date.now() < hit.exp - 60_000) return hit.token

  const accounts = await listAccounts(userId)
  const account = accounts.find(a => a.id === accountId)
  if (!account?.refreshToken) throw Object.assign(new Error('That Microsoft account is not connected.'), { status: 409 })

  const e = env()
  const res = await fetch(`${AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: e.clientId, client_secret: e.clientSecret, refresh_token: account.refreshToken, grant_type: 'refresh_token', scope: SCOPES.join(' ') }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (body.error === 'invalid_grant') {
      throw Object.assign(new Error(`Microsoft access for ${account.email} expired or was revoked — reconnect it in Settings.`), { status: 409 })
    }
    throw new Error(body.error_description ?? body.error ?? `token refresh failed (${res.status})`)
  }
  if (body.refresh_token && body.refresh_token !== account.refreshToken) {
    await saveAccounts(userId, accounts.map(a => (a.id === accountId ? { ...a, refreshToken: body.refresh_token } : a)))
  }
  cache.set(key, { token: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000 })
  return body.access_token
}

export async function graph(userId, accountId, path, init = {}) {
  const token = await accessToken(userId, accountId)
  const res = await fetch(path.startsWith('http') ? path : `${GRAPH}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  if (res.status === 204) return null
  const text = await res.text()
  const body = text ? JSON.parse(text) : null
  if (!res.ok) throw Object.assign(new Error(body?.error?.message ?? `Microsoft Graph ${res.status}`), { status: res.status })
  return body
}

export async function connectAccount(userId, tokens) {
  let me = {}
  try {
    me = await fetch(`${GRAPH}/me`, { headers: { authorization: `Bearer ${tokens.access_token}` } }).then(r => r.json())
  } catch {
    /* identity is cosmetic */
  }
  const id = me.id ?? randomBytes(8).toString('hex')
  const account = {
    id,
    email: me.mail ?? me.userPrincipalName ?? '',
    name: me.displayName ?? me.mail ?? 'Microsoft account',
    refreshToken: tokens.refresh_token,
    drafterCalendarId: null,
  }
  const accounts = await listAccounts(userId)
  await saveAccounts(userId, [...accounts.filter(a => a.id !== id), account].slice(-4))
  cache.delete(`${userId}:${id}`)
  return publicAccount(account)
}

export async function disconnectAccount(userId, accountId) {
  const accounts = await listAccounts(userId)
  await saveAccounts(userId, accounts.filter(a => a.id !== accountId))
  cache.delete(`${userId}:${accountId}`)
}

// ----------------------------------------------------------------- reading

export async function listCalendars(userId, accountId) {
  const page = await graph(userId, accountId, '/me/calendars?$top=50&$select=id,name,color,canEdit,isDefaultCalendar')
  return (page.value ?? []).map(c => ({
    id: c.id,
    name: c.name,
    primary: !!c.isDefaultCalendar,
    writable: c.canEdit !== false,
  }))
}

/** Graph event -> the app's CalendarEvent shape (null for our own mirrored tasks). */
export function toEvent(item, sourceId) {
  if (!item || item.isCancelled) return null
  if ((item.singleValueExtendedProperties ?? []).some(p => p.id === TASK_PROP)) return null
  const allDay = !!item.isAllDay
  const start = item.start?.dateTime
  const end = item.end?.dateTime
  if (!start) return null
  // Graph returns naive local times plus a timeZone field; requesting UTC in the
  // Prefer header (below) makes these instants directly parseable.
  const iso = v => (v?.endsWith('Z') ? v : `${v}Z`)
  return {
    id: `${sourceId}:${item.id}`,
    sourceId,
    title: item.subject || '(untitled)',
    start: allDay ? iso(start).slice(0, 10) : new Date(iso(start)).toISOString(),
    end: allDay ? iso(end ?? start).slice(0, 10) : new Date(iso(end ?? start)).toISOString(),
    allDay,
    location: item.location?.displayName || undefined,
  }
}

/**
 * Events in a window. calendarView expands recurring series server-side, so
 * birthdays and weekly meetings arrive as concrete occurrences.
 */
export async function listEvents(userId, accountId, calendarId, fromIso, toIso) {
  const out = []
  let url = `${GRAPH}/me/calendars/${encodeURIComponent(calendarId)}/calendarView?startDateTime=${encodeURIComponent(fromIso)}&endDateTime=${encodeURIComponent(toIso)}&$top=250&$select=id,subject,start,end,isAllDay,isCancelled,location&$expand=singleValueExtendedProperties($filter=id eq ${odataLiteral(TASK_PROP)})`
  while (url && out.length < 2000) {
    const page = await graph(userId, accountId, url, { headers: { Prefer: 'outlook.timezone="UTC"' } })
    for (const item of page.value ?? []) out.push(item)
    url = page['@odata.nextLink'] ?? null
  }
  return out
}

// ----------------------------------------------------------------- writing

const OPEN = ['todo', 'doing', 'blocked']
const hasClock = iso => {
  const d = new Date(iso)
  return d.getUTCHours() + d.getUTCMinutes() > 0
}

/** The "Drafter" calendar in a connected account, created on first mirror. */
export async function drafterCalendarId(userId, accountId) {
  const accounts = await listAccounts(userId)
  const account = accounts.find(a => a.id === accountId)
  if (account?.drafterCalendarId) {
    try {
      await graph(userId, accountId, `/me/calendars/${encodeURIComponent(account.drafterCalendarId)}?$select=id`)
      return account.drafterCalendarId
    } catch (e) {
      if (e.status !== 404 && e.status !== 410) throw e
    }
  }
  const existing = (await listCalendars(userId, accountId)).find(c => c.name === 'Drafter' && c.writable)
  const id = existing?.id ?? (await graph(userId, accountId, '/me/calendars', { method: 'POST', body: JSON.stringify({ name: 'Drafter' }) })).id
  await saveAccounts(userId, accounts.map(a => (a.id === accountId ? { ...a, drafterCalendarId: id } : a)))
  return id
}

function eventBodyFor(task, projectName, site) {
  const timed = hasClock(task.dueAt)
  const start = new Date(task.dueAt)
  const prefix = task.priority === 'urgent' ? '‼ ' : task.priority === 'high' ? '▲ ' : ''
  const stamp = d => d.toISOString().replace(/\.\d{3}Z$/, '')
  const dayOnly = d => d.toISOString().slice(0, 10)
  return {
    subject: `${prefix}${task.title || 'Untitled task'}`,
    body: {
      contentType: 'text',
      content: [task.description, projectName ? `Project: ${projectName}` : '', `Status: ${task.status} · Priority: ${task.priority}`, site ? `Open in Drafter: ${site}` : '']
        .filter(Boolean)
        .join('\n\n'),
    },
    isAllDay: !timed,
    showAs: 'free',
    start: timed ? { dateTime: stamp(start), timeZone: 'UTC' } : { dateTime: `${dayOnly(start)}T00:00:00`, timeZone: 'UTC' },
    end: timed
      ? { dateTime: stamp(new Date(start.getTime() + 3_600_000)), timeZone: 'UTC' }
      : { dateTime: `${dayOnly(new Date(start.getTime() + 86_400_000))}T00:00:00`, timeZone: 'UTC' },
    singleValueExtendedProperties: [{ id: TASK_PROP, value: task.id }],
  }
}

async function findMirrored(userId, accountId, calendarId, taskId) {
  const filter = `singleValueExtendedProperties/any(ep: ep/id eq ${odataLiteral(TASK_PROP)} and ep/value eq ${odataLiteral(taskId)})`
  const q = `/me/calendars/${encodeURIComponent(calendarId)}/events?$top=2&$select=id&$filter=${encodeURIComponent(filter)}`
  const page = await graph(userId, accountId, q)
  return page.value?.[0] ?? null
}

/** Mirror one task: upsert while open and dated, remove otherwise. */
export async function pushTask(userId, accountId, calendarId, task, projectName, site) {
  const wanted = task.kind === 'task' && !task.deletedAt && OPEN.includes(task.status) && !!task.dueAt
  const existing = await findMirrored(userId, accountId, calendarId, task.id)
  const path = id => `/me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`
  if (!wanted) {
    if (existing) {
      await graph(userId, accountId, path(existing.id), { method: 'DELETE' }).catch(e => {
        if (e.status !== 404 && e.status !== 410) throw e
      })
      return 'removed'
    }
    return 'skipped'
  }
  const body = eventBodyFor(task, projectName, site)
  if (existing) {
    await graph(userId, accountId, path(existing.id), { method: 'PATCH', body: JSON.stringify(body) })
    return 'updated'
  }
  await graph(userId, accountId, `/me/calendars/${encodeURIComponent(calendarId)}/events`, { method: 'POST', body: JSON.stringify(body) })
  return 'created'
}

/** Mirrored events changed in Outlook since `since` — the pull half of the sync. */
export async function pullChanges(userId, accountId, calendarId, sinceIso) {
  const q = `/me/calendars/${encodeURIComponent(calendarId)}/events?$top=250&$select=id,start,isAllDay,isCancelled,lastModifiedDateTime&$expand=singleValueExtendedProperties($filter=id eq ${odataLiteral(TASK_PROP)})&$filter=${encodeURIComponent(`lastModifiedDateTime ge ${sinceIso}`)}`
  const page = await graph(userId, accountId, q, { headers: { Prefer: 'outlook.timezone="UTC"' } })
  return (page.value ?? [])
    .map(ev => {
      const taskId = (ev.singleValueExtendedProperties ?? []).find(p => p.id === TASK_PROP)?.value
      if (!taskId) return null
      const raw = ev.start?.dateTime
      const iso = raw ? (raw.endsWith('Z') ? raw : `${raw}Z`) : null
      return { taskId, deleted: !!ev.isCancelled, start: iso, allDay: !!ev.isAllDay, updated: ev.lastModifiedDateTime }
    })
    .filter(Boolean)
}

export function authUrl(clientId, redirectUri, state, loginHint) {
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SCOPES.join(' '),
    state,
    // always prompt so a second (work) account can be added alongside a personal one
    prompt: 'select_account',
  })
  if (loginHint) q.set('login_hint', loginHint)
  return `${AUTHORITY}/authorize?${q}`
}
