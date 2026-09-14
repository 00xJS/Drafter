import { CORE_TYPES, GARMENT_TYPES, GARMENT_TYPE_META, Garment, GarmentType, MAX_PIECES, Outfit, Wear } from './types'
import { daysAgo, daysBetween } from './kitchen'
import { monthsAndTrend, visitSummary } from './people'
import { dateKey, uid } from './utils'
import { newerStamp } from '../shared/domain.mjs'

// The wardrobe's rules and figures: pure, no DOM, worked out once per screen
// from a WearIndex, the way Kitchen works from a CookedIndex and the pickers
// from a VisitIndex. Nothing here rewrites a look or an outfit because a piece
// changed or went away: every reader resolves ids through liveById, so a piece
// in Trash drops out of every list and key, and Restore brings its history
// back exactly. Every figure counts distinct days, so a second look on one day
// never makes a piece "worn twice".

// ---- ids and writers -------------------------------------------------------------

/** wear~YYYY-MM-DD~ and 10 characters of a uid (hex where crypto.randomUUID exists): the journal's pattern. */
export const wearId = (day: string): string => `wear~${day}~${uid().replace(/-/g, '').slice(0, 10)}`

/** Unique, trimmed ids in order, capped: what the sanitizer would keep of an outfit's or a look's pieces. */
function cleanIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map(id => id.trim()).filter(Boolean))].slice(0, MAX_PIECES)
}

/** Oldest look first: when it was made, then its id, so two looks made in one millisecond still keep an order. */
const byCreated = (a: Wear, b: Wear) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)

/** A new look for a day. */
export function newWear(day: string, garmentIds: readonly string[], now = new Date().toISOString()): Wear {
  return { kind: 'wear', id: wearId(day), date: day, garmentIds: cleanIds(garmentIds), createdAt: now, updatedAt: now }
}

/** The look with other pieces, stamped newer than the copy it was made on. */
export function withPieces(w: Wear, garmentIds: readonly string[]): Wear {
  return { ...w, garmentIds: cleanIds(garmentIds), updatedAt: newerStamp(w.updatedAt) }
}

/** Renamed and stamped. A piece left without a name takes its type's; an outfit is then named by its pieces. */
export function renamed<T extends Garment | Outfit>(x: T, name: string): T {
  const typed = name.trim().slice(0, 80)
  const fallback = x.kind === 'garment' ? GARMENT_TYPE_META[(x as Garment).type].label : undefined
  return { ...x, name: typed || fallback, updatedAt: newerStamp(x.updatedAt) }
}

/** Retired (given away, worn out) or brought back, stamped. Its history stays either way. */
export function retired(g: Garment, on: boolean, now = new Date().toISOString()): Garment {
  const next: Garment = { ...g, updatedAt: newerStamp(g.updatedAt) }
  if (on) next.archivedAt = g.archivedAt ?? now
  else delete next.archivedAt
  return next
}

/** Live looks on a day, oldest first (createdAt, then id); the last is what "Wearing this" edits. */
export function looksOn(wears: readonly Wear[], day: string): Wear[] {
  return wears.filter(w => !w.deletedAt && w.date === day).sort(byCreated)
}

/** Save or reuse: a live outfit with the same pieces, in any order, is returned instead of a copy. */
export function saveOutfit(outfits: readonly Outfit[], garmentIds: readonly string[], name?: string, now = new Date().toISOString()): { outfit: Outfit; reused: boolean } {
  const ids = cleanIds(garmentIds)
  const key = pieceKey(ids)
  const same = outfits.find(o => !o.deletedAt && pieceKey(o.garmentIds) === key)
  if (same) return { outfit: same, reused: true }
  return { outfit: { kind: 'outfit', id: uid(), name: name?.trim().slice(0, 80) || undefined, garmentIds: ids, createdAt: now, updatedAt: now }, reused: false }
}

// ---- identity --------------------------------------------------------------------

const CORE = new Set<GarmentType>(CORE_TYPES)
const slot = (type: GarmentType) => GARMENT_TYPES.indexOf(type)
/** A top and a bottom, or a one-piece: enough to be dressed. */
const dresses = (types: ReadonlySet<GarmentType>) => types.has('onepiece') || (types.has('top') && types.has('bottom'))

/** Live garments by id, retired ones included; deleted and purged are absent, so every reader drops them. */
export function liveById(garments: readonly Garment[]): Map<string, Garment> {
  return new Map(garments.filter(g => !g.deletedAt && !g.purged).map(g => [g.id, g]))
}

