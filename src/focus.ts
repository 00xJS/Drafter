import { CalendarEntry, CalendarEvent, OPEN_STATUSES, Project, Review, Task } from './types'
import { shiftDayKey } from './journal'
import { nextUp, shiftRange, weekRange } from './review'
import { compareTasks, hasDueTime } from './taskutils'
import { clock, dateKey } from './utils'
import { localMidnightIso, newerStamp } from '../shared/domain.mjs'
import { isFocusFor } from '../shared/today.mjs'

// Today's focus, Plan my day and Shut down: the rules behind the sheets, kept
// pure so the sheets only render them. Nothing here saves anything — each plan
// comes back as the records to write, the moves that must go through the
// store's setStatus, and the copies Undo puts back. The planner does the saving.

/**
 * Task and CalendarEntry carry focusOn / focusBy and taskId themselves (B1), and
 * src/schema.ts keeps them through every sync. These names stay as plain
 * aliases so the sheets and tests can say which role a record plays.
 */
export type FocusTask = Task
export type BlockEntry = CalendarEntry

export const MAX_FOCUS = 3

const DAY_MS = 86_400_000
const MINUTE_MS = 60_000
/** How far back an unfinished focus is "carried over" rather than history. */
const CARRY_DAYS = 7
/** A gap shorter than this is not worth offering as time for a task. */
const MIN_SLOT_MIN = 15

const daysBetween = (fromKey: string, toKey: string) => Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / DAY_MS)

// ---- step 2: what to focus on ------------------------------------------------

export type FocusGroup = 'carried' | 'dueToday' | 'weekTop' | 'nextUp'

export interface FocusCandidate {
  group: FocusGroup
  task: Task
  reason: string
}

/** The week's Top 3 lines not yet ticked, found exactly where Today's "This week's 3" finds them. */
function weekTopTitles(reviews: Review[], now: Date): string[] {
  const thisWeek = weekRange(now)
  const prevKey = shiftRange(thisWeek, -1).key
  const weeks = reviews.filter(r => r.period === 'week' && !r.deletedAt)
  // written during last week's review as "for next week"
  const review = weeks.find(r => r.key === prevKey) ?? weeks.find(r => r.key === thisWeek.key)
  const top = (review?.top ?? []).map(t => t.trim()).filter(Boolean).slice(0, 3)
  return top.filter((_, i) => !review?.topDone?.[i])
}

/**
 * What Plan my day offers to focus on, grouped and in this order: focus carried
 * over from the last few days and never finished, what is due today (with
 * anything step 1 just moved to today, whose stored date has not changed yet),
 * the week's Top 3, and the top six of Next up with their reasons. Each task
 * appears once, in the first group that has it.
 */
export function focusCandidates(i: {
  tasks: Task[]
  projects: Project[]
  reviews: Review[]
  today: string
  now: Date
  myId: string | null
  movedToday?: ReadonlySet<string>
}): FocusCandidate[] {
  const live = (i.tasks as FocusTask[]).filter(t => !t.deletedAt)
  const open = live.filter(t => OPEN_STATUSES.includes(t.status))
  const out: FocusCandidate[] = []
  const seen = new Set<string>()
  const add = (group: FocusGroup, task: Task, reason: string) => {
    if (seen.has(task.id)) return
    seen.add(task.id)
    out.push({ group, task, reason })
  }

  const since = shiftDayKey(i.today, -CARRY_DAYS)
  open
    .filter(t => !!t.focusOn && t.focusOn < i.today && t.focusOn >= since && isFocusFor(t, t.focusOn, i.myId))
    .sort((a, b) => (b.focusOn ?? '').localeCompare(a.focusOn ?? '') || compareTasks(a, b))
    .forEach(t => {
      const ago = daysBetween(t.focusOn!, i.today)
      add('carried', t, ago === 1 ? 'from yesterday' : `from ${ago} days ago`)
    })

  const dueDay = (t: Task) => (t.dueAt ? dateKey(t.dueAt) : undefined)
  open
    .filter(t => dueDay(t) === i.today || i.movedToday?.has(t.id))
    .sort(compareTasks)
    .forEach(t => add('dueToday', t, dueDay(t) !== i.today ? 'moved to today' : hasDueTime(t.dueAt!) ? `due ${clock(t.dueAt!)}` : 'due today'))

  for (const title of weekTopTitles(i.reviews, i.now)) {
    const t = open.find(x => (x.title || '').trim().toLowerCase() === title.toLowerCase())
    if (t) add('weekTop', t, "this week's 3")
  }

  for (const n of nextUp(live, i.projects, 6, i.now, [], seen)) add('nextUp', n.task, n.reason)
  return out
}

