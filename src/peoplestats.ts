import { DAY_MS } from '../shared/people.mjs'
import { shortDay } from './kitchen'
import { compareStats, personStats, seenTasks, upcomingOccasions, visitDays, yearReport, type Occasion, type PersonStats } from './people'
import { countDays, dayStreaks, daysBetween, monthsAndTrend, topN, type DayWindow, type Streaks } from './stats'
import { PERSON_GROUPS, type CalendarEntry, type Person, type PersonGroup, type Task } from './types'
import { dateKey } from './utils'

// People → Stats, counted: pure, worked out once per render and handed to the
// kit that draws it (src/components/stats). Every figure is read off exactly
// what the People list reads — seenTasks (a done task with someone on it, or
// an event of your own once it has happened) and personStats — so a number
// here and the same number on a row can never disagree: days seen, never
// events unless it says events; the rows' 30- and 90-day windows, back from
// now; the people the list's group chip and find box leave (personMatcher).
// Nothing personal is read: no journal, habits or wardrobe reach these figures.

/** The group chips: everyone, or one group's people, as on the list. */
export type GroupFilter = 'all' | PersonGroup

/** What the list reads, at `now`: your own visits (seenTasks) and each person's rollup (personStats). */
export function peopleSeen(
  people: readonly Person[],
  tasks: Task[],
  entries: CalendarEntry[] | undefined,
  now: Date = new Date(),
  myId?: string | null,
): { seen: Task[]; all: PersonStats[] } {
  const seen = seenTasks(tasks, entries, now, myId)
  return { seen, all: people.map(p => personStats(p, seen, now)) }
}

/** One get-together: a done task with any of these people on it, and which of them it had. */
export interface GetTogether {
  id: string
  at: string
  peopleIds: string[]
}

/** Every get-together with any of these people, in `seen`'s order; the others on it are left out. */
export function getTogethers(shown: readonly PersonStats[], seen: readonly Task[]): GetTogether[] {
  const scoped = new Set(shown.map(s => s.person.id))
  const out: GetTogether[] = []
  for (const t of seen) {
    if (t.status !== 'done' || !t.completedAt) continue
    const peopleIds = (t.peopleIds ?? []).filter(id => scoped.has(id))
    if (peopleIds.length) out.push({ id: t.id, at: t.completedAt, peopleIds })
  }
  return out
}

/**
 * The tiles the list used to carry, counted as it counted them. Three numbers
 * that are easy to conflate: one dinner with three relatives is ONE occasion
 * but THREE people seen, and three get-togethers on one Saturday are THREE
 * occasions but ONE day together. Then who is overdue, and who is due a
 * catch-up, by the rows' own status.
 */
export function togetherCounts(shown: readonly PersonStats[], together: readonly GetTogether[]) {
  const attention = { overdue: 0, due: 0 }
  for (const s of shown) if (s.status === 'overdue' || s.status === 'due') attention[s.status]++
  return {
    days: visitDays([...together]).length,
    occasions: new Set(together.map(t => t.id)).size,
    personVisits: together.reduce((n, t) => n + t.peopleIds.length, 0),
    attention,
  }
}

/** The tiles at the head of Stats. */
export interface PeopleTiles {
  people: number
  /** The days this month so far with any of them, of the month's days so far. */
  thisMonth: { days: number; of: number }
  /** How many were seen in the last 90 days: those whose row shows a 90-day figure. */
  seenLately: number
  /** Days with someone in a row: today waits rather than breaks the run, as a habit's does. */
  streak: Streaks & { today: boolean }
}

export function peopleTiles(shown: readonly PersonStats[], together: readonly GetTogether[], todayKey: string): PeopleTiles {
  const days = visitDays([...together])
  const month = todayKey.slice(0, 7)
  return {
    people: shown.length,
    thisMonth: { days: days.filter(d => d.startsWith(month) && d <= todayKey).length, of: Number(todayKey.slice(8, 10)) },
    seenLately: shown.filter(s => s.days90 > 0).length,
    streak: { ...dayStreaks(days, todayKey), today: days.includes(todayKey) },
  }
}

