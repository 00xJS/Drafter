import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isMineTask } from '../shared/domain.mjs'
import { CalendarEntry, CalendarEvent, CalendarSource, Item, OPEN_STATUSES, Project, Task } from './types'
import { apiFetch } from './api'
import { idbGet, idbSet } from './idb'
import { hashId } from './itemops'
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
    work: e.work,
  }
}

/**
 * Write one entry through to the connected Google calendar.
 *
 * Best-effort by design, like every other Google call here: a network that is
 * down must never block saving locally. The row is already in the store by the
 * time this runs, so a failure costs the mirror, not the entry.
 */
export function pushEventToGoogle(entry: CalendarEntry, opts: { revive?: boolean } = {}): Promise<{ result: string }> {
  // takes its turn with the sweep (see withMirrorLock), and tells it what went
  // out, so a save is not sent a second time a few seconds later
  const key = lockKey(GOOGLE_LOCK, entry.id)
  return withMirrorLock([key], async () => {
    // `revive` is for Drafter's own Undo: Google keeps our deletion as a
    // cancelled event, which would otherwise read as "deleted in Google on purpose"
    const r = await googleAction<{ result: string }>('push-event', { event: entry, revive: opts.revive === true })
    singles.set(key, mirrorStamp(entry.updatedAt))
    return r
  })
}

/**
 * The same, into one Microsoft account. The caller fans out across every
 * enabled mirror account, exactly as task mirroring already does; Graph
 * hard-deletes, so Undo needs no revive flag here.
 */
export function pushEventToMicrosoft(entry: CalendarEntry, accountId: string): Promise<{ result: string }> {
  const key = lockKey(msLock(accountId), entry.id)
  return withMirrorLock([key], async () => {
    const r = await microsoftAction<{ result: string }>('push-event', { event: entry, accountId })
    singles.set(key, mirrorStamp(entry.updatedAt))
    return r
  })
}

/**
 * Whether a task is one the mirrors keep in the provider: open and dated.
 *
 * The server decides what to push with exactly this rule (lib/google.mjs
 * pushTask `wanted`), so the pull uses it too, to tell a cancellation the
 * mirror itself caused from one the owner made in Google. Without it, moving a
 * task to Wishlist or clearing its date removed the event, the pull saw that
 * cancellation, and marked the task done.
 */
export function isMirroredTask(t: Pick<Task, 'status' | 'dueAt'> & { deletedAt?: string }): boolean {
  return !t.deletedAt && OPEN_STATUSES.includes(t.status) && !!t.dueAt
}

/**
 * The concrete days a repeating work pattern covers: every chosen weekday from
 * `fromDay` for `weeks` weeks, each with the same working hours in LOCAL time.
 *
 * Materialised into separate entries on purpose. Each day then stays editable
 * on its own — the Tuesday you go into the office instead — which one repeating
 * rule would make awkward, and the mirrors, the feed and the grid need nothing
 * new to understand them. Capped at a year so a slip cannot mint thousands.
 */
export function expandWorkDays(
  fromDay: string,
  weekdays: number[],
  weeks: number,
  startHM: string,
  endHM: string,
): { day: string; start: string; end: string }[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fromDay)
  const hm = (v: string) => {
    const x = /^(\d{1,2}):(\d{2})/.exec(v)
    return x ? { h: Number(x[1]), min: Number(x[2]) } : null
  }
  const a = hm(startHM)
  const b = hm(endHM)
  if (!m || !a || !b) return []
  const want = new Set(weekdays)
  const first = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const span = Math.max(1, Math.min(52, Math.floor(weeks) || 1)) * 7
  const out: { day: string; start: string; end: string }[] = []
  for (let i = 0; i < span; i++) {
    const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i)
    if (!want.has(d.getDay())) continue
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), a.h, a.min)
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), b.h, b.min)
    if (end.getTime() <= start.getTime()) continue
    out.push({ day: dateKey(d), start: start.toISOString(), end: end.toISOString() })
  }
  return out
}