// ---- step 3: time ------------------------------------------------------------

/** YYYY-MM-DD at HH:MM, local time. */
function atLocal(dayKey: string, hhmm: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey)
  const t = /^(\d{1,2}):(\d{2})$/.exec(hhmm)
  if (!d || !t) return null
  return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]))
}

/** The next :00 or :30 at or after an instant, in local time. */
function nextHalfHour(ms: number): number {
  const d = new Date(ms)
  if (d.getMinutes() % 30 === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0) return ms
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60)
  return d.getTime()
}

/**
 * The free stretches of a day, for time blocks: 08:00–21:30 by default, from
 * now onwards when it is today, around every timed event with a buffer either
 * side. A work day's hours are taken whole and without a buffer — you are at
 * work, not between meetings. All-day events take no time. Each slot starts on
 * the next :00 or :30.
 */
export function freeSlots(events: CalendarEvent[], dayKey: string, now: Date, o: { from?: string; to?: string; bufferMin?: number } = {}): { start: Date; end: Date }[] {
  const from = atLocal(dayKey, o.from ?? '08:00')
  const to = atLocal(dayKey, o.to ?? '21:30')
  if (!from || !to) return []
  const dayEnd = to.getTime()
  const buffer = (o.bufferMin ?? 10) * MINUTE_MS
  const busy: [number, number][] = []
  for (const ev of events) {
    if (ev.allDay) continue
    const s = Date.parse(ev.start)
    const e = Date.parse(ev.end)
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue
    const pad = ev.work ? 0 : buffer
    busy.push([s - pad, e + pad])
  }
  busy.sort((a, b) => a[0] - b[0])

  const slots: { start: Date; end: Date }[] = []
  const offer = (a: number, b: number) => {
    const start = nextHalfHour(a)
    if (b - start >= MIN_SLOT_MIN * MINUTE_MS) slots.push({ start: new Date(start), end: new Date(b) })
  }
  let cursor = Math.max(from.getTime(), now.getTime())
  for (const [s, e] of busy) {
    if (e <= cursor) continue
    if (s >= dayEnd) break
    if (s > cursor) offer(cursor, Math.min(s, dayEnd))
    cursor = Math.max(cursor, e)
  }
  if (cursor < dayEnd) offer(cursor, dayEnd)
  return slots
}

/**
 * The suggested block for each pick, in the order picked: the first slot with
 * room, from its start, the next block beginning on the following :00 or :30.
 * A pick of 0 minutes ("No block"), or one that fits nowhere, gets none.
 */
export function allocateBlocks(slots: { start: Date; end: Date }[], picks: { taskId: string; minutes: number }[]): { taskId: string; start: string; end: string }[] {
  const free = slots.map(s => ({ start: s.start.getTime(), end: s.end.getTime() }))
  const out: { taskId: string; start: string; end: string }[] = []
  for (const p of picks) {
    const ms = p.minutes * MINUTE_MS
    if (!(ms > 0)) continue
    const slot = free.find(s => s.end - s.start >= ms)
    if (!slot) continue
    out.push({ taskId: p.taskId, start: new Date(slot.start).toISOString(), end: new Date(slot.start + ms).toISOString() })
    slot.start = nextHalfHour(slot.start + ms)
  }
  return out
}

// ---- dates -------------------------------------------------------------------

/**
 * "Today" for an overdue task: its time today if that is still ahead, else
 * today with no time — local midnight, which reads as due today rather than
 * late (taskutils dueTone), where 09:00 would already be late by lunchtime.
 */
export function todayDueAt(task: Task, now: Date): string {
  if (task.dueAt && hasDueTime(task.dueAt)) {
    const old = new Date(task.dueAt)
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), old.getHours(), old.getMinutes())
    if (at.getTime() > now.getTime()) return at.toISOString()
  }
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
}

/** The planner's reschedule rule on a day key: the same time of day, or 09:00 for a task that had no date. */
export function rescheduledDueAt(task: Task, dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number)
  const old = task.dueAt && Number.isFinite(Date.parse(task.dueAt)) ? new Date(task.dueAt) : null
  return new Date(y, m - 1, d, old?.getHours() ?? 9, old?.getMinutes() ?? 0).toISOString()
}

