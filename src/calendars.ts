import { isMineTask } from '../shared/domain.mts'
import { CalendarEntry, CalendarSource, Item, OPEN_STATUSES, Task, TaskStatus } from './types'
import { apiFetch } from './api'
import { googleLedgerKey, msLedgerKey, readCursor, writeCursor, type MirrorSpec } from './calendarstate'
import { hashId, localMidnightIso, newerStamp } from './itemops'
import { oauthReasonLabel } from './links'
import { isNative, onOAuthReturn, startOAuth } from './native'
import { getSupabase } from './supabase'
import { dateKey } from './utils'

// The calendars: subscribing, connecting Google and Outlook, and the engine
// that mirrors my tasks and entries into them and reads back what changed
// there. What the shell holds from launch — the feeds' events, the mirrors'
// state and the day arithmetic Today draws with — is src/calendarstate.ts;
// this file loads with the first mirror pass, the first entry written through
// to a mirror, or Settings. Re-exported here so the calendars read as one API.
export {
  GOOGLE_PUSH_ID,
  GOOGLE_PUSH_URL,
  LOCAL_SOURCE_ID,
  entryToEvent,
  eventDayKeys,
  eventStartDate,
  googleLedgerKey,
  googlePushId,
  msLedgerKey,
  prepDueFor,
} from './calendarstate'
export type { CalendarState, GooglePushState, MirrorSpec } from './calendarstate'

export interface CalendarFeedInfo {
  configured: boolean
  enabled: boolean
  url: string | null
  inboundUrl?: string | null
  missing: string[]
}

export function inboundAction(action: 'inbound-enable' | 'inbound-rotate' | 'inbound-disable'): Promise<{ inboundUrl: string | null }> {
  // the zone rides along so an emailed "Thursday 3pm" is read where you are
  return apiFetch('/api/feed.ics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, timezone: deviceTimeZone() }) }).then(json<{ inboundUrl: string | null }>)
}

/** A refused call, with the status and — for a sign-in the provider no longer takes — `reason: 'reauth'`. */
export type ActionError = Error & { status?: number; reason?: string }

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { error?: string; reason?: string }) | null
  if (!res.ok || !body) throw Object.assign(new Error(body?.error ?? `HTTP ${res.status}`), { status: res.status, reason: body?.reason }) as ActionError
  return body
}

/** Whether a failure is an account whose sign-in the provider refuses for good: retrying cannot mend it, signing in again can. */
export const needsSignIn = (e: unknown): boolean => (e as ActionError | null)?.reason === 'reauth'

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
  /** Connected once, until Google refused the sign-in: it needs signing in again. */
  needsSignIn?: boolean
  missing: string[]
  redirectUri: string
}

export interface GoogleCalendarInfo {
  id: string
  name: string
  color?: string
  primary: boolean
  writable: boolean
  /** Drafter's own mirror calendar: what it holds is already on the grid, so it is no overlay. */
  drafter?: boolean
}

export function googleAction<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  return apiFetch('/api/google', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...payload }), timeoutMs: 60_000 }).then(json<T>)
}

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
    const r = await googleAction<{ result: string; replaced?: boolean }>('push-event', { event: entry, revive: opts.revive === true })
    singles.set(key, mirrorStamp(entry.updatedAt))
    if (r.replaced) recreatedBy.add(GOOGLE_LOCK)
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
    const r = await microsoftAction<{ result: string; replaced?: boolean }>('push-event', { event: entry, accountId })
    singles.set(key, mirrorStamp(entry.updatedAt))
    if (r.replaced) recreatedBy.add(msLock(accountId))
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

/**
 * The device's IANA zone, sent with every mirror push and with each email-in
 * address action (triage reads an emailed "Thursday 3pm" in it). The server decides
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
    // the old mirror pushed them at or after the cursor's own time, so that
    // time stands in for when each was confirmed
    const at = Math.max(0, Math.floor((Date.parse(legacyCursor) || 0) / 1000)).toString(36)
    for (const i of items) if (i.kind === 'task' && isMineTask(i, myId) && i.updatedAt <= legacyCursor) seen[i.id] = `${mirrorStamp(i.updatedAt)}.${at}`
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
  errors?: { id: string; error: string; status?: number; reason?: string }[]
  left?: string[]
  fatal?: boolean
  calendarId?: string
  /** The stored Drafter calendar had gone, so the server found or made another. */
  replaced?: boolean
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
  /** The account's sign-in is gone for good (the provider refused its grant): `fatal` says so, and retrying cannot mend it. */
  signIn?: boolean
  /** A chunk came back with nothing done and nothing refused, so the pass stopped rather than spin. */
  stalled: boolean
  /** The provider calendar was not the one the ledger knew, so everything was owed to the new one. */
  replaced: boolean
  /** ...because the server found the old one deleted. */
  recreated: boolean
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
  let recreated = false
  let stalled = false
  let fatal: string | undefined
  let signIn = false
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
      signIn = needsSignIn(e)
      break
    }
    if (!replaced && (reply.replaced || (reply.calendarId && ledger.cal && reply.calendarId !== ledger.cal))) {
      // these confirmations were for a calendar that is gone (deleted, or a
      // reconnect to another account): everything is owed to the new one. What
      // this reply confirmed went into the new calendar, so it counts below.
      ledger = { v: 1, seen: {} }
      replaced = true
      recreated = !!reply.replaced
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
      signIn = reply.errors?.[0]?.reason === 'reauth'
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
    ...(signIn ? { signIn } : {}),
    stalled,
    replaced,
    recreated,
    ready: mirrorCandidates(items, ledger, myId, r => refused(target.lock, r, now())).length,
    waiting: mirrorCandidates(items, ledger, myId).length,
  }
}