/** Reserved: never a real CalendarSource id, so it cannot collide with a subscription. */
export const LOCAL_SOURCE_ID = 'drafter:local'

/**
 * The device's IANA zone, sent with every mirror push. The server decides
 * whether a task is untimed in the owner's zone, and an account that never
 * saved push prefs had none, so it judged in UTC and every untimed task reached
 * both calendars as a 00:00 event all summer. It is only ever adopted, never
 * used to overwrite a zone the owner chose.
 */
function deviceTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

const PUSH_CURSOR_KEY = 'drafter:google-push-cursor'
const pushCursorKey = (userId?: string | null) => (userId ? `${PUSH_CURSOR_KEY}:${userId}` : PUSH_CURSOR_KEY)

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

// ---- the mirror ledger ----------------------------------------------------------
//
// Which version of each record a provider calendar has confirmed. The mirrors
// used to keep one cursor per provider ("everything with updatedAt past this
// went out"), and three things fell through it. Entries were never swept at
// all: pushed once, on save, so a failed push, a mirror turned on later or a
// new Outlook account never got them, and a failed delete left a busy block
// behind. A batch was capped at 200 and a large one ran past the function's
// time limit. And updatedAt is stamped by whichever device made the edit, so a
// phone whose clock ran behind wrote edits BELOW a cursor this device had
// already passed, and they never went out. The server's syncedAt cannot fix
// that on its own: a row edited here keeps the syncedAt of the copy it was
// edited from (a merge only replaces a row on a strictly newer updatedAt), so
// it cannot tell a fresh local edit from an old row.
//
// So the ledger keeps, per record, the exact version the provider confirmed.
// A record whose current version differs is owed, whatever any clock says, and
// stays owed until it is confirmed — which is also the retry.

/** One provider calendar's confirmations. */
export interface MirrorLedger {
  v: 1
  /** The provider calendar these confirmations are for; another one means everything is owed again. */
  cal?: string
  /** record id -> `${mirrorStamp(updatedAt)}.${base-36 seconds when confirmed}` */
  seen: Record<string, string>
}

/** What the mirrors keep in a provider: my tasks, and my entries (events and work days). */
export type MirrorRecord = Task | CalendarEntry

const LEDGER_PREFIX = 'drafter:mirror-ledger:'
const ledgers = new Map<string, MirrorLedger>()

/** A version fingerprint, short because the ledger holds one per record. */
export const mirrorStamp = (updatedAt: string): string => hashId(updatedAt)

export const googleLedgerKey = (userId?: string | null) => `google:${userId ?? ''}`
export const msLedgerKey = (accountId: string) => `ms:${accountId}`

function readLedger(key: string): MirrorLedger | null {
  const hit = ledgers.get(key)
  if (hit) return hit
  try {
    const raw = localStorage.getItem(LEDGER_PREFIX + key)
    const parsed = raw ? (JSON.parse(raw) as MirrorLedger) : null
    if (parsed && parsed.v === 1 && parsed.seen && typeof parsed.seen === 'object') {
      ledgers.set(key, parsed)
      return parsed
    }
  } catch {
    /* unreadable: the caller starts a fresh one */
  }
  return null
}

function writeLedger(key: string, ledger: MirrorLedger, held?: Set<string>): void {
  // a record no longer held here (a tombstone past its 90 days) has nothing left to owe
  if (held) for (const id of Object.keys(ledger.seen)) if (!held.has(id)) delete ledger.seen[id]
  ledgers.set(key, ledger)
  try {
    localStorage.setItem(LEDGER_PREFIX + key, JSON.stringify(ledger))
  } catch {
    /* full or blocked: the copy in memory still serves this session */
  }
}

/** Forget every confirmation for one provider calendar, so the next sweep sends everything. */
export function resetMirrorLedger(key: string): void {
  writeLedger(key, { v: 1, seen: {} })
}

