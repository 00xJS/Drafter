import { Cadence, CalendarEntry, Person, PersonGroup, Task } from './types'
import { monthsAndTrend } from './stats'
import { startOfDay } from './taskutils'
import { dateKey } from './utils'
import {
  DEFAULT_CADENCE_DAYS,
  DAY_MS,
  RHYTHM_CHOICES,
  remindersOff,
  rhythmOf,
  suggestRhythm,
  withRhythm,
  visitsFor as sharedVisitsFor,
  visitDays as sharedVisitDays,
  eventVisits as sharedEventVisits,
  seenTasks as sharedSeenTasks,
  plannedVisit as sharedPlannedVisit,
  plannedGift as sharedPlannedGift,
  seenStatus as sharedSeenStatus,
  upcomingOccasions as sharedOccasions,
  type Rhythm,
} from '../shared/people.mts'

export { RHYTHM_CHOICES, remindersOff, rhythmOf, suggestRhythm, withRhythm }
export type { Rhythm }

// "Seeing someone" is a completed task they're attached to: a logged visit,
// a dinner you planned, a task you did together. An event of your own they
// are on counts too once it has happened, read as the visit task it amounts
// to (eventVisits). Everything below derives from those completion dates.
// Each one is an event; "how often" is counted in days seen, because three
// events with the same group on one Saturday are one time you saw them, not
// three.

export interface Visit {
  task: Task
  at: string
}

/** 'off' is someone on No reminders: never due, never a nudge. */
export type SeenStatus = 'never' | 'overdue' | 'due' | 'ok' | 'off'

export interface PersonStats {
  person: Person
  visits: Visit[]
  lastSeen?: string
  daysSince?: number
  /** Events (completed tasks with them) in the last 30 / 90 days. */
  count30: number
  count90: number
  /** Days seen in the last 30 / 90 days and all time: several events on one day are one day. */
  days30: number
  days90: number
  daysAll: number
  /** Events all time, to sit beside daysAll. */
  eventsAll: number
  /** Average days between the days you saw them over the last year. */
  avgGapDays?: number
  /** Days seen per week (0..7) over the last 12 weeks, oldest first — for the mini bars. */
  weekly: number[]
  status: SeenStatus
  /** Human explanation of the status. */
  reason: string
  /** Soonest open visit/catch-up task, if one exists. */
  planned?: Task
}

export function visitsFor(personId: string, tasks: Task[]): Visit[] {
  return sharedVisitsFor(personId, tasks) as Visit[]
}

/** The distinct days among these visits, on the viewer's own calendar unless told otherwise. */
export function visitDays(visits: { at: string }[], dayKeyOf: (at: string) => string | null = dateKey): string[] {
  return sharedVisitDays(visits, dayKeyOf)
}

/** "1 day", "3 events". */
export const countOf = (n: number, noun: string, plural?: string) => `${n} ${n === 1 ? noun : (plural ?? `${noun}s`)}`

/** "2 days · 3 events", or just "2 days" when no two events shared a day. */
export function seenLabel(days: number, events: number): string {
  return events === days ? countOf(days, 'day') : `${countOf(days, 'day')} · ${countOf(events, 'event')}`
}

/** A YYYY-MM-DD key as a whole day number, so a DST hour never shortens a gap. */
const dayNumber = (key: string) => Math.round(Date.parse(`${key}T00:00:00Z`) / DAY_MS)

/**
 * Your own past events with people on them, as the done visit tasks they
 * amount to. Add them to the tasks a count reads and each counts as a
 * subscribed calendar's event does once Who was there? has logged it. They
 * are read, never saved.
 */
export function eventVisits(entries: CalendarEntry[], now: Date = new Date()): Task[] {
  return sharedEventVisits(entries, now)
}

/**
 * What every "have you seen them" figure reads: the tasks plus those event
 * visits. People, Today, Review, Ask and the week plan all count through it.
 *
 * `myId` narrows it to your own log (v3.24): the address book is the
 * household's, the record of who saw whom is not. Pass it wherever there is a
 * viewer — every surface in the app has one — and the household member's
 * visits stop being counted as yours.
 */
export function seenTasks(tasks: Task[], entries: CalendarEntry[] | undefined, now: Date = new Date(), myId?: string | null): Task[] {
  return sharedSeenTasks(tasks, entries, now, myId)
}