// ---- writing a plan ----------------------------------------------------------

export type DayMove = { id: string; to: 'today' | 'tomorrow' | 'nextweek' | 'wishlist' | 'done' }

export interface DayPlanResult {
  moves: DayMove[]
  focusIds: string[]
  blocks: { taskId: string; title: string; start: string; end: string }[]
  /** "+ New task for today": created due today. The id is the sheet's own, so a pick or a block can name it. */
  newTasks?: { id: string; title: string }[]
}

export interface ShutdownResult {
  moves: DayMove[]
  tomorrowFocusIds: string[]
}

/**
 * A move to Wishlist or Done. These go through the store's setStatus, never an
 * upsert: setStatus spawns a repeating task's next copy and releases what it
 * was blocking. Undo must also remove the copy it spawned.
 */
export interface StatusMove {
  id: string
  status: 'wishlist' | 'done'
}

export interface DayWrites {
  upserts: FocusTask[]
  events: BlockEntry[]
  /** Every task this plan touches, as it was — what Undo puts back (restoreSnapshots). */
  snapshots: Task[]
  statuses: StatusMove[]
  /** Tasks this plan created: Undo deletes them, there is nothing to restore. */
  createdIds: string[]
}

export interface ShutdownWrites {
  upserts: FocusTask[]
  snapshots: Task[]
  statuses: StatusMove[]
}

interface Draft {
  byId: Map<string, FocusTask>
  next: Map<string, FocusTask>
  snapshots: Map<string, Task>
  statuses: StatusMove[]
}

function draftOf(tasks: Task[]): Draft {
  return { byId: new Map((tasks as FocusTask[]).filter(t => !t.deletedAt).map(t => [t.id, t])), next: new Map(), snapshots: new Map(), statuses: [] }
}

/** The copy this plan is editing, remembering the original once for Undo. */
function editing(d: Draft, t: FocusTask): FocusTask {
  if (!d.snapshots.has(t.id)) d.snapshots.set(t.id, { ...t })
  let cur = d.next.get(t.id)
  if (!cur) {
    cur = { ...t }
    d.next.set(t.id, cur)
  }
  return cur
}

const statusMoved = (d: Draft, id: string) => d.statuses.some(s => s.id === id)

function applyMoves(d: Draft, moves: DayMove[], days: { tomorrow: string; nextWeek: string }, now: Date): void {
  const handled = new Set<string>()
  for (const m of moves) {
    const t = d.byId.get(m.id)
    if (!t || handled.has(t.id)) continue
    handled.add(t.id)
    if (m.to === 'wishlist' || m.to === 'done') {
      if (t.status === m.to) continue
      if (!d.snapshots.has(t.id)) d.snapshots.set(t.id, { ...t })
      d.statuses.push({ id: t.id, status: m.to })
      continue
    }
    // the reschedule rule: a finished task stays where it finished
    if (t.status === 'done') continue
    const cur = editing(d, t)
    cur.dueAt = m.to === 'today' ? todayDueAt(t, now) : rescheduledDueAt(t, m.to === 'tomorrow' ? days.tomorrow : days.nextWeek)
    if (cur.status === 'wishlist' || cur.status === 'canceled') cur.status = 'todo'
  }
}

/**
 * Make the first MAX_FOCUS of `wanted` the focus for `day`, and take it off
 * whatever of yours was focused that day and no longer is. A finished task
 * keeps its focus — it is the "done" in "2 of 3 done" — and a household
 * member's pick is theirs to change.
 */
function applyFocus(d: Draft, wanted: string[], day: string, myId: string | null, created: Map<string, FocusTask>): void {
  const picks: string[] = []
  for (const id of wanted) {
    if (picks.length >= MAX_FOCUS) break
    if (picks.includes(id) || statusMoved(d, id) || (!d.byId.has(id) && !created.has(id))) continue
    picks.push(id)
  }
  // absent in local mode, where there is no one else to tell apart
  const focusBy = myId ?? undefined
  for (const id of picks) {
    const fresh = created.get(id)
    if (fresh) {
      fresh.focusOn = day
      fresh.focusBy = focusBy
      continue
    }
    const t = d.byId.get(id)!
    if (isFocusFor(t, day, myId)) continue
    const cur = editing(d, t)
    cur.focusOn = day
    cur.focusBy = focusBy
  }
  for (const t of d.byId.values()) {
    if (picks.includes(t.id) || t.status === 'done' || statusMoved(d, t.id) || !isFocusFor(t, day, myId)) continue
    const cur = editing(d, t)
    cur.focusOn = undefined
    cur.focusBy = undefined
  }
}