export function isMirrorRecord(i: Item, myId?: string | null): i is MirrorRecord {
  if (i.kind === 'task') return isMineTask(i, myId)
  // entries are household-visible, but a partner's evening stays out of MY calendar
  if (i.kind === 'event') return !i.ownerId || !myId || i.ownerId === myId
  return false
}

const confirmedStamp = (ledger: MirrorLedger, id: string) => ledger.seen[id]?.split('.')[0]

/**
 * The ledger a device starts from the first time it runs this code: every task
 * the old cursor had passed counts as confirmed, so upgrading does not re-send
 * every task ever written. Entries are deliberately not carried over — the old
 * mirror never swept them — so the first sweep sends each once. That is the
 * backfill that was missing; the providers patch or skip what they already hold.
 */
export function seedLedger(items: Item[], myId: string | null | undefined, legacyCursor: string): MirrorLedger {
  const seen: Record<string, string> = {}
  if (legacyCursor) {
    for (const i of items) if (i.kind === 'task' && isMineTask(i, myId) && i.updatedAt <= legacyCursor) seen[i.id] = `${mirrorStamp(i.updatedAt)}.0`
  }
  return { v: 1, seen }
}

/** Everything owed to one provider calendar, newest change first, so the edit just made goes out first. */
export function mirrorCandidates(items: Item[], ledger: MirrorLedger, myId?: string | null, skip?: (r: MirrorRecord) => boolean): MirrorRecord[] {
  return items
    .filter((i): i is MirrorRecord => isMirrorRecord(i, myId) && confirmedStamp(ledger, i.id) !== mirrorStamp(i.updatedAt) && !skip?.(i as MirrorRecord))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
}

/** Only the fields the provider bodies read: a task's comments, notes and checklist stay home. */
export function mirrorPayload(r: MirrorRecord): Record<string, unknown> {
  if (r.kind === 'task') {
    const { kind, id, title, description, status, priority, dueAt, projectId, deletedAt, updatedAt } = r
    return { kind, id, title, description, status, priority, dueAt, projectId, deletedAt, updatedAt }
  }
  const { kind, id, title, start, end, allDay, location, notes, work, deletedAt, updatedAt } = r
  return { kind, id, title, start, end, allDay, location, notes, work, deletedAt, updatedAt }
}

// ---- one write per record at a time --------------------------------------------
//
// An entry saved in Planner goes out at once through push-event, and the sweep
// a few seconds later would send it again. Side by side, both lookups can miss
// the other's copy and both create one: a duplicate busy block. So every write
// for one record to one provider takes its turn, and a sweep counts what
// push-event already confirmed instead of sending it twice.

const GOOGLE_LOCK = 'google'
const msLock = (accountId: string) => `ms:${accountId}`
const lockKey = (lock: string, id: string) => `${lock}|${id}`
const locks = new Map<string, Promise<unknown>>()
/** lock key -> the version push-event last confirmed. */
const singles = new Map<string, string>()

function withMirrorLock<T>(keys: string[], run: () => Promise<T>): Promise<T> {
  const before = keys.map(k => locks.get(k)).filter((p): p is Promise<unknown> => !!p)
  const turn = Promise.allSettled(before).then(run)
  for (const k of keys) locks.set(k, turn)
  void turn
    .finally(() => {
      for (const k of keys) if (locks.get(k) === turn) locks.delete(k)
    })
    .catch(() => {})
  return turn
}