/** Shared last/gap/weekly rollup used by people and places. */
// Widened to anything carrying an instant: a place's outings now include meals
// eaten out, which are not tasks. Only `at` is ever read here.
export function visitSummary(visits: { at: string }[], now: Date = new Date()) {
  const nowMs = now.getTime()
  const lastAt = visits[0]?.at
  const daysSince =
    lastAt !== undefined
      ? Math.floor((startOfDay(now).getTime() - startOfDay(new Date(lastAt)).getTime()) / DAY_MS)
      : undefined
  const count30 = visits.filter(v => nowMs - Date.parse(v.at) < 30 * DAY_MS).length
  const count90 = visits.filter(v => nowMs - Date.parse(v.at) < 90 * DAY_MS).length
  const count365 = visits.filter(v => nowMs - Date.parse(v.at) < 365 * DAY_MS).length

  const yearVisits = visits
    .filter(v => nowMs - Date.parse(v.at) < 365 * DAY_MS)
    .map(v => Date.parse(v.at))
    .sort((a, b) => a - b)
  let avgGapDays: number | undefined
  if (yearVisits.length >= 2) {
    const gaps = yearVisits.slice(1).map((t, i) => t - yearVisits[i])
    avgGapDays = gaps.reduce((s, g) => s + g, 0) / gaps.length / DAY_MS
  }

  const weekStart = startOfDay(now).getTime() - 11 * 7 * DAY_MS
  const weekly = Array.from({ length: 12 }, () => 0)
  for (const v of visits) {
    const idx = Math.floor((Date.parse(v.at) - weekStart) / (7 * DAY_MS))
    if (idx >= 0 && idx < 12) weekly[idx]++
  }

  return { lastAt, daysSince, count30, count90, count365, avgGapDays, weekly }
}

/**
 * The people half of the rollup, counted in days seen rather than events.
 * Places keep visitSummary: an outing there is what they count.
 */
export function daySummary(visits: { at: string }[], now: Date = new Date()) {
  const nowMs = now.getTime()
  const daysWithin = (days: number) => visitDays(visits.filter(v => nowMs - Date.parse(v.at) < days * DAY_MS))
  const all = visitDays(visits)

  // the whole span over one fewer gaps: a same-day repeat is no longer a 0-day gap
  const year = daysWithin(365).map(dayNumber)
  const avgGapDays = year.length >= 2 ? (Math.max(...year) - Math.min(...year)) / (year.length - 1) : undefined

  // twelve 7-day buckets, the last one ending today
  const first = dayNumber(dateKey(now)) - 12 * 7 + 1
  const weekly = Array.from({ length: 12 }, () => 0)
  for (const key of all) {
    const idx = Math.floor((dayNumber(key) - first) / 7)
    if (idx >= 0 && idx < 12) weekly[idx]++
  }

  return { days30: daysWithin(30).length, days90: daysWithin(90).length, daysAll: all.length, avgGapDays, weekly }
}

export function personStats(person: Person, tasks: Task[], now: Date = new Date()): PersonStats {
  const base = sharedSeenStatus(person, tasks, now)
  const visits = base.visits as Visit[]
  const summary = visitSummary(visits, now)
  const days = daySummary(visits, now)
  const planned = (sharedPlannedVisit(person.id, tasks) as Task | null) ?? undefined

  return {
    person,
    visits,
    lastSeen: base.lastSeen,
    daysSince: base.daysSince,
    count30: summary.count30,
    count90: summary.count90,
    days30: days.days30,
    days90: days.days90,
    daysAll: days.daysAll,
    eventsAll: visits.length,
    avgGapDays: days.avgGapDays,
    weekly: days.weekly,
    status: base.status as SeenStatus,
    reason: base.reason,
    planned,
  }
}

export function plannedGift(personId: string, kind: 'birthday' | 'anniversary', at: Date, tasks: Task[]): Task | null {
  return sharedPlannedGift(personId, kind, at, tasks) as Task | null
}

/** Used when someone has no declared rhythm, so drift is still visible. */
export { DEFAULT_CADENCE_DAYS }

