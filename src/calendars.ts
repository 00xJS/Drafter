import { useCallback, useEffect, useRef, useState } from 'react'
import { isMineTask } from '../shared/domain.mjs'
import { CalendarEntry, CalendarEvent, CalendarSource, Item, Project } from './types'
import { apiFetch } from './api'
import { idbGet, idbSet } from './idb'
import { dateKey } from './utils'

// External calendars are read through the session-gated /api/calendars proxy
// and cached in IndexedDB so the overlay survives offline and reloads.

const CACHE_KEY = 'calendar-events'
const FRESH_MS = 15 * 60_000
const DAY = 86_400_000

interface Cached {
  at: string
  events: CalendarEvent[]
  errors: Record<string, string>
  names: Record<string, string>
}

export interface CalendarFeedInfo {
  configured: boolean
  enabled: boolean
  url: string | null
  inboundUrl?: string | null
  missing: string[]
}

export function inboundAction(action: 'inbound-enable' | 'inbound-rotate' | 'inbound-disable'): Promise<{ inboundUrl: string | null }> {
  return apiFetch('/api/feed.ics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) }).then(json<{ inboundUrl: string | null }>)
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok || !body) throw new Error(body?.error ?? `HTTP ${res.status}`)
  return body
}

export function fetchFeedInfo(): Promise<CalendarFeedInfo> {
  return apiFetch('/api/feed.ics').then(json<CalendarFeedInfo>)
}

export function feedAction(action: 'enable' | 'rotate' | 'disable'): Promise<CalendarFeedInfo> {
  return apiFetch('/api/feed.ics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) }).then(json<CalendarFeedInfo>)
}

// ---- Google Calendar (OAuth, per user) ---------------------------------------

export interface GoogleStatus {
  configured: boolean
  connected: boolean
  email: string | null
  missing: string[]
  redirectUri: string
}

export interface GoogleCalendarInfo {
  id: string
  name: string
  color?: string
  primary: boolean
  writable: boolean
}

export function googleAction<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  return apiFetch('/api/google', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...payload }), timeoutMs: 60_000 }).then(json<T>)
}

/** The pseudo-source that turns on mirroring tasks into the connected Google account. */
export const GOOGLE_PUSH_URL = 'google:push'
/** Legacy fixed id — migrated to googlePushId(myId) so household members don't collide. */
export const GOOGLE_PUSH_ID = 'google-push'
export const googlePushId = (userId: string) => `google-push-${userId}`
export const isGoogleSource = (s: CalendarSource) => s.url.startsWith('google:')

/**
 * What flipping the Google mirror switch has to write.
 *
 * The rule that matters is the legacy one: a row still carrying the shared
 * `google-push` id must be dropped in BOTH directions. Planner decides whether
 * to run the mirror with `some(c => (c.id === myPushId || c.id === GOOGLE_PUSH_ID) && c.enabled)`,
 * so writing `enabled: false` onto a fresh per-user row while leaving the
 * legacy row enabled turns the switch off in Settings and leaves the mirror
 * pushing to Google. Turning it off has to mean off.
 *
 * Pure so it can be tested: the caller performs `remove` then `upsert`.
 */
export function mirrorToggle(
  pushSource: { id: string; updatedAt: string } | undefined,
  myPushId: string,
  on: boolean,
): { removeId?: string; write: 'existing' | 'fresh' | 'none' } {
  if (!pushSource) return { write: on ? 'fresh' : 'none' }
  if (pushSource.id !== myPushId) return { removeId: pushSource.id, write: 'fresh' }
  return { write: 'existing' }
}

/**
 * Draw one of our own entries with the code that already draws feed events.
 * The alternative — a parallel render path for local events — is how a month
 * grid ends up with two kinds of pill that drift apart.
 */
export function entryToEvent(e: CalendarEntry): CalendarEvent {
  return {
    id: `local:${e.id}`,
    sourceId: LOCAL_SOURCE_ID,
    title: e.title || 'Untitled event',
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    location: e.location,
    localId: e.id,
  }
}

/**
 * Write one entry through to the connected Google calendar.
 *
 * Best-effort by design, like every other Google call here: a network that is
 * down must never block saving locally. The row is already in the store by the
 * time this runs, so a failure costs the mirror, not the entry.
 */
export function pushEventToGoogle(entry: CalendarEntry): Promise<{ result: string }> {
  return googleAction<{ result: string }>('push-event', { event: entry })
}

/** Reserved: never a real CalendarSource id, so it cannot collide with a subscription. */
export const LOCAL_SOURCE_ID = 'drafter:local'

