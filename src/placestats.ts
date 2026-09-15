import { driftedFrom, filedAt, type PlaceStats } from './places'
import { monthsAndTrend, topN, type DayWindow } from './stats'
import { MEAL_SLOTS, PLACE_CATEGORIES, PLACE_CATEGORY_META, type Person, type Place, type PlaceCategory } from './types'
import { dateKey } from './utils'

// People → Places → Stats: every figure it shows, worked out from the same
// PlaceStats the list's rows are (placeStats, over outingsAt), so a done task
// there and a past meal eaten out there are one outing each, a meal still to
// come is none, and a figure here agrees with the same figure on a row. The
// view hands in the tasks and meals the list is handed, so Mine / Everyone
// narrows neither: places are the household's. The list's kind chip and find
// box narrow the places before anything is counted, by the list's own rule
// (placeMatcher), so each figure counts only the rows the list shows. What
// counts by the calendar — this year, this month, a year's months, a day —
// files a meal on its own date (filedAt), as the year table always has; the
// ranked windows count the last 30 days and 12 months in
// instants, as a row's "12mo" does. A tie never falls to the order the store
// holds things in: it ends on the name, then the id. Pure: no DOM, and the
// clock is handed in. Only the Stats view reads this module, so it loads with
// that view's chunk.

const DAY_MS = 86_400_000

/** Whether an outing at `at` falls in a ranked chart's window, by a row's own rule (visitSummary): its age in instants. */
function within(at: string, window: DayWindow, nowMs: number): boolean {
  return window === 'all' || nowMs - Date.parse(at) < window * DAY_MS
}

/** A place's outings in a window: its row's "12mo" for 12 months, its "all time" for All. */
export function outingsWithin(s: PlaceStats, window: DayWindow, now: Date = new Date()): number {
  const nowMs = now.getTime()
  return s.visits.filter(v => within(v.at, window, nowMs)).length
}

/** A to Z, then the id: two places (or people) of one name keep one order, whatever order the store holds them in. */
const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)

/** A tie goes to the place you went to last; one never been to comes after; then A to Z. */
const latestFirst = (a: PlaceStats, b: PlaceStats) => (b.lastAt ?? '').localeCompare(a.lastAt ?? '') || byName(a.place, b.place)

/** A rhythm you set that is due or overdue a return: the Been a while tile's rule, and Today's and the digest's. */
export const dueBack = (s: PlaceStats) => s.status === 'due' || s.status === 'overdue'

// ---- the kind chips ----------------------------------------------------------------

/** A chip for each kind you have places of, in the kinds' own order, with how many: the list's chips and their badges. */
export function kindChips(places: readonly Place[]): { kind: PlaceCategory; count: number }[] {
  return PLACE_CATEGORIES.flatMap(kind => {
    const count = places.filter(p => p.category === kind).length
    return count ? [{ kind, count }] : []
  })
}

// ---- the tiles ---------------------------------------------------------------------

export interface PlacesTiles {
  /** Places saved: the list's All. */
  places: number
  /** Outings this calendar year, as the year table sums them. */
  outingsThisYear: number
  /** …and this calendar month: this year's column for it. */
  outingsThisMonth: number
  /** Places with a rhythm, due or overdue a return. */
  beenAWhile: number
  /** Places whose first outing was this year. */
  newThisYear: number
}

export function placesTiles(stats: readonly PlaceStats[], now: Date = new Date()): PlacesTiles {
  const year = now.getFullYear()
  const month = now.getMonth()
  let outingsThisYear = 0
  let outingsThisMonth = 0
  let newThisYear = 0
  for (const s of stats) {
    const filed = s.visits.map(v => new Date(filedAt(v)))
    for (const d of filed) {
      if (d.getFullYear() !== year) continue
      outingsThisYear++
      if (d.getMonth() === month) outingsThisMonth++
    }
    const first = filed.reduce<Date | undefined>((a, d) => (!a || d < a ? d : a), undefined)
    if (first && first.getFullYear() === year) newThisYear++
  }
  return { places: stats.length, outingsThisYear, outingsThisMonth, beenAWhile: stats.filter(dueBack).length, newThisYear }
}

// ---- ranked ------------------------------------------------------------------------

/** A place as the kit ranks it. */
export interface RankedPlace {
  key: string
  name: string
  count: number
  place: Place
}

/** The most visited in a window, most first: the podium (all time, three) and the bars. A tie goes to the latest, then A to Z, then the id. */
export function mostVisited(stats: readonly PlaceStats[], window: DayWindow, now: Date = new Date(), n = 10): RankedPlace[] {
  const count = (s: PlaceStats) => outingsWithin(s, window, now)
  return topN(stats, n, { count, name: s => s.place.name, tie: latestFirst }).map(s => ({ key: s.place.id, name: s.place.name, count: count(s), place: s.place }))
}

// ---- the lists ---------------------------------------------------------------------

/**
 * Been before, and further back than their rhythm: the one you set, due or
 * overdue (the Been a while tile's), or for a place with none, your usual one
 * there (driftedFrom, "Where should we go?"'s drifted-from). A rhythm you set
 * that is still on track keeps a place off, however long the gap. Longest
 * since first.
 */
export function notBeenBack(stats: readonly PlaceStats[]): PlaceStats[] {
  return stats
    .filter(s => s.visits.length > 0 && (s.status === 'none' ? driftedFrom(s) : dueBack(s)))
    .sort((a, b) => (b.daysSince ?? 0) - (a.daysSince ?? 0) || byName(a.place, b.place))
}

/** Saved, with no outing yet: the one waiting longest first. */
export function neverBeen(stats: readonly PlaceStats[]): PlaceStats[] {
  return stats.filter(s => s.visits.length === 0).sort((a, b) => a.place.createdAt.localeCompare(b.place.createdAt) || byName(a.place, b.place))
}

