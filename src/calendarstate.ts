import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CalendarEntry, CalendarEvent, CalendarSource, Item, Project } from './types'
import type { MirrorPulled, PassResult } from './calendars'
import { apiFetch } from './api'
import { idbGet, idbSet } from './idb'
import { dateKey } from './utils'

// The calendars as the shell holds them from launch: the subscribed feeds'
// events (read through the session-gated /api/calendars proxy and cached in
// IndexedDB, so the overlay survives offline and reloads), the Google and
// Outlook mirrors' state, and the day arithmetic Today and the grids draw
// with. The mirror engine itself — the ledger, the sweep, what a pull's changes
// do — and everything Settings connects with is src/calendars.ts, which loads
// with the first mirror pass (a device with no mirror on never fetches it),
// the first entry written through to a mirror, or Settings.

const CACHE_KEY = 'calendar-events'
const FRESH_MS = 15 * 60_000
const DAY = 86_400_000

interface Cached {
  at: string
  events: CalendarEvent[]
  errors: Record<string, string>
  names: Record<string, string>
}

/** The pseudo-source that turns on mirroring tasks into the connected Google account. */
export const GOOGLE_PUSH_URL = 'google:push'
/** Legacy fixed id — migrated to googlePushId(myId) so household members don't collide. */
export const GOOGLE_PUSH_ID = 'google-push'
export const googlePushId = (userId: string) => `google-push-${userId}`

export const googleLedgerKey = (userId?: string | null) => `google:${userId ?? ''}`
export const msLedgerKey = (accountId: string) => `ms:${accountId}`

/** Reserved: never a real CalendarSource id, so it cannot collide with a subscription. */
export const LOCAL_SOURCE_ID = 'drafter:local'

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
    work: e.work,
    ownerId: e.ownerId,
  }
}

export const readCursor = (key: string) => {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}
export const writeCursor = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

/**
 * A provider calendar a mirror hook keeps current: Google, or one Outlook
 * account. `key` names its ledger and its stored notice; the engine
 * (passTarget in calendars.ts) makes the sweep's target from it.
 */
export type MirrorSpec = { provider: 'google'; id: 'google'; key: string } | { provider: 'microsoft'; id: string; key: string; accountId: string }

export interface GooglePushState {
  lastAt?: string
  error?: string
  pending: boolean
  /** Why each target's last pass failed: 'google', or an Outlook account id. */
  accountErrors?: Record<string, string>
  /** Records still owed to a provider (refused, unreachable or not reached yet); they are retried. */
  waiting?: number
  /** Something to tell the owner, by target ('google' or an Outlook account id), kept until dismissed. */
  notices?: Record<string, string>
  dismissNotice?(id: string): void
  /** Send what is owed; pulls afterwards when anything went out. */
  pushNow(): Promise<void>
  /**
   * Retry what is owed, then fetch what moved on the other side — the pass the
   * foreground resume runs, and what pull-to-refresh asks for.
   */
  pullNow(): Promise<void>
}

type MirrorStatus = Omit<GooglePushState, 'pushNow' | 'pullNow' | 'dismissNotice'>

const NOTICE_PREFIX = 'drafter:mirror-notice:'

/** Notices outlive a reload until dismissed: a recreated calendar is worth hearing about even if Settings was closed at the time. */
function storedNotices(targets: readonly MirrorSpec[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const t of targets) {
    const text = readCursor(NOTICE_PREFIX + t.key)
    if (text) out[t.id] = text
  }
  return out
}

/**
 * The React side both mirrors share: when a pass runs, and what it reports. A
 * pass runs a few seconds after any change, on focus, every half hour and when
 * the network comes back. Whatever is still owed afterwards is retried on its
 * own — straight away while there is more to send, backing off from a minute
 * to half an hour while something is failing.
 */