/** Pieces in slot order (GARMENT_TYPES), stable within a slot; unknown ids dropped. */
export function orderPieces(ids: readonly string[], byId: ReadonlyMap<string, Garment>): string[] {
  return [...new Set(ids)].filter(id => byId.has(id)).sort((a, b) => slot(byId.get(a)!.type) - slot(byId.get(b)!.type))
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

/** A day key as the instant it is filed under: local midday (places.ts filedAt's rule), so no zone moves its month. */
export function middayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 12).toISOString()
}

export interface WearIndex {
  dayKey: string
  /** garment id → distinct days worn, newest first; never after dayKey. */
  days: ReadonlyMap<string, readonly string[]>
  /** Every day with a live, non-empty look, newest first. */
  logged: readonly string[]
  /** day → its live, non-empty looks, oldest first. */
  looks: ReadonlyMap<string, readonly Wear[]>
}

/** Skips deleted looks, empty looks and any date after dayKey (clock skew). Two looks on a day are one day. */
export function wearIndex(wears: readonly Wear[], dayKey: string): WearIndex {
  const looks = new Map<string, Wear[]>()
  for (const w of wears) {
    if (w.deletedAt || w.garmentIds.length === 0 || !w.date || w.date > dayKey) continue
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

// ---- per piece: the Kitchen's words, the Places tab's idea -----------------------

const times = (n: number) => `${n} time${n === 1 ? '' : 's'}`

/** Days among these inside the `window` days ending on dayKey — counted in day keys, never milliseconds. */
const within = (days: readonly string[], dayKey: string, window: number) => days.filter(d => daysBetween(d, dayKey) < window).length

/** "Last worn today · 1 time", "Last worn 12 days ago · 5 times", or "Not worn yet": Kitchen's cookedLine, for a piece. */
export function wornLine(ix: WearIndex, id: string): string {
  const days = ix.days.get(id)
  if (!days?.length) return 'Not worn yet'
  return `Last worn ${daysAgo(daysBetween(days[0], ix.dayKey))} · ${times(days.length)}`
}

/** "12 days ago", or "new": under a card in the composer rows, as lastCookedShort is beside a recipe. */
export function wornShort(ix: WearIndex, id: string): string {
  const last = ix.days.get(id)?.[0]
  return last ? daysAgo(daysBetween(last, ix.dayKey)) : 'new'
}

/** A piece's figures: days worn, the last and first of them, how many in the last 30 and 365 days, and 12 weekly bars. */
export function garmentStats(
  g: Garment,
  ix: WearIndex,
  now = new Date(),
): { timesWorn: number; lastWorn?: string; firstWorn?: string; in30: number; in365: number; weekly: number[] } {
  const days = ix.days.get(g.id) ?? []
  return {
    timesWorn: days.length,
    lastWorn: days[0],
    firstWorn: days[days.length - 1],
    in30: within(days, ix.dayKey, 30),
    in365: within(days, ix.dayKey, 365),
    // the People and Places bars, over each day filed at its local midday
    weekly: visitSummary(days.map(d => ({ at: middayOf(d) })), now).weekly,
  }
}

// ---- the lists -------------------------------------------------------------------

/**
 * A window in day keys. A day filed at midday would cross visitSummary's
 * millisecond 30-day line during the afternoon, and the list would change
 * between the morning and the evening.
 */
export type WearWindow = 30 | 365 | 'all'

/**
 * Days worn inside the window, most first, then the latest worn, then by
 * name; only pieces worn in it. Retired pieces count: this is history.
 */
export function mostWorn(garments: readonly Garment[], ix: WearIndex, window: WearWindow = 30, limit = 10): { garment: Garment; count: number; lastWorn: string }[] {
  return garments
    .filter(g => !g.deletedAt)
    .map(garment => {
      const days = ix.days.get(garment.id) ?? []
      return { garment, count: window === 'all' ? days.length : within(days, ix.dayKey, window), lastWorn: days[0] ?? '' }
    })
    .filter(r => r.count > 0)
    .sort((a, b) => b.count - a.count || b.lastWorn.localeCompare(a.lastWorn) || a.garment.name.localeCompare(b.garment.name))
    .slice(0, limit)
}

/** A piece not worn in this many days is not worn lately. Clothes rotate more slowly than dinners (Kitchen's 30). */
export const NOT_WORN_DAYS = 60

/** Worn before, but not in the last `days` days; live and unretired; the longest rested first. */
export function notWornLately(garments: readonly Garment[], ix: WearIndex, days = NOT_WORN_DAYS): Garment[] {
  const last = (g: Garment) => ix.days.get(g.id)?.[0] ?? ''
  return garments
    .filter(g => !g.deletedAt && !g.archivedAt && !!last(g) && daysBetween(last(g), ix.dayKey) >= days)
    .sort((a, b) => last(a).localeCompare(last(b)) || a.name.localeCompare(b.name))
}

/** A piece added fewer local days ago than this is not nagged about as never worn. */
export const NEVER_WORN_GRACE_DAYS = 7

/** Live, unretired, never worn, and added at least `grace` local days ago; the oldest first. */
export function neverWorn(garments: readonly Garment[], ix: WearIndex, grace = NEVER_WORN_GRACE_DAYS): Garment[] {
  return garments
    .filter(g => !g.deletedAt && !g.archivedAt && !ix.days.get(g.id)?.length && daysBetween(dateKey(g.createdAt), ix.dayKey) >= grace)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name))
}

