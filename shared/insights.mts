// Insights' Highlights: the few things worth saying about a week, a month or a
// year, picked by rules — never by a model — from figures the app's own rules
// count. The app draws them (src/components/insights) and the monthly recap
// sends them (netlify/functions/digest.mjs), both through here, so the two can
// never disagree about your September. Dependency-free ESM.
//
// Figures first (insightFigures), then the cards (pickHighlights).
//
// - Every figure is counted by the rule the rest of the app counts it by.
//   Finished work is workDone's, a visit seenTasks' (your own log, v3.24), an
//   outing outingsAt's, a meal's way mealWays', money paid payments', the
//   journal's streak journalStreaks', habits habitsKept's and the clothes
//   wearIndex's. None is spelled again here: eight Stats figures once
//   disagreed with the rest of the app because each had been.
// - Whose log counts is `whose`. Mine is the viewer's own: their work
//   (isMineTask), their visits and outings (ownVisit), the meals shared with
//   the household and their own. Both of us is every member's, among the
//   records this device — or on the server, this member — can already read,
//   and never anything more. The personal kinds, the journal, habits and the
//   wardrobe, are the viewer's own in either.
// - A period is a calendar week (Sunday first, as the app's weeks are), month
//   or year, on the reader's calendar. One still going is compared with the
//   same days of the one before, so a Monday is never "↓15 on last week".
// - A card whose figure is nothing is never made. A quiet period has no cards,
//   and the page says so.

import type { CalendarEntry, Garment, Habit, JournalEntry, Meal, Person, Place, Recipe, Task, Wear } from '../src/types.ts'
import { isMineTask } from './domain.mts'
import { journalStreaks, moodAverage, shiftDayKey, writtenDays } from './journal.mts'
import { cookedRecipeIds, mealWays, savedPlaces } from './kitchen.mts'
import { formatMoney, payments } from './money.mts'
import { seenTasks, visitDays, visitsFor } from './people.mts'
import { mealCountsFor, outingsAt } from './places.mts'
import { habitsKept, inRange, workDone } from './review.mts'
import { dayStreaks, daysBetween, type Streaks } from './stats.mts'
import { neverWorn, wearIndex } from './wardrobe.mts'
import { isDayKey, weekKeyOf, weekKeyStart, weekStartKey } from './weeks.mts'

// ---- words -----------------------------------------------------------------------

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** "1 task", "2 tasks"; a noun with its own plural where it needs one. */
const count = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
/** "once", "twice", "3 times". */
const times = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)
/** "A", "A and B", "A, B and C". */
const andList = (names: readonly string[]): string => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

// ---- the areas -------------------------------------------------------------------

/** The areas a highlight opens, in the order the chips draw them (STATS_AREAS in src/components/planner/routes.ts). */
export type InsightArea = 'tasks' | 'money' | 'people' | 'places' | 'kitchen' | 'wardrobe' | 'habits' | 'journal'
export const INSIGHT_AREAS: readonly InsightArea[] = ['tasks', 'money', 'people', 'places', 'kitchen', 'wardrobe', 'habits', 'journal']

/**
 * The areas that are each member's own whoever is asking: what you write,
 * keep up and wear. Both of us never counts another member's, and the device
 * never holds one to count (PERSONAL_KINDS, shared/kinds.mts).
 */
export const PERSONAL_AREAS: ReadonlySet<InsightArea> = new Set<InsightArea>(['journal', 'habits', 'wardrobe'])

/** Whose log the shared areas count: yours, or every member's in the household. */
export type Whose = 'mine' | 'both'

// ---- periods ---------------------------------------------------------------------

export type InsightPeriod = 'week' | 'month' | 'year'
export const INSIGHT_PERIODS: readonly { key: InsightPeriod; label: string }[] = [
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'year', label: 'Year' },
]

/** A calendar week, month or year, as day keys on the reader's calendar. */
export interface PeriodSpan {
  period: InsightPeriod
  /** Its own name: `2026-W39`, `2026-09` or `2026`. */
  key: string
  /** Its first day and its last, both included. */
  start: string
  end: string
  /** The last day counted: the end, or today while the period is still going. */
  last: string
  /** Today is in it. */
  current: boolean
}

const pad = (n: number) => String(n).padStart(2, '0')

