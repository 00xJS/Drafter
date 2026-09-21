import { Meal, PLACE_CATEGORY_META, Person, Place, PlaceCategory, Task } from './types'
import { monthsAndTrend, visitSummary, visitsFor } from './people'
import {
  Outing,
  PlaceCadenceState,
  PlaceCadenceStatus,
  matchPlace as sharedMatchPlace,
  normalisePlaceText,
  placeCadenceStatus,
  outingsAt as sharedOutingsAt,
  tidyPlaceAddress,
  tidyPlaceAliases,
} from '../shared/places.mjs'

export { normalisePlaceText, placeCadenceStatus, tidyPlaceAddress, tidyPlaceAliases }
export type { Outing, PlaceCadenceState, PlaceCadenceStatus }

/**
 * The saved place a free-text location (calendar LOCATION, a note) refers to,
 * or undefined: by its name, one of its other names or its address, as whole
 * words (rule in shared/places.mjs).
 */
export function matchPlace(text: string | null | undefined, places: Place[]): Place | undefined {
  return sharedMatchPlace(text, places) ?? undefined
}

/** The editor's Other names box, "Pret, Pret A Manger": split at the commas and tidied as every other name is. */
export function placeAliasesFromText(text: string, name: string): string[] | undefined {
  return tidyPlaceAliases(text.split(','), name)
}

/**
 * Whether Open in Maps goes to Apple Maps: on an iPhone, iPad or Mac, the
 * iPhone app included (its web view says iPhone). iPadOS Safari says it is a
 * Mac, which the Mac test covers. Everywhere else gets Google Maps.
 */
export function prefersAppleMaps(nav: { userAgent?: string; platform?: string } | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  if (!nav) return false
  return /iPhone|iPad|iPod|Macintosh|Mac OS X/i.test(nav.userAgent ?? '') || /^(Mac|iPhone|iPad|iPod)/i.test(nav.platform ?? '')
}

/** Open in Maps: the pin when it has one, else a search for the address, else the name. */
export function mapsUrl(place: Pick<Place, 'name' | 'address' | 'lat' | 'lon'>, apple: boolean): string {
  if (place.lat != null && place.lon != null) {
    const ll = `${place.lat},${place.lon}`
    return apple
      ? `https://maps.apple.com/?ll=${ll}&q=${encodeURIComponent(place.name.trim() || ll)}`
      : `https://www.google.com/maps/search/?api=1&query=${ll}`
  }
  const query = encodeURIComponent(place.address?.trim() || place.name.trim())
  return apple ? `https://maps.apple.com/?q=${query}` : `https://www.google.com/maps/search/?api=1&query=${query}`
}

/** Places' find box: the lower-cased query in a place's name, other names, address or notes. */
export function findsPlace(p: Place, needle: string): boolean {
  if (!needle) return true
  return [p.name, ...(p.aliases ?? []), p.address ?? '', p.notes ?? ''].some(s => s.toLowerCase().includes(needle))
}

/** What the Places list's kind chip and find box are set to: a kind of place, or 'all', and what is typed. */
export interface PlaceFilter {
  category: 'all' | PlaceCategory
  q: string
}

/** The list as it opens: every kind, nothing typed. */
export const NO_PLACE_FILTER: PlaceFilter = { category: 'all', q: '' }

/** The kind chip that is on: the one chosen, or All once no place of that kind is left, as its chip has gone with it. */
export function kindOn(places: readonly Place[], category: PlaceFilter['category']): PlaceFilter['category'] {
  return category !== 'all' && places.some(p => p.category === category) ? category : 'all'
}

/**
 * The Places list's rule for which places it shows: of the kind whose chip is
 * on (kindOn), with what is typed in the find box (findsPlace). Places → Stats
 * counts only the places it keeps, so every figure there agrees with the rows.
 */
export function placeMatcher(places: readonly Place[], filter: PlaceFilter): (p: Place) => boolean {
  const kind = kindOn(places, filter.category)
  const needle = filter.q.trim().toLowerCase()
  return p => (kind === 'all' || p.category === kind) && findsPlace(p, needle)
}

