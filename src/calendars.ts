import { useCallback, useEffect, useRef, useState } from 'react'
import { CalendarEvent, CalendarSource } from './types'
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
  url: string | null
  missing: string[]
}

export async function fetchFeedInfo(): Promise<CalendarFeedInfo> {
  const res = await apiFetch('/api/feed.ics')
  const body = (await res.json().catch(() => null)) as (CalendarFeedInfo & { error?: string }) | null
  if (!res.ok || !body) throw new Error(body?.error ?? `HTTP ${res.status}`)
  return body
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
  const enabled = sources.filter(s => s.enabled)
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