/** One provider calendar as the hooks drive it: the sweep, plus how to send and how to pull. */
export interface PassTarget extends MirrorTarget {
  /** 'google', or the Outlook account id: what errors are reported under. */
  id: string
  push(records: Record<string, unknown>[], projects: Record<string, string>): Promise<MirrorBatchReply>
  /** Fetch what moved on the provider side and hand it on; `items` is what this pass swept. */
  pull(items: Item[]): Promise<PullOutcome | void>
}

/** What a pull learned about the provider calendar itself. */
export interface PullOutcome {
  /** The Drafter calendar the provider holds now. */
  calendarId?: string
  /** Records the ledger thought were there that should be written again rather than read as deleted. */
  resend?: string[]
  /** The stored Drafter calendar had gone, so the server found or made another. */
  replaced?: boolean
}

export interface PassResult {
  /** Why each target's pass failed, by target id. */
  accountErrors: Record<string, string>
  waiting: number
  /** Something is sendable right now (a chunk limit or the time budget cut the pass short). */
  more: boolean
  /** Something failed that a retry may mend: retry later, backing off. */
  failed: boolean
  /** Something the owner should hear, by target id: the Drafter calendar was replaced. */
  notices: Record<string, string>
  /**
   * Targets whose account's sign-in the provider refuses for good, by target
   * id, with what to say. No retry mends that, so they are not `failed`: the
   * hooks stop asking until the account is signed in again, and Today says so.
   */
  signIn: Record<string, string>
}

const describeRefusals = (errors: { error: string }[]) =>
  errors.length === 1 ? errors[0].error : `${errors.length} could not be mirrored — ${errors[0].error}`

/** Locks whose push-event found the stored Drafter calendar deleted, so the next pass can say so. */
const recreatedBy = new Set<string>()

/**
 * What Settings says when a target's Drafter calendar is not the one its
 * ledger confirmed into. A deleted calendar used to be recreated empty with
 * nothing said; now everything is written into the new one, and the owner hears why.
 */
function calendarNotice(t: PassTarget, recreated: boolean): string {
  const flagged = recreatedBy.delete(t.lock)
  const where = t.id === 'google' ? 'Google' : 'this Outlook account'
  return recreated || flagged
    ? `The Drafter calendar in ${where} had been deleted, so a new one was made and everything is being written into it again.`
    : `Mirroring now goes to a different Drafter calendar in ${where}, so everything is being written into it again.`
}

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
  const notices: Record<string, string> = {}
  const signIn: Record<string, string> = {}
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
    if (res.replaced) notices[t.id] = calendarNotice(t, res.recreated)
    if (res.signIn && res.fatal) {
      // a dead sign-in is said, not retried: nothing below can reach the account either
      accountErrors[t.id] = signIn[t.id] = res.fatal
      continue
    }
    if (res.fatal || res.errors.length || res.stalled) failed = true
    if (res.fatal) {
      accountErrors[t.id] = res.fatal
      continue
    }
    if (res.errors.length) accountErrors[t.id] = describeRefusals(res.errors)
    if (res.ready > 0) more = true
    if (!opts.pull && res.confirmed === 0) continue
    let out: PullOutcome | void
    try {
      out = await t.pull(items)
    } catch (e) {
      // a dead account shows here even when nothing was owed to it
      if (!accountErrors[t.id]) accountErrors[t.id] = (e as Error).message
      if (needsSignIn(e)) signIn[t.id] = (e as Error).message
      else failed = true
      continue
    }
    if (!out) continue
    const settled = settlePull(t.key, out)
    if (settled.work) more = true
    if (settled.switched) notices[t.id] = calendarNotice(t, !!out.replaced)
  }
  return { accountErrors, waiting, more, failed, notices, signIn }
}

/**
 * What a pull says about the ledger. A Drafter calendar other than the one the
 * ledger confirmed into (the owner deleted it and it was made again, or a
 * reconnect landed on another account) holds none of it, so everything is
 * owed again. Tasks a scan could not trust as deleted are owed again as well:
 * writing them back is safe, marking them all done is not. `work` when the
 * sweep has something to send again; `switched` when the calendar changed.
 */