/** Theme tokens (a tone on its own tint), so each badge reads in light and dark. */
export const SEEN_META: Record<SeenStatus, { label: string; color: string; bg: string }> = {
  never: { label: 'No visits yet', color: 'var(--tone-grey)', bg: 'var(--tone-grey-bg)' },
  overdue: { label: 'Overdue', color: 'var(--tone-rose)', bg: 'var(--tone-rose-bg)' },
  due: { label: 'Due a catch-up', color: 'var(--tone-amber)', bg: 'var(--tone-amber-bg)' },
  ok: { label: 'On track', color: 'var(--tone-green)', bg: 'var(--tone-green-bg)' },
  off: { label: 'No reminders', color: 'var(--tone-grey)', bg: 'var(--tone-grey-bg)' },
}

/** Sort: the people who need attention first, then by how long since. Planned catch-ups sort below true drift; No reminders last. */
export function compareStats(a: PersonStats, b: PersonStats): number {
  const aPlanned = a.planned ? 1 : 0
  const bPlanned = b.planned ? 1 : 0
  if (aPlanned !== bPlanned) return aPlanned - bPlanned
  const rank: Record<SeenStatus, number> = { overdue: 0, due: 1, never: 2, ok: 3, off: 4 }
  if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status]
  return (b.daysSince ?? 0) - (a.daysSince ?? 0)
}

/**
 * How many never-logged people Today offers a day. Two, not all of them: the
 * whole list at once is a backlog to scroll past, and two is an invitation.
 */
export const NEVER_NUDGES = 2

/** A YYYY-MM-DD key as a whole day number: the clock the turns go by. */
const dayIndex = (key: string) => Math.round(Date.parse(`${key}T00:00:00Z`) / DAY_MS)

/**
 * The never-logged in the order they take their turn today: oldest on the list
 * first (then by id, so two devices agree), started `per` further on each day.
 * Everyone comes round every ceil(n / per) days, so the same two are not there
 * every morning. Without a day key it starts at the oldest.
 */
export function neverInTurn<T extends Pick<PersonStats, 'person'>>(unseen: readonly T[], todayKey?: string, per = NEVER_NUDGES): T[] {
  const order = [...unseen].sort((a, b) => a.person.createdAt.localeCompare(b.person.createdAt) || a.person.id.localeCompare(b.person.id))
  const day = todayKey ? dayIndex(todayKey) : NaN
  if (!order.length || !Number.isFinite(day)) return order
  const start = (((day * per) % order.length) + order.length) % order.length
  return [...order.slice(start), ...order.slice(0, start)]
}

export interface NudgeOptions {
  /** Today's key: which of the never-logged take their turn. */
  todayKey?: string
  /** Ids put off with the ×: left out, and the next in turn comes up instead. */
  putOff?: ReadonlySet<string>
  /** The whole list's cap. */
  max?: number
  /** How many of the never-logged a day. */
  never?: number
}

/** Seen for the first time on this day: never-logged when the day began. Visits run newest first. */
const firstSeenOn = (s: PersonStats, todayKey: string) => s.visits.length > 0 && dateKey(s.visits[s.visits.length - 1].at) === todayKey

/**
 * Who Today asks about: the people drifting, then a couple nobody has logged
 * at all.
 *
 * Today used to take only `due` and `overdue`, and someone with no visit is
 * `never`, so a person had to be logged once before Today would suggest
 * logging them. Never having is the strongest reason to ask, so they come in
 * below the drifting ones, NEVER_NUDGES a day, taking turns by day
 * (neverInTurn). The turn is taken over everyone who was never-logged when
 * the day began, so Saw them on one of today's two leaves the other where it
 * is and brings the next in turn up, as an × does. Someone on No reminders is
 * `off` and never here at all.
 */
export function peopleToNudge(stats: readonly PersonStats[], { todayKey, putOff, max = 6, never = NEVER_NUDGES }: NudgeOptions = {}): PersonStats[] {
  const waiting = (s: PersonStats) => !putOff?.has(s.person.id)
  const drifting = stats.filter(s => (s.status === 'overdue' || s.status === 'due') && waiting(s)).sort(compareStats)
  const unseen = neverInTurn(
    stats.filter(s => s.status === 'never' || (!!todayKey && s.status !== 'off' && firstSeenOn(s, todayKey))),
    todayKey,
    never,
  )
    .filter(s => s.status === 'never' && waiting(s))
    .slice(0, never)
  return [...drifting, ...unseen].slice(0, max)
}