// A record the provider refused is not re-sent on every keystroke: it waits,
// longer each time, up to an hour. Keyed by version, so editing it sends the
// new version at once.
const refusals = new Map<string, { n: number; until: number }>()
const refusalKey = (lock: string, r: MirrorRecord) => `${lockKey(lock, r.id)}|${mirrorStamp(r.updatedAt)}`
function refuse(lock: string, r: MirrorRecord, now: number): void {
  const k = refusalKey(lock, r)
  const n = (refusals.get(k)?.n ?? 0) + 1
  refusals.set(k, { n, until: now + Math.min(60 * 60_000, 30_000 * 2 ** (n - 1)) })
}
const refused = (lock: string, r: MirrorRecord, now: number) => (refusals.get(refusalKey(lock, r))?.until ?? 0) > now
/** The account refused, not the record (revoked, not connected): no reason to hold the record back. */
const accountRefusal = (status?: number) => status === 401 || status === 403 || status === 409

// ---- the sweep -------------------------------------------------------------------

/** What a provider said to one chunk (see runMirrorBatch in netlify/functions/lib/mirror.mjs). */
export interface MirrorBatchReply {
  done?: string[]
  errors?: { id: string; error: string; status?: number }[]
  left?: string[]
  fatal?: boolean
  calendarId?: string
}

export interface MirrorTarget {
  /** Ledger key: googleLedgerKey(me) or msLedgerKey(account). */
  key: string
  /** Shared with push-event, so a sweep and a save of the same entry take turns. */
  lock: string
  /** The pre-ledger cursor, read once, the first time this target is swept here. */
  legacyCursor?(): string
}

export interface SweepResult {
  /** Records the provider confirmed this pass. */
  confirmed: number
  /** Records it refused; they stay owed. */
  errors: { id: string; error: string }[]
  /** Set when the request failed outright or the account refused: nothing after it was tried. */
  fatal?: string
  /** A chunk came back with nothing done and nothing refused, so the pass stopped rather than spin. */
  stalled: boolean
  /** The provider calendar was not the one the ledger knew, so everything was owed to the new one. */
  replaced: boolean
  /** Owed and sendable now (not waiting out a refusal). */
  ready: number
  /** Owed at all. */
  waiting: number
}

/**
 * Send one provider calendar everything it is owed, a chunk per request, until
 * nothing is owed, the account refuses, or `rounds` runs out (the next pass
 * carries on). Pure apart from the ledger and `send`, so it is tested with a stub.
 */
export async function sweepMirror(
  target: MirrorTarget,
  items: Item[],
  myId: string | null | undefined,
  send: (records: Record<string, unknown>[]) => Promise<MirrorBatchReply>,
  opts: { chunk?: number; rounds?: number; now?: () => number } = {},
): Promise<SweepResult> {
  const now = opts.now ?? Date.now
  const chunk = opts.chunk ?? 20
  const rounds = opts.rounds ?? 40
  const held = new Set(items.map(i => i.id))
  let ledger: MirrorLedger = readLedger(target.key) ?? seedLedger(items, myId, target.legacyCursor?.() ?? '')
  const confirm = (r: MirrorRecord) => {
    ledger.seen[r.id] = `${mirrorStamp(r.updatedAt)}.${Math.floor(now() / 1000).toString(36)}`
  }
  const errors: SweepResult['errors'] = []
  const failedNow = new Set<string>()
  let confirmed = 0
  let replaced = false
  let stalled = false
  let fatal: string | undefined
  for (let round = 0; round < rounds; round++) {
    const owed = mirrorCandidates(items, ledger, myId, r => failedNow.has(r.id) || refused(target.lock, r, now()))
    if (owed.length === 0) break
    let batch = owed.slice(0, chunk)
    // a push-event for one of these may be on its way: let it land, then count it
    await Promise.allSettled(batch.map(r => locks.get(lockKey(target.lock, r.id))))
    batch = batch.filter(r => {
      if (singles.get(lockKey(target.lock, r.id)) !== mirrorStamp(r.updatedAt)) return true
      confirm(r)
      confirmed++
      return false
    })
    if (batch.length === 0) continue
    let reply: MirrorBatchReply
    try {
      reply = await withMirrorLock(
        batch.map(r => lockKey(target.lock, r.id)),
        () => send(batch.map(mirrorPayload)),
      )
    } catch (e) {
      // the request itself failed (offline, the function down, the account
      // refused outright): nothing in it was confirmed, so all of it stays owed
      fatal = (e as Error).message || 'The calendar could not be reached.'
      break
    }
    if (!replaced && reply.calendarId && ledger.cal && reply.calendarId !== ledger.cal) {
      // these confirmations were for a calendar that is gone (deleted, or a
      // reconnect to another account): everything is owed to the new one. What
      // this reply confirmed went into the new calendar, so it counts below.
      ledger = { v: 1, seen: {} }
      replaced = true
    }
    if (reply.calendarId) ledger.cal = reply.calendarId
    const sent = new Map(batch.map(r => [r.id, r]))
    for (const id of reply.done ?? []) {
      const r = sent.get(id)
      if (!r) continue
      confirm(r)
      confirmed++
    }
    for (const e of reply.errors ?? []) {
      const r = sent.get(e.id)
      if (!r) continue
      failedNow.add(r.id)
      if (!accountRefusal(e.status)) refuse(target.lock, r, now())
      errors.push({ id: e.id, error: e.error })
    }
    writeLedger(target.key, ledger, held)
    if (reply.fatal) {
      fatal = reply.errors?.[0]?.error ?? 'The calendar refused the update.'
      break
    }
    if (!reply.done?.length && !reply.errors?.length) {
      stalled = true
      break
    }
  }
  writeLedger(target.key, ledger, held)
  return {
    confirmed,
    errors,
    fatal,
    stalled,
    replaced,
    ready: mirrorCandidates(items, ledger, myId, r => refused(target.lock, r, now())).length,
    waiting: mirrorCandidates(items, ledger, myId).length,
  }
}