function settlePull(key: string, out: PullOutcome): { work: boolean; switched: boolean } {
  const ledger = readLedger(key)
  if (!ledger) return { work: false, switched: false }
  if (out.replaced || (out.calendarId && ledger.cal && out.calendarId !== ledger.cal)) {
    writeLedger(key, { v: 1, cal: out.calendarId ?? ledger.cal, seen: {} })
    return { work: true, switched: true }
  }
  let changed = false
  if (out.calendarId && !ledger.cal) {
    ledger.cal = out.calendarId
    changed = true
  }
  let resend = false
  for (const id of out.resend ?? []) {
    if (!ledger.seen[id]) continue
    delete ledger.seen[id]
    resend = true
  }
  if (changed || resend) writeLedger(key, ledger)
  return { work: resend, switched: false }
}


/** One of my mirrored tasks as Google or Outlook now holds it (googlePullRows / graphTaskChange on the server). */
export interface GoogleChange {
  taskId: string
  deleted: boolean
  start: string | null
  allDay: boolean
  updated: string
  /** Its title as it reads there, Drafter's priority mark included (see titleThere). Absent from a delete, and from an older function. */
  title?: string
  /** Its description there, Drafter's footer taken off. Absent from a delete, and from an older function. */
  notes?: string
  /** The same with only the footer taken off, sent when reading it as HTML changed anything (see notesThere). */
  notesRaw?: string
}

/** One of my entries as a provider now holds it (googleEntryChange / graphEntryChange on the server). */
export interface EntryChange {
  eventId: string
  deleted: boolean
  title: string
  /** ISO instant, or YYYY-MM-DD when allDay. */
  start: string | null
  /** Exclusive end, in the same convention. */
  end: string | null
  allDay: boolean
  /** When the provider last changed it. */
  updated: string
  /** Its notes there, Drafter's footer taken off. Absent from a delete, and from an older function. */
  notes?: string
  /** The same with only the footer taken off, sent when reading it as HTML changed anything (see notesThere). */
  notesRaw?: string
  /** Its place there ('' once emptied). Absent from a delete, and from an older function. */
  location?: string
}

const PULL_CURSOR_KEY = 'drafter:google-pull-cursor'

interface GooglePull {
  changes: GoogleChange[]
  entries?: EntryChange[]
  calendarId?: string
  at: string
}