/** The rhythm chips of the setup sheet, in its order: the choices, then No reminders. */
export const RHYTHM_CHIPS: { value: number | 'off'; label: string }[] = [
  { value: 7, label: '1 week' },
  { value: 14, label: '2 weeks' },
  { value: 30, label: 'Monthly' },
  { value: 90, label: '3 months' },
  { value: 180, label: '6 months' },
  { value: 'off', label: 'No reminders' },
]

/** An editor's rhythm select, read: '' for none set, 'off' for No reminders, or days. */
export const cadenceChoice = (v: string): Cadence | '' | 'off' => (v === '' || v === 'off' ? v : (Number(v) as Cadence))

/** A rhythm in words: a chip's own label, "Every 2 months" for one the chips do not offer, "Every 45 days" otherwise. */
export function rhythmLabel(rhythm: Rhythm): string {
  if (rhythm === null) return 'None set'
  const chip = RHYTHM_CHIPS.find(c => c.value === rhythm)
  if (chip) return chip.label
  return rhythm === 60 ? 'Every 2 months' : `Every ${rhythm} days`
}

/**
 * What the setup sheet suggests for someone with no rhythm yet: from the days
 * YOU saw them (`seen` is seenTasks narrowed by myId, as People reads it), on
 * this device's calendar. Null when there is nothing in a year to go on.
 */
export function personRhythmSuggestion(person: Person, seen: Task[], todayKey: string): number | null {
  return suggestRhythm(visitDays(visitsFor(person.id, seen)), todayKey)
}

/** People's find box: the lower-cased query in a person's name or notes, as findsPlace is Places'. */
export function findsPerson(p: Person, needle: string): boolean {
  if (!needle) return true
  return p.name.toLowerCase().includes(needle) || (p.notes ?? '').toLowerCase().includes(needle)
}

/** What the People list's group chip and find box are set to: a group, or 'all', and what is typed. */
export interface PersonFilter {
  group: 'all' | PersonGroup
  q: string
}

/** The list as it opens: everyone, nothing typed. */
export const NO_PERSON_FILTER: PersonFilter = { group: 'all', q: '' }

/**
 * The People list's rule for whom it shows: in the group whose chip is on,
 * with what is typed in the find box (findsPerson). People → Stats counts only
 * the people it keeps, so every figure there agrees with the rows.
 */
export function personMatcher(filter: PersonFilter): (p: Person) => boolean {
  const needle = filter.q.trim().toLowerCase()
  return p => (filter.group === 'all' || p.group === filter.group) && findsPerson(p, needle)
}

export interface Occasion {
  person: Person
  kind: 'birthday' | 'anniversary'
  /** Next occurrence as a local Date. */
  at: Date
  daysUntil: number
  /** Age or years, when the stored date has a real year. */
  years?: number
}

/** Birthdays and anniversaries coming up within `days` (today included). */
export function upcomingOccasions(people: Person[], days = 14, now: Date = new Date()): Occasion[] {
  return sharedOccasions(people, days, now) as Occasion[]
}

export interface YearRow {
  person: Person
  /** Days seen per month, Jan..Dec of the given year. */
  months: number[]
  /** Days seen in the year. */
  total: number
  /** Events in the year, however many shared a day. */
  events: number
  /** Positive = seeing more lately, negative = drifting (days seen in the last 90 days vs the 90 before). */
  trend: number
}

/**
 * One row of a year table: a count for each month of `year`, the year's total
 * and the 90-against-90-day trend. The Stats rules' own (src/stats.ts), under
 * the name People, Places and the wardrobe have always imported.
 */
export { monthsAndTrend }

export function yearReport(people: Person[], tasks: Task[], year: number, now: Date = new Date()): YearRow[] {
  return people
    .map(person => {
      const visits = visitsFor(person.id, tasks)
      const { months, total, trend } = monthsAndTrend(visits, year, now, vs => visitDays(vs).length)
      const events = visits.filter(v => new Date(v.at).getFullYear() === year).length
      return { person, months, total, events, trend }
    })
    .sort((a, b) => b.total - a.total || b.events - a.events)
}