/** One provider calendar as the hooks drive it: the sweep, plus how to send and how to pull. */
export interface PassTarget extends MirrorTarget {
  /** 'google', or the Outlook account id: what errors are reported under. */
  id: string
  push(records: Record<string, unknown>[], projects: Record<string, string>): Promise<MirrorBatchReply>
  /** Fetch what moved on the provider side and hand it on. */
  pull(): Promise<void>
}

export interface PassResult {
  /** Why each target's pass failed, by target id. */
  accountErrors: Record<string, string>
  waiting: number
  /** Something is sendable right now (a chunk limit or the time budget cut the pass short). */
  more: boolean
  /** Something failed: retry later, backing off. */
  failed: boolean
}

const describeRefusals = (errors: { error: string }[]) =>
  errors.length === 1 ? errors[0].error : `${errors.length} could not be mirrored — ${errors[0].error}`

/**
 * One pass over every target, each on its own. One account that refuses (a
 * revoked token) used to throw out of the loop and stop every account after
 * it, and a refused record was overwritten by the "synced" that followed, so
 * neither ever showed. Now each target's trouble is kept under its own id.
 */
export async function mirrorPass(
  targets: PassTarget[],
  items: Item[],
  projects: Record<string, string>,
  myId: string | null | undefined,
  opts: { pull: boolean; now?: () => number },
): Promise<PassResult> {
  const accountErrors: Record<string, string> = {}
  let waiting = 0
  let more = false
  let failed = false
  for (const t of targets) {
    let res: SweepResult
    try {
      res = await sweepMirror(t, items, myId, records => t.push(records, projects), { now: opts.now })
    } catch (e) {
      accountErrors[t.id] = (e as Error).message
      failed = true
      continue
    }
    waiting += res.waiting
    if (res.fatal || res.errors.length || res.stalled) failed = true
    if (res.fatal) {
      accountErrors[t.id] = res.fatal
      continue
    }
    if (res.errors.length) accountErrors[t.id] = describeRefusals(res.errors)
    if (res.ready > 0) more = true
    if (!opts.pull && res.confirmed === 0) continue
    try {
      await t.pull()
    } catch (e) {
      // a dead account shows here even when nothing was owed to it
      if (!accountErrors[t.id]) accountErrors[t.id] = (e as Error).message
      failed = true
    }
  }
  return { accountErrors, waiting, more, failed }
}