const PUSH_CURSOR_KEY = 'drafter:google-push-cursor'
const pushCursorKey = (userId?: string | null) => (userId ? `${PUSH_CURSOR_KEY}:${userId}` : PUSH_CURSOR_KEY)

export interface GooglePushState {
  lastAt?: string
  error?: string
  pending: boolean
  pushNow(): Promise<void>
}

export interface GoogleChange {
  taskId: string
  deleted: boolean
  start: string | null
  allDay: boolean
  updated: string
}

const PULL_CURSOR_KEY = 'drafter:google-pull-cursor'

/** Ask Google which mirrored tasks were moved there since the last pull. */
export async function pullGoogleChanges(): Promise<GoogleChange[]> {
  let since = ''
  try {
    since = localStorage.getItem(PULL_CURSOR_KEY) ?? ''
  } catch {
    /* ignore */
  }
  const r = await googleAction<{ changes: GoogleChange[]; at: string }>('pull', { since: since || undefined })
  try {
    localStorage.setItem(PULL_CURSOR_KEY, r.at)
  } catch {
    /* ignore */
  }
  return r.changes
}

/**
 * Mirror tasks into the Google "Drafter" calendar: after every local change,
 * push the tasks whose updatedAt passed the cursor. Server-side the push is
 * idempotent (upsert by task id, delete when no longer open/dated).
 * Only `isMineTask` rows are pushed so a partner's chores stay out of my calendar.
 */
export function useGooglePush(
  items: Item[],
  projects: Project[],
  enabled: boolean,
  onPulled?: (changes: GoogleChange[]) => void,
  myId?: string | null,
): GooglePushState {
  const [state, setState] = useState<{ lastAt?: string; error?: string; pending: boolean }>({ pending: false })
  const busy = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const itemsRef = useRef(items)
  itemsRef.current = items
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const myIdRef = useRef(myId)
  myIdRef.current = myId
  const onPulledRef = useRef(onPulled)
  onPulledRef.current = onPulled

  const pushNow = useCallback(async () => {
    if (busy.current) return
    const cursorKey = pushCursorKey(myIdRef.current)
    let cursor = ''
    try {
      cursor = localStorage.getItem(cursorKey) ?? localStorage.getItem(PUSH_CURSOR_KEY) ?? ''
    } catch {
      /* ignore */
    }
    const tasks = itemsRef.current.filter(i => i.kind === 'task' && isMineTask(i, myIdRef.current) && i.updatedAt > cursor)
    if (tasks.length === 0) return
    busy.current = true
    setState(s => ({ ...s, pending: true }))
    try {
      const names = Object.fromEntries(projectsRef.current.map(p => [p.id, p.name]))
      const result = await googleAction<{ errors: { id: string; error: string }[] }>('push', { tasks: tasks.slice(0, 200), projects: names })
      if (result.errors.length > 0) {
        setState({ lastAt: new Date().toISOString(), error: result.errors[0].error, pending: false })
        return
      }
      const maxSeen = tasks.slice(0, 200).reduce((m, t) => (t.updatedAt > m ? t.updatedAt : m), cursor)
      try {
        localStorage.setItem(cursorKey, maxSeen)
      } catch {
        /* ignore */
      }
      setState({ lastAt: new Date().toISOString(), pending: false })
      if (tasks.length > 200) window.setTimeout(() => pushNow(), 500)
      else if (onPulledRef.current) {
        try {
          const changes = await pullGoogleChanges()
          if (changes.length) onPulledRef.current(changes)
        } catch {
          /* pull is best-effort */
        }
      }
    } catch (e) {
      setState(s => ({ ...s, error: (e as Error).message, pending: false }))
    } finally {
      busy.current = false
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => pushNow(), 3000)
    return () => window.clearTimeout(timer.current)
  }, [items, enabled, pushNow])

  useEffect(() => {
    if (!enabled || !onPulledRef.current) return
    const pull = () => pullGoogleChanges().then(c => c.length && onPulledRef.current?.(c)).catch(() => {})
    const onVisible = () => {
      if (document.visibilityState === 'visible') pull()
    }
    const t = window.setInterval(pull, 30 * 60_000)
    document.addEventListener('visibilitychange', onVisible)
    pull()
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled])

  return { ...state, pushNow }
}

/** Forget the push cursor so the next push re-mirrors everything (after connecting or reconnecting). */
export function resetGooglePushCursor(userId?: string | null): void {
  try {
    localStorage.removeItem(pushCursorKey(userId))
    if (!userId) localStorage.removeItem(PUSH_CURSOR_KEY)
  } catch {
    /* ignore */
  }
}

