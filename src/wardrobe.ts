import { GARMENT_TYPE_META, Garment, GarmentType, Outfit, SEASONS, Season, Wear } from './types'
import { formatMoney } from './bills'
import { daysAgo, daysBetween } from './kitchen'
import { countOf, monthsAndTrend, visitSummary } from './people'
import { garmentTags } from './schema'
import { uid } from './utils'
import { describeCode, type Forecast } from './weather'
import { newerStamp } from '../shared/domain.mjs'
import { shiftDayKey } from '../shared/journal.mjs'
import { NOT_WORN_DAYS, cleanIds, coreKey, daysWithin, isPlanned, looksOn, marked, orderPieces, outfitDays, outfitLabel, pieceKey, wearable } from '../shared/wardrobe.mjs'
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
  isPlanned,
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

/** What a write of a piece did to its photos — Replace photo, or the Undo of one: the ids it let go of, and the ones it points at now. */
export function swappedPhotos(before: Garment, after: Garment): { gone: string[]; now: string[] } {
  const now = [after.photoId, after.thumbId].filter((id): id is string => !!id)
  const gone = [before.photoId, before.thumbId].filter((id): id is string => !!id && !now.includes(id))
  return { gone, now }
}

/** A piece or a saved outfit starred as a favourite, or not, stamped. */
export function starred<T extends Garment | Outfit>(x: T, on: boolean): T {
  const next: Garment | Outfit = { ...x, updatedAt: newerStamp(x.updatedAt) }
  if (on) next.favourite = true
  else delete next.favourite
  return next as T
}

/**
 * A piece's details changed, stamped: a price in whole units (null clears it),
 * tags as a sync keeps them (garmentTags), seasons in the year's order — none
 * is any season. Only what is given changes.
 */
export function withDetails(g: Garment, d: { price?: number | null; tags?: readonly string[]; seasons?: readonly Season[] }): Garment {
  const next: Garment = { ...g, updatedAt: newerStamp(g.updatedAt) }
  if (d.price !== undefined) {
    if (d.price === null || !Number.isFinite(d.price) || d.price < 0) delete next.price
    else next.price = Math.round(d.price)
  }
  if (d.tags !== undefined) {
    const tags = garmentTags(d.tags)
    if (tags) next.tags = tags
    else delete next.tags
  }
  const given = d.seasons
  if (given !== undefined) {
    const seasons = SEASONS.filter(s => given.includes(s))
    if (seasons.length > 0) next.seasons = seasons
    else delete next.seasons
  }
  return next
}

// ---- plans and notes -------------------------------------------------------------

/** How far ahead a look can be planned: a year of days. */
export const PLAN_DAYS = 365

/** The last day a look can be planned for, from today's day key. */
export const lastPlanDay = (today: string): string => shiftDayKey(today, PLAN_DAYS)

/** The look confirmed worn — a plan no longer, so it counts from now on — stamped. */
export function confirmed(w: Wear): Wear {
  return { ...marked(w, { planned: false }), updatedAt: newerStamp(w.updatedAt) }
}

/** The look with a note ('' clears it), stamped; a plan stays a plan. */
export function withNote(w: Wear, note: string): Wear {
  return { ...marked(w, { note }), updatedAt: newerStamp(w.updatedAt) }
}

/**
 * A day's plan: its latest live look with pieces, when that was put together
 * ahead and the day has no look worn yet. On its day the Today card shows it
 * as "Planned: …", with one tap to say it was worn.
 */
