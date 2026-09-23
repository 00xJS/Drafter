// People cadence / occasions shared by the web app, digest, and MCP.
// Dependency-free ESM.

import type { CalendarEntry, Person, Task } from '../src/types.ts'
import { daysWithin, distinctDays } from './stats.mts'
import { doneWithTime, openVisitPlan, taskIndex } from './visitindex.mts'

export const DEFAULT_CADENCE_DAYS = 90
export const DAY_MS = 86_400_000

const OPEN = ['todo', 'doing', 'blocked']

/**
 * "No reminders": someone (or somewhere) kept on the list but never nudged
 * about. Stored on the record as `noReminders: true` and read through here by
 * every surface that nudges or counts who is due. Not a rhythm of 0: a 0 has
 * always meant "none set", which for a person is the 90-day default.
 */
export function remindersOff(record: { noReminders?: unknown } | null | undefined): boolean {
  return record?.noReminders === true
}

/** The rhythms the app offers, in days: a week, a fortnight, a month, three months, six. */
export const RHYTHM_CHOICES: readonly number[] = [7, 14, 30, 90, 180]

/** A rhythm as the setup sheet holds it: days, No reminders, or none set. */
export type Rhythm = number | 'off' | null

/** A record's rhythm as the setup sheet and withRhythm read it: 'off', its days, or null for none set. */
export function rhythmOf(record: { cadenceDays?: unknown; noReminders?: unknown } | null | undefined): Rhythm {
  if (remindersOff(record)) return 'off'
  const days = Number(record?.cadenceDays)
  return Number.isFinite(days) && days > 0 ? Math.round(days) : null
}

/**
 * The record with this rhythm: days, 'off' for No reminders, or null for none
 * set. The one writer of both fields, so a rhythm clears No reminders and No
 * reminders clears the rhythm. Not stamped: the caller stamps it (newerStamp).
 */
export function withRhythm<T extends { cadenceDays?: number; noReminders?: boolean }>(record: T, rhythm: Rhythm): T
export function withRhythm(record: { cadenceDays?: number; noReminders?: boolean }, rhythm: Rhythm): { cadenceDays?: number; noReminders?: boolean } {
  const { cadenceDays: _days, noReminders: _off, ...rest } = record
  if (rhythm === 'off') return { ...rest, noReminders: true }
  return typeof rhythm === 'number' && Number.isFinite(rhythm) && rhythm > 0 ? { ...rest, cadenceDays: Math.round(rhythm) } : rest
}

/**
 * A rhythm to suggest from your own history: the days you saw someone (or went
 * somewhere), as day keys, and today's. The last 90 days count first — seen on
 * 3 of them is about monthly, on one about every three months — and with none
 * there the last year, so a visit in the spring reads as about six months. The
 * gap that implies goes to the nearest choice on a log scale. Nothing in a year
 * suggests nothing.
 */
export function suggestRhythm(days: readonly string[] | null | undefined, todayKey: string): number | null {
  const unique = [...new Set(days ?? [])]
  const recent = daysWithin(unique, todayKey, 90)
  const n = recent || daysWithin(unique, todayKey, 365)
  if (!n) return null
  const gap = (recent ? 90 : 365) / n
  let best = RHYTHM_CHOICES[0]
  for (const c of RHYTHM_CHOICES) if (Math.abs(Math.log(gap / c)) < Math.abs(Math.log(gap / best))) best = c
  return best
}

/** A done task with this person on it, and when it was done. */
export interface Visit {
  task: Task
  at: string
}

/**
 * Completed tasks attached to this person, newest first. Read off the list's
 * index (shared/visitindex.mts), filed once for everyone asked about.
 */
export function visitsFor(personId: string, tasks: readonly Task[]): Visit[] {
  const index = taskIndex(tasks)
  const done = index
    ? (index.visits.get(personId) ?? [])
    : (tasks ?? []).filter((t): t is Task & { completedAt: string } => doneWithTime(t) && (t.peopleIds ?? []).includes(personId))
  return done.map(t => ({ task: t, at: t.completedAt })).sort((a, b) => b.at.localeCompare(a.at))
}

/**
 * The distinct days among these visits, in their order (newest first for
 * visitsFor's list): three events on one Saturday are one day seen. `dayKeyOf`
 * turns an instant into YYYY-MM-DD in the viewer's zone, so the app passes its
 * local calendar and the MCP server its clock's. The Stats rules' distinctDays
 * (shared/stats.mts), under the name People has always used.
 */
export const visitDays = distinctDays