async function fetchEvents(sources: CalendarSource[]): Promise<Cached> {
  const now = Date.now()
  const res = await apiFetch('/api/calendars', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sources: sources.map(s => ({ id: s.id, url: s.url })),
      from: new Date(now - 60 * DAY).toISOString(),
      to: new Date(now + 400 * DAY).toISOString(),
    }),
    timeoutMs: 45_000,
  })
  const body = (await res.json().catch(() => null)) as (Omit<Cached, 'at'> & { fetchedAt?: string; error?: string }) | null
  if (!res.ok || !body) throw new Error(body?.error ?? `HTTP ${res.status}`)
  return { at: body.fetchedAt ?? new Date().toISOString(), events: body.events ?? [], errors: body.errors ?? {}, names: body.names ?? {} }
}

export interface CalendarState {
  events: CalendarEvent[]
  errors: Record<string, string>
  names: Record<string, string>
  lastAt?: string
  loading: boolean
  /** Network-level failure (proxy unreachable), separate from per-source errors. */
  error?: string
  refresh(): Promise<void>
}

export function useCalendarEvents(sources: CalendarSource[]): CalendarState {
  const [state, setState] = useState<Omit<CalendarState, 'refresh'>>({ events: [], errors: {}, names: {}, loading: false })
  // pseudo-sources (task mirrors) are not feeds to fetch
  const enabled = sources.filter(s => s.enabled && s.url !== GOOGLE_PUSH_URL && !s.url.startsWith('ms-push:'))
  const signature = enabled.map(s => s.id + '|' + s.url).join('\n')
  const busy = useRef(false)
  const sigRef = useRef(signature)
  sigRef.current = signature
  const sourcesRef = useRef(enabled)
  sourcesRef.current = enabled

  const refresh = useCallback(async () => {
    if (busy.current) return
    const list = sourcesRef.current
    if (list.length === 0) {
      setState({ events: [], errors: {}, names: {}, loading: false })
      idbSet('posts', CACHE_KEY, { at: new Date().toISOString(), events: [], errors: {}, names: {}, signature: '' }).catch(() => {})
      return
    }
    busy.current = true
    setState(s => ({ ...s, loading: true, error: undefined }))
    try {
      const fresh = await fetchEvents(list)
      setState({ ...fresh, lastAt: fresh.at, loading: false })
      idbSet('posts', CACHE_KEY, { ...fresh, signature: sigRef.current }).catch(() => {})
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: (e as Error).message }))
    } finally {
      busy.current = false
    }
  }, [])

  // boot: serve the cache immediately, refresh if stale or the source list changed
  useEffect(() => {
    let live = true
    idbGet<Cached & { signature?: string }>('posts', CACHE_KEY)
      .then(cached => {
        if (!live) return
        const sameSources = cached?.signature === signature
        if (cached && sameSources) setState({ events: cached.events, errors: cached.errors ?? {}, names: cached.names ?? {}, lastAt: cached.at, loading: false })
        const stale = !cached || !sameSources || Date.now() - Date.parse(cached.at) > FRESH_MS
        if (stale) refresh()
      })
      .catch(() => refresh())
    return () => {
      live = false
    }
  }, [signature, refresh])

  // periodic refresh + when the app returns to the foreground
  useEffect(() => {
    const t = window.setInterval(() => refresh(), 30 * 60_000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  return { ...state, refresh }
}

/** Local calendar-day keys an event occupies (all-day spans cover every day; timed events their start day). */
export function eventDayKeys(ev: CalendarEvent): string[] {
  if (!ev.allDay) return [dateKey(ev.start)]
  const keys: string[] = []
  const [y, m, d] = ev.start.split('-').map(Number)
  const [ey, em, ed] = ev.end.split('-').map(Number)
  const end = new Date(ey, em - 1, ed).getTime()
  for (let cur = new Date(y, m - 1, d); cur.getTime() < end && keys.length < 62; cur.setDate(cur.getDate() + 1)) keys.push(dateKey(cur))
  return keys.length > 0 ? keys : [ev.start]
}

/** Start of an event as a local Date (all-day → local midnight of its first day). */
export function eventStartDate(ev: CalendarEvent): Date {
  if (!ev.allDay) return new Date(ev.start)
  const [y, m, d] = ev.start.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** Sensible due date for a prep task: the morning before the event (same morning if that is already past). */
export function prepDueFor(ev: CalendarEvent): string {
  const start = eventStartDate(ev)
  const dayBefore = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1, 9, 0, 0)
  if (dayBefore.getTime() > Date.now()) return dayBefore.toISOString()
  const sameDay = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 9, 0, 0)
  return (sameDay.getTime() > Date.now() ? sameDay : new Date(Date.now() + 3_600_000)).toISOString()
}

// ---- Outlook / Microsoft 365 (OAuth, per user, several accounts) -------------

export interface MicrosoftAccount {
  id: string
  email: string
  name: string
  hasMirror: boolean
}

export interface MicrosoftStatus {
  configured: boolean
  accounts: MicrosoftAccount[]
  missing: string[]
  redirectUri: string
}

export interface MicrosoftCalendarInfo {
  id: string
  name: string
  primary: boolean
  writable: boolean
}

export function microsoftAction<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  return apiFetch('/api/microsoft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
    timeoutMs: 60_000,
  }).then(json<T>)
}

