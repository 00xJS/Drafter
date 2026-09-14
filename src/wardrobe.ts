import { GARMENT_TYPE_META, Garment, GarmentType, Outfit } from './types'
import { daysAgo, daysBetween } from './kitchen'
import { monthsAndTrend, visitSummary } from './people'
import { uid } from './utils'
import { newerStamp } from '../shared/domain.mjs'
import { shiftDayKey } from '../shared/journal.mjs'
import { cleanIds, coreKey, daysWithin, orderPieces, outfitDays, outfitLabel, pieceKey, wearable } from '../shared/wardrobe.mjs'
import type { WearIndex } from '../shared/wardrobe.mjs'

// The wardrobe's rules and figures: pure, no DOM, worked out once per screen
// from a WearIndex, the way Kitchen works from a CookedIndex and the pickers
// from a VisitIndex. Nothing here rewrites a look or an outfit because a piece
// changed or went away: every reader resolves ids through liveById, so a piece
// in Trash drops out of every list and key, and Restore brings its history
// back exactly. Every figure counts distinct days, so a second look on one day
// never makes a piece "worn twice".
//
// The rules an assistant needs too — the ids and writers, what a look is, the
// index and the three lists Stats shows — live in shared/wardrobe.mjs, where
// the MCP server reads them, and are re-exported here under the same names.

export {
  NEVER_WORN_GRACE_DAYS,
  NOT_WORN_DAYS,
  canDress,
  coreKey,
  liveById,
  logLook,
  looksOn,
  mostWorn,
  neverWorn,
  newWear,
  notInUse,
  notWornLately,
  orderPieces,
  outfitDays,
  outfitLabel,
  pieceKey,
  unwearable,
  wearId,
  wearIndex,
  wearable,
  withPieces,
} from '../shared/wardrobe.mjs'
export type { LookLog, WearIndex, WearWindow } from '../shared/wardrobe.mjs'

// ---- writers ---------------------------------------------------------------------

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

/** Save or reuse: a live outfit with the same pieces, in any order, is returned instead of a copy. */
export function saveOutfit(outfits: readonly Outfit[], garmentIds: readonly string[], name?: string, now = new Date().toISOString()): { outfit: Outfit; reused: boolean } {
  const ids = cleanIds(garmentIds)
  const key = pieceKey(ids)
  const same = outfits.find(o => !o.deletedAt && pieceKey(o.garmentIds) === key)
  if (same) return { outfit: same, reused: true }
  return { outfit: { kind: 'outfit', id: uid(), name: name?.trim().slice(0, 80) || undefined, garmentIds: ids, createdAt: now, updatedAt: now }, reused: false }
}

// ---- days as instants ------------------------------------------------------------

/** A day key as the instant it is filed under: local midday (places.ts filedAt's rule), so no zone moves its month. */
export function middayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 12).toISOString()
}

// ---- per piece: the Kitchen's words, the Places tab's idea -----------------------

const times = (n: number) => `${n} time${n === 1 ? '' : 's'}`

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
    in30: daysWithin(days, ix.dayKey, 30),
    in365: daysWithin(days, ix.dayKey, 365),
    // the People and Places bars, over each day filed at its local midday
    weekly: visitSummary(days.map(d => ({ at: middayOf(d) })), now).weekly,
  }
}

// ---- the lists -------------------------------------------------------------------

/** Never worn first, the oldest added first; then the longest rested. */
function restOrder(ix: WearIndex): (a: Garment, b: Garment) => number {
  const last = (g: Garment) => ix.days.get(g.id)?.[0] ?? ''
  return (a, b) => last(a).localeCompare(last(b)) || a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name)
}

/** Live, unretired pieces in rest order: what the composer's rows are dealt from. */
export function byRest(garments: readonly Garment[], ix: WearIndex): Garment[] {
  return garments.filter(g => !g.deletedAt && !g.archivedAt).sort(restOrder(ix))
}

