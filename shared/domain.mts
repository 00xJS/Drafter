// Domain rules shared by the web app (src/) and the MCP server (mcp/).
// Dependency-free ESM so the MCP server stays zero-install.

import type { Platform, Priority, ProjectStatus, RecurrenceFreq, Task, TaskStatus } from '../src/types.ts'

export const PLATFORMS: Platform[] = ['x', 'instagram', 'threads', 'linkedin', 'facebook', 'tiktok', 'youtube']

export const TASK_STATUSES: TaskStatus[] = ['wishlist', 'todo', 'doing', 'blocked', 'done', 'canceled']
export const PROJECT_STATUSES: ProjectStatus[] = ['active', 'paused', 'done', 'archived']
export const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent']
export const RECURRENCE_FREQS: RecurrenceFreq[] = ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']

/** The project every migrated social post lands in (deterministic so all devices agree). */
export const SOCIAL_PROJECT_ID = 'project-social'

/**
 * A stamp guaranteed strictly newer than the previous one, so an edit always
 * wins the strictly-newer-wins merge against the copy it was based on — even
 * against clock skew or a bot that wrote a slightly-future timestamp.
 */
export function newerStamp(prevIso?: string): string {
  const prev = prevIso ? Date.parse(prevIso) : 0
  return new Date(Math.max(Date.now(), (Number.isFinite(prev) ? prev : 0) + 1)).toISOString()
}

const LEGACY_STATUS: Record<string, TaskStatus> = { idea: 'wishlist', draft: 'todo', scheduled: 'todo', posted: 'done', canceled: 'canceled' }

/** An object whose fields can be read one by one: a stored row's data, before anything in it is trusted. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object'
}

/** True for records written before v3 (social posts without a `kind`). */
export function isLegacyPost(raw: unknown): boolean {
  return isRecord(raw) && raw.kind === undefined
}

const isPlatform = (p: unknown): p is Platform => (PLATFORMS as readonly unknown[]).includes(p)

/**
 * Convert a pre-v3 post into a task. Pure and idempotent on already-converted
 * input (returns it untouched), so every reader can call it defensively.
 * Rows in the database are never rewritten just for shape: the conversion
 * runs on read, in the app and in the MCP server alike. Callers pass a stored
 * row's `data`; a post comes back as a task's fields, unchecked like the
 * post's were.
 */
export function legacyPostToTask<T>(raw: T): T | Record<string, unknown> {
  if (!isRecord(raw) || !isLegacyPost(raw)) return raw
  const platforms = Array.isArray(raw.platforms) ? raw.platforms.filter(isPlatform) : []
  const social = platforms.length > 0 || raw.metrics || raw.variants
  const task: Record<string, unknown> = {
    kind: 'task',
    id: raw.id,
    ownerId: raw.ownerId,
    title: raw.title ?? '',
    description: raw.body ?? '',
    status: LEGACY_STATUS[String(raw.status)] ?? (raw.postedAt ? 'done' : 'todo'),
    priority: 'normal',
    projectId: social ? SOCIAL_PROJECT_ID : raw.projectId,
    dueAt: raw.scheduledFor,
    completedAt: raw.postedAt,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    deletedAt: raw.deletedAt,
    tags: raw.tags ?? [],
    notes: raw.notes,
    link: raw.link,
    mediaIds: raw.mediaIds,
    recurrence: raw.recurrence,
  }
  if (social) task.social = { platforms, variants: raw.variants, metrics: raw.metrics }
  return task
}

/**
 * Wall-clock date (YYYY-MM-DD) of an instant in `tz` (IANA). Falls back to the
 * runtime's local zone when tz is missing/invalid.
 */
export function localDate(iso: string | number | null | undefined, tz?: string | null): string | null {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso ?? '')
  if (!Number.isFinite(ms)) return null
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date(ms))
        .map(p => [p.type, p.value]),
    )
    if (parts.year && parts.month && parts.day) return `${parts.year}-${parts.month}-${parts.day}`
  } catch {
    /* bad tz — fall through */
  }
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * True when the instant is "date only" in `tz`: local midnight (no meaningful
 * wall-clock time). Used so untimed tasks mirror as all-day events.
 */
