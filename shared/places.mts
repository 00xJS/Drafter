// Place rules shared by the web app and the MCP server. Dependency-free ESM.

import type { Meal, Place, Task } from '../src/types.ts'
import { ownVisit, remindersOff } from './people.mts'
import { doneOuting, mealOut, mealOutings, taskIndex } from './visitindex.mts'

export type PlaceCategory = 'restaurant' | 'fastfood' | 'cafe' | 'bar' | 'outdoors' | 'venue' | 'shop' | 'home' | 'other'

/**
 * The kinds of place, in the order the app offers them. One list for the app
 * and the MCP server: a category added here is one an assistant can save and
 * filter by too, instead of being refused as invalid.
 */
export const PLACE_CATEGORIES: PlaceCategory[] = ['restaurant', 'fastfood', 'cafe', 'bar', 'outdoors', 'venue', 'shop', 'home', 'other']

/** How each category reads: the app's chips and pickers, and the MCP tool descriptions. */
export const PLACE_CATEGORY_META: Record<PlaceCategory, { label: string; emoji: string }> = {
  restaurant: { label: 'Restaurant', emoji: '🍽️' },
  fastfood: { label: 'Fast food', emoji: '🍔' },
  cafe: { label: 'Café', emoji: '☕' },
  bar: { label: 'Bar', emoji: '🍸' },
  outdoors: { label: 'Outdoors', emoji: '🌳' },
  venue: { label: 'Venue', emoji: '🎭' },
  shop: { label: 'Shop', emoji: '🛍️' },
  home: { label: 'Home', emoji: '🏠' },
  other: { label: 'Other', emoji: '📍' },
}

/** Lower-case, no diacritics or punctuation, single spaces — so "NOPI, 21 Warwick St" and "Nopi" can meet. */
export function normalisePlaceText(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The most other names a place keeps. */
export const MAX_PLACE_ALIASES = 12
const ALIAS_MAX = 80
const ADDRESS_MAX = 200

/** One line with single spaces, cut to `max` characters. */
const oneLine = (s: string, max: number): string => String(s).replace(/\s+/g, ' ').trim().slice(0, max).trim()

/** A place's address as it is kept: one line, or undefined when there is none. */
export function tidyPlaceAddress(v: unknown): string | undefined {
  return typeof v === 'string' ? oneLine(v, ADDRESS_MAX) || undefined : undefined
}

/**
 * A place's other names ("Pret" for Pret A Manger) as the editor, the
 * sanitizer and the MCP server all keep them: each on one line, each once
 * however it is capitalised, never the place's own name over again, and at
 * most MAX_PLACE_ALIASES. Undefined when none are left, so a place without
 * any carries no empty list.
 */
export function tidyPlaceAliases(v: unknown, name?: string | null): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const seen = new Set([oneLine(name ?? '', ALIAS_MAX).toLowerCase()])
  const out: string[] = []
  const list: readonly unknown[] = v
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const alias = oneLine(raw, ALIAS_MAX)
    if (!alias || seen.has(alias.toLowerCase())) continue
    seen.add(alias.toLowerCase())
    out.push(alias)
    if (out.length === MAX_PLACE_ALIASES) break
  }
  return out.length ? out : undefined
}

/**
 * The shortest name or other name looked for among the words of a longer
 * text. One of one or two letters ("BK", "Q") is too little to go on there,
 * where it could be any word ("Meet up at the station" for a bar called Up):
 * it links only a text that is exactly it, or a location that opens with it
 * as the venue, before the first comma or line ("BK, High St").
 */
const MIN_TERM = 3

/**
 * What a place goes by, normalised, each with its rank for a tie: its name
 * (0), its other names (1) and its address (2). Whatever is not a string, as
 * a malformed row may carry, is left out.
 */
function placeTerms(p: Pick<Place, 'name' | 'aliases' | 'address'>): { n: string; rank: number }[] {
  const aliases: string[] = Array.isArray(p.aliases) ? p.aliases.filter(a => typeof a === 'string') : []
  return [
    { n: normalisePlaceText(p.name), rank: 0 },
    ...aliases.map(a => ({ n: normalisePlaceText(a), rank: 1 })),
    { n: normalisePlaceText(typeof p.address === 'string' ? p.address : ''), rank: 2 },
  ].filter(t => t.n)
}