function useMirrorSync(
  items: Item[],
  projects: Project[],
  targets: MirrorSpec[],
  onPulled: ((pulled: MirrorPulled) => void) | undefined,
  myId?: string | null,
): GooglePushState {
  const [state, setState] = useState<MirrorStatus>(() => ({ pending: false, notices: storedNotices(targets) }))
  // what the pass reads when it runs, from the render last committed
  const onPulledRef = useRef(onPulled)
  const itemsRef = useRef(items)
  const projectsRef = useRef(projects)
  const myIdRef = useRef(myId)
  const targetsRef = useRef(targets)
  useLayoutEffect(() => {
    onPulledRef.current = onPulled
    itemsRef.current = items
    projectsRef.current = projects
    myIdRef.current = myId
    targetsRef.current = targets
  })
  const inflight = useRef<Promise<void> | null>(null)
  const queued = useRef<{ pull: boolean } | null>(null)
  const retry = useRef<{ timer?: number; delay: number }>({ delay: 0 })
  const debounce = useRef<number | undefined>(undefined)

  // named, so a retry can queue the next pass on the very function that is running
  const trigger = useCallback(function requestPass(pull: boolean): Promise<void> {
    // one pass at a time; a request made mid-pass gets a pass of its own right
    // after, and waits for it, so pull-to-refresh never reports done early
    queued.current = { pull: pull || !!queued.current?.pull }
    if (inflight.current) return inflight.current
    const loop = (async () => {
      try {
        while (queued.current) {
          const want = queued.current
          queued.current = null
          const list = targetsRef.current
          if (list.length === 0) continue
          setState(s => ({ ...s, pending: true }))
          const names = Object.fromEntries(projectsRef.current.map(p => [p.id, p.name]))
          let pass: PassResult
          try {
            // the engine loads with the first pass: a device with no mirror on never fetches it
            const engine = await import('./calendars')
            const passTargets = list.map(spec => engine.passTarget(spec, myIdRef.current, () => onPulledRef.current))
            pass = await engine.mirrorPass(passTargets, itemsRef.current, names, myIdRef.current, { pull: want.pull })
          } catch (e) {
            // its chunk would not load: a failed pass like any other, retried with the same backoff
            const why = (e as Error).message || 'The calendar mirror could not load.'
            pass = { accountErrors: Object.fromEntries(list.map(t => [t.id, why])), waiting: 0, more: false, failed: true, notices: {} }
          }
          for (const t of list) if (pass.notices[t.id]) writeCursor(NOTICE_PREFIX + t.key, pass.notices[t.id])
          setState({
            lastAt: new Date().toISOString(),
            pending: false,
            error: Object.values(pass.accountErrors)[0],
            accountErrors: pass.accountErrors,
            waiting: pass.waiting,
            notices: storedNotices(list),
          })
          window.clearTimeout(retry.current.timer)
          let delay = 0
          if (pass.failed) delay = retry.current.delay = Math.min(30 * 60_000, retry.current.delay ? retry.current.delay * 2 : 60_000)
          else {
            retry.current.delay = 0
            delay = pass.more ? 1500 : pass.waiting > 0 ? 5 * 60_000 : 0
          }
          if (delay) retry.current.timer = window.setTimeout(() => void requestPass(false), delay)
        }
      } finally {
        inflight.current = null
      }
    })()
    inflight.current = loop
    return loop
  }, [])

  const signature = targets.map(t => t.key).join('\n')
  // A mirror switched on or off, or an account added: what is shown is redone
  // as the new set renders — the notices stored for it, or, switched off, a
  // clean slate, so an old error cannot linger beside the switch.
  const [shownFor, setShownFor] = useState(signature)
  if (shownFor !== signature) {
    setShownFor(signature)
    setState(signature ? s => ({ ...s, notices: storedNotices(targets) }) : { pending: false })
  }

  // a few seconds after any change: send what is owed
  useEffect(() => {
    if (!signature) return
    window.clearTimeout(debounce.current)
    debounce.current = window.setTimeout(() => void trigger(false), 3000)
    return () => window.clearTimeout(debounce.current)
  }, [items, signature, trigger])

  // now, on focus, every half hour and when the network returns: retry, then pull
  useEffect(() => {
    if (!signature) return
    const onVisible = () => {
      if (document.visibilityState === 'visible') void trigger(true)
    }
    const onOnline = () => void trigger(false)
    const every = window.setInterval(() => void trigger(true), 30 * 60_000)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    void trigger(true)
    return () => {
      window.clearInterval(every)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
    }
  }, [signature, trigger])

  useEffect(() => () => window.clearTimeout(retry.current.timer), [])

  const pushNow = useCallback(() => trigger(false), [trigger])
  const pullNow = useCallback(() => trigger(true), [trigger])
  const dismissNotice = useCallback((id: string) => {
    const t = targetsRef.current.find(x => x.id === id)
    if (t) {
      try {
        localStorage.removeItem(NOTICE_PREFIX + t.key)
      } catch {
        /* ignore */
      }
    }
    setState(s => {
      const notices = { ...(s.notices ?? {}) }
      delete notices[id]
      return { ...s, notices }
    })
  }, [])
  return { ...state, pushNow, pullNow, dismissNotice }
}