export function isUntimed(iso: string, tz?: string | null): boolean {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return false
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz || undefined,
        hourCycle: 'h23',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
        .formatToParts(new Date(ms))
        .map(p => [p.type, p.value]),
    )
    return Number(parts.hour) === 0 && Number(parts.minute) === 0 && Number(parts.second || 0) === 0
  } catch {
    const d = new Date(ms)
    return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0
  }
}

/** Local-midnight ISO for a YYYY-MM-DD calendar day in the runtime's local zone. */
export function localMidnightIso(dateKey: string): string | null {
  const m = String(dateKey ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).toISOString()
}

/** Every `~freq~day` an occurrence's id has had put on it; none on the task its series started from. */
const SPAWN_TAIL = new RegExp(`(?:~(?:${RECURRENCE_FREQS.join('|')})~\\d{4}-\\d{2}-\\d{2})+$`)

/**
 * The id a repeating task's series goes by: the task it started from, every
 * `~freq~day` taken off. An occurrence under the short id and one whose id
 * grew under the old rule read back to the same root.
 */
export function seriesRoot(id: string): string {
  const tail = typeof id === 'string' ? SPAWN_TAIL.exec(id) : null
  return tail ? id.slice(0, tail.index) : id
}

/** The latest day anywhere in an occurrence's id — the furthest its series had got when it was written — or null for a series' first task. */
function furthestDay(id: string): string | null {
  const tail = SPAWN_TAIL.exec(id)
  if (!tail) return null
  let furthest = ''
  for (const [day] of tail[0].matchAll(/\d{4}-\d{2}-\d{2}/g)) if (day > furthest) furthest = day
  return furthest
}

/**
 * Deterministic id for the next occurrence of a repeating task: the series'
 * root and ONE `~freq~day`, so two devices that tick the same chore off on the
 * same day write one id, and the id is as long on the thousandth time round as
 * on the first.
 *
 * It used to append to the id of the occurrence just done, every completion
 * adding some 17 characters: a daily chore's id passes a kilobyte in two
 * months. An id grown that way is never rewritten; its next occurrence simply
 * takes the short form.
 *
 * The short form names a day, not an occurrence, and a chore ticked off early
 * enough comes round on a day its series has already had (tomorrow's, done
 * today, is due tomorrow again). So it is used only for a day later than any
 * the occurrence's own id names; otherwise the occurrence just done lends its
 * id and the segment goes on the end, as it always did — an id no other
 * occurrence can have. Each id therefore still names the furthest day its
 * series had reached, and a series ticked off on one device never gives two
 * of its occurrences the same short id.
 */
export function spawnId(taskId: string, freq: string, nextDueIso: string): string {
  const day = (nextDueIso ?? '').slice(0, 10)
  const furthest = furthestDay(taskId)
  return furthest === null || day > furthest ? `${seriesRoot(taskId)}~${freq}~${day}` : `${taskId}~${freq}~${day}`
}

/** What nextOccurrence needs to know of a record already holding an id it might use. */
export interface HeldRecord {
  updatedAt?: string
  deletedAt?: string
  purged?: boolean
}

/**
 * The weekly balance check-in's ids begin with this (Finance's "Check in
 * weekly", src/finance.ts). It is a task, so it is on Home, the calendar and
 * the reminders like any other; what sets it apart is that it keeps its slot
 * (nextOccurrence) and that the app opens it on the Check in sheet.
 */
export const CHECK_IN_PREFIX = 'task~checkin~'

/** How many months apart the repeats that go by the month fall. */
const MONTH_STEPS: Partial<Record<RecurrenceFreq, number>> = { monthly: 1, quarterly: 3, yearly: 12 }

/** Whole months later in local time, on `day` clamped to that month's length. */
function addMonthsOnDay(date: Date, months: number, day: number): Date {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1, date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds())
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  target.setDate(Math.min(day, last))
  return target
}