// ---- by month (monthsAndTrend over local-midday instants) ------------------------

/** Days logged per month of `year`, with the 90-vs-90-day trend. */
export function wearsByMonth(ix: WearIndex, year: number, now = new Date()): { months: number[]; total: number; trend: number } {
  return monthsAndTrend(ix.logged.map(d => ({ at: middayOf(d) })), year, now)
}

/** Per live piece: days worn in each month of `year`, the total and the trend; worn that year only; most first, then by name. */
export function wardrobeYearReport(
  garments: readonly Garment[],
  ix: WearIndex,
  year: number,
  now = new Date(),
): { garment: Garment; months: number[]; total: number; trend: number }[] {
  return garments
    .filter(g => !g.deletedAt)
    .map(garment => ({ garment, ...monthsAndTrend((ix.days.get(garment.id) ?? []).map(d => ({ at: middayOf(d) })), year, now) }))
    .filter(r => r.total > 0)
    .sort((a, b) => b.total - a.total || a.garment.name.localeCompare(b.garment.name))
}

// ---- outfits ---------------------------------------------------------------------

/** The first live saved outfit with this core. */
function savedWithCore(outfits: readonly Outfit[], byId: ReadonlyMap<string, Garment>, key: string): Outfit | undefined {
  return outfits.find(o => !o.deletedAt && coreKey(o.garmentIds, byId) === key)
}

/**
 * Core combinations worn on at least `min` distinct days, most first (then
 * the latest). The pieces shown are the newest such look's, known ones only;
 * `outfit` is a live saved outfit with the same core.
 */
export function repeatedOutfits(
  ix: WearIndex,
  byId: ReadonlyMap<string, Garment>,
  outfits: readonly Outfit[],
  min = 2,
): { key: string; garmentIds: string[]; days: number; lastWorn: string; outfit?: Outfit }[] {
  const groups = new Map<string, { garmentIds: string[]; days: Set<string>; lastWorn: string }>()
  for (const day of ix.logged) {
    // newest day first, and a day's newest look first: the first look seen of a core is its newest
    for (const look of [...(ix.looks.get(day) ?? [])].reverse()) {
      const key = coreKey(look.garmentIds, byId)
      if (!key) continue
      const group = groups.get(key)
      if (group) group.days.add(day)
      else groups.set(key, { garmentIds: orderPieces(look.garmentIds, byId), days: new Set([day]), lastWorn: day })
    }
  }
  return [...groups.entries()]
    .filter(([, g]) => g.days.size >= min)
    .map(([key, g]) => ({ key, garmentIds: g.garmentIds, days: g.days.size, lastWorn: g.lastWorn, outfit: savedWithCore(outfits, byId, key) }))
    .sort((a, b) => b.days - a.days || b.lastWorn.localeCompare(a.lastWorn) || a.key.localeCompare(b.key))
}

/** "last 2 weeks ago", but plain "today" and "yesterday". */
const lastWorn = (days: number) => (days <= 1 ? daysAgo(days) : `last ${daysAgo(days)}`)

/**
 * A saved outfit's line, counting the days with any look of its core: "Worn 4
 * times · last 2 weeks ago", "Not worn yet", or "A piece was deleted" when its
 * core is gone.
 */
export function outfitLine(o: Outfit, ix: WearIndex, byId: ReadonlyMap<string, Garment>): string {
  const key = coreKey(o.garmentIds, byId)
  if (!key) return o.garmentIds.some(id => !byId.has(id)) ? 'A piece was deleted' : 'Not worn yet'
  const days = ix.logged.filter(day => (ix.looks.get(day) ?? []).some(w => coreKey(w.garmentIds, byId) === key))
  if (days.length === 0) return 'Not worn yet'
  return `Worn ${times(days.length)} · ${lastWorn(daysBetween(days[0], ix.dayKey))}`
}

/** How far back the Today card looks for what you wear often. */
const SUGGEST_DAYS = 60