/**
 * normalisePlaceText letter for letter, except that a hyphen inside a word
 * stays: "co-op high st" where normalisePlaceText gives "co op high st". The
 * two line up, so a term found in one is checked in the other for a hyphen
 * gluing it to the word beside it.
 */
function keepHyphens(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, (run: string, at: number, all: string) => (run === '-' && at > 0 && at + 1 < all.length ? '-' : ' '))
    .trim()
}

/**
 * An address that names a door: it opens with a house number and runs to
 * three words or more ("21-22 Warwick St, London"). A street, a town or a
 * shopping centre ("Oxford St, London", "London W2") is every venue's on it,
 * so an address without a number links only a location that is exactly it.
 */
function namesADoor(address: string): boolean {
  const words = address.split(' ')
  return words.length >= 3 && /\d/.test(words[0])
}

/**
 * Find the saved place a free-text location refers to: an event's location,
 * a question, a place an assistant names. A place goes by its name, its other
 * names and its address, and the text finds it by any of them.
 *
 * The whole text being one of them wins first: a place's own name before
 * anyone's other name, and an other name before an address. Otherwise
 * - a name or other name is found as a run of whole words inside the text
 *   ("Nopi" in "NOPI, 21 Warwick St"), never part of a word: "Bo" is not in
 *   "Bob's Diner", and a hyphen makes one word, so "Wok" is not in
 *   "Wok-to-Walk". One of one or two letters counts only as the venue the
 *   text opens with (MIN_TERM).
 * - an address is found only at the start of the text, and only when it
 *   names a door (namesADoor). After another venue's name it is that venue's
 *   address too: a food hall, a shopping centre.
 * The earliest found wins, then the longer, then a place's own name before an
 * other name before an address. Never fuzzier than that — a wrong match would
 * log an outing somewhere you never went.
 */
export function matchPlace(text: string | null | undefined, places: readonly Place[]): Place | null {
  const joined = keepHyphens(text)
  const needle = joined.replace(/-/g, ' ')
  if (!needle) return null
  const terms = (places ?? []).filter(p => p && !p.deletedAt && p.name).flatMap(p => placeTerms(p).map(t => ({ ...t, p })))
  const exact = terms.filter(t => t.n === needle).sort((a, b) => a.rank - b.rank)[0]
  if (exact) return exact.p
  // a location string usually opens with the venue, before its first comma or line
  const venue = normalisePlaceText(String(text ?? '').split(/[,;\n]/)[0])
  const padded = ` ${needle} `
  const foundAt = ({ n, rank }: { n: string; rank: number }): number => {
    if (rank === 2) return namesADoor(n) && padded.startsWith(` ${n} `) && joined[n.length] !== '-' ? 0 : -1
    if (n.length < MIN_TERM) return n === venue ? 0 : -1
    let at = padded.indexOf(` ${n} `)
    // glued to the word beside it by a hyphen: try the next time it comes up
    while (at >= 0 && (joined[at - 1] === '-' || joined[at + n.length] === '-')) at = padded.indexOf(` ${n} `, at + 1)
    return at
  }
  const found = terms
    .map(t => ({ ...t, at: foundAt(t) }))
    .filter(t => t.at >= 0)
    .sort((a, b) => a.at - b.at || b.n.length - a.n.length || a.rank - b.rank)
  return found[0]?.p ?? null
}

const DAY_MS = 86_400_000

/**
 * Midday UTC for a date-only key. A meal records a day, not an instant, and
 * midday UTC lands on that same calendar day in every zone from UTC-12 to
 * UTC+11, which midnight would not. East of UTC+11 (all of New Zealand, Tonga,
 * Kiribati) it is already the next day, so a count that files outings by month
 * or year re-dates a meal to local midday on its own date first
 * (placeYearReport in src/places.ts).
 */
const middayOf = (dateKey: string): string => `${dateKey}T12:00:00.000Z`

/** A done task at the place, or a past meal you marked as eaten out there. */
export type Outing = { kind: 'task'; task: Task; at: string } | { kind: 'meal'; meal: Meal; at: string }