/** Ask Google what changed in the Drafter calendar since the last pull: task moves and deletes, entry edits. */
async function pullGoogle(): Promise<GooglePull> {
  const since = readCursor(PULL_CURSOR_KEY)
  const r = await googleAction<GooglePull>('pull', { since: since || undefined })
  writeCursor(PULL_CURSOR_KEY, r.at)
  return r
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

/** A mirrored task Google or Outlook deleted, to mark done; Undo puts `prevStatus` back. */
export interface MirrorDone {
  id: string
  prevStatus: TaskStatus
}

/** What a pull's changes do to Drafter's own records (see mirrorChangeWrites). */
export interface MirrorWrites {
  /** Tasks as they should now be saved: moved, renamed or with a rewritten description there. */
  writes: Task[]
  /** Mirrored tasks deleted there, to mark done. */
  done: MirrorDone[]
  /** Entries as they should now be saved: moved, retitled, or with new notes or a new place there. */
  events: CalendarEntry[]
  /** Entries deleted there, to move to the Trash. */
  trashed: string[]
}

/**
 * Notes as a comparison key. Line endings, blank lines, trailing spaces and the
 * `<address>` Outlook writes after a link are nobody's edit — and a pull that
 * read them as one would write the notes back, have them reformatted, and read
 * them as an edit again, on every pull.
 */
const notesKey = (s?: string) => (s ?? '').replace(/<(?:https?|mailto):[^>\s]*>/gi, '').replace(/\s+/g, ' ').trim()

/**
 * The notes a copy came back with, or undefined when they are no edit. The
 * function reads a description two ways once it looks like HTML: as text, and
 * with nothing but the footer taken off (`notesRaw`). Drafter's own plain text
 * comes back exactly as written, so when either reading is what the record
 * holds it is the echo of Drafter's own write — "From: Alice
 * <a.smith@example.com>" is the owner's words, not a tag to strip. Otherwise the
 * text reading is the edit: what Google's own editor saved.
 */
function notesThere(c: { notes?: string; notesRaw?: string }, mine?: string): string | undefined {
  if (typeof c.notes !== 'string') return undefined
  const key = notesKey(mine)
  if (notesKey(c.notes) === key || (typeof c.notesRaw === 'string' && notesKey(c.notesRaw) === key)) return undefined
  return c.notes
}

const PRIORITY_MARK = /^(?:‼|▲) /

/**
 * The title a task's copy came back with, or undefined when it is no rename.
 * Drafter writes ‼ (urgent) or ▲ (high) in front, so the copy's title read with
 * or without a leading mark is the echo, whichever priority wrote it (another
 * device may have changed that since) — and a title of the owner's own that
 * starts with one ("▲ Climb", normal priority) is theirs, not Drafter's mark. A
 * new title loses a mark Drafter would have put there and keeps one of theirs.
 * An emptied title is no rename, and "Untitled task" is only Drafter's placeholder.
 */
function titleThere(t: Task, there?: string): string | undefined {
  const title = there?.trim()
  if (!title) return undefined
  const bare = title.replace(PRIORITY_MARK, '')
  const mine = t.title.trim()
  if (title === mine || bare === mine || (bare === 'Untitled task' && !mine)) return undefined
  const drafterMarks = t.priority === 'urgent' || t.priority === 'high'
  return PRIORITY_MARK.test(mine) && !drafterMarks ? title : bare
}

/** The newest word on each record, when one page (or a page and a scan) carries two. */
function newestWord<C extends { updated: string }>(changes: C[], key: (c: C) => unknown): C[] {
  const latest = new Map<string, C>()
  for (const c of changes) {
    const k = c ? key(c) : undefined
    if (typeof k !== 'string') continue
    const cur = latest.get(k)
    if (!cur || Date.parse(c.updated) > Date.parse(cur.updated)) latest.set(k, c)
  }
  return [...latest.values()]
}

/** A provider's change counts only when it was made after the record's own last edit, here or on any device. */
const newerThan = (updated: string, record: { updatedAt: string }) => Date.parse(updated) > Date.parse(record.updatedAt)

/**
 * The due date a task's copy was moved to, or null when it did not move. An
 * all-day event is an untimed task, so it comes back as local midnight, and one
 * still on the task's own local day is no move at all — Google echoing the push
 * back, or the old pull's made-up 09:00 on a date-only start, must not rewrite
 * the task or say it moved.
 */
function movedDue(t: Task, c: GoogleChange): string | null {
  if (!c.start) return null
  const day = /^\d{4}-\d{2}-\d{2}/.exec(c.start)?.[0] ?? c.start.slice(0, 10)
  const at = Date.parse(c.start)
  const next = c.allDay ? localMidnightIso(day) : Number.isFinite(at) ? new Date(at).toISOString() : null
  if (!next || next === t.dueAt) return null
  // An all-day change is compared by the task's local day against the
  // event's own date, so a 09:00 rewrite is ignored. Never against the UTC
  // date of the new local midnight: east of UTC that is the day before, the
  // task's old day, and a move one day forward was dropped.
  if (c.allDay && t.dueAt && dateKey(t.dueAt) === day) return null
  return next
}

/**
 * What a pull's changes do, to tasks and entries alike: the records changed in
 * Google or Outlook, as they should be saved; the mirrored tasks deleted there,
 * to mark done; and the entries deleted there, to move to the Trash.
 *
 * One rule over all of it: a change counts only when the provider made it
 * after the record's own last edit, so an edit made in Drafter since is never
 * overridden. What comes back is what the owner can change there — a task's due
 * date, title and description; an entry's time, all-day, title, notes and
 * place — read without Drafter's own footer and priority mark, so an echo of
 * Drafter's own write changes nothing and a pull after a push cannot bounce a
 * record back and forth. A field the function did not send (an older one) is
 * no word at all.
 *
 * A task in a calendar is a reminder of it, so deleting the copy marks the task
 * done, as it always has. An entry's copy is the entry itself, so deleting it
 * there puts the entry in the Trash — never further, and Restore brings it back
 * to every calendar.
 *
 * applyMirrorChanges applies these against the records as they are at that
 * moment, with one toast, and an Undo for what it marked done or put in the Trash.
 */
export function mirrorChangeWrites(tasks: Task[], changes: GoogleChange[], events: CalendarEntry[] = [], entries: EntryChange[] = []): MirrorWrites {
  const writes: Task[] = []
  const done: MirrorDone[] = []
  const taskById = new Map(tasks.map(t => [t.id, t]))
  for (const c of newestWord(changes, c => c.taskId)) {
    const t = taskById.get(c.taskId)
    if (!t || !newerThan(c.updated, t)) continue
    if (c.deleted) {
      // A cancelled event for a task that is no longer mirrored is our OWN
      // delete echoing back, not the owner deleting it in the provider: the
      // mirror removes the event the moment a task leaves the open, dated set
      // (wishlist, due date cleared, done, canceled), and the pull then sees
      // that cancellation. Reading it as "deleted in Google, so done" marked a
      // task done seconds after it was moved to Wishlist. Same rule the server
      // uses to decide what to mirror (lib/google.mjs pushTask `wanted`).
      if (isMirroredTask(t)) done.push({ id: t.id, prevStatus: t.status })
      continue
    }
    const patch: Partial<Task> = {}
    const dueAt = movedDue(t, c)
    if (dueAt) patch.dueAt = dueAt
    const title = titleThere(t, c.title)
    if (title !== undefined) patch.title = title
    const notes = notesThere(c, t.description)
    if (notes !== undefined) patch.description = notes
    if (Object.keys(patch).length) writes.push({ ...t, ...patch, updatedAt: newerStamp(t.updatedAt) })
  }

  const edited: CalendarEntry[] = []
  const trashed: string[] = []
  const entryById = new Map(events.map(e => [e.id, e]))
  for (const c of newestWord(entries, c => c.eventId)) {
    const e = entryById.get(c.eventId)
    // a pull never brings a deleted entry back, nor deletes one twice
    if (!e || e.deletedAt || !newerThan(c.updated, e)) continue
    if (c.deleted) {
      trashed.push(e.id)
      continue
    }
    if (!c.start || !c.end) continue
    const sane = c.allDay ? DAY_KEY.test(c.start) && DAY_KEY.test(c.end) && c.end > c.start : Date.parse(c.end) > Date.parse(c.start)
    if (!sane) continue
    // the provider's placeholder for an entry Drafter keeps untitled
    const title = c.title === 'Untitled event' && !e.title ? '' : c.title
    const same = (a: string, b: string) => (c.allDay ? a === b : Date.parse(a) === Date.parse(b))
    const moved = c.allDay !== e.allDay || !same(c.start, e.start) || !same(c.end, e.end)
    const notes = notesThere(c, e.notes)
    const location = typeof c.location === 'string' && c.location.trim() !== (e.location ?? '').trim() ? c.location.trim() : undefined
    if (!moved && title === e.title && notes === undefined && location === undefined) continue
    edited.push({
      ...e,
      title,
      start: c.start,
      end: c.end,
      allDay: c.allDay,
      ...(notes !== undefined ? { notes: notes || undefined } : {}),
      ...(location !== undefined ? { location: location || undefined } : {}),
      updatedAt: newerStamp(e.updatedAt),
    })
  }
  return { writes, done, events: edited, trashed }
}

/** What one pull brought back from a calendar: its task changes and its entry changes. */
export interface MirrorPulled {
  changes?: GoogleChange[]
  entries?: EntryChange[]
}

/** The store as applyMirrorChanges uses it. */
export interface MirrorStore {
  tasks: Task[]
  events: CalendarEntry[]
  upsert(item: Item): void
  /** Truthy when the status actually changed. */
  setStatus(id: string, status: TaskStatus): unknown
  remove(id: string): void
  restore(ids: string[]): void
}

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`

/**
 * Save what a pull from `source` changed — mirrorChangeWrites decides — and say
 * so in one toast. The toast's Undo takes back what took something off the
 * owner's lists: the tasks marked done get their status back, and the entries
 * put in the Trash come out of it, onto every calendar again. Moves and edits
 * need no Undo: each is the owner's own, made in the other calendar.
 */
export function applyMirrorChanges(store: MirrorStore, pulled: MirrorPulled, source: string, toast: (msg: string, undo?: () => void) => void): void {
  const { writes, done, events, trashed } = mirrorChangeWrites(store.tasks, pulled.changes ?? [], store.events, pulled.entries ?? [])
  const before = new Map(store.tasks.map(t => [t.id, t]))
  for (const t of writes) store.upsert(t)
  for (const e of events) store.upsert(e)
  const undone: MirrorDone[] = []
  for (const d of done) if (store.setStatus(d.id, 'done')) undone.push(d)
  for (const id of trashed) store.remove(id)
  // "moved" while every task change is a new due date and nothing else, as the toast always said
  const onlyMoved = writes.every(w => {
    const t = before.get(w.id)
    return !!t && w.title === t.title && w.description === t.description
  })
  const parts = [
    writes.length ? `${count(writes.length, 'task')} ${onlyMoved ? 'moved' : 'updated'}` : '',
    undone.length ? `${count(undone.length, 'task')} marked done` : '',
    events.length ? `${count(events.length, 'event')} updated` : '',
    trashed.length ? `${count(trashed.length, 'event')} moved to Trash` : '',
  ].filter(Boolean)
  if (parts.length === 0) return
  const undo =
    undone.length || trashed.length
      ? () => {
          for (const u of undone) store.setStatus(u.id, u.prevStatus)
          if (trashed.length) store.restore(trashed)
        }
      : undefined
  toast(`${parts.join(', ')} from ${source}`, undo)
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

// ---- the copies' own reminders ----------------------------------------------------
//
// Drafter sends every reminder itself — the iPhone's own, and push — so the
// copies the mirrors write into Google and every Outlook account carry none.
// "Calendar copies remind me too" (Settings → Reminders, off by default) brings
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


// ---- Outlook / Microsoft 365 (OAuth, per user, several accounts) -------------

export interface MicrosoftAccount {
  id: string
  email: string
  name: string
  hasMirror: boolean
  /** Microsoft refused this account's sign-in: it needs signing in again. */
  needsSignIn?: boolean
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
  /** The account's own Drafter calendar: overlaid, every entry showed twice. */
  drafter?: boolean
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

/** The calendar rows that belong to one Outlook account — its overlays and its mirror switch — and no other account's. */
export function outlookSourcesFor(accountId: string, sources: CalendarSource[]): CalendarSource[] {
  return sources.filter(c => c.url.startsWith(`ms:${accountId}:`) || c.url === msPushUrl(accountId))
}

/**
 * Disconnect one Outlook account: the server first, and only once it has
 * forgotten the account are this device's rows for it removed. It used to be
 * the other way round, so a disconnect the server refused (offline, a lapsed
 * session) looked done here while the account stayed connected there. Throws
 * with the server's reason, and then nothing here has changed.
 */
export async function disconnectOutlook(
  accountId: string,
  sources: CalendarSource[],
  remove: (id: string) => void,
  action: (name: string, payload: Record<string, unknown>) => Promise<unknown> = microsoftAction,
): Promise<void> {
  await action('disconnect', { accountId })
  for (const c of outlookSourcesFor(accountId, sources)) remove(c.id)
  resetMicrosoftPushCursor(accountId)
}

const MS_PUSH_CURSOR = 'drafter:ms-push-cursor'
const MS_PULL_CURSOR = 'drafter:ms-pull-cursor'

/** Forget what one Outlook account has confirmed, so the next sweep sends everything again. */
export function resetMicrosoftPushCursor(accountId: string): void {
  writeCursor(`${MS_PUSH_CURSOR}:${accountId}`, '')
  resetMirrorLedger(msLedgerKey(accountId))
}

/** When the ledger confirmed this exact version (ms), or null when it has not. */
function confirmedAt(ledger: MirrorLedger, r: { id: string; updatedAt: string }): number | null {
  const seen = ledger.seen[r.id]
  if (!seen) return null
  const [stamp, at36] = seen.split('.')
  if (stamp !== mirrorStamp(r.updatedAt)) return null
  const sec = parseInt(at36 ?? '', 36)
  return Number.isFinite(sec) ? sec * 1000 : 0
}

/**
 * The tasks this device put into an Outlook calendar and has not touched since:
 * mine, open and dated, confirmed in their current version at least ten
 * minutes ago (a copy written a moment ago may not be listed yet). Only these
 * can be judged deleted in Outlook when the calendar no longer holds them.
 */
export function believedLive(items: Item[], ledger: MirrorLedger, myId: string | null | undefined, now: number, marginMs = 10 * 60_000): string[] {
  const out: string[] = []
  for (const i of items) {
    if (i.kind !== 'task' || !isMineTask(i, myId) || !isMirroredTask(i)) continue
    const at = confirmedAt(ledger, i)
    if (at === null || now - at < marginMs) continue
    out.push(i.id)
    if (out.length >= 2000) break
  }
  return out
}

/**
 * Tasks missing from Outlook, as the change Planner already applies for a
 * Google delete (mark done, with Undo). Stamped a second after this device
 * confirmed the task — the one thing known about when the delete happened — so
 * an edit made anywhere after that still wins over it.
 */
export function outlookDeletions(ledger: MirrorLedger, missing: string[]): GoogleChange[] {
  return missing.flatMap(taskId => {
    const sec = parseInt(ledger.seen[taskId]?.split('.')[1] ?? '', 36)
    if (!Number.isFinite(sec)) return []
    return [{ taskId, deleted: true, start: null, allDay: false, updated: new Date((sec + 1) * 1000).toISOString() }]
  })
}

/**
 * The entries this device put into an Outlook calendar and has not touched
 * since, judged as believedLive judges tasks: mine, not deleted, confirmed in
 * their current version at least ten minutes ago. Graph hard-deletes an
 * entry's copy too, so only these can be judged deleted when it is gone.
 */
export function believedLiveEntries(items: Item[], ledger: MirrorLedger, myId: string | null | undefined, now: number, marginMs = 10 * 60_000): string[] {
  const out: string[] = []
  for (const i of items) {
    if (i.kind !== 'event' || i.deletedAt || !isMirrorRecord(i, myId)) continue
    const at = confirmedAt(ledger, i)
    if (at === null || now - at < marginMs) continue
    out.push(i.id)
    if (out.length >= 2000) break
  }
  return out
}

/** Entries missing from Outlook, as the delete a Google pull reports for one, stamped as outlookDeletions stamps a task's. */
export function outlookEntryDeletions(ledger: MirrorLedger, missing: string[]): EntryChange[] {
  return missing.flatMap(eventId => {
    const sec = parseInt(ledger.seen[eventId]?.split('.')[1] ?? '', 36)
    if (!Number.isFinite(sec)) return []
    return [{ eventId, deleted: true, title: '', start: null, end: null, allDay: false, updated: new Date((sec + 1) * 1000).toISOString() }]
  })
}

/** How often a pull also checks which mirrored tasks an Outlook calendar still holds. */
const MS_SCAN_EVERY_MS = 15 * 60_000
const MS_SCAN_AT = 'drafter:ms-scan-at'

interface MicrosoftPull {
  changes?: GoogleChange[]
  entries?: EntryChange[]
  /** Tasks believed there that the calendar no longer holds. */
  missing?: string[]
  /** Entries believed there that the calendar no longer holds. */
  missingEntries?: string[]
  resend?: string[]
  calendarId?: string
  at: string
}

/**
 * The provider calendar a mirror hook names (calendarstate.ts), as the sweep
 * drives it: how to send to it and how to pull from it. `onPulled` is read at
 * pull time, so what came back goes to the latest render's handler (apply it
 * with applyMirrorChanges).
 *
 * Google: whatever the ledger says Google has not confirmed goes out, then
 * what changed in Google comes back. Server-side every write is idempotent
 * (upsert by record id; remove a task that is no longer open and dated, or a
 * deleted entry). Only my rows go, so a partner's chores stay out of my calendar.
 *
 * Outlook: the same sweep into the "Drafter" calendar of each account that has
 * mirroring on, one account after another and each on its own, so a dead
 * account cannot stop the rest and reports under its own id.
 */
export function passTarget(spec: MirrorSpec, myId: string | null | undefined, onPulled: () => ((pulled: MirrorPulled) => void) | undefined): PassTarget {
  if (spec.provider === 'google') {
    return {
      id: 'google',
      key: spec.key,
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
        const apply = onPulled()
        if (!apply) return
        const r = await pullGoogle()
        if (r.changes.length || r.entries?.length) apply({ changes: r.changes, entries: r.entries ?? [] })
        return { calendarId: r.calendarId }
      },
    }
  }
  const { accountId } = spec
  return {
    id: accountId,
    key: spec.key,
    lock: msLock(accountId),
    legacyCursor: () => readCursor(`${MS_PUSH_CURSOR}:${accountId}`),
    push: (records, projectNames) => microsoftAction<MirrorBatchReply>('push', { accountId, records, projects: projectNames, timezone: deviceTimeZone() }),
    pull: async current => {
      const apply = onPulled()
      if (!apply) return
      const pullKey = `${MS_PULL_CURSOR}:${accountId}`
      const scanKey = `${MS_SCAN_AT}:${accountId}`
      const ledger = readLedger(msLedgerKey(accountId))
      const now = Date.now()
      // Graph hard-deletes, so a task or an entry deleted in Outlook is
      // never a change; now and then, name the ones we believe are there
      // and hear back which are not
      const scan = !!ledger?.cal && now - (Number(readCursor(scanKey)) || 0) > MS_SCAN_EVERY_MS
      const live = scan && ledger ? believedLive(current, ledger, myId, now) : []
      const liveEntries = scan && ledger ? believedLiveEntries(current, ledger, myId, now) : []
      const r = await microsoftAction<MicrosoftPull>('pull', {
        accountId,
        since: readCursor(pullKey) || undefined,
        entries: true,
        live: live.length ? live : undefined,
        liveEntries: liveEntries.length ? liveEntries : undefined,
        calendarId: ledger?.cal,
      })
      writeCursor(pullKey, r.at)
      if (scan) writeCursor(scanKey, String(now))
      const changes = [...(r.changes ?? []), ...(ledger ? outlookDeletions(ledger, r.missing ?? []) : [])]
      const entries = [...(r.entries ?? []), ...(ledger ? outlookEntryDeletions(ledger, r.missingEntries ?? []) : [])]
      if (changes.length || entries.length) apply({ changes, entries })
      return { calendarId: r.calendarId, resend: r.resend }
    },
  }
}

// ---- connecting an account -----------------------------------------------------
//
// On the web the consent screen replaces the page and the callback finishes
// the job, bound to this browser by a short-lived cookie. The iOS app's web
// view cannot share cookies with the Safari sheet consent runs in, so it used
// to hand Safari a one-time link that minted the cookie there — and whoever
// opened that link inside its two minutes could attach THEIR calendar to this
// account. Now the app keeps a random verifier in memory and sends only its
// challenge; the callback hands the code back to the app instead of finishing;
// and the server finishes only for this signed-in account presenting that
// verifier. The code reaches the device consent happened on, so a link opened
// by anyone else leads nowhere.

export type CalendarProvider = 'google' | 'microsoft'

export interface OAuthSettled {
  provider: CalendarProvider
  ok: boolean
  error?: string
}

export interface OAuthReturn {
  provider: CalendarProvider
  code?: string
  state?: string
  error?: string
}

const OAUTH_PENDING_MS = 10 * 60_000
let pendingOAuth: { provider: CalendarProvider; verifier: string; at: number } | null = null
let completingOAuth: CalendarProvider | null = null
const oauthWatchers = new Set<(r: OAuthSettled) => void>()
let oauthReturnArmed: Promise<unknown> | null = null

const providerAction = (p: CalendarProvider): (<T>(action: string, payload?: Record<string, unknown>) => Promise<T>) => (p === 'google' ? googleAction : microsoftAction)

function base64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 256 random bits, base64url: the app's half of the handoff. Held in memory only, never stored or sent. */
export function newOAuthVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

/** base64url(SHA-256(verifier)), RFC 7636's S256 — what the server's challengeFor computes. */
export async function oauthChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
}

/** What Safari hands back to the app: drafter://oauth?google=connected&code=…&state=…, or a refusal. */
export function parseOAuthReturn(url: string): OAuthReturn | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'drafter:' || u.hostname !== 'oauth') return null
  const provider: CalendarProvider | null = u.searchParams.has('microsoft') ? 'microsoft' : u.searchParams.has('google') ? 'google' : null
  if (!provider) return null
  if (u.searchParams.get(provider) !== 'connected') return { provider, error: u.searchParams.get('reason') ?? 'unknown' }
  return { provider, code: u.searchParams.get('code') ?? undefined, state: u.searchParams.get('state') ?? undefined }
}

/** Hear when a sign-in the app started has finished or failed; Settings refreshes on it. Returns a disposer. */
export function onOAuthSettled(cb: (r: OAuthSettled) => void): () => void {
  oauthWatchers.add(cb)
  return () => {
    oauthWatchers.delete(cb)
  }
}

/** The provider whose sign-in the app is finishing at this moment, if any. */
export function oauthCompleting(): CalendarProvider | null {
  return completingOAuth
}

/** Begin the app's half of a handoff: a fresh verifier kept in memory, and the challenge to send for it. */
export async function beginNativeOAuth(provider: CalendarProvider, now = Date.now()): Promise<{ challenge: string }> {
  const verifier = newOAuthVerifier()
  pendingOAuth = { provider, verifier, at: now }
  return { challenge: await oauthChallenge(verifier) }
}

/**
 * Finish a sign-in this app started, from the URL Safari handed back. Nothing
 * happens for a return this app did not start a flow for (a link opened on
 * another device), for the other provider, or once its verifier is stale; and
 * a verifier is used once. `action` is the server call, stubbed in tests.
 */
export async function finishOAuthReturn(
  url: string,
  action: (provider: CalendarProvider, name: string, payload: Record<string, unknown>) => Promise<unknown> = (p, name, payload) => providerAction(p)(name, payload),
  now = Date.now(),
): Promise<OAuthSettled | null> {
  const ret = parseOAuthReturn(url)
  const pending = pendingOAuth
  if (!ret || !pending || pending.provider !== ret.provider) return null
  pendingOAuth = null
  if (now - pending.at > OAUTH_PENDING_MS) return null
  const who = ret.provider === 'google' ? 'Google Calendar' : 'Outlook'
  let settled: OAuthSettled
  if (ret.error || !ret.code || !ret.state) {
    settled = { provider: ret.provider, ok: false, error: `${who} could not be connected (${oauthReasonLabel(ret.error ?? 'missing_code')}).` }
  } else {
    completingOAuth = ret.provider
    try {
      await action(ret.provider, 'complete', { code: ret.code, state: ret.state, verifier: pending.verifier })
      settled = { provider: ret.provider, ok: true }
    } catch (e) {
      settled = { provider: ret.provider, ok: false, error: (e as Error).message }
    } finally {
      completingOAuth = null
    }
  }
  for (const cb of [...oauthWatchers]) cb(settled)
  return settled
}

/**
 * Start connecting Google or an Outlook account. The web navigates to the
 * consent screen ('redirect'); the app opens Safari's sheet ('native') and
 * finishes the flow itself when Safari hands the code back.
 */
export async function connectCalendarAccount(provider: CalendarProvider): Promise<'native' | 'redirect'> {
  const action = providerAction(provider)
  if (!isNative()) {
    const { url } = await action<{ url: string }>('auth')
    return startOAuth(url)
  }
  if (!oauthReturnArmed) {
    oauthReturnArmed = onOAuthReturn(url => void finishOAuthReturn(url)).catch(() => {
      oauthReturnArmed = null
    })
  }
  await oauthReturnArmed
  const { challenge } = await beginNativeOAuth(provider)
  const { url } = await action<{ url: string }>('auth', { native: true, challenge })
  return startOAuth(url)
}