/**
 * Your own calendar entries that have happened with people on them, as the done
 * visit task "Who was there?" logs for a subscribed calendar's event: titled as
 * the event and dated at its start (midday on an all-day one), so visitsFor and
 * everything built on it counts them the same way. A work day is never a visit,
 * nor is a Plan my day block (taskId): its task carries the people, and counts
 * once it is done. Nothing counts before that time has come. Each keeps its
 * entry's id, so a visit can open the entry it came from.
 */
export function eventVisits(entries: readonly CalendarEntry[] | null | undefined, now: Date | string = new Date()): Task[] {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now)
  const out: Task[] = []
  for (const e of entries ?? []) {
    const peopleIds = e?.peopleIds ?? []
    if (!e || e.kind !== 'event' || e.deletedAt || e.work || e.taskId || !peopleIds.length) continue
    const atMs = e.allDay ? new Date(`${e.start}T12:00`).getTime() : Date.parse(e.start)
    if (!Number.isFinite(atMs) || atMs > nowMs) continue
    out.push({
      kind: 'task',
      id: e.id,
      title: e.title,
      description: e.location ? `At ${e.location}` : '',
      status: 'done',
      priority: 'normal',
      completedAt: new Date(atMs).toISOString(),
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      tags: ['visit'],
      peopleIds: [...peopleIds],
    })
  }
  return out
}

/**
 * Whether this row counts as YOU having been there (v3.24).
 *
 * The address book is the household's — one Mum, one favourite restaurant —
 * but the log of who saw whom is not. Two people in a household are in
 * different places on different days, and a fortnight where Maria saw her
 * mother twice was reading on Joseph's Today and in his weekly recap as
 * though he had.
 *
 * A row is yours when you wrote it (a logged visit is written by whoever
 * tapped the button), or when it was handed to you and you are the one who
 * did it. A row with no owner is this device's own — local mode, and the
 * rows written before anyone signed in. `myId` absent means "don't ask":
 * every caller that has no viewer (a local copy, a test) counts everything,
 * exactly as it did before.
 */
export function ownVisit(row: { ownerId?: string; assigneeId?: string } | null | undefined, myId?: string | null): boolean {
  if (!myId || !row) return true
  return !row.ownerId || row.ownerId === myId || row.assigneeId === myId
}

/**
 * What every "have you seen them" figure reads: the tasks, and your own past
 * events with people on them as the visits they amount to. People, Today, the
 * week plan, the digest, Review, Ask and MCP all count through this, so no
 * surface calls someone overdue whom another shows as seen. Plans (plannedVisit)
 * and gifts still read the tasks alone: an event is never an open plan.
 *
 * `myId` narrows it to your own log (ownVisit). Pass it wherever there is a
 * viewer to be wrong about; leave it out where there is not.
 */
export function seenTasks(tasks: readonly Task[], entries: readonly CalendarEntry[] | null | undefined, now: Date | string = new Date(), myId: string | null = null): Task[] {
  const mine = (row: { ownerId?: string; assigneeId?: string }) => ownVisit(row, myId)
  return [...(tasks ?? []).filter(mine), ...eventVisits((entries ?? []).filter(mine), now)]
}

/** Soonest open catch-up / visit plan for this person, if any. Read off the list's index, as visitsFor is. */
export function plannedVisit(personId: string, tasks: readonly Task[]): Task | null {
  const index = taskIndex(tasks)
  // a copy to sort: the index's entry keeps the list's order for the next question
  const open = index
    ? [...(index.plans.get(personId) ?? [])]
    : (tasks ?? []).filter(t => openVisitPlan(t) && (t.peopleIds ?? []).includes(personId))
  return open.sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') || a.updatedAt.localeCompare(b.updatedAt))[0] ?? null
}

/**
 * Open gift task for an occasion (tags include 'gift' and the kind), due within
 * `windowDays` of the occasion date. Used to suppress "Plan a gift" duplicates.
 */
export function plannedGift(personId: string, kind: 'birthday' | 'anniversary', occasionAt: Date | string, tasks: readonly Task[], windowDays = 40): Task | null {
  const atMs = occasionAt instanceof Date ? occasionAt.getTime() : Date.parse(occasionAt)
  if (!Number.isFinite(atMs)) return null
  const window = windowDays * DAY_MS
  return (
    (tasks ?? []).find(t => {
      if (!OPEN.includes(t.status) || !(t.peopleIds ?? []).includes(personId)) return false
      const tags = t.tags ?? []
      if (!tags.includes('gift') || !tags.includes(kind)) return false
      if (!t.dueAt) return true
      const due = Date.parse(t.dueAt)
      return Number.isFinite(due) && Math.abs(due - atMs) <= window
    }) ?? null
  )
}

/** 'off' for someone on No reminders, whatever their visits say. */
export type SeenStatus = 'never' | 'overdue' | 'due' | 'ok' | 'off'