/**
 * A place's name as the key for "is this the same place": its letters, digits
 * and symbols in any script, in order, with case, accents, punctuation and
 * spacing set aside. So "Cafe Kafka" is "Café Kafka" and "Franco's" is
 * "Franco’s", but 金龙 is not 银龙, Grøn is not Græn and C++ Bar is not C Bar.
 *
 * normalisePlaceText is the wrong key for this: it keeps only a–z and 0–9, to
 * find a place's name inside a calendar location, so each of those pairs would
 * come out as one name and a visit would be logged at the wrong place. Only the
 * Latin accents it strips are stripped here; other scripts' marks (a Hindi
 * vowel sign, a Japanese dakuten) spell different words, so they stay. Spacing
 * accents (´ `), often typed for an apostrophe, count as punctuation.
 */
export function placeNameKey(name: string | null | undefined): string {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Sm}\p{Sc}\p{So}]+/gu, ' ')
    .trim()
}

/**
 * The saved place a typed name means, or undefined when it is genuinely new.
 *
 * Used when somewhere new is named, planning a meal or in a Where picker.
 * Matching on placeNameKey is what stops a fortnight of takeaways leaving
 * three spellings of the same restaurant, which would split its counts and
 * make "how often do we eat there" meaningless, without ever taking one
 * place's name for another's. A place's own name comes first, then one of
 * its other names: "Pret" is the Pret A Manger that goes by it, not a second
 * Pret beside it.
 */
export function placeByName(name: string | null | undefined, places: readonly Place[]): Place | undefined {
  const key = placeNameKey(name)
  if (!key) return undefined
  const live = places.filter(p => !p.deletedAt)
  return live.find(p => placeNameKey(p.name) === key) ?? live.find(p => (p.aliases ?? []).some(a => placeNameKey(a) === key))
}

/**
 * A place name being typed into a Where picker: the name tidied, the saved
 * place it already means, and up to eight places whose names hold it, that one
 * first and those that only another of their names holds last. The saved
 * place is placeByName's, so "Cafe Kafka" is "Café Kafka" and "Pret" is Pret A
 * Manger, and the picker reuses it instead of offering to make a second copy,
 * while "金龙 Restaurant" is offered as new beside a saved "银龙 Restaurant".
 */
export function placeSearch(query: string, places: readonly Place[]): { name: string; exact?: Place; matches: Place[] } {
  const name = query.trim().replace(/\s+/g, ' ')
  if (!name) return { name, exact: undefined, matches: [] }
  const key = placeNameKey(name)
  const live = places.filter(p => !p.deletedAt)
  const exact = placeByName(name, live)
  const holds = (s: string) => !!key && placeNameKey(s).includes(key)
  const byName = live.filter(p => p.id !== exact?.id && holds(p.name))
  const byOther = live.filter(p => p.id !== exact?.id && !holds(p.name) && (p.aliases ?? []).some(holds))
  return { name, exact, matches: [...(exact ? [exact] : []), ...byName, ...byOther].slice(0, 8) }
}

/**
 * Somewhere new, as the app saves it: the name tidied and the kind you picked.
 * Every path that makes a place from a typed name or an event's location builds
 * it here, and the kind is required — there is none to fall back on, so a place
 * is never filed under one nobody chose.
 */
export function newPlace(name: string, category: PlaceCategory, opts: { id: string; color: string; now: Date; address?: string; lat?: number; lon?: number }): Place {
  const stamp = opts.now.toISOString()
  const address = tidyPlaceAddress(opts.address)
  return {
    kind: 'place',
    id: opts.id,
    name: name.trim().replace(/\s+/g, ' '),
    category,
    color: opts.color,
    ...(address ? { address } : {}),
    ...(opts.lat != null && opts.lon != null ? { lat: opts.lat, lon: opts.lon } : {}),
    createdAt: stamp,
    updatedAt: stamp,
  }
}

/**
 * The place a name typed for somewhere new ends up as: the saved place it
 * already means (placeByName), reused without asking anything, else a new one
 * of the kind you picked. With no kind picked nothing is made and it answers
 * null, so the caller's Save waits for one.
 */
export function placeFor(
  name: string,
  kind: PlaceCategory | undefined,
  places: readonly Place[],
  create: (name: string, kind: PlaceCategory) => Place,
): { place: Place; created: boolean } | null {
  const clean = name.trim().replace(/\s+/g, ' ')
  if (!clean) return null
  const saved = placeByName(clean, places)
  if (saved) return { place: saved, created: false }
  return kind ? { place: create(clean, kind), created: true } : null
}