// ---- by the calendar ---------------------------------------------------------------

/** Every outing at every place, filed as the year table files it; a meal keeps its slot's place in the day (-1 for a task). */
const filed = (stats: readonly PlaceStats[]) =>
  stats.flatMap(s => s.visits.map(v => ({ place: s.place, at: filedAt(v), slot: v.kind === 'meal' ? MEAL_SLOTS.indexOf(v.meal.slot) : -1 })))

/** Outings each month of `year`, the year's total and the trend: the year table's rows added up. */
export function outingsByMonth(stats: readonly PlaceStats[], year: number, now: Date = new Date()): { months: number[]; total: number; trend: number } {
  return monthsAndTrend(filed(stats), year, now)
}

/**
 * Each day's places on this device's calendar: where you went, each place
 * once, in the order you first went there that day. Every meal files at
 * midday, so lunch out and dinner out tie on the instant: the slot settles
 * it, breakfast first, and then the name and the id, never the store's order.
 */
export function placesByDay(stats: readonly PlaceStats[]): Map<string, Place[]> {
  const out = new Map<string, Place[]>()
  const order = filed(stats).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.slot - b.slot || byName(a.place, b.place))
  for (const { place, at } of order) {
    const key = dateKey(at)
    const went = out.get(key)
    if (!went) out.set(key, [place])
    else if (!went.some(p => p.id === place.id)) went.push(place)
  }
  return out
}

// ---- by kind -----------------------------------------------------------------------

/** A kind of place as the kit ranks it: its outings in the window, and their share of every kind's. */
export interface KindShare {
  key: PlaceCategory
  name: string
  emoji: string
  count: number
  /** 0–1 of the window's outings. */
  share: number
}

/** Outings by kind of place in a window, most first; a tie keeps the kinds' own order. A kind with none is left out. */
export function outingsByKind(stats: readonly PlaceStats[], window: DayWindow, now: Date = new Date()): KindShare[] {
  const counts = new Map<PlaceCategory, number>()
  for (const s of stats) counts.set(s.place.category, (counts.get(s.place.category) ?? 0) + outingsWithin(s, window, now))
  const total = PLACE_CATEGORIES.reduce((n, c) => n + (counts.get(c) ?? 0), 0)
  const rows = PLACE_CATEGORIES.map(c => {
    const count = counts.get(c) ?? 0
    return { key: c, name: PLACE_CATEGORY_META[c].label, emoji: PLACE_CATEGORY_META[c].emoji, count, share: total ? count / total : 0 }
  })
  return topN(rows, rows.length, { count: r => r.count, name: r => r.name, tie: (a, b) => PLACE_CATEGORIES.indexOf(a.key) - PLACE_CATEGORIES.indexOf(b.key) })
}

// ---- company -----------------------------------------------------------------------

/** A person as the kit ranks them. */
export interface RankedPerson {
  key: string
  name: string
  count: number
  person: Person
}

/**
 * Who is on your outings, most first: a done task at one of your places with
 * them ticked counts once for each, as the Where should we go? With row and a
 * person's "where we go" count it. A meal eaten out records the place, not
 * the company, so it names nobody. A tie goes A to Z, then to the id.
 */
export function companyOnOutings(stats: readonly PlaceStats[], people: readonly Person[], window: DayWindow, now: Date = new Date(), n = 8): RankedPerson[] {
  const nowMs = now.getTime()
  const counts = new Map<string, number>()
  for (const s of stats)
    for (const v of s.visits) {
      if (v.kind !== 'task' || !within(v.at, window, nowMs)) continue
      for (const id of new Set(v.task.peopleIds ?? [])) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
  const rows = people.map(person => ({ key: person.id, name: person.name, count: counts.get(person.id) ?? 0, person }))
  return topN(rows, n, { count: r => r.count, name: r => r.name, tie: (a, b) => byName(a.person, b.person) })
}

/** A top place and whoever you most often go there with. */
export interface UsualCompany {
  place: Place
  person: Person
  /** Outings there with them. */
  count: number
}

/** Your most visited places of all time, each with the first of its row's "Usually with"; a place you only go to alone is left out. */
export function usualCompany(stats: readonly PlaceStats[], n = 5): UsualCompany[] {
  return topN(stats, n, { count: s => s.visits.length, name: s => s.place.name, tie: latestFirst }).flatMap(s => {
    const first = s.companions[0]
    return first ? [{ place: s.place, person: first.person, count: first.count }] : []
  })
}

// ---- meals out ---------------------------------------------------------------------

/** A place's meals eaten out in the year, and the latest of them. */
export interface MealsOutRow {
  key: string
  name: string
  count: number
  place: Place
  /** Its latest, as a day key. */
  last: string
}

/**
 * The meals eaten out at your places in `year`, counted as the Outings tile
 * counts them: a meal marked as eaten out at a saved place, once its day has
 * come, filed on its own date. Most first, then the latest, then A to Z.
 */
export function mealsOut(stats: readonly PlaceStats[], year: number): { rows: MealsOutRow[]; total: number } {
  const rows = stats.flatMap(s => {
    const days = s.visits.flatMap(v => (v.kind === 'meal' && new Date(filedAt(v)).getFullYear() === year ? [v.meal.date] : []))
    return days.length ? [{ key: s.place.id, name: s.place.name, count: days.length, place: s.place, last: days.reduce((a, b) => (b > a ? b : a)) }] : []
  })
  return {
    rows: topN(rows, rows.length, { count: r => r.count, name: r => r.name, tie: (a, b) => b.last.localeCompare(a.last) || byName(a.place, b.place) }),
    total: rows.reduce((n, r) => n + r.count, 0),
  }
}
