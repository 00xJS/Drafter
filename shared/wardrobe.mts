// The wardrobe's rules the app and the MCP server share: what a look is, how
// a log writes one, and the three lists Stats shows. Dependency-free ESM. The
// app's src/wardrobe.ts re-exports each of these under the same name and keeps
// the rest — the words, the suggestions, the figures by month — to itself.
//
// Nothing here rewrites a look or an outfit because a piece changed or went
// away: every reader resolves ids through liveById, so a piece in Trash drops
// out of every list and key, and Restore brings its history back exactly.
// Every figure counts distinct days, so a second look on one day never makes a
// piece "worn twice".

import type { Garment, GarmentType, Outfit, Wear } from '../src/types.ts'
import { newerStamp } from './domain.mts'
import { localDayKey } from './journal.mts'
import { daysBetween, daysWithin, topN } from './stats.mts'

/** A piece's types in slot order, top to toe (GARMENT_TYPES in src/types.ts; wardrobe-shared.test.ts holds them equal). */
export const GARMENT_TYPES: GarmentType[] = ['top', 'bottom', 'onepiece', 'outerwear', 'shoes', 'accessory']
/** What makes a look a look: top(s) and bottom(s), or a one-piece. */
export const CORE_TYPES: GarmentType[] = ['top', 'bottom', 'onepiece']
/** Most pieces an outfit or a look can hold. */
export const MAX_PIECES = 12
/** The longest note a look keeps (LOOK_NOTE_MAX in src/types.ts; wardrobe-shared.test.ts holds them equal). */
export const LOOK_NOTE_MAX = 120

// ---- ids and writers -------------------------------------------------------------

/** Ten random characters: hex from randomUUID where there is one, as src/utils.ts uid(). */
function randomTen(): string {
  const u = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return u.replace(/-/g, '').slice(0, 10)
}

/** wear~YYYY-MM-DD~ and 10 random characters: the journal's pattern. */
export const wearId = (day: string, rand: () => string = randomTen): string => `wear~${day}~${rand()}`

/** Unique, trimmed ids in order, capped: what the sanitizer would keep of an outfit's or a look's pieces. */
export function cleanIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map(id => id.trim()).filter(Boolean))].slice(0, MAX_PIECES)
}

/** Oldest look first: when it was made, then its id, so two looks made in one millisecond still keep an order. */
const byCreated = (a: Wear, b: Wear): number => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)

/** A new look for a day. */
export function newWear(day: string, garmentIds: readonly string[], now: string = new Date().toISOString(), rand?: () => string): Wear {
  return { kind: 'wear', id: wearId(day, rand), date: day, garmentIds: cleanIds(garmentIds), createdAt: now, updatedAt: now }
}

/** The look with other pieces, stamped newer than the copy it was made on. */
export function withPieces(w: Wear, garmentIds: readonly string[]): Wear {
  return { ...w, garmentIds: cleanIds(garmentIds), updatedAt: newerStamp(w.updatedAt) }
}

/** Live looks on a day, oldest first (createdAt, then id); the last is what "Wearing this" edits. */
export function looksOn(wears: readonly Wear[], day: string): Wear[] {
  return wears.filter(w => !w.deletedAt && w.date === day).sort(byCreated)
}

/**
 * A look put together ahead for its day and not yet confirmed worn. The one
 * test every figure and every last-worn date goes through (wearIndex), in the
 * app and over MCP: a plan counts once it is confirmed, and one whose day
 * passed unconfirmed never does.
 */
export const isPlanned = (w: Wear): boolean => w.planned === true

/**
 * A look filed as a plan (`planned` true) or as worn (false), with its note as
 * given ('' clears it); either left out stays as it was. Unstamped: the
 * writers stamp.
 */
export function marked(w: Wear, as: { planned?: boolean; note?: string } = {}): Wear {
  const { planned, note } = as
  const next = { ...w }
  if (planned === true) next.planned = true
  else if (planned === false) delete next.planned
  if (note !== undefined) {
    const text = String(note).trim().slice(0, LOOK_NOTE_MAX)
    if (text) next.note = text
    else delete next.note
  }
  return next
}