/**
 * The next occurrence of a recurring task, cloned from the one just completed.
 *
 * `held`, where the caller has the records, says what already holds an id. The
 * id spawnId gives is then used only if nothing does, or a tombstone does: a
 * chore ticked off, undone and ticked off again spawns the id its first tick
 * did, and the new occurrence replaces that one's tombstone, stamped newer so
 * it wins the merge. A live record keeps its id, and the occurrence just done
 * lends its own instead, one segment longer each time it has to. The caller
 * puts the occurrence in place of the record holding its id, never beside it.
 */
export function nextOccurrence(task: Task, uidFn: () => string, held?: (id: string) => HeldRecord | undefined): (Task & { spawnedFrom: string }) | null {
  if (!task.recurrence) return null
  const bill = task.bill && typeof task.bill === 'object' ? task.bill : null
  // the weekly balance check-in keeps its slot, as a bill keeps its day
  const slot = typeof task.id === 'string' && task.id.startsWith(CHECK_IN_PREFIX)
  // A bill falls due on its own day however early or late it was paid; a chore
  // comes round again from when it was last done. Anchoring a bill on its
  // completion made it drift: due on the 15th, paid on the 12th, and the next
  // one was due on the 12th.
  const baseIso = bill || slot ? (task.dueAt ?? task.completedAt) : (task.completedAt ?? task.dueAt)
  const base = baseIso ? new Date(baseIso) : new Date()
  if (isNaN(base.getTime())) return null
  const freq = task.recurrence.freq
  let billDay: number | undefined
  const advance = (from: Date): Date => {
    const at = new Date(from)
    if (freq === 'daily') at.setDate(at.getDate() + 1)
    else if (freq === 'weekly') at.setDate(at.getDate() + 7)
    else if (freq === 'biweekly') at.setDate(at.getDate() + 14)
    else {
      // Monthly, quarterly and yearly land on a clamped day: setMonth used to roll
      // 31 January into 3 March. A bill also remembers its intended day, so one due
      // on the 31st goes 31 Jan -> 28 Feb -> 31 Mar instead of settling on the 28th;
      // if the owner has moved the date since, the new day wins.
      const baseDay = at.getDate()
      const monthLen = new Date(at.getFullYear(), at.getMonth() + 1, 0).getDate()
      const stored = bill && Number.isInteger(bill.day) ? bill.day : undefined
      const day = stored !== undefined && Math.min(stored, monthLen) === baseDay ? stored : baseDay
      if (bill) billDay = day
      return addMonthsOnDay(at, MONTH_STEPS[freq] ?? 1, day)
    }
    return at
  }
  let next = advance(base)
  // …and one done late, or missed for weeks, is next due on the first slot
  // still ahead of when it was done: a bill owes every month it missed, and
  // a reminder to type in balances does not
  const done = slot ? Date.parse(task.completedAt ?? '') : NaN
  for (let i = 0; i < 520 && Number.isFinite(done) && next.getTime() <= done; i++) next = advance(next)
  const now = new Date().toISOString()
  const dueAt = next.toISOString()
  // uidFn kept for call-site compatibility; id is deterministic so two devices agree
  void uidFn
  const step = `~${freq}~${dueAt.slice(0, 10)}`
  let id = spawnId(task.id, freq, dueAt)
  let replaces: HeldRecord | undefined
  for (let cur = held?.(id); cur; cur = held?.(id)) {
    if (cur.deletedAt && !cur.purged) {
      replaces = cur
      break
    }
    // a live record's: the occurrence just done lends its own id, a segment longer each time it has to
    id = id.length < task.id.length + step.length ? task.id + step : id + step
  }
  const spawn: Task & { spawnedFrom: string } = {
    kind: 'task',
    id,
    title: task.title,
    description: task.description,
    status: 'todo',
    priority: task.priority ?? 'normal',
    projectId: task.projectId,
    createdAt: now,
    updatedAt: replaces ? newerStamp(replaces.updatedAt) : now,
    dueAt,
    tags: [...(task.tags ?? [])],
    notes: task.notes,
    // carry the context forward, or a recurring "Sunday lunch with Mum" records
    // exactly one visit ever and her last-seen date freezes on the first one
    peopleIds: task.peopleIds ? [...task.peopleIds] : undefined,
    placeId: task.placeId,
    link: task.link,
    githubUrl: task.githubUrl,
    estimateCost: task.estimateCost,
    bill: bill ? { ...bill, ...(billDay !== undefined ? { day: billDay } : {}) } : undefined,
    checklist: task.checklist ? task.checklist.map(c => ({ ...c, done: false })) : undefined,
    social: task.social
      ? { platforms: [...task.social.platforms], variants: task.social.variants ? { ...task.social.variants } : undefined }
      : undefined,
    recurrence: { ...task.recurrence },
    // and carry who it is for, for the same reason the context above is
    // carried: a private chore that comes round again is still private
    // (v3.19), and this object is built field by field, so anything left off
    // it defaults to the household's. The spawn is a NEW row, so the flag has
    // to be on it — posts_private_flag only guards an existing one.
    shared: task.shared,
    spawnedFrom: task.id,
  }
  return spawn
}