/**
 * Everything that counts as having been to this place, newest first.
 *
 * Two things count, and they are the same event seen from different tabs: a
 * done task carrying the place, and a meal you marked as eaten out there. A
 * takeaway IS an outing — counting it is what lets "how often do we eat there"
 * and "been a while" agree instead of drifting apart.
 *
 * Open tasks and tombstones never count, and neither does a meal in the
 * FUTURE: next Friday's booking is a plan, not a visit, so it must not reset a
 * cadence or inflate a count. Meals are optional so every existing caller keeps
 * working unchanged.
 *
 * `myId` narrows it to YOUR outings (v3.24). The list of places is the
 * household's — one favourite café — but going there is not something both
 * members did because one of them did. A logged outing is whoever logged it's
 * (ownVisit). A meal is the exception, and deliberately: a meal SHARED with
 * the household is the evening you both ate out, so it counts for both, while
 * a meal kept to yourself counts for you alone. `shared` absent reads as
 * shared, which is every meal written before v3.22.
 */
export function outingsAt(placeId: string, tasks: readonly Task[], meals: readonly Meal[] = [], now: Date | string = new Date(), myId: string | null = null): Outing[] {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now)
  // each list's outings filed by place once (shared/visitindex.mts), so asking
  // about every place reads the lists once rather than once per place
  const index = taskIndex(tasks)
  const done = index ? (index.outings.get(placeId) ?? []) : (tasks ?? []).filter((t): t is Task & { completedAt: string } => doneOuting(t) && t.placeId === placeId)
  const out = mealOutings(meals)
  const eaten = out ? (out.get(placeId) ?? []) : (meals ?? []).filter(m => mealOut(m) && m.placeId === placeId)
  const fromTasks = done.filter(t => ownVisit(t, myId)).map((t): Outing => ({ kind: 'task', task: t, at: t.completedAt }))
  const fromMeals = eaten
    .filter(m => m.shared !== false || ownVisit(m, myId))
    .map((m): Outing => ({ kind: 'meal', meal: m, at: middayOf(m.date) }))
    .filter(v => Date.parse(v.at) <= nowMs)
  return [...fromTasks, ...fromMeals].sort((a, b) => b.at.localeCompare(a.at))
}

/** 'none': no rhythm set. 'off': No reminders, chosen. Neither is ever due. */
export type PlaceCadenceState = 'none' | 'off' | 'never' | 'ok' | 'due' | 'overdue'

export interface PlaceCadenceStatus {
  status: PlaceCadenceState
  /** Empty when no cadence is set, or on No reminders. */
  reason: string
  lastAt?: string
  daysSince?: number
  cadenceDays?: number
}

/**
 * Cadence status for one place. Opt-in per place: there is deliberately no
 * default cadence for places (people fall back to 90 days) — a restaurant you
 * never set a rhythm for must never read as due or overdue on Today or in the
 * digest. Same 1× due / 1.5× overdue thresholds as people once a cadence is set.
 *
 * 'off' is No reminders (remindersOff), a choice rather than a gap: never
 * nudged, and left out of Stats' Not been back and Never been as well, where a
 * place with no rhythm ('none') still shows once you have drifted from it.
 * Meals are required so every caller decides: one that leaves them out says
 * "been a while" about the place you ate at last night.
 */
export function placeCadenceStatus(place: Place, tasks: readonly Task[], now: Date, meals: readonly Meal[], myId?: string | null): PlaceCadenceStatus
export function placeCadenceStatus(place: Place, tasks: readonly Task[], now: Date = new Date(), meals: readonly Meal[] = [], myId: string | null = null): PlaceCadenceStatus {
  if (remindersOff(place)) return { status: 'off', reason: '' }
  const cadence = Number(place?.cadenceDays)
  if (!Number.isFinite(cadence) || cadence <= 0) return { status: 'none', reason: '' }
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now)
  const lastAt = outingsAt(place.id, tasks, meals, now, myId)[0]?.at
  if (!lastAt) {
    return { status: 'never', reason: `No outings yet — you aimed for every ${cadence} days`, cadenceDays: cadence }
  }
  const daysSince = Math.floor((nowMs - Date.parse(lastAt)) / DAY_MS)
  let status: PlaceCadenceState
  let reason: string
  if (daysSince > cadence * 1.5) {
    status = 'overdue'
    reason = `Last went ${daysSince} days ago — you aimed for every ${cadence} days`
  } else if (daysSince > cadence) {
    status = 'due'
    reason = `It's been ${daysSince} days; you aimed for every ${cadence} days`
  } else {
    status = 'ok'
    reason = daysSince <= 0 ? 'Went today' : `Last went ${daysSince} day${daysSince === 1 ? '' : 's'} ago`
  }
  return { status, reason, lastAt, daysSince, cadenceDays: cadence }
}