// ---- identity --------------------------------------------------------------------

const CORE = new Set(CORE_TYPES)
/** A top, a bottom or a one-piece (CORE_TYPES): what a look's core is made of. */
export const isCoreType = (type: GarmentType): boolean => CORE.has(type)
/** A type's place in a row of pieces, top to toe (GARMENT_TYPES). */
export const slotOf = (type: GarmentType): number => GARMENT_TYPES.indexOf(type)
/** A top and a bottom, or a one-piece: enough to be dressed. */
const dresses = (types: ReadonlySet<GarmentType>): boolean => types.has('onepiece') || (types.has('top') && types.has('bottom'))

/** Live garments by id, retired ones included; deleted and purged are absent, so every reader drops them. */
export function liveById(garments: readonly Garment[]): Map<string, Garment> {
  return new Map(garments.filter(g => !g.deletedAt && !g.purged).map(g => [g.id, g]))
}

/** Pieces in slot order (GARMENT_TYPES), stable within a slot; unknown ids dropped. */
export function orderPieces(ids: readonly string[], byId: ReadonlyMap<string, Garment>): string[] {
  return [...new Set(ids)].filter(id => byId.has(id)).sort((a, b) => slotOf(byId.get(a)!.type) - slotOf(byId.get(b)!.type))
}

/**
 * Whether putting `g` on takes the place of `other` in a look: a piece of its
 * own type, a one-piece for a top and a bottom, and either of those for a
 * one-piece. An accessory joins the others, and a piece with no record at all
 * (deleted forever, or not synced here yet) is never displaced.
 */
function displaces(g: Garment, other: Garment | undefined): boolean {
  if (!other || g.type === 'accessory') return false
  if (other.type === g.type) return true
  if (g.type === 'onepiece') return other.type === 'top' || other.type === 'bottom'
  return other.type === 'onepiece' && (g.type === 'top' || g.type === 'bottom')
}

/** A log: the look to write, and what its Undo puts back — that look as it was, stamped newer again, or the new one to remove. */
export interface LookLog {
  write: Wear
  undo: Wear | { remove: string }
}

/**
 * Pieces logged on a day. With `another`, or on a day with no look yet, a new
 * look. Otherwise the day's latest look takes them under its own id, stamped
 * newer. What that look held and the screen did not show (`shown`; by default
 * the composer's rows, every live and unretired piece) stays, unless a new
 * piece takes its slot: a retired piece, or one in Trash, keeps its day, and
 * nothing is written that nobody chose. `records` is every piece this device
 * has, Trash included, so one in Trash still has a slot; an id with no record
 * always stays. The piece sheet's Wear today is a log of one piece that shows
 * none of today's look. `now` stamps a new look, and `rand` makes its id.
 *
 * A log is a look worn unless `planned` makes it a plan (a day still to
 * come), so logging a day whose latest look was a plan confirms that plan,
 * as the composer's Wearing this and an assistant's log_outfit do: a caller
 * that logs one piece and shows none of the plan (a piece's Wear today) logs
 * `another` beside it instead. `wearId` edits that look of the day instead of
 * the latest. `note`, when given, is the look's note; '' clears it.
 */
export function logLook(
  wears: readonly Wear[],
  day: string,
  pieces: readonly string[],
  records: readonly Garment[],
  opts: { another?: boolean; wearId?: string; shown?: ReadonlySet<string>; now?: string; rand?: () => string; planned?: boolean; note?: string } = {},
): LookLog {
  const as = { planned: opts.planned ?? false, note: opts.note }
  const looks = opts.another ? [] : looksOn(wears, day)
  const latest = opts.wearId && !opts.another ? looks.find(w => w.id === opts.wearId) ?? looks[looks.length - 1] : looks[looks.length - 1]
  if (!latest) {
    const write = marked(newWear(day, pieces, opts.now, opts.rand), as)
    return { write, undo: { remove: write.id } }
  }
  const known = new Map(records.filter(g => !g.purged).map(g => [g.id, g]))
  const shown = opts.shown ?? new Set([...known.values()].filter(g => !g.deletedAt && !g.archivedAt).map(g => g.id))
  const putOn = pieces.map(id => known.get(id)).filter((g): g is Garment => !!g)
  const kept = latest.garmentIds.filter(id => !pieces.includes(id) && !shown.has(id) && !putOn.some(g => displaces(g, known.get(id))))
  const write = marked(withPieces(latest, [...pieces, ...kept]), as)
  return { write, undo: { ...latest, updatedAt: newerStamp(write.updatedAt) } }
}