/**
 * These in a window as a row counts one: the last 30 days (a row's 30-day
 * figure), 12 months, or all time, by the instant and back from now.
 */
export function within<T extends { at: string }>(items: readonly T[], window: DayWindow, now: Date = new Date()): T[] {
  if (window === 'all') return [...items]
  const nowMs = now.getTime()
  return items.filter(v => nowMs - Date.parse(v.at) < window * DAY_MS)
}

/** The days seen among these visits in a window: a row's days30 at 30, its daysAll at 'all'. */
export const daysSeenIn = (visits: readonly { at: string }[], window: DayWindow, now: Date = new Date()): number => visitDays(within(visits, window, now)).length

/** A person as the kit ranks one: by id and name, with the days seen and the events under them. */
export interface SeenRow {
  key: string
  name: string
  count: number
  events: number
  person: Person
}

/**
 * The most seen in a window, in days; a tie goes to more events, then to the
 * name, A–Z, then to the id, so two people of one name stand in the same order
 * on every device. Nobody unseen in the window ranks. The podium is the first
 * three of all time.
 */
export function mostSeen(shown: readonly PersonStats[], window: DayWindow, now: Date = new Date(), n = 10): SeenRow[] {
  const rows = shown.map(s => {
    const visits = within(s.visits, window, now)
    return { key: s.person.id, name: s.person.name, count: visitDays(visits).length, events: visits.length, person: s.person }
  })
  return topN(rows, n, { count: r => r.count, name: r => r.name, tie: (a, b) => b.events - a.events || a.name.localeCompare(b.name) || a.key.localeCompare(b.key) })
}

/** Past their catch-up rhythm, overdue or due, in the list's Needs attention order: Today's people nudges, all of them. */
export const notSeenLately = (shown: readonly PersonStats[]): PersonStats[] => shown.filter(s => s.status === 'overdue' || s.status === 'due').sort(compareStats)

/** How long a new person is given before they count as never seen. */
export const NEVER_SEEN_DAYS = 14

/** Added two weeks ago or more, with no day seen: the longest waiting first, then by name, then by id. */
export const neverSeen = (shown: readonly PersonStats[], todayKey: string): PersonStats[] =>
  shown
    .filter(s => s.daysAll === 0 && daysBetween(dateKey(s.person.createdAt), todayKey) >= NEVER_SEEN_DAYS)
    .sort((a, b) => a.person.createdAt.localeCompare(b.person.createdAt) || a.person.name.localeCompare(b.person.name) || a.person.id.localeCompare(b.person.id))

/** Who of these people you saw on each day, by its key: each person once a day, in the order given. */
export function whoByDay(shown: readonly PersonStats[]): Map<string, Person[]> {
  const out = new Map<string, Person[]>()
  for (const s of shown)
    for (const day of visitDays(s.visits)) {
      const who = out.get(day)
      if (who) who.push(s.person)
      else out.set(day, [s.person])
    }
  return out
}

/** The days of a month (1–12) with anyone in `byDay`, up to today: a month calendar's count. */
export const daysInMonth = (byDay: ReadonlyMap<string, unknown>, year: number, month: number, todayKey: string): number => {
  const prefix = `${year}-${String(month).padStart(2, '0')}`
  return [...byDay.keys()].filter(k => k.startsWith(prefix) && k <= todayKey).length
}