export interface GooglePushState {
  lastAt?: string
  error?: string
  pending: boolean
  /** Why each target's last pass failed: 'google', or an Outlook account id. */
  accountErrors?: Record<string, string>
  /** Records still owed to a provider (refused, unreachable or not reached yet); they are retried. */
  waiting?: number
  /** Send what is owed; pulls afterwards when anything went out. */
  pushNow(): Promise<void>
  /**
   * Retry what is owed, then fetch what moved on the other side — the pass the
   * foreground resume runs, and what pull-to-refresh asks for.
   */
  pullNow(): Promise<void>
}

type MirrorStatus = Omit<GooglePushState, 'pushNow' | 'pullNow'>

/**
 * The React side both mirrors share: when a pass runs, and what it reports. A
 * pass runs a few seconds after any change, on focus, every half hour and when
 * the network comes back. Whatever is still owed afterwards is retried on its
 * own — straight away while there is more to send, backing off from a minute
 * to half an hour while something is failing.
 */
function useMirrorSync(items: Item[], projects: Project[], targets: PassTarget[], myId?: string | null): GooglePushState {
  const [state, setState] = useState<MirrorStatus>({ pending: false })
  const itemsRef = useRef(items)
  itemsRef.current = items
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const myIdRef = useRef(myId)
  myIdRef.current = myId
  const targetsRef = useRef(targets)
  targetsRef.current = targets
  const inflight = useRef<Promise<void> | null>(null)
  const queued = useRef<{ pull: boolean } | null>(null)
  const retry = useRef<{ timer?: number; delay: number }>({ delay: 0 })
  const debounce = useRef<number | undefined>(undefined)
  const triggerRef = useRef<(pull: boolean) => Promise<void>>(() => Promise.resolve())

  const trigger = useCallback((pull: boolean): Promise<void> => {
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
          const pass = await mirrorPass(list, itemsRef.current, names, myIdRef.current, { pull: want.pull })
          setState({ lastAt: new Date().toISOString(), pending: false, error: Object.values(pass.accountErrors)[0], accountErrors: pass.accountErrors, waiting: pass.waiting })
          window.clearTimeout(retry.current.timer)
          let delay = 0
          if (pass.failed) delay = retry.current.delay = Math.min(30 * 60_000, retry.current.delay ? retry.current.delay * 2 : 60_000)
          else {
            retry.current.delay = 0
            delay = pass.more ? 1500 : pass.waiting > 0 ? 5 * 60_000 : 0
          }
          if (delay) retry.current.timer = window.setTimeout(() => void triggerRef.current(false), delay)
        }
      } finally {
        inflight.current = null
      }
    })()
    inflight.current = loop
    return loop
  }, [])
  triggerRef.current = trigger

  const signature = targets.map(t => t.key).join('\n')

  // a few seconds after any change: send what is owed
  useEffect(() => {
    if (!signature) return
    window.clearTimeout(debounce.current)
    debounce.current = window.setTimeout(() => void trigger(false), 3000)
    return () => window.clearTimeout(debounce.current)
  }, [items, signature, trigger])

  // now, on focus, every half hour and when the network returns: retry, then pull
  useEffect(() => {
    if (!signature) {
      // mirroring switched off: an old error must not linger beside the switch
      setState({ pending: false })
      return
    }
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
  return { ...state, pushNow, pullNow }
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
 * Mirror my tasks and entries into the Google "Drafter" calendar: whatever the
 * ledger says Google has not confirmed goes out a few seconds after a change,
 * on focus, every half hour and when the network returns, and then what moved
 * in Google comes back. Server-side every write is idempotent (upsert by
 * record id; remove a task that is no longer open and dated, or a deleted
 * entry). Only my rows go, so a partner's chores stay out of my calendar.
 */
export function useGooglePush(
  items: Item[],
  projects: Project[],
  enabled: boolean,
  onPulled?: (changes: GoogleChange[]) => void,
  myId?: string | null,
): GooglePushState {
  const onPulledRef = useRef(onPulled)
  onPulledRef.current = onPulled
  const targets = useMemo<PassTarget[]>(
    () =>
      enabled
        ? [
            {
              id: 'google',
              key: googleLedgerKey(myId),
              lock: GOOGLE_LOCK,
              legacyCursor: () => {
                try {
                  return localStorage.getItem(pushCursorKey(myId)) ?? localStorage.getItem(PUSH_CURSOR_KEY) ?? ''
                } catch {
                  return ''
                }
              },
              push: (records, projectNames) => googleAction<MirrorBatchReply>('push', { records, projects: projectNames, timezone: deviceTimeZone() }),
              pull: async () => {
                const apply = onPulledRef.current
                if (!apply) return
                const changes = await pullGoogleChanges()
                if (changes.length) apply(changes)
              },
            },
          ]
        : [],
    [enabled, myId],
  )
  return useMirrorSync(items, projects, targets, myId)
}

/** Forget what Google has confirmed, so the next sweep sends everything — tasks and entries — again (turning the mirror on, reconnecting). */
export function resetGooglePushCursor(userId?: string | null): void {
  try {
    localStorage.removeItem(pushCursorKey(userId))
    if (!userId) localStorage.removeItem(PUSH_CURSOR_KEY)
  } catch {
    /* ignore */
  }
  // an explicit empty ledger, so the next sweep cannot seed itself from a stale cursor
  resetMirrorLedger(googleLedgerKey(userId))
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
  sigRef.current = signature
  const sourcesRef = useRef(enabled)
  sourcesRef.current = enabled

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

/** Forget what one Outlook account has confirmed, so the next sweep sends everything again. */
export function resetMicrosoftPushCursor(accountId: string): void {
  writeCursor(`${MS_PUSH_CURSOR}:${accountId}`, '')
  resetMirrorLedger(msLedgerKey(accountId))
}

/**
 * Mirror my tasks and entries into the "Drafter" calendar of each Outlook
 * account that has mirroring on, then pull back what moved in Outlook. The same
 * sweep as Google, one account after another and each on its own, so a dead
 * account cannot stop the rest and reports under its own id; and the pull runs
 * on focus and every half hour like Google's, not only after a push.
 */
export function useMicrosoftSync(
  items: Item[],
  projects: Project[],
  accountIds: string[],
  onPulled?: (changes: GoogleChange[]) => void,
  myId?: string | null,
): GooglePushState {
  const onPulledRef = useRef(onPulled)
  onPulledRef.current = onPulled
  const signature = accountIds.join('\n')
  const targets = useMemo<PassTarget[]>(
    () =>
      signature
        .split('\n')
        .filter(Boolean)
        .map(
          (accountId): PassTarget => ({
            id: accountId,
            key: msLedgerKey(accountId),
            lock: msLock(accountId),
            legacyCursor: () => readCursor(`${MS_PUSH_CURSOR}:${accountId}`),
            push: (records, projectNames) => microsoftAction<MirrorBatchReply>('push', { accountId, records, projects: projectNames, timezone: deviceTimeZone() }),
            pull: async () => {
              const apply = onPulledRef.current
              if (!apply) return
              const pullKey = `${MS_PULL_CURSOR}:${accountId}`
              const r = await microsoftAction<{ changes: GoogleChange[]; at: string }>('pull', { accountId, since: readCursor(pullKey) || undefined })
              writeCursor(pullKey, r.at)
              if (r.changes.length) apply(r.changes)
            },
          }),
        ),
    [signature],
  )
  return useMirrorSync(items, projects, targets, myId)
}