/** The first and last day of the period holding `day`. */
function bounds(period: InsightPeriod, day: string): { start: string; end: string } {
  if (period === 'week') {
    const start = weekStartKey(day) ?? day
    return { start, end: shiftDayKey(start, 6) }
  }
  if (period === 'year') return { start: `${day.slice(0, 4)}-01-01`, end: `${day.slice(0, 4)}-12-31` }
  const [y, m] = [Number(day.slice(0, 4)), Number(day.slice(5, 7))]
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`
  return { start: `${day.slice(0, 7)}-01`, end: shiftDayKey(next, -1) }
}

/** The period's own name, from its first day. */
function keyOf(period: InsightPeriod, start: string): string {
  if (period === 'week') return weekKeyOf(start) ?? start
  return period === 'year' ? start.slice(0, 4) : start.slice(0, 7)
}

/**
 * The week, month or year holding `anchor`, as it stands on `today`: counted
 * up to today while it is still going. One that has not started yet is not a
 * period with anything in it, so a later anchor gives today's.
 */
export function periodSpan(period: InsightPeriod, anchor: string, today: string): PeriodSpan {
  const day = isDayKey(anchor) && anchor <= today ? anchor : today
  const { start, end } = bounds(period, day)
  const current = start <= today && today <= end
  return { period, key: keyOf(period, start), start, end, last: current ? today : end, current }
}

/** The period before this one, whole. */
export const previousSpan = (span: PeriodSpan, today: string): PeriodSpan => periodSpan(span.period, shiftDayKey(span.start, -1), today)

/** The period after this one, or null when this one is still going. */
export const nextSpan = (span: PeriodSpan, today: string): PeriodSpan | null => (span.current ? null : periodSpan(span.period, shiftDayKey(span.end, 1), today))

/**
 * What a period is compared with: the one before it, cut to as many days as
 * this one has counted while it is still going. On the 24th, this month is
 * the 1st to the 24th and so is last month; a finished month is set against
 * the whole month before it.
 */
export function comparedSpan(span: PeriodSpan, today: string): PeriodSpan {
  const prev = previousSpan(span, today)
  if (!span.current) return prev
  const cut = shiftDayKey(prev.start, daysBetween(span.start, span.last))
  return { ...prev, last: cut < prev.end ? cut : prev.end }
}

/**
 * A period named in a link (`?insights=month&period=2026-09`) or a notice:
 * `2026-W39`, `2026-09` or `2026`, and the day it starts on. Null for
 * anything else, so a crafted value lands nowhere.
 */
export function parsePeriodKey(key: string | null | undefined): { period: InsightPeriod; anchor: string } | null {
  const k = String(key ?? '')
  if (/^\d{4}$/.test(k)) return isDayKey(`${k}-01-01`) ? { period: 'year', anchor: `${k}-01-01` } : null
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(k)) return { period: 'month', anchor: `${k}-01` }
  const week = /^\d{4}-W\d{2}$/.test(k) ? weekKeyStart(k) : null
  return week ? { period: 'week', anchor: week } : null
}

const monthName = (key: string, today: string): string => {
  const name = MONTH_NAMES[Number(key.slice(5, 7)) - 1]
  return key.slice(0, 4) === today.slice(0, 4) ? name : `${name} ${key.slice(0, 4)}`
}
const shortDay = (key: string): string => `${MONTH_SHORT[Number(key.slice(5, 7)) - 1]} ${Number(key.slice(8, 10))}`
/** "Sep 13 – 19", or "Dec 28 – Jan 3" across a month. */
const weekRange = (span: PeriodSpan): string =>
  span.start.slice(0, 7) === span.end.slice(0, 7) ? `${shortDay(span.start)} – ${Number(span.end.slice(8, 10))}` : `${shortDay(span.start)} – ${shortDay(span.end)}`

/** A period's name at the head of the page: This week, Last week, Sep 13 – 19; This month, August, August 2025; This year, 2025. */
export function periodName(span: PeriodSpan, today: string): string {
  if (span.current) return span.period === 'week' ? 'This week' : span.period === 'month' ? 'This month' : 'This year'
  const last = previousSpan(periodSpan(span.period, today, today), today)
  if (span.period === 'week') return span.key === last.key ? 'Last week' : weekRange(span)
  return span.period === 'month' ? monthName(span.key, today) : span.key
}

/** The period inside a sentence: this week, last week, the week of Sep 13; this month, in August; this year, in 2025. */
export function periodPhrase(span: PeriodSpan, today: string): string {
  if (span.current) return `this ${span.period}`
  const last = previousSpan(periodSpan(span.period, today, today), today)
  if (span.period === 'week') return span.key === last.key ? 'last week' : `the week of ${shortDay(span.start)}`
  return `in ${span.period === 'month' ? monthName(span.key, today) : span.key}`
}

/** What a change is set against: on last week, on the week before; on August; on 2025. */
export function previousPhrase(span: PeriodSpan, today: string): string {
  const prev = previousSpan(span, today)
  if (span.period === 'week') return span.current ? 'on last week' : 'on the week before'
  return `on ${span.period === 'month' ? monthName(prev.key, today) : prev.key}`
}

/** "Your September in Drafter": the monthly recap's headline, for a month's key. */
export const recapTitle = (monthKey: string): string => `Your ${MONTH_NAMES[Number(monthKey.slice(5, 7)) - 1] ?? 'month'} in Drafter`

/** The month before the one `today` is in, as its key: what the recap on the 1st is about. */
export const lastMonthKey = (today: string): string => shiftDayKey(`${today.slice(0, 7)}-01`, -1).slice(0, 7)

// ---- the reader's calendar -------------------------------------------------------

/** The day an instant falls on, YYYY-MM-DD, in the reader's zone: the device's in the app, the member's on the server. */
export type DayKeyOf = (iso: string) => string | null | undefined

const HOUR = 3_600_000
const MINUTE = 60_000
const iso = (ms: number) => new Date(ms).toISOString()

/** An instant that falls on `key` in the reader's zone: its midday UTC, moved half a day where the zone is that far off. */
function instantOn(key: string, dayKeyOf: DayKeyOf): number {
  const noon = Date.parse(`${key}T12:00:00.000Z`)
  for (const shift of [0, -12, 12]) if (dayKeyOf(iso(noon + shift * HOUR)) === key) return noon + shift * HOUR
  return noon
}

/**
 * The first instant of a day in the reader's zone, found by stepping back from
 * an instant on it: an hour at a time, then a minute. So a period's edges are
 * the reader's midnights on the device and on the server alike, whatever the
 * zone and whatever daylight saving did to that day.
 */
export function dayStart(key: string, dayKeyOf: DayKeyOf): number {
  let t = instantOn(key, dayKeyOf)
  while (dayKeyOf(iso(t - HOUR)) === key) t -= HOUR
  while (dayKeyOf(iso(t - MINUTE)) === key) t -= MINUTE
  return t
}

/** A span's first instant, and the first of the day after its last: the range the Review's rules take. */
export const spanRange = (span: PeriodSpan, dayKeyOf: DayKeyOf): { start: number; end: number } => ({
  start: dayStart(span.start, dayKeyOf),
  end: dayStart(shiftDayKey(span.last, 1), dayKeyOf),
})

/** A day key's weekday, 0 = Sunday: the date's own, whatever the zone. */
const weekdayOf = (key: string): number => new Date(`${key}T12:00:00Z`).getUTCDay()

// ---- whose records ---------------------------------------------------------------

/** What the figures are counted from. */
export interface InsightInput {
  tasks: readonly Task[]
  /** Calendar entries written here: one that has happened with people on it counts as seeing them. */
  events?: readonly CalendarEntry[]
  people?: readonly Person[]
  places?: readonly Place[]
  meals?: readonly Meal[]
  recipes?: readonly Recipe[]
  journal?: readonly JournalEntry[]
  habits?: readonly Habit[]
  garments?: readonly Garment[]
  wears?: readonly Wear[]
  /** The viewer. Null in local mode, where every record is this device's own. */
  myId: string | null
  whose: Whose
  now: Date
  /** Today on the reader's calendar. */
  today: string
  dayKeyOf: DayKeyOf
}

/** The records each area counts, narrowed to whose log they are. */
export interface Scoped {
  /** The work the viewer's (isMineTask) under Mine; every task under Both. Finished work, what is open and money paid are counted from these. */
  work: Task[]
  /** Whose visits and outings count (ownVisit): the viewer under Mine, everyone under Both. The visit rules are handed every task and narrow it themselves. */
  visitsOf: string | null
  /** The meals that are part of the log: shared with the household or the viewer's own under Mine (mealCountsFor), all under Both. */
  meals: Meal[]
  /** The personal kinds: the viewer's own, under either. */
  journal: JournalEntry[]
  habits: Habit[]
  garments: Garment[]
  wears: Wear[]
}

/**
 * A record of a personal kind that is the viewer's own: one they wrote, or
 * one with no owner, which is this device's own (local mode, or a row from
 * before anyone signed in). With no viewer every record is theirs.
 */
export const ownRecord = (r: { ownerId?: string } | null | undefined, myId: string | null): boolean => !!r && (!myId || !r.ownerId || r.ownerId === myId)

/**
 * The records each area counts, by whose log is asked for. The one place
 * Mine and Both of us are decided: the Highlights, the areas' own pages and
 * the monthly recap all read what this hands back.
 */
export function scopeRecords(input: Pick<InsightInput, 'tasks' | 'meals' | 'journal' | 'habits' | 'garments' | 'wears' | 'myId' | 'whose'>): Scoped {
  const log = input.whose === 'both' ? null : input.myId
  const own = <T extends { ownerId?: string }>(list: readonly T[] | undefined): T[] => (list ?? []).filter(r => ownRecord(r, input.myId))
  return {
    work: input.tasks.filter(t => isMineTask(t, log)),
    visitsOf: log,
    meals: (input.meals ?? []).filter(m => mealCountsFor(m, log)),
    journal: own(input.journal),
    habits: own(input.habits),
    garments: own(input.garments),
    wears: own(input.wears),
  }
}

// ---- the figures -----------------------------------------------------------------

/** A named thing and how many of it: a person's days, a place's outings, a recipe's days. */
export interface Tally {
  id: string
  name: string
  n: number
}

/** One period's figures, each by the app's own rule. */
export interface SpanFigures {
  span: PeriodSpan
  tasks: {
    done: number
    /** Finished on each weekday, Sunday first. */
    weekdays: number[]
    /** Finished each day (a week, a month) or each month (a year), up to the last day counted. */
    series: number[]
  }
  money: { paid: number; byPayee: Tally[]; series: number[] }
  people: {
    /** Everyone seen, most days first. */
    seen: Tally[]
    /** The days with anyone. */
    days: number
  }
  places: {
    /** Each place gone to, most outings first. */
    visited: Tally[]
    outings: number
    /** Places whose first outing ever fell in the period. */
    firsts: Tally[]
  }
  kitchen: {
    cooked: number
    out: number
    bought: number
    /** Where the meals eaten out were, most first. */
    outAt: Tally[]
    /** The recipes cooked on the most days. */
    recipes: Tally[]
  }
  journal: { days: number; mood: number | null }
  habits: { done: number; due: number; pct: number; best: Tally | null }
  wardrobe: { days: number; worn: Tally[] }
  /** Runs as the period ended (or as it stands today): something done, and the journal. */
  streaks: { tasks: Streaks; journal: Streaks }
  /** Pieces never worn by the period's last day, the oldest first. */
  neverWorn: string[]
}

const byCount = (a: Tally, b: Tally) => b.n - a.n || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)

/** Where a day falls in a span's series: its day of the week or month, or its month of the year. */
const bucketOf = (span: PeriodSpan, day: string): number => (span.period === 'year' ? Number(day.slice(5, 7)) - 1 : daysBetween(span.start, day))
/** How long a span's series is: up to its last day counted. */
const seriesLength = (span: PeriodSpan): number => bucketOf(span, span.last) + 1

/** Every figure for one period. `scoped` is scopeRecords' answer for the same input. */
export function spanFigures(input: InsightInput, scoped: Scoped, span: PeriodSpan): SpanFigures {
  const { dayKeyOf, now, today } = input
  const range = spanRange(span, dayKeyOf)
  const inSpan = (day: string | null | undefined): day is string => !!day && day >= span.start && day <= span.last
  const length = seriesLength(span)

  // finished work (workDone), filed on the reader's calendar
  const weekdays = Array.from({ length: 7 }, () => 0)
  const doneSeries = Array.from({ length }, () => 0)
  let done = 0
  const doneDays: string[] = []
  for (const t of workDone(scoped.work)) {
    const day = dayKeyOf(t.completedAt as string)
    if (day) doneDays.push(day)
    if (!inRange(t.completedAt, range.start, range.end) || !inSpan(day)) continue
    done++
    weekdays[weekdayOf(day)]++
    doneSeries[bucketOf(span, day)]++
  }

  // money paid (payments), by who was paid
  const paidSeries = Array.from({ length }, () => 0)
  const payees = new Map<string, number>()
  let paid = 0
  for (const p of payments(scoped.work)) {
    const day = dayKeyOf(p.at)
    if (!inRange(p.at, range.start, range.end) || !inSpan(day)) continue
    paid += p.amount
    paidSeries[bucketOf(span, day)] += p.amount
    payees.set(p.payee, (payees.get(p.payee) ?? 0) + p.amount)
  }

  // who was seen (seenTasks, visitsFor, visitDays), whose log `visitsOf` says
  const seenLog = seenTasks(input.tasks, input.events ?? [], now, scoped.visitsOf)
  const seen: Tally[] = []
  const anyDay = new Set<string>()
  for (const p of input.people ?? []) {
    if (!p || p.deletedAt) continue
    const visits = visitsFor(p.id, seenLog).filter(v => inRange(v.at, range.start, range.end))
    const days = visitDays(visits, dayKeyOf)
    for (const d of days) anyDay.add(d)
    if (days.length) seen.push({ id: p.id, name: p.name, n: days.length })
  }

  // where you went (outingsAt: a done task there, or a meal eaten out there)
  const saved = savedPlaces(input.places ?? [])
  const visited: Tally[] = []
  const firsts: Tally[] = []
  let outings = 0
  for (const place of saved.values()) {
    const all = outingsAt(place.id, input.tasks, input.meals ?? [], now, scoped.visitsOf)
    const here = all.filter(o => inRange(o.at, range.start, range.end))
    if (!here.length) continue
    outings += here.length
    visited.push({ id: place.id, name: place.name, n: here.length })
    // newest first, so the last is the first time there ever was
    if (inRange(all[all.length - 1].at, range.start, range.end)) firsts.push({ id: place.id, name: place.name, n: here.length })
  }

  // how the meals were had (mealWays), and what was cooked (cookedRecipeIds)
  const ways = mealWays(scoped.meals, saved, now, today)
  const kitchen = { cooked: 0, out: 0, bought: 0 }
  const outAt = new Map<string, number>()
  const cookedDays = new Map<string, Set<string>>()
  for (const m of scoped.meals) {
    const way = ways.get(m.id)
    if (!way || !inSpan(m.date)) continue
    kitchen[way]++
    if (way === 'out' && m.placeId) outAt.set(m.placeId, (outAt.get(m.placeId) ?? 0) + 1)
    if (way === 'cooked') for (const id of cookedRecipeIds(m, today)) cookedDays.set(id, (cookedDays.get(id) ?? new Set<string>()).add(m.date))
  }
  const recipeNames = new Map((input.recipes ?? []).filter(r => r && !r.deletedAt).map(r => [r.id, r.name]))

  // the journal: the days written on, and the mood of the entries that carry one
  const entries = scoped.journal.filter(e => !e.deletedAt && inSpan(e.date))
  const mood = moodAverage(entries)

  // habits: the Review's own count of due days kept, and the run each ended on
  const kept = habitsKept(scoped.habits, range, now, dayKeyOf)
  const best = kept.rows.reduce<(typeof kept.rows)[number] | null>((a, r) => (r.streak > (a?.streak ?? 0) ? r : a), null)

  // the wardrobe: days logged, and each piece's days, as the index files them
  const ix = wearIndex(scoped.wears, span.last)
  const names = new Map(scoped.garments.filter(g => !g.deletedAt).map(g => [g.id, g.name]))
  const worn: Tally[] = []
  for (const [id, days] of ix.days) {
    const n = days.filter(d => d >= span.start).length
    const name = names.get(id)
    if (n && name) worn.push({ id, name, n })
  }

  return {
    span,
    tasks: { done, weekdays, series: doneSeries },
    money: { paid, byPayee: [...payees].map(([name, n]) => ({ id: name, name, n })).sort(byCount), series: paidSeries },
    people: { seen: seen.sort(byCount), days: anyDay.size },
    places: { visited: visited.sort(byCount), outings, firsts: firsts.sort(byCount) },
    kitchen: {
      ...kitchen,
      outAt: [...outAt].flatMap(([id, n]) => (saved.has(id) ? [{ id, name: saved.get(id)!.name, n }] : [])).sort(byCount),
      recipes: [...cookedDays].flatMap(([id, days]) => (recipeNames.has(id) ? [{ id, name: recipeNames.get(id)!, n: days.size }] : [])).sort(byCount),
    },
    journal: { days: writtenDays(scoped.journal).filter(inSpan).length, mood: mood ?? null },
    habits: { done: kept.done, due: kept.due, pct: kept.pct, best: best ? { id: best.habit.id, name: best.habit.name, n: best.streak } : null },
    wardrobe: { days: ix.logged.filter(d => d >= span.start).length, worn: worn.sort(byCount) },
    streaks: {
      tasks: dayStreaks(doneDays, span.last),
      journal: journalStreaks(scoped.journal, span.last),
    },
    neverWorn: neverWorn(scoped.garments, ix, undefined, at => dayKeyOf(at) ?? '').map(g => g.name),
  }
}

/** A period's figures, the ones it is compared with, and whose log they count. */
export interface InsightFigures {
  current: SpanFigures
  previous: SpanFigures
  whose: Whose
  today: string
}

/** Every figure the Highlights read: this period's and the one it is compared with (comparedSpan), by one scoping. */
export function insightFigures(input: InsightInput, span: PeriodSpan): InsightFigures {
  const scoped = scopeRecords(input)
  return {
    current: spanFigures(input, scoped, span),
    previous: spanFigures(input, scoped, comparedSpan(span, input.today)),
    whose: input.whose,
    today: input.today,
  }
}

// ---- the cards -------------------------------------------------------------------

export type HighlightKind = 'tasks-done' | 'tasks-streak' | 'money' | 'people' | 'places' | 'kitchen' | 'journal' | 'habits' | 'wardrobe-days' | 'wardrobe-never'

/** The small picture a card carries, drawn by the Stats kit: a sparkline, a ring, or a bar split into its parts. */
export type HighlightVisual =
  | { kind: 'spark'; series: number[] }
  | { kind: 'ring'; value: number; of: number; label: string }
  | { kind: 'split'; parts: { key: string; label: string; value: number }[] }

/** A change on the period before: by how much, in words, and what it is set against. */
export interface HighlightDelta {
  by: number
  /** "↑7", "↓$120.00", "same as". */
  text: string
  /** "on last week", "on August". */
  than: string
}

export interface Highlight {
  /** Stable: one card of each kind. */
  id: HighlightKind
  kind: HighlightKind
  /** The area its tap opens. */
  area: InsightArea
  /**
   * Whose figure it is, when that needs saying: 'both' counts every member's
   * log, 'just-you' is a personal figure shown under Both of us, and null is
   * simply the viewer's own.
   */
  who: 'both' | 'just-you' | null
  title: string
  delta?: HighlightDelta
  detail?: string
  visual?: HighlightVisual
  /** The card as one plain line: the recap's body, and the card's name for a screen reader. */
  line: string
  /** How interesting the rules found it; the feed is drawn most first. */
  score: number
}

/** At most this many cards on the page. */
export const MAX_HIGHLIGHTS = 8
/** Days in a row worth saying. */
const MIN_STREAK = 3

/** A change as the card says it; money is dollars, and a share is in points. */
function delta(by: number, than: string, unit: 'n' | 'money' | 'points' = 'n'): HighlightDelta {
  const size = Math.abs(by)
  const amount = unit === 'money' ? formatMoney(size) : unit === 'points' ? `${size} ${size === 1 ? 'point' : 'points'}` : size.toLocaleString('en-US')
  return { by, text: by > 0 ? `↑${amount}` : by < 0 ? `↓${amount}` : 'same as', than: by === 0 ? than.replace(/^on /, '') : than }
}

/** How much more interesting a rise makes a card, and how much less a fall. */
const lift = (now: number, before: number): number => (now > before ? Math.min(15, 3 + Math.round((10 * (now - before)) / Math.max(1, before))) : now < before ? -5 : 0)

/** "A and B twice each", or "most often A, 3 times": what leads a tally, when one thing or a few lead it. */
function leaders(list: readonly Tally[], mostOften = 'most often'): string | undefined {
  const top = list[0]
  if (!top || list.length < 2) return undefined
  const tied = list.filter(t => t.n === top.n)
  if (tied.length === 1) return `${mostOften} ${top.name}, ${times(top.n)}`
  if (tied.length <= 3 && top.n > 1) return `${andList(tied.map(t => t.name))} ${times(top.n)} each`
  return undefined
}

/**
 * The cards worth drawing for a period, most interesting first, at most
 * MAX_HIGHLIGHTS: each made by a rule over the figures, never for a figure of
 * nothing. The same answer on the device and in the recap for the same records.
 */
export function pickHighlights(figs: InsightFigures): Highlight[] {
  const { current: cur, previous: prev, whose, today } = figs
  const span = cur.span
  const phrase = periodPhrase(span, today)
  const than = previousPhrase(span, today)
  const both = whose === 'both'
  const past = !span.current
  const cards: Omit<Highlight, 'line' | 'id'>[] = []
  const shared = (area: InsightArea): Highlight['who'] => (both ? (PERSONAL_AREAS.has(area) ? 'just-you' : 'both') : null)
  const card = (c: Omit<Highlight, 'line' | 'id' | 'who'>) => cards.push({ ...c, who: shared(c.area) })

  // what got done
  if (cur.tasks.done > 0) {
    const top = Math.max(...cur.tasks.weekdays)
    const day = cur.tasks.weekdays.indexOf(top)
    const clear = cur.tasks.done >= 3 && top >= 2 && cur.tasks.weekdays.filter(n => n === top).length === 1
    const whoseBest = both ? 'the busiest' : 'your best'
    card({
      kind: 'tasks-done',
      area: 'tasks',
      title: `${count(cur.tasks.done, 'task')} done ${phrase}`,
      delta: delta(cur.tasks.done - prev.tasks.done, than),
      detail: !clear ? undefined : span.period === 'week' ? `${WEEKDAYS[day]} was ${both ? 'the busiest day' : 'your best day'}` : `${WEEKDAYS[day]}s ${past ? 'were' : 'are'} ${whoseBest}`,
      visual: cur.tasks.series.length > 1 ? { kind: 'spark', series: cur.tasks.series } : undefined,
      score: 55 + lift(cur.tasks.done, prev.tasks.done),
    })
  }
  const runs = cur.streaks.tasks
  if (runs.current >= MIN_STREAK) {
    const record = runs.current >= runs.best
    card({
      kind: 'tasks-streak',
      area: 'tasks',
      title: `Something done ${runs.current} days in a row`,
      detail: record ? 'your longest yet' : `your best is ${runs.best}`,
      score: 48 + Math.min(20, runs.current) + (record ? 15 : 0),
    })
  }

  // money paid
  if (cur.money.paid > 0) {
    const top = cur.money.byPayee[0]
    card({
      kind: 'money',
      area: 'money',
      title: `Paid ${formatMoney(cur.money.paid)} ${phrase}`,
      delta: delta(Math.round(cur.money.paid - prev.money.paid), than, 'money'),
      detail: top && cur.money.byPayee.length > 1 ? `${top.name} ${past ? 'was' : 'is'} the biggest` : undefined,
      visual: cur.money.series.length > 1 ? { kind: 'spark', series: cur.money.series.map(n => Math.round(n)) } : undefined,
      score: 44 + lift(cur.money.paid, prev.money.paid) / 3,
    })
  }

  // who you saw
  const seen = cur.people.seen
  if (seen.length > 0) {
    const title = both
      ? seen.length === 1
        ? `${seen[0].name} seen between you ${phrase}`
        : `${count(seen.length, 'person', 'people')} seen between you ${phrase}`
      : seen.length === 1
        ? `You saw ${seen[0].name} ${phrase}`
        : `You saw ${count(seen.length, 'person', 'people')} ${phrase}`
    const days = seen.length === 1 ? `on ${count(seen[0].n, 'day')}` : undefined
    const lead = seen.length > 1 && seen[0].n > seen[1].n ? `most often ${seen[0].name}` : undefined
    card({
      kind: 'people',
      area: 'people',
      title,
      delta: delta(seen.length - prev.people.seen.length, than),
      detail: lead ?? days,
      visual: { kind: 'ring', value: cur.people.days, of: Math.max(1, daysBetween(span.start, span.last) + 1), label: String(cur.people.days) },
      score: 52 + Math.min(10, 2 * seen.length) + lift(seen.length, prev.people.seen.length) / 2,
    })
  }

  // where you went
  const visited = cur.places.visited
  if (visited.length > 0) {
    const firsts = cur.places.firsts
    const first = firsts.length ? `first time at ${andList(firsts.slice(0, 2).map(f => f.name))}${firsts.length > 2 ? ` and ${count(firsts.length - 2, 'more place')}` : ''}` : undefined
    card({
      kind: 'places',
      area: 'places',
      title: visited.length === 1 ? `${both ? 'Went' : 'You went'} to ${visited[0].name} ${phrase}` : `${both ? 'Went' : 'You went'} to ${count(visited.length, 'place')} ${phrase}`,
      delta: delta(visited.length - prev.places.visited.length, than),
      detail: first ?? leaders(visited) ?? (visited.length === 1 ? times(visited[0].n) : undefined),
      score: 48 + Math.min(10, 2 * visited.length) + (firsts.length ? 8 : 0),
    })
  }

  // what you ate
  const k = cur.kitchen
  if (k.cooked + k.out + k.bought > 0) {
    const away = k.out + k.bought
    const title = away && k.cooked ? `Out ${times(away)}, cooked ${k.cooked} ${phrase}` : away ? `Out ${times(away)} ${phrase}` : `Cooked ${count(k.cooked, 'meal')} ${phrase}`
    const dish = k.recipes[0] && k.recipes[0].n > 1 && (k.recipes.length === 1 || k.recipes[1].n < k.recipes[0].n) ? `${k.recipes[0].name} ${times(k.recipes[0].n)}` : undefined
    card({
      kind: 'kitchen',
      area: 'kitchen',
      title,
      detail: leaders(k.outAt, 'mostly') ?? dish,
      visual: {
        kind: 'split',
        parts: [
          { key: 'cooked', label: 'Cooked', value: k.cooked },
          { key: 'out', label: 'Eaten out', value: k.out },
          { key: 'bought', label: 'Bought', value: k.bought },
        ],
      },
      score: 50 + (k.cooked > away ? 4 : 0) + (k.outAt.length ? 3 : 0),
    })
  }

  // the journal: its run leads when there is one, the days written otherwise
  const jr = cur.streaks.journal
  if (jr.current >= MIN_STREAK) {
    const record = jr.current >= jr.best
    card({
      kind: 'journal',
      area: 'journal',
      title: `Journal ${jr.current} days in a row`,
      detail: [record ? 'your longest yet' : '', cur.journal.days > jr.current ? `written on ${count(cur.journal.days, 'day')} ${phrase}` : ''].filter(Boolean).join(' · ') || undefined,
      score: 68 + Math.min(20, jr.current) + (record ? 15 : 0),
    })
  } else if (cur.journal.days > 0) {
    card({
      kind: 'journal',
      area: 'journal',
      title: `Wrote in the journal on ${count(cur.journal.days, 'day')} ${phrase}`,
      delta: delta(cur.journal.days - prev.journal.days, than),
      detail: cur.journal.mood !== null ? `mood ${cur.journal.mood.toFixed(1)} of 5` : undefined,
      visual: { kind: 'ring', value: cur.journal.days, of: Math.max(1, daysBetween(span.start, span.last) + 1), label: String(cur.journal.days) },
      score: 42 + Math.min(10, cur.journal.days) + lift(cur.journal.days, prev.journal.days) / 2,
    })
  }

  // habits kept on the days they were due
  const h = cur.habits
  if (h.due > 0 && h.done > 0) {
    const run = h.best && h.best.n >= MIN_STREAK ? `${h.best.name} ${h.best.n} days in a row` : undefined
    card({
      kind: 'habits',
      area: 'habits',
      title: `Habits kept ${h.pct}% of the time`,
      delta: prev.habits.due > 0 ? delta(h.pct - prev.habits.pct, than, 'points') : undefined,
      detail: [`${h.done} of ${h.due} due days`, run].filter(Boolean).join(' · '),
      visual: { kind: 'ring', value: h.done, of: h.due, label: `${h.pct}%` },
      score: 46 + (h.pct >= 80 ? 12 : 0) + (run ? 5 : 0),
    })
  }

  // clothes: the days logged, and what nobody has worn
  const w = cur.wardrobe
  if (w.days > 0) {
    const top = w.worn[0] && w.worn[0].n > 1 && (w.worn.length === 1 || w.worn[1].n < w.worn[0].n) ? `most worn: ${w.worn[0].name}, ${count(w.worn[0].n, 'day')}` : undefined
    card({
      kind: 'wardrobe-days',
      area: 'wardrobe',
      title: `Outfit logged on ${count(w.days, 'day')} ${phrase}`,
      delta: delta(w.days - prev.wardrobe.days, than),
      detail: top,
      score: 38 + Math.min(8, w.days / 2),
    })
  }
  if (cur.neverWorn.length > 0) {
    const [first, ...rest] = cur.neverWorn
    card({
      kind: 'wardrobe-never',
      area: 'wardrobe',
      title: rest.length ? `${first} and ${count(rest.length, 'more piece')}: never worn` : `${first}: never worn`,
      score: 28 + Math.min(6, cur.neverWorn.length),
    })
  }

  const order = (c: Omit<Highlight, 'line' | 'id'>) => INSIGHT_AREAS.indexOf(c.area)
  return cards
    .sort((a, b) => b.score - a.score || order(a) - order(b))
    .slice(0, MAX_HIGHLIGHTS)
    .map(c => ({ ...c, id: c.kind, line: highlightLine(c) }))
}

/** A card as one plain line: "19 tasks done this week, ↑7 on last week · Tuesdays are your best". */
export function highlightLine(c: Pick<Highlight, 'who' | 'title' | 'delta' | 'detail'>): string {
  const change = c.delta ? `, ${c.delta.by === 0 ? `the same as ${c.delta.than}` : `${c.delta.text} ${c.delta.than}`}` : ''
  return `${c.who === 'just-you' ? 'Just you: ' : ''}${c.title}${change}${c.detail ? ` · ${c.detail}` : ''}`
}

/** The recap's body: the first few cards' lines, most interesting first. */
export const recapLines = (cards: readonly Highlight[], n = 4): string[] => cards.slice(0, n).map(c => c.line)