/** A place's own emoji, else its category's: what its row on Places shows. */
export function placeEmoji(p: Place): string {
  return p.emoji || PLACE_CATEGORY_META[p.category].emoji
}

/** How long a loved place can go unvisited before it counts as lapsed. */
export const LAPSED_AFTER_DAYS = 120

/** Places with at least two outings in the last year, most visited first. */
export function favourites(places: Place[], tasks: Task[], people: Person[] = [], now: Date = new Date(), meals: Meal[] = []): PlaceStats[] {
  return places
    .map(p => placeStats(p, tasks, people, now, meals))
    .filter(s => s.count365 >= 2)
    .sort((a, b) => b.count365 - a.count365 || (b.lastAt ?? '').localeCompare(a.lastAt ?? ''))
}

/**
 * Places you loved and drifted from: two or more outings ever, and longer since
 * the last one than both LAPSED_AFTER_DAYS and twice your usual gap there.
 */
export function lapsed(places: Place[], tasks: Task[], people: Person[] = [], now: Date = new Date(), meals: Meal[] = []): PlaceStats[] {
  return places
    .map(p => placeStats(p, tasks, people, now, meals))
    .filter(driftedFrom)
    .sort((a, b) => b.visits.length - a.visits.length)
}

/**
 * lapsed()'s rule for one place: two or more outings, and longer since the
 * last than both LAPSED_AFTER_DAYS and twice your usual gap there. Places →
 * Stats's "Not been back" reads it for a place with no rhythm of its own.
 */
export function driftedFrom(s: PlaceStats): boolean {
  return s.visits.length >= 2 && s.daysSince !== undefined && s.daysSince > Math.max(LAPSED_AFTER_DAYS, s.avgGapDays ? 2 * s.avgGapDays : 0)
}

/**
 * Everything that counts as having been to a place, newest first: done tasks
 * carrying it, plus past meals marked as eaten out there. Open tasks,
 * tombstones and FUTURE meals are ignored (rule in shared/places.mjs).
 */
export function outingsAt(placeId: string, tasks: Task[], meals: Meal[] = [], now: Date = new Date(), myId?: string | null): Outing[] {
  return sharedOutingsAt(placeId, tasks, meals, now, myId) as Outing[]
}

export interface Companion {
  person: Person
  count: number
}

export interface PlaceStats {
  place: Place
  visits: Outing[]
  lastAt?: string
  daysSince?: number
  count365: number
  avgGapDays?: number
  weekly: number[]
  companions: Companion[]
  /** One-line list reason; when the place is due/overdue it ends with the rhythm you set. */
  reason: string
  /** 'none' unless the place has a cadence — a place without one is never due. */
  status: PlaceCadenceState
  /** Meals eaten out here, all time. The "how often do we eat there" number. */
  eatenOut: number
  /** …and in the last year, to sit beside count365. */
  eatenOut365: number
}

function placeReason(lastAt: string | undefined, daysSince: number | undefined, count365: number, eatenOut365 = 0): string {
  if (!lastAt) return 'No outings yet'
  const ago =
    daysSince === undefined
      ? 'recently'
      : daysSince <= 0
        ? 'today'
        : daysSince === 1
          ? 'yesterday'
          : `${daysSince} days ago`
  // "3 of them meals" is the answer to "how often do we eat there" — shown only
  // when some of those outings actually were meals. Both counts are the last 12
  // months, as the row's 12mo figure is, so the wording says so: the calendar
  // year is the tile's and the year table's.
  const eating = eatenOut365 > 0 ? ` · ate here ${eatenOut365} time${eatenOut365 === 1 ? '' : 's'}` : ''
  return `Last went ${ago} · ${count365} time${count365 === 1 ? '' : 's'} in 12 months${eating}`
}

export function companionsAt(placeId: string, people: Person[], tasks: Task[]): Companion[] {
  const counts = new Map<string, number>()
  // Only tasks name who was there; a meal records the place, not the company.
  for (const v of outingsAt(placeId, tasks)) {
    if (v.kind !== 'task') continue
    for (const id of v.task.peopleIds ?? []) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([id, count]) => {
      const person = people.find(p => p.id === id)
      return person ? { person, count } : null
    })
    .filter((c): c is Companion => !!c)
    .sort((a, b) => b.count - a.count || a.person.name.localeCompare(b.person.name))
    .slice(0, 5)
}