/** "Mum", "Mum and Dad", "Mum, Dad and Sam". */
export const namesOf = (people: readonly Person[]): string => {
  const names = people.map(p => p.name)
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** One group's share of the days you saw anyone. */
export interface GroupShare {
  group: PersonGroup
  /** People in the group. */
  people: number
  /** Days with anyone from it. */
  days: number
  /** Those days over the days with anyone at all, 0 to 1. */
  share: number
}

/**
 * Of the days you saw any of these people in the window, the share with
 * someone from each group; Stats hands it everyone the list shows under All.
 * A day with family and friends counts for both, so the shares can add up
 * past 100%. A group with nobody in it is left out; the rest keep the list's
 * order, Family first.
 */
export function groupShares(shown: readonly PersonStats[], seen: readonly Task[], window: DayWindow, now: Date = new Date()): { days: number; groups: GroupShare[] } {
  const together = within(getTogethers(shown, seen), window, now)
  const days = visitDays(together).length
  const groupOf = new Map(shown.map(s => [s.person.id, s.person.group]))
  const groups = PERSON_GROUPS.flatMap(group => {
    const people = shown.filter(s => s.person.group === group).length
    if (!people) return []
    const n = visitDays(together.filter(t => t.peopleIds.some(id => groupOf.get(id) === group))).length
    return [{ group, people, days: n, share: days ? n / days : 0 }]
  })
  return { days, groups }
}

/** Two people seen on the same days. */
export interface Pair {
  key: string
  a: Person
  b: Person
  /** Days both were seen. */
  days: number
  /** The latest of them. */
  last: string
}

/** Two people count as often together from their second day. */
export const TOGETHER_MIN_DAYS = 2

/**
 * The pairs of these people seen on the same days most often, all time — the
 * same day, not only the same get-together; each pair is named A–Z. A tie goes
 * to the latest, then to the names, then to the ids, so pairs named alike
 * stand in the same order on every device.
 */
export function oftenTogether(shown: readonly PersonStats[], n = 5): Pair[] {
  const pairs = new Map<string, Pair>()
  for (const [day, who] of whoByDay(shown))
    for (let i = 0; i < who.length; i++)
      for (let j = i + 1; j < who.length; j++) {
        const [a, b] = [who[i], who[j]].sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id))
        const key = `${a.id}+${b.id}`
        const pair = pairs.get(key)
        if (!pair) pairs.set(key, { key, a, b, days: 1, last: day })
        else {
          pair.days++
          if (day > pair.last) pair.last = day
        }
      }
  const often = [...pairs.values()].filter(p => p.days >= TOGETHER_MIN_DAYS)
  const named = (p: Pair) => `${p.a.name} ${p.b.name}`
  return topN(often, n, { count: p => p.days, name: named, tie: (x, y) => y.last.localeCompare(x.last) || named(x).localeCompare(named(y)) || x.key.localeCompare(y.key) })
}

/** How far ahead Coming up looks, today included. */
export const COMING_UP_DAYS = 30

/** Birthdays and anniversaries in the next 30 days, the soonest first (upcomingOccasions, Today's rule). */
export const comingUp = (shown: readonly PersonStats[], now: Date = new Date()): Occasion[] => upcomingOccasions(shown.map(s => s.person), COMING_UP_DAYS, now)

/** "Birthday · turns 60 · Sat 26 Sep, in 12 days", "Anniversary · today". */
export function occasionLine(o: Occasion, todayKey: string): string {
  const what = o.kind === 'birthday' ? `Birthday${o.years ? ` · turns ${o.years}` : ''}` : `Anniversary${o.years ? ` · ${o.years} years` : ''}`
  const when = o.daysUntil === 0 ? 'today' : o.daysUntil === 1 ? 'tomorrow' : `${shortDay(dateKey(o.at), todayKey)}, in ${o.daysUntil} days`
  return `${what} · ${when}`
}

/** A person's row in "The year with people": yearReport's, keyed and named for the kit's year table. */
export type PersonYearRow = ReturnType<typeof yearReport>[number] & { key: string; name: string }

/** "The year with people", as the list drew it: each person's days seen per month of `year`, the total, the events and the trend. */
export function yearWithPeople(shown: readonly PersonStats[], seen: Task[], year: number, now: Date = new Date()): PersonYearRow[] {
  return yearReport(
    shown.map(s => s.person),
    seen,
    year,
    now,
  ).map(r => ({ ...r, key: r.person.id, name: r.person.name }))
}

/** The days with anyone each month of `year`, the year's total, and the trend (the last 90 days against the 90 before). */
export const daysByMonth = (together: readonly GetTogether[], year: number, now: Date = new Date()) => monthsAndTrend(together, year, now, countDays)