/**
 * Cadence status for one person. `nowMs` and optional `todayKey` (YYYY-MM-DD in
 * the viewer's zone) keep digest and client aligned. Someone on No reminders
 * is 'off' whatever their visits say: never due, never overdue, never a
 * cold-start nudge, and with no rhythm to measure against.
 */
export function seenStatus(
  person: Person,
  tasks: readonly Task[],
  now: Date | string = new Date(),
): {
  status: SeenStatus
  reason: string
  lastSeen?: string
  daysSince?: number
  visits: Visit[]
  /** Null on No reminders: there is no rhythm to measure against. */
  effectiveCadenceDays: number | null
} {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now)
  const visits = visitsFor(person.id, tasks)
  const lastSeen = visits[0]?.at
  const daysSince = lastSeen ? Math.floor((nowMs - Date.parse(lastSeen)) / DAY_MS) : undefined
  const off = remindersOff(person)
  const cadence = off ? undefined : person.cadenceDays
  const effective = cadence ?? DEFAULT_CADENCE_DAYS
  let status: SeenStatus
  let reason: string
  if (off) {
    status = 'off'
    const seen = daysSince === undefined ? 'No visits logged' : daysSince === 0 ? 'Seen today' : `Last seen ${daysSince} day${daysSince === 1 ? '' : 's'} ago`
    reason = `${seen} · no reminders`
  } else if (!lastSeen) {
    status = 'never'
    reason = 'No visits logged yet'
  } else if (daysSince !== undefined && daysSince > effective * 1.5) {
    status = 'overdue'
    reason = cadence
      ? `Last seen ${daysSince} days ago — you aimed for every ${cadence} days`
      : `Last seen ${daysSince} days ago (target ${DEFAULT_CADENCE_DAYS} days)`
  } else if (daysSince !== undefined && daysSince > effective) {
    status = 'due'
    reason = cadence ? `It's been ${daysSince} days; you aimed for every ${cadence} days` : `It's been ${daysSince} days`
  } else {
    status = 'ok'
    reason = daysSince === 0 ? 'Seen today' : `Last seen ${daysSince} day${daysSince === 1 ? '' : 's'} ago`
  }
  return { status, reason, lastSeen, daysSince, visits, effectiveCadenceDays: off ? null : effective }
}

/** A birthday or an anniversary coming up. */
export interface Occasion {
  person: Person
  kind: 'birthday' | 'anniversary'
  /** Next occurrence as a Date: local midnight, or UTC midnight when read on a day key. */
  at: Date
  daysUntil: number
  /** Age or years, when the stored date has a real year. */
  years?: number
}

/**
 * Birthdays and anniversaries within `days` (today included).
 * When `todayKey` (YYYY-MM-DD) is set — digest path — compare on that calendar
 * day in UTC maths so a timezone string from user_settings stays consistent.
 * Otherwise use the runtime's local calendar (client / MCP).
 */
export function upcomingOccasions(people: readonly Person[], days = 14, now: Date | string | number = new Date(), todayKey?: string | null): Occasion[] {
  const useKey = todayKey && /^\d{4}-\d{2}-\d{2}$/.test(todayKey)
  let ty: number, tm: number, td: number
  if (useKey) {
    ;[ty, tm, td] = todayKey.split('-').map(Number)
  } else {
    const d = now instanceof Date ? now : new Date(now)
    ty = d.getFullYear()
    tm = d.getMonth() + 1
    td = d.getDate()
  }
  const out: Occasion[] = []
  for (const person of people ?? []) {
    for (const kind of ['birthday', 'anniversary'] as const) {
      const raw = person[kind]
      if (!raw) continue
      const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})$/)
      if (!m) continue
      const year = Number(m[1])
      let daysUntil: number
      let at: Date
      if (useKey) {
        const todayUtc = Date.UTC(ty, tm - 1, td)
        let next = Date.UTC(ty, Number(m[2]) - 1, Number(m[3]))
        if (next < todayUtc) next = Date.UTC(ty + 1, Number(m[2]) - 1, Number(m[3]))
        daysUntil = Math.round((next - todayUtc) / DAY_MS)
        at = new Date(next)
      } else {
        const today = new Date(ty, tm - 1, td)
        let next = new Date(ty, Number(m[2]) - 1, Number(m[3]))
        if (next < today) next = new Date(ty + 1, Number(m[2]) - 1, Number(m[3]))
        daysUntil = Math.round((next.getTime() - today.getTime()) / DAY_MS)
        at = next
      }
      if (daysUntil > days) continue
      out.push({
        person,
        kind,
        at,
        daysUntil,
        years: year > 1900 ? at.getFullYear() - year : undefined,
      })
    }
  }
  return out.sort((a, b) => a.daysUntil - b.daysUntil)
}