export function placeStats(place: Place, tasks: Task[], people: Person[], now: Date = new Date(), meals: Meal[] = [], myId?: string | null): PlaceStats {
  const visits = outingsAt(place.id, tasks, meals, now, myId)
  const summary = visitSummary(visits, now)
  const cadence = placeCadenceStatus(place, tasks, now, meals, myId)
  const eatenOut365 = visits.filter(v => v.kind === 'meal' && now.getTime() - Date.parse(v.at) < 365 * 86_400_000).length
  const base = placeReason(summary.lastAt, summary.daysSince, summary.count365, eatenOut365)
  const nagging = cadence.status === 'due' || cadence.status === 'overdue'
  return {
    place,
    visits,
    lastAt: summary.lastAt,
    daysSince: summary.daysSince,
    count365: summary.count365,
    avgGapDays: summary.avgGapDays,
    weekly: summary.weekly,
    companions: companionsAt(place.id, people, tasks),
    eatenOut: visits.filter(v => v.kind === 'meal').length,
    eatenOut365,
    reason: nagging ? `${base} — you aimed for every ${cadence.cadenceDays} days` : base,
    status: cadence.status,
  }
}

export interface PlaceYearRow {
  place: Place
  /** Outings per month, Jan..Dec of the given year. */
  months: number[]
  /** Outings in the year. */
  total: number
  /** Positive = going more lately, negative = drifting (outings in the last 90 days vs the 90 before). */
  trend: number
}

/**
 * The year in places: outings per month for each place, most first. It counts
 * what every other Places figure counts (outingsAt): a done task there is one
 * outing and a meal eaten out there is one, while a meal still to come is not
 * one yet. People counts days instead, because three events with one group on
 * a Saturday are one time you saw them; lunch and dinner at the same place are
 * two meals out, so here each outing counts. A meal is filed under its own
 * date (filedAt), as Kitchen and the calendar show it.
 */
export function placeYearReport(places: Place[], tasks: Task[], meals: Meal[], year: number, now: Date = new Date()): PlaceYearRow[] {
  return places
    .map(place => {
      // re-dated after outingsAt, so a meal still to come stays out
      const outings = outingsAt(place.id, tasks, meals, now).map(v => ({ at: filedAt(v) }))
      return { place, ...monthsAndTrend(outings, year, now) }
    })
    .sort((a, b) => b.total - a.total || a.place.name.localeCompare(b.place.name))
}

/**
 * The instant an outing is filed under when it is counted by month or year. A
 * task keeps its own. A meal records a day, not an instant, so it goes at local
 * midday on its own date: outingsAt dates it midday UTC, which east of UTC+11
 * (all of New Zealand) is already the next day, and would put the takeaway
 * eaten on 31 December in the next year's table. Places → Stats files by it
 * too, wherever it counts by the calendar: a year, a month, a day.
 */
export function filedAt(v: Outing): string {
  if (v.kind !== 'meal') return v.at
  const [y, m, d] = v.meal.date.split('-').map(Number)
  return new Date(y, m - 1, d, 12).toISOString()
}

/**
 * The newest outings anywhere, read off each place's own: a done task there or
 * a past meal eaten out there, as the rows and the Kitchen count them.
 */
export function recentOutings(stats: PlaceStats[], limit = 6): { place: Place; outing: Outing }[] {
  return stats
    .flatMap(s => s.visits.map(outing => ({ place: s.place, outing })))
    .sort((a, b) => b.outing.at.localeCompare(a.outing.at))
    .slice(0, limit)
}

export interface PlaceWithPerson {
  place: Place
  count: number
  lastAt: string
}

/** Places logged on visits with this person, by outing count. */
export function placesWith(personId: string, places: Place[], tasks: Task[]): PlaceWithPerson[] {
  const byPlace = new Map<string, { count: number; lastAt: string }>()
  for (const v of visitsFor(personId, tasks)) {
    const pid = v.task.placeId
    if (!pid) continue
    const cur = byPlace.get(pid)
    if (!cur) byPlace.set(pid, { count: 1, lastAt: v.at })
    else {
      cur.count++
      if (v.at.localeCompare(cur.lastAt) > 0) cur.lastAt = v.at
    }
  }
  return [...byPlace.entries()]
    .map(([id, stats]) => {
      const place = places.find(p => p.id === id)
      return place ? { place, ...stats } : null
    })
    .filter((x): x is PlaceWithPerson => !!x)
    .sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt))
}