/**
 * Mirror my tasks and entries into the Google "Drafter" calendar: whatever the
 * ledger says Google has not confirmed goes out a few seconds after a change,
 * on focus, every half hour and when the network returns, and then what changed
 * in Google comes back, to `onPulled` (apply it with applyMirrorChanges).
 * Server-side every write is idempotent (upsert by record id; remove a task
 * that is no longer open and dated, or a deleted entry). Only my rows go, so a
 * partner's chores stay out of my calendar.
 */
export function useGooglePush(
  items: Item[],
  projects: Project[],
  enabled: boolean,
  onPulled?: (pulled: MirrorPulled) => void,
  myId?: string | null,
): GooglePushState {
  const targets = useMemo<MirrorSpec[]>(() => (enabled ? [{ provider: 'google', id: 'google', key: googleLedgerKey(myId) }] : []), [enabled, myId])
  return useMirrorSync(items, projects, targets, onPulled, myId)
}

/**
 * Mirror my tasks and entries into the "Drafter" calendar of each Outlook
 * account that has mirroring on, then pull back what changed in Outlook, to
 * `onPulled` (apply it with applyMirrorChanges). The same sweep as Google, one
 * account after another and each on its own, so a dead account cannot stop the
 * rest and reports under its own id; and the pull runs on focus and every half
 * hour like Google's, not only after a push.
 */
export function useMicrosoftSync(
  items: Item[],
  projects: Project[],
  accountIds: string[],
  onPulled?: (pulled: MirrorPulled) => void,
  myId?: string | null,
): GooglePushState {
  const signature = accountIds.join('\n')
  const targets = useMemo<MirrorSpec[]>(
    () =>
      signature
        .split('\n')
        .filter(Boolean)
        .map((accountId): MirrorSpec => ({ provider: 'microsoft', id: accountId, key: msLedgerKey(accountId), accountId })),
    [signature],
  )
  return useMirrorSync(items, projects, targets, onPulled, myId)
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
  // the fetch in flight, if any: a refresh asked for mid-fetch (the pull-down
  // right after a foreground resume) waits for that one rather than returning
  // at once and reporting done while the feeds are still loading
  const inflight = useRef<Promise<void> | null>(null)
  const sigRef = useRef(signature)
  const sourcesRef = useRef(enabled)
  useLayoutEffect(() => {
    sigRef.current = signature
    sourcesRef.current = enabled
  })

  const refresh = useCallback((): Promise<void> => {
    if (inflight.current) return inflight.current
    const list = sourcesRef.current
    if (list.length === 0) {
      setState({ events: [], errors: {}, names: {}, loading: false })
      idbSet('posts', CACHE_KEY, { at: new Date().toISOString(), events: [], errors: {}, names: {}, signature: '' }).catch(() => {})
      return Promise.resolve()
    }
    setState(s => ({ ...s, loading: true, error: undefined }))
    inflight.current = fetchEvents(list)
      .then(fresh => {
        setState({ ...fresh, lastAt: fresh.at, loading: false })
        idbSet('posts', CACHE_KEY, { ...fresh, signature: sigRef.current }).catch(() => {})
      })
      .catch((e: Error) => {
        setState(s => ({ ...s, loading: false, error: e.message }))
      })
      .finally(() => {
        inflight.current = null
      })
    return inflight.current
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