/** Exact combination: sorted unique ids joined by '+'. */
export const pieceKey = (ids: readonly string[]): string => [...new Set(ids)].sort().join('+')

/**
 * The core: every known piece whose type is in CORE_TYPES, sorted, joined by
 * '+'; null unless it holds a top and a bottom, or a one-piece. Shoes,
 * outerwear and accessories never split "White tee + Jeans" into two entries.
 */
export function coreKey(ids: readonly string[], byId: ReadonlyMap<string, Garment>): string | null {
  const core = [...new Set(ids)].filter(id => {
    const g = byId.get(id)
    return !!g && CORE.has(g.type)
  })
  return dresses(new Set(core.map(id => byId.get(id)!.type))) ? core.sort().join('+') : null
}

/** Enough to dress: a live, unretired top and bottom, or a one-piece. The Today card shows only then. */
export function canDress(garments: readonly Garment[]): boolean {
  return dresses(new Set(garments.filter(g => !g.deletedAt && !g.archivedAt).map(g => g.type)))
}

/**
 * Wearable as it is: every piece live and unretired, and a core among them.
 * What a Today chip offers, and all a saved outfit's Wear today will log.
 */
export function wearable(ids: readonly string[], byId: ReadonlyMap<string, Garment>): boolean {
  return (
    ids.length > 0 &&
    ids.every(id => {
      const g = byId.get(id)
      return !!g && !g.archivedAt
    }) &&
    coreKey(ids, byId) !== null
  )
}

/**
 * What of these pieces is not in use, in words: "Old band tee is retired",
 * "Old band tee and Mac are retired", "A piece was deleted", or both; '' when
 * every one is live and unretired.
 */