/**
 * The Today card's one-tap chips, deterministic. Candidates are live saved
 * outfits, plus the cores of looks in the 60 days before dayKey. A candidate
 * counts only when every piece is live and unretired and it has a core.
 * Grouped by coreKey; score = distinct days worn in those 60 days. Sorted by
 * score, then the latest worn, saved first, then by label. The pieces are the
 * saved outfit's, else the newest look's that is still wearable whole. The
 * label is the outfit's name, else outfitLabel. At most `limit`.
 */
export function todaySuggestions(
  ix: WearIndex,
  outfits: readonly Outfit[],
  byId: ReadonlyMap<string, Garment>,
  limit = 3,
): { key: string; garmentIds: string[]; label: string; reason: 'saved' | 'often' }[] {
  const wearable = (ids: readonly string[]) =>
    ids.length > 0 &&
    ids.every(id => {
      const g = byId.get(id)
      return !!g && !g.archivedAt
    })
  const found = new Map<string, { saved?: Outfit; pieces?: string[]; days: Set<string>; lastWorn: string }>()
  const at = (key: string) => {
    const got = found.get(key) ?? { days: new Set<string>(), lastWorn: '' }
    found.set(key, got)
    return got
  }
  for (const o of outfits) {
    const key = o.deletedAt || !wearable(o.garmentIds) ? null : coreKey(o.garmentIds, byId)
    if (!key) continue
    const c = at(key)
    c.saved ??= o
  }
  for (const day of ix.logged) {
    const ago = daysBetween(day, ix.dayKey)
    if (ago < 1 || ago > SUGGEST_DAYS) continue
    for (const look of [...(ix.looks.get(day) ?? [])].reverse()) {
      const key = coreKey(look.garmentIds, byId)
      if (!key) continue
      const c = at(key)
      c.days.add(day)
      if (day > c.lastWorn) c.lastWorn = day
      if (!c.pieces && wearable(look.garmentIds)) c.pieces = [...look.garmentIds]
    }
  }
  const ranked: { key: string; garmentIds: string[]; label: string; reason: 'saved' | 'often'; score: number; lastWorn: string }[] = []
  for (const [key, c] of found) {
    const garmentIds = c.saved ? [...c.saved.garmentIds] : c.pieces
    if (!garmentIds) continue
    const label = c.saved?.name || outfitLabel(garmentIds, byId)
    ranked.push({ key, garmentIds, label, reason: c.saved ? 'saved' : 'often', score: c.days.size, lastWorn: c.lastWorn })
  }
  return ranked
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.lastWorn.localeCompare(a.lastWorn) ||
        Number(b.reason === 'saved') - Number(a.reason === 'saved') ||
        a.label.localeCompare(b.label) ||
        a.key.localeCompare(b.key),
    )
    .slice(0, limit)
    .map(({ key, garmentIds, label, reason }) => ({ key, garmentIds, label, reason }))
}

// ---- names from a colour ---------------------------------------------------------

/** Each name's reference colour, nearer fabric in a photo than the pure RGB primaries. */
const COLOR_NAMES: [name: string, r: number, g: number, b: number][] = [
  ['black', 22, 22, 22],
  ['white', 245, 245, 242],
  ['grey', 150, 150, 150],
  ['navy', 30, 40, 72],
  ['blue', 52, 101, 180],
  ['green', 56, 128, 72],
  ['red', 190, 36, 44],
  ['pink', 236, 150, 180],
  ['beige', 220, 200, 165],
  ['brown', 115, 72, 40],
  ['yellow', 240, 205, 50],
  ['orange', 235, 125, 35],
  ['purple', 110, 60, 140],
]

/**
 * The nearest of 13 names (black, white, grey, navy, blue, green, red, pink,
 * beige, brown, yellow, orange, purple) by weighted RGB distance ("redmean");
 * '' for anything that is not #rrggbb.
 */
export function colorName(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!m) return ''
  const [r, g, b] = [m[1], m[2], m[3]].map(x => parseInt(x, 16))
  let best = ''
  let bestDistance = Infinity
  for (const [name, cr, cg, cb] of COLOR_NAMES) {
    const mean = (r + cr) / 2
    const distance = (2 + mean / 256) * (r - cr) ** 2 + 4 * (g - cg) ** 2 + (2 + (255 - mean) / 256) * (b - cb) ** 2
    if (distance < bestDistance) {
      bestDistance = distance
      best = name
    }
  }
  return best
}

/** ["Navy top", "Top"] with a colour, ["Top"] without; the first is what an empty name saves as. */
export function suggestedNames(type: GarmentType, hex?: string): string[] {
  const label = GARMENT_TYPE_META[type].label
  const color = hex ? colorName(hex) : ''
  return color ? [`${color[0].toUpperCase()}${color.slice(1)} ${label.toLowerCase()}`, label] : [label]
}