/** The Clothes grid's orders. */
export type ClothesSort = 'rest' | 'most' | 'newest' | 'name'
export const CLOTHES_SORTS: { key: ClothesSort; label: string }[] = [
  { key: 'rest', label: 'Not worn lately' },
  { key: 'most', label: 'Most worn' },
  { key: 'newest', label: 'Newest' },
  { key: 'name', label: 'A–Z' },
]

/** Live pieces in a Clothes order: rest order (the default), most days worn, newest added, or by name. */
export function clothesOrder(garments: readonly Garment[], ix: WearIndex, sort: ClothesSort): Garment[] {
  const live = garments.filter(g => !g.deletedAt)
  const worn = (g: Garment) => ix.days.get(g.id) ?? []
  const byName = (a: Garment, b: Garment) => a.name.localeCompare(b.name)
  if (sort === 'most') return live.sort((a, b) => worn(b).length - worn(a).length || (worn(b)[0] ?? '').localeCompare(worn(a)[0] ?? '') || byName(a, b))
  if (sort === 'newest') return live.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || byName(a, b))
  if (sort === 'name') return live.sort(byName)
  return live.sort(restOrder(ix))
}

/** Stats' three tiles: pieces in use; days logged this month and its days so far; pieces in use worn in the last 90 days. */
export function wardrobeTiles(garments: readonly Garment[], ix: WearIndex): { pieces: number; loggedThisMonth: number; daysThisMonth: number; wornLately: number } {
  const inUse = garments.filter(g => !g.deletedAt && !g.archivedAt)
  const month = ix.dayKey.slice(0, 7)
  return {
    pieces: inUse.length,
    loggedThisMonth: ix.logged.filter(d => d.startsWith(month)).length,
    daysThisMonth: Number(ix.dayKey.slice(8, 10)),
    wornLately: inUse.filter(g => daysWithin(ix.days.get(g.id) ?? [], ix.dayKey, 90) > 0).length,
  }
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
  if (!coreKey(o.garmentIds, byId)) return o.garmentIds.some(id => !byId.has(id)) ? 'A piece was deleted' : 'Not worn yet'
  const days = outfitDays(o, ix, byId)
  if (days.length === 0) return 'Not worn yet'
  return `Worn ${times(days.length)} · ${lastWorn(daysBetween(days[0], ix.dayKey))}`
}

/** The saved outfits under the composer: the most days worn in the last 60 first, then the newest saved. */
export function savedOrder(outfits: readonly Outfit[], ix: WearIndex, byId: ReadonlyMap<string, Garment>): Outfit[] {
  const lately = new Map(outfits.map(o => [o.id, outfitDays(o, ix, byId).filter(d => daysBetween(d, ix.dayKey) < SUGGEST_DAYS).length]))
  return outfits
    .filter(o => !o.deletedAt)
    .sort((a, b) => (lately.get(b.id) ?? 0) - (lately.get(a.id) ?? 0) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
}

/**
 * The Today card's "Forgot yesterday?": yesterday's day key, before noon only,
 * when yesterday has no look and an earlier day has one — someone who has
 * never logged is not asked about a day they would not have logged anyway.
 */
export function forgotYesterday(ix: WearIndex, hour: number): string | null {
  if (hour >= 12) return null
  const yesterday = shiftDayKey(ix.dayKey, -1)
  return !ix.looks.has(yesterday) && ix.logged.some(d => d < yesterday) ? yesterday : null
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
  const found = new Map<string, { saved?: Outfit; pieces?: string[]; days: Set<string>; lastWorn: string }>()
  const at = (key: string) => {
    const got = found.get(key) ?? { days: new Set<string>(), lastWorn: '' }
    found.set(key, got)
    return got
  }
  for (const o of outfits) {
    const key = o.deletedAt || !wearable(o.garmentIds, byId) ? null : coreKey(o.garmentIds, byId)
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
      if (!c.pieces && wearable(look.garmentIds, byId)) c.pieces = [...look.garmentIds]
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