export function planFor(wears: readonly Wear[], day: string): Wear | undefined {
  const looks = looksOn(wears, day).filter(w => w.garmentIds.length > 0)
  return looks.some(w => !isPlanned(w)) ? undefined : looks[looks.length - 1]
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

// ---- Surprise me -----------------------------------------------------------------

/**
 * A piece's weight in Surprise me's draw: one, and a day more for every day it
 * has rested, up to NOT_WORN_DAYS; never worn counts as the longest rest. The
 * least recently worn come up most, and nothing is ever ruled out.
 */
export function restWeight(ix: WearIndex, id: string): number {
  const last = ix.days.get(id)?.[0]
  return 1 + (last ? Math.min(NOT_WORN_DAYS, Math.max(0, daysBetween(last, ix.dayKey))) : NOT_WORN_DAYS)
}

/** One of `items` drawn at random, each as likely as its weight; undefined from none. `random` is Math.random's shape: the tests hand one in. */
export function pickWeighted<T>(items: readonly T[], weight: (x: T) => number, random: () => number = Math.random): T | undefined {
  if (items.length === 0) return undefined
  const weights = items.map(x => Math.max(0, weight(x)))
  const total = weights.reduce((a, b) => a + b, 0)
  if (total <= 0) return items[Math.min(items.length - 1, Math.floor(random() * items.length))]
  let at = random() * total
  for (let i = 0; i < items.length; i++) {
    at -= weights[i]
    if (at < 0) return items[i]
  }
  return items[items.length - 1]
}

// ---- seasons, tags and favourites ------------------------------------------------

/** The season a day falls in, by its month: the meteorological seasons as the north has them, March to May being spring. */
export function seasonOf(day: string): Season {
  const m = Number(day.slice(5, 7))
  return m >= 3 && m <= 5 ? 'spring' : m >= 6 && m <= 8 ? 'summer' : m >= 9 && m <= 11 ? 'autumn' : 'winter'
}

/** For this season: marked for it, or marked for none, which is a piece for any season. */
export const inSeason = (g: Garment, season: Season): boolean => !g.seasons?.length || g.seasons.includes(season)

/** What Clothes shows: every piece, the favourites, or one type. */
export type ClothesShow = 'all' | 'favourites' | GarmentType

/** Whether a piece passes Clothes' filters: what to show, a season (a piece for any season passes every one) and a tag. */
export function clothesMatch(g: Garment, f: { show: ClothesShow; season?: Season | null; tag?: string | null }): boolean {
  if (f.show === 'favourites' ? !g.favourite : f.show !== 'all' && g.type !== f.show) return false
  if (f.season && !inSeason(g, f.season)) return false
  return !f.tag || !!g.tags?.includes(f.tag)
}

/** The tags these pieces carry, the most used first, then A–Z. */
export function tagsOf(garments: readonly Garment[]): { tag: string; count: number }[] {
  const n = new Map<string, number>()
  for (const g of garments) for (const t of g.tags ?? []) n.set(t, (n.get(t) ?? 0) + 1)
  return [...n].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
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

/** The saved outfits under the composer: the favourites first, then the most days worn in the last 60, then the newest saved. */
export function savedOrder(outfits: readonly Outfit[], ix: WearIndex, byId: ReadonlyMap<string, Garment>): Outfit[] {
  const lately = new Map(outfits.map(o => [o.id, outfitDays(o, ix, byId).filter(d => daysBetween(d, ix.dayKey) < SUGGEST_DAYS).length]))
  return outfits
    .filter(o => !o.deletedAt)
    .sort(
      (a, b) =>
        Number(!!b.favourite) - Number(!!a.favourite) ||
        (lately.get(b.id) ?? 0) - (lately.get(a.id) ?? 0) ||
        b.createdAt.localeCompare(a.createdAt) ||
        a.id.localeCompare(b.id),
    )
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

// ---- a piece's company and its cost ---------------------------------------------

/**
 * "Worn with": the pieces worn on the most of the same days as this one — in
 * any look that day, since a day is a day — then the latest together, then by
 * name. Live pieces only (a retired one counts: this is history); `limit` at most.
 */
export function wornWith(id: string, ix: WearIndex, byId: ReadonlyMap<string, Garment>, limit = 5): { garment: Garment; days: number; last: string }[] {
  const found = new Map<string, { days: number; last: string }>()
  for (const day of ix.days.get(id) ?? []) {
    for (const other of new Set((ix.looks.get(day) ?? []).flatMap(w => w.garmentIds))) {
      if (other === id || !byId.has(other)) continue
      const f = found.get(other)
      // the days come newest first, so the first seen is the latest together
      if (f) f.days++
      else found.set(other, { days: 1, last: day })
    }
  }
  return [...found]
    .map(([other, f]) => ({ garment: byId.get(other)!, ...f }))
    .sort((a, b) => b.days - a.days || b.last.localeCompare(a.last) || a.garment.name.localeCompare(b.garment.name))
    .slice(0, limit)
}

/** What a piece has cost per day worn: its price over the days, or null with no price or no day worn yet. */
export function costPerWear(g: Garment, ix: WearIndex): number | null {
  const days = ix.days.get(g.id)?.length ?? 0
  return g.price === undefined || days === 0 ? null : g.price / days
}

/** The sheet's line: "£40.00 · £8.00 a wear over 5 days", "£40.00 · not worn yet", or null with no price. */
export function costLine(g: Garment, ix: WearIndex): string | null {
  if (g.price === undefined) return null
  const each = costPerWear(g, ix)
  const days = ix.days.get(g.id)?.length ?? 0
  return each === null ? `${formatMoney(g.price)} · not worn yet` : `${formatMoney(g.price)} · ${formatMoney(each)} a wear over ${countOf(days, 'day')}`
}

// ---- the weather -------------------------------------------------------------------

/** A day whose high is at most this is cold enough for a coat: 13 °C, or 55 °F where the forecast reads in Fahrenheit. */
export const COLD_C = 13
export const COLD_F = 55
/** The chance of rain from which a day counts as wet. */
export const WET_PCT = 50
/** The skies describeCode names that are wet whatever the chance says. */
const WET_SKIES = new Set(['Drizzle', 'Rain', 'Snow', 'Showers', 'Snow showers', 'Thunder'])

export interface WeatherNeed {
  cold: boolean
  wet: boolean
}

/** What today's forecast asks of a look: cold, wet or both; null for neither, and with no forecast. */
export function weatherNeed(f: Forecast | null | undefined): WeatherNeed | null {
  if (!f) return null
  const cold = f.hiC <= (/f/i.test(f.unit) ? COLD_F : COLD_C)
  const wet = f.rainPct >= WET_PCT || WET_SKIES.has(describeCode(f.code).label)
  return cold || wet ? { cold, wet } : null
}

/** The hint's words: "Cold today · 9° at most", "Wet today · rain 70%", "Cold and wet today · 6° at most · showers". */
export function weatherLine(f: Forecast, need: WeatherNeed): string {
  const sky = describeCode(f.code).label
  const head = need.cold && need.wet ? 'Cold and wet today' : need.cold ? 'Cold today' : 'Wet today'
  return [head, need.cold ? `${f.hiC}° at most` : '', need.wet ? (WET_SKIES.has(sky) ? sky.toLowerCase() : `rain ${f.rainPct}%`) : ''].filter(Boolean).join(' · ')
}

/** Tags that mark a coat for the rain. */
const RAIN_TAG = /rain|waterproof/

/**
 * The outerwear a cold or wet day suggests: live and unretired, in season when
 * one is; on a wet day one tagged for rain first; then the one worn on the most
 * days in the last 60, the latest worn, the name. Undefined with none to offer.
 */
export function outerwearFor(garments: readonly Garment[], ix: WearIndex, need: WeatherNeed, season: Season = seasonOf(ix.dayKey)): Garment | undefined {
  const coats = garments.filter(g => !g.deletedAt && !g.archivedAt && g.type === 'outerwear')
  const fits = coats.filter(g => inSeason(g, season))
  const rainy = (g: Garment) => (need.wet && g.tags?.some(t => RAIN_TAG.test(t)) ? 1 : 0)
  const lately = (g: Garment) => daysWithin(ix.days.get(g.id) ?? [], ix.dayKey, SUGGEST_DAYS)
  const last = (g: Garment) => ix.days.get(g.id)?.[0] ?? ''
  return [...(fits.length > 0 ? fits : coats)].sort((a, b) => rainy(b) - rainy(a) || lately(b) - lately(a) || last(b).localeCompare(last(a)) || a.name.localeCompare(b.name))[0]
}

/** Whether these pieces already hold outerwear, so a weather hint has nothing to add. */
export const hasOuterwear = (ids: readonly string[], byId: ReadonlyMap<string, Garment>): boolean => ids.some(id => byId.get(id)?.type === 'outerwear')

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