/** What duplicateSpawnPairs reads of a record: its kind, id and whether it is an open, repeating task. */
export interface SpawnCandidate {
  kind?: string
  id: string
  status?: string
  recurrence?: unknown
  deletedAt?: string
  purged?: boolean
}

/**
 * Next occurrences that repeat one another: open copies spawned from the same
 * repeating chore. Ticked off on the same day on two devices, a chore spawns
 * the same id on both and they merge as one; ticked off on two devices on
 * DIFFERENT days before they sync, it spawns two ids, and both came back. Only
 * one may stay open. The one kept is the one due latest — a chore comes round
 * again from when it was last done — and the rule reads nothing but each row's
 * id, which never changes, so every device that sees both keeps the same one
 * whatever else it has not heard yet.
 *
 * A series is read from the ids themselves (`spawnedFrom` is gone from any row
 * an older build has edited: it dropped the fields it did not list), so an
 * occurrence of an occurrence counts too. Only an open copy that
 * still repeats is a candidate: a finished occurrence reopened by hand has no
 * repeat of its own, and neither has a copy restored from the Trash after this
 * put it there. Returns each id that should go to the Trash, with `keptId`, the
 * occurrence kept in its place.
 */
export function duplicateSpawnPairs(items: readonly SpawnCandidate[]): { id: string; keptId: string }[] {
  const series = new Map<string, { id: string; day: string }[]>()
  const rows: readonly SpawnCandidate[] = Array.isArray(items) ? items : []
  for (const i of rows) {
    if (!i || i.kind !== 'task' || i.deletedAt || i.purged || !i.recurrence || i.status === 'done' || i.status === 'canceled') continue
    // the series' first task is not a next occurrence; every other reads back to its root, short id or grown
    const root = seriesRoot(i.id)
    if (root === i.id) continue
    const list = series.get(root) ?? []
    list.push({ id: i.id, day: i.id.slice(-10) })
    series.set(root, list)
  }
  const out: { id: string; keptId: string }[] = []
  for (const list of series.values()) {
    if (list.length < 2) continue
    list.sort((a, b) => (a.day === b.day ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.day < b.day ? -1 : 1))
    const keptId = list[list.length - 1].id
    for (const s of list.slice(0, -1)) out.push({ id: s.id, keptId })
  }
  return out
}

/** The ids alone of the next occurrences that repeat one another (duplicateSpawnPairs): the ones that should go to the Trash. */
export function duplicateSpawns(items: readonly SpawnCandidate[]): string[] {
  return duplicateSpawnPairs(items).map(p => p.id)
}

/**
 * Tasks that belong on *my* calendar mirror / ICS feed. Household peers' chores
 * must not land in the owner's Google/Outlook. Unowned rows (local-only /
 * pre-household) count as mine. Assignees win when set.
 */
export function isMineTask(task: { kind?: string; ownerId?: string; assigneeId?: string } | null | undefined, myId?: string | null): boolean {
  if (!task || task.kind !== 'task') return false
  if (!myId) return true
  if (task.assigneeId) return task.assigneeId === myId
  if (task.ownerId) return task.ownerId === myId
  return true
}