/** Source url for one Outlook calendar. */
export const msSourceUrl = (accountId: string, calendarId: string) => `ms:${accountId}:${calendarId}`
/** The pseudo-source that turns on mirroring tasks into one Outlook account. */
export const msPushUrl = (accountId: string) => `ms-push:${accountId}`
export const msPushId = (accountId: string) => `ms-push-${accountId}`
export const isMicrosoftSource = (s: CalendarSource) => s.url.startsWith('ms:') || s.url.startsWith('ms-push:')

const MS_PUSH_CURSOR = 'drafter:ms-push-cursor'
const MS_PULL_CURSOR = 'drafter:ms-pull-cursor'

const readCursor = (key: string) => {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}
const writeCursor = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

/** Forget the mirror cursor so the next push re-sends everything. */
export function resetMicrosoftPushCursor(accountId: string): void {
  writeCursor(`${MS_PUSH_CURSOR}:${accountId}`, '')
}

/**
 * Mirror tasks into the "Drafter" calendar of each Outlook account that has
 * mirroring on, then pull back anything moved in Outlook. Same shape as the
 * Google mirror; the server side is idempotent.
 */
export function useMicrosoftSync(
  items: Item[],
  projects: Project[],
  accountIds: string[],
  onPulled?: (changes: GoogleChange[]) => void,
  myId?: string | null,
): GooglePushState {
  const [state, setState] = useState<{ lastAt?: string; error?: string; pending: boolean }>({ pending: false })
  const busy = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const itemsRef = useRef(items)
  itemsRef.current = items
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const idsRef = useRef(accountIds)
  idsRef.current = accountIds
  const myIdRef = useRef(myId)
  myIdRef.current = myId
  const onPulledRef = useRef(onPulled)
  onPulledRef.current = onPulled

  const pushNow = useCallback(async () => {
    if (busy.current || idsRef.current.length === 0) return
    busy.current = true
    setState(s => ({ ...s, pending: true }))
    try {
      const names = Object.fromEntries(projectsRef.current.map(p => [p.id, p.name]))
      for (const accountId of idsRef.current) {
        const cursorKey = `${MS_PUSH_CURSOR}:${accountId}`
        const cursor = readCursor(cursorKey)
        const tasks = itemsRef.current.filter(i => i.kind === 'task' && isMineTask(i, myIdRef.current) && i.updatedAt > cursor)
        if (tasks.length > 0) {
          const result = await microsoftAction<{ errors: { id: string; error: string }[] }>('push', { accountId, tasks: tasks.slice(0, 200), projects: names })
          if (result.errors.length > 0) {
            setState({ lastAt: new Date().toISOString(), error: result.errors[0].error, pending: false })
            continue
          }
          writeCursor(cursorKey, tasks.slice(0, 200).reduce((m, t) => (t.updatedAt > m ? t.updatedAt : m), cursor))
        }
        if (onPulledRef.current) {
          try {
            const pullKey = `${MS_PULL_CURSOR}:${accountId}`
            const r = await microsoftAction<{ changes: GoogleChange[]; at: string }>('pull', { accountId, since: readCursor(pullKey) || undefined })
            writeCursor(pullKey, r.at)
            if (r.changes.length) onPulledRef.current(r.changes)
          } catch {
            /* pull is best-effort */
          }
        }
      }
      setState({ lastAt: new Date().toISOString(), pending: false })
    } catch (e) {
      setState(s => ({ ...s, error: (e as Error).message, pending: false }))
    } finally {
      busy.current = false
    }
  }, [])

  useEffect(() => {
    if (accountIds.length === 0) return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => pushNow(), 3000)
    return () => window.clearTimeout(timer.current)
  }, [items, accountIds, pushNow])

  return { ...state, pushNow }
}