export function notInUse(ids: readonly string[], byId: ReadonlyMap<string, Garment>): string {
  const names = [...new Set(ids)].map(id => byId.get(id)).filter((g): g is Garment => !!g?.archivedAt).map(g => g.name)
  const retiredLine = names.length === 0 ? '' : names.length === 1 ? `${names[0]} is retired` : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are retired`
  return [retiredLine, ids.some(id => !byId.has(id)) ? 'A piece was deleted' : ''].filter(Boolean).join(' · ')
}

/** Why these pieces cannot be worn as they are — what is retired or deleted, or no core — or null when they can. */
export function unwearable(ids: readonly string[], byId: ReadonlyMap<string, Garment>): string | null {
  return wearable(ids, byId) ? null : notInUse(ids, byId) || 'It needs a top and a bottom, or a one-piece'
}

/**
 * "Navy tee + Black jeans": the core first, in slot order, at most three
 * names, then "+ n more"; "Pieces since deleted" when none is known.
 */
export function outfitLabel(ids: readonly string[], byId: ReadonlyMap<string, Garment>): string {
  const known = orderPieces(ids, byId)
  if (known.length === 0) return 'Pieces since deleted'
  const isCore = (id: string) => CORE.has(byId.get(id)!.type)
  const ordered = [...known.filter(isCore), ...known.filter(id => !isCore(id))]
  const names = ordered.slice(0, 3).map(id => byId.get(id)!.name)
  const more = ordered.length - names.length
  return more > 0 ? `${names.join(' + ')} + ${more} more` : names.join(' + ')
}

// ---- the index every figure reads ------------------------------------------------

export interface WearIndex {
  dayKey: string
  /** garment id → distinct days worn, newest first; never after dayKey. */
  days: ReadonlyMap<string, readonly string[]>
  /** Every day with a live, non-empty look, newest first. */
  logged: readonly string[]
  /** day → its live, non-empty looks, oldest first. */
  looks: ReadonlyMap<string, readonly Wear[]>
}

/**
 * Skips deleted looks, empty looks, plans (isPlanned: a plan counts once it is
 * confirmed worn, and one whose day passed unconfirmed never does) and any
 * date after dayKey (clock skew). Two looks on a day are one day.
 */
export function wearIndex(wears: readonly Wear[], dayKey: string): WearIndex {
  const looks = new Map<string, Wear[]>()
  for (const w of wears) {
    if (w.deletedAt || isPlanned(w) || w.garmentIds.length === 0 || !w.date || w.date > dayKey) continue
    const list = looks.get(w.date)
    if (list) list.push(w)
    else looks.set(w.date, [w])
  }
  for (const list of looks.values()) list.sort(byCreated)
  const logged = [...looks.keys()].sort().reverse()
  const days = new Map<string, string[]>()
  // newest day first, so each piece's days come out newest first
  for (const day of logged) {
    for (const id of new Set(looks.get(day)!.flatMap(w => w.garmentIds))) {
      const list = days.get(id)
      if (list) list.push(day)
      else days.set(id, [day])
    }
  }
  return { dayKey, days, logged, looks }
}

/** Days among these inside the `window` days ending on dayKey — counted in day keys, never milliseconds (shared/stats.mts). */
export { daysWithin }

// ---- the lists -------------------------------------------------------------------

/**
 * A window in day keys. A day filed at midday would cross visitSummary's
 * millisecond 30-day line during the afternoon, and the list would change
 * between the morning and the evening.
 */
export type WearWindow = 30 | 365 | 'all'

/**
 * Days worn inside the window (30, 365 or 'all', counted in day keys), most
 * first, then the latest worn, then by name; only pieces worn in it. Retired
 * pieces count: this is history.
 */
export function mostWorn(garments: readonly Garment[], ix: WearIndex, window: WearWindow = 30, limit = 10): { garment: Garment; count: number; lastWorn: string }[] {
  const rows = garments
    .filter(g => !g.deletedAt)
    .map(garment => {
      const days = ix.days.get(garment.id) ?? []
      return { garment, count: daysWithin(days, ix.dayKey, window), lastWorn: days[0] ?? '' }
    })
  return topN(rows, limit, { count: r => r.count, name: r => r.garment.name, tie: (a, b) => b.lastWorn.localeCompare(a.lastWorn) })
}

/** A piece not worn in this many days is not worn lately. Clothes rotate more slowly than dinners (Kitchen's 30). */
export const NOT_WORN_DAYS = 60

/** Worn before, but not in the last `days` days; live and unretired; the longest rested first. */
export function notWornLately(garments: readonly Garment[], ix: WearIndex, days: number = NOT_WORN_DAYS): Garment[] {
  const last = (g: Garment) => ix.days.get(g.id)?.[0] ?? ''
  return garments
    .filter(g => !g.deletedAt && !g.archivedAt && !!last(g) && daysBetween(last(g), ix.dayKey) >= days)
    .sort((a, b) => last(a).localeCompare(last(b)) || a.name.localeCompare(b.name))
}

/** A piece added fewer local days ago than this is not nagged about as never worn. */
export const NEVER_WORN_GRACE_DAYS = 7

/**
 * Live, unretired, never worn, and added at least `grace` local days ago; the
 * oldest first. `dayOf` is the day an instant falls on: this runtime's zone by
 * default, the user's on the server.
 */
export function neverWorn(garments: readonly Garment[], ix: WearIndex, grace: number = NEVER_WORN_GRACE_DAYS, dayOf: (iso: string) => string = localDayKey): Garment[] {
  return garments
    .filter(g => !g.deletedAt && !g.archivedAt && !ix.days.get(g.id)?.length && daysBetween(dayOf(g.createdAt), ix.dayKey) >= grace)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name))
}

// ---- outfits ---------------------------------------------------------------------

/** The days with a look of this outfit's core, newest first; none once its core is gone. */
export function outfitDays(o: Outfit, ix: WearIndex, byId: ReadonlyMap<string, Garment>): string[] {
  const key = coreKey(o.garmentIds, byId)
  if (!key) return []
  return ix.logged.filter(day => (ix.looks.get(day) ?? []).some(w => coreKey(w.garmentIds, byId) === key))
}