/** Edited copies, each stamped newer than the one it was based on so it wins the merge. */
function stamped(d: Draft): FocusTask[] {
  return [...d.next.values()].map(t => ({ ...t, updatedAt: newerStamp(d.snapshots.get(t.id)?.updatedAt ?? t.updatedAt) }))
}

/**
 * Everything Plan my day writes. Moves to today, tomorrow or next week become
 * new due dates (Wishlist and Done are status moves, for setStatus); the picks
 * get focusOn today, a deselected pick loses it; new tasks are created due
 * today; and each block becomes an event carrying its task's id — saved like any
 * other event, so it mirrors to the connected calendars.
 */
export function planDayWrites(tasks: Task[], r: DayPlanResult, c: { today: string; myId: string | null; now: Date; newId(): string }): DayWrites {
  const d = draftOf(tasks)
  applyMoves(d, r.moves, { tomorrow: shiftDayKey(c.today, 1), nextWeek: shiftDayKey(c.today, 7) }, c.now)
  const stamp = c.now.toISOString()
  const created = new Map<string, FocusTask>()
  for (const n of r.newTasks ?? []) {
    const title = n.title.trim().slice(0, 140)
    if (!title || d.byId.has(n.id) || created.has(n.id)) continue
    // due today with no time: on Today's list, and never "late"
    created.set(n.id, { kind: 'task', id: n.id, title, description: '', status: 'todo', priority: 'normal', dueAt: localMidnightIso(c.today) ?? undefined, createdAt: stamp, updatedAt: stamp, tags: [] })
  }
  applyFocus(d, r.focusIds, c.today, c.myId, created)
  const events: BlockEntry[] = []
  for (const b of r.blocks) {
    const start = Date.parse(b.start)
    const end = Date.parse(b.end)
    const task = created.get(b.taskId) ?? d.next.get(b.taskId) ?? d.byId.get(b.taskId)
    if (!task || statusMoved(d, task.id) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    events.push({
      kind: 'event',
      id: c.newId(),
      title: (b.title ?? '').trim() || task.title,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      allDay: false,
      taskId: task.id,
      createdAt: stamp,
      updatedAt: stamp,
    })
  }
  return { upserts: [...created.values(), ...stamped(d)], events, snapshots: [...d.snapshots.values()], statuses: d.statuses, createdIds: [...created.keys()] }
}

/** What Shut down offers to deal with: your unfinished focus first, then everything open due today or overdue. */
export function leftovers(tasks: Task[], today: string, myId: string | null): Task[] {
  const open = (tasks as FocusTask[]).filter(t => !t.deletedAt && OPEN_STATUSES.includes(t.status))
  const focus = open.filter(t => isFocusFor(t, today, myId)).sort(compareTasks)
  const due = open.filter(t => !focus.includes(t) && !!t.dueAt && dateKey(t.dueAt) <= today).sort(compareTasks)
  return [...focus, ...due]
}

/** Everything Shut down writes: the leftovers' moves, and tomorrow's focus in place of whatever was picked for it before. */
export function shutdownWrites(tasks: Task[], r: ShutdownResult, c: { today: string; tomorrow: string; myId: string | null; now: Date }): ShutdownWrites {
  const d = draftOf(tasks)
  applyMoves(d, r.moves, { tomorrow: c.tomorrow, nextWeek: shiftDayKey(c.today, 7) }, c.now)
  applyFocus(d, r.tomorrowFocusIds, c.tomorrow, c.myId, new Map())
  return { upserts: stamped(d), snapshots: [...d.snapshots.values()], statuses: d.statuses }
}

/**
 * Undo: each snapshot put back with a stamp newer than whatever is stored now,
 * so it wins the merge against the plan's own write — even in the same
 * millisecond, where a stamp newer than the snapshot's alone could tie with it.
 */
export function restoreSnapshots(snapshots: Task[], current: Task[]): Task[] {
  const stored = new Map(current.map(t => [t.id, t.updatedAt]))
  return snapshots.map(s => {
    const cur = stored.get(s.id)
    return { ...s, updatedAt: newerStamp(cur && cur > s.updatedAt ? cur : s.updatedAt) }
  })
}
