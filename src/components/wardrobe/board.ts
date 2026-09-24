import { weekDayKeys } from '../../../shared/weeks.mts'
import { CORE_TYPES, type Garment, type GarmentType, type Season, type Wear } from '../../types'
import { fitsOccasion, isPlanned, looksOn, pickWeighted, pieceTags, restWeight, seasonOf, type DayOccasion, type WearIndex } from '../../wardrobe'
import { byName, heldBadge, ideaPool, type Rows, type Slot } from './composer'

// The Outfit board's rules, with no React in them: the week strip's marks, the
// picker's order, the ideas and the week's plan. Each is pure — a deal takes
// its randomness from a seed (seeded) — so the board can work them out as it
// draws, and a test can hold them to one answer.

// ---- a seeded draw ---------------------------------------------------------------

/**
 * Math.random's shape from a seed: the same seed draws the same numbers. The
 * ideas and the week's plan are dealt from one, so the board deals them as it
 * draws — the same looks every time it draws, until New ideas or Another moves
 * the seed on — and never reads a clock or a random source to do it.
 */
export function seeded(seed: string): () => number {
  // FNV-1a over the seed, then mulberry32 from it
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193)
  let a = h >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---- the week strip --------------------------------------------------------------

/** A day as the strip marks it: a look worn, only a plan, or nothing. */
export type DayMark = 'logged' | 'planned' | null

/** A day's looks that hold anything: an empty look counts as none, as it does in every figure. */
export const looksWithPieces = (wears: readonly Wear[], day: string): Wear[] => looksOn(wears, day).filter(w => w.garmentIds.length > 0)

/** Whether a day has a look, worn or planned. */
export const hasLook = (wears: readonly Wear[], day: string): boolean => looksWithPieces(wears, day).length > 0

/** The strip's mark: a dot once a look was worn, a ring while the day has only a plan, nothing while it has neither. */
export function dayMark(wears: readonly Wear[], day: string): DayMark {
  const looks = looksWithPieces(wears, day)
  return looks.some(w => !isPlanned(w)) ? 'logged' : looks.length > 0 ? 'planned' : null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const partsOf = (key: string): [number, number, number] => {
  const [y, m, d] = key.split('-').map(Number)
  return [y, m, d]
}

/** The seven days of the week `day` falls in, Sunday first: the app's weeks start on a Sunday. */
export const weekOf = (day: string): string[] => weekDayKeys(day)

/** A day's letter on the strip, Sunday's S first. A day key is a day, so no zone can move it. */
export function dayLetter(key: string): string {
  const [y, m, d] = partsOf(key)
  return LETTERS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
}

/** The day of the month, as the strip numbers it. */
export const dayNumber = (key: string): number => partsOf(key)[2]

/** The week between the strip's arrows: "13 – 19 Sep", "30 Aug – 5 Sep", with the year when it is not this one. */
export function weekRange(days: readonly string[], todayKey: string): string {
  const [fy, fm, fd] = partsOf(days[0])
  const [ly, lm, ld] = partsOf(days[days.length - 1])
  if (fy !== ly) return `${fd} ${MONTHS[fm - 1]} ${fy} – ${ld} ${MONTHS[lm - 1]} ${ly}`
  const year = String(ly) === todayKey.slice(0, 4) ? '' : ` ${ly}`
  return fm === lm ? `${fd} – ${ld} ${MONTHS[lm - 1]}${year}` : `${fd} ${MONTHS[fm - 1]} – ${ld} ${MONTHS[lm - 1]}${year}`
}

// ---- the picker ------------------------------------------------------------------

/** What the picker shows: the pieces for the day (and for any time), every one, or the favourites. */
export type PickerFilter = 'fit' | 'all' | 'favourites'

/**
 * The picker's order, worked out once as it opens and kept while it is open:
 * the longest rested first — never worn before any worn — and a tie by name.
 * It reads nothing but when each piece was last worn, so every day of a week,
 * and every visit until something is worn, opens on the same order.
 */
export function pickerOrder(pieces: readonly Garment[], ix: WearIndex): string[] {
  const last = (g: Garment) => ix.days.get(g.id)?.[0] ?? ''
  return [...pieces].sort((a, b) => last(a).localeCompare(last(b)) || byName(a, b)).map(g => g.id)
}

export interface PickerGroups {
  /** What the day's look holds that is retired or in Trash: first, badged. */
  held: Garment[]
  /** For the day's occasion, or for any time. */
  fit: Garment[]
  /** For the other occasion: under Other days. */
  other: Garment[]
  /** How many For work (or For days off) leaves out: it says so, with Show all. */
  hidden: number
}

/**
 * The picker's tiles for a filter and a search, in the order it opened with
 * (`order`; a piece that arrived since goes last, by name): the held pieces,
 * then the group for the day, then the others. For work, or For days off, is
 * the group for the day alone; All and Favourites keep both groups, the others
 * under their own header, so where a piece sits is always said. A search
 * matches the name, or a tag.
 */
export function pickerGroups(pieces: readonly Garment[], order: readonly string[], occasion: DayOccasion, filter: PickerFilter, query = ''): PickerGroups {
  const at = new Map(order.map((id, i) => [id, i]))
  const rank = (g: Garment) => at.get(g.id) ?? order.length
  const sorted = [...pieces].sort((a, b) => rank(a) - rank(b) || byName(a, b))
  const q = query.trim().toLowerCase()
  const found = (g: Garment) => !q || g.name.toLowerCase().includes(q) || pieceTags(g).some(t => t.includes(q))
  const held = sorted.filter(g => heldBadge(g) && found(g))
  const live = sorted.filter(g => !heldBadge(g) && found(g) && (filter !== 'favourites' || !!g.favourite))
  const fit = live.filter(g => fitsOccasion(g, occasion))
  const other = live.filter(g => !fitsOccasion(g, occasion))
  return filter === 'fit' ? { held, fit, other: [], hidden: other.length } : { held, fit, other, hidden: 0 }
}

// ---- ideas -----------------------------------------------------------------------

/** A look the board offers: its core — a top and a bottom, or a one-piece — and the day's coat when it asks for one. */
export interface Idea {
  /** The core's ids, sorted and joined: one idea per combination. */
  key: string
  core: string[]
  /** The core, then the coat. */
  ids: string[]
}

const keyOf = (ids: readonly string[]): string => [...ids].sort().join('+')

/**
 * Looks dealt for a day: `count` of them, each a combination of its own,
 * drawn from the pieces for the day's occasion (or any time) and in season
 * when there are any (ideaPool), each as likely as its pieces' rest multiplied
 * (restWeight): the least recently worn come up most, and nothing is ruled
 * out. A one-piece counts its rest twice, so it weighs what a pair would.
 *
 * No piece comes up twice while the day's pieces allow: a look whose pieces
 * are all fresh — in no look dealt before it here, and not in `avoid` — is
 * drawn first, then one with a fresh piece, then any. A look in `last` (the
 * deal before, or the plan's look for the day) comes only when nothing else
 * can. The day's `coat` rides on every look. A held piece (retired, or in
 * Trash) is never dealt. The draw is `seed`'s (seeded), or `random`.
 */
export function dealIdeas(
  rows: Rows,
  ix: WearIndex,
  opts: { occasion: DayOccasion; season: Season; count?: number; avoid?: Iterable<string>; last?: Iterable<string>; coat?: Garment; seed?: string; random?: () => number },
): Idea[] {
  const { count = 3, coat } = opts
  // a draw of its own for every deal, so the same seed deals the same looks however often it is asked
  const random = opts.random ?? seeded(opts.seed ?? '')
  const w = (g: Garment) => restWeight(ix, g.id)
  const pool = (slot: Slot) => ideaPool(rows[slot], opts.season, opts.occasion)
  const bottoms = pool('bottom')
  const looks = [
    ...pool('top').flatMap(t => bottoms.map(b => ({ core: [t.id, b.id], weight: w(t) * w(b) }))),
    ...pool('onepiece').map(o => ({ core: [o.id], weight: w(o) ** 2 })),
  ].map(l => ({ ...l, key: keyOf(l.core) }))
  const used = new Set(opts.avoid)
  const last = new Set(opts.last)
  const dealt = new Set<string>()
  const fresh = (l: { core: string[] }) => l.core.every(id => !used.has(id))
  const some = (l: { core: string[] }) => l.core.some(id => !used.has(id))
  const anew = (l: { key: string }) => !last.has(l.key)
  const tiers = [(l: (typeof looks)[number]) => anew(l) && fresh(l), (l: (typeof looks)[number]) => anew(l) && some(l), anew, fresh, some, () => true]
  const ideas: Idea[] = []
  while (ideas.length < count) {
    const open = looks.filter(l => !dealt.has(l.key))
    const tier = tiers.map(t => open.filter(t)).find(p => p.length > 0)
    const look = tier && pickWeighted(tier, l => l.weight, random)
    if (!look) break
    dealt.add(look.key)
    for (const id of look.core) used.add(id)
    ideas.push({ key: look.key, core: look.core, ids: coat ? [...look.core, coat.id] : look.core })
  }
  return ideas
}

// ---- plan the week ---------------------------------------------------------------

/**
 * The days Plan the week offers: the shown week's days from today on — today
 * among them while it has no look — up to the last day a plan can be made for,
 * each with no look yet, worn or planned. Never a day gone by.
 */
export function daysToPlan(week: readonly string[], wears: readonly Wear[], todayKey: string, lastDay: string): string[] {
  return week.filter(d => d >= todayKey && d <= lastDay && !hasLook(wears, d))
}

const CORE = new Set<GarmentType>(CORE_TYPES)

/** The tops, bottoms and one-pieces the week's looks hold already, worn or planned: the plan steers round them. */
export function weekTaken(week: readonly string[], wears: readonly Wear[], byId: ReadonlyMap<string, Garment>): Set<string> {
  const ids = week.flatMap(d => looksWithPieces(wears, d).flatMap(w => w.garmentIds))
  return new Set(ids.filter(id => CORE.has(byId.get(id)?.type as GarmentType)))
}

/** What a day of the plan is dealt from. */
export interface PlanSource {
  rows: Rows
  ix: WearIndex
  /** What a day is dressed for. */
  occasionOf(day: string): DayOccasion
  /** The coat a day's forecast asks for: only today has a forecast. */
  coatOf?(day: string): Garment | undefined
}

/** One day's look for the plan: an idea for its occasion and season, steering round `avoid`; `deal` moves it on to another. */
export function proposeDay(src: PlanSource, day: string, avoid: Iterable<string>, deal = 0, last: Iterable<string> = []): Idea | null {
  const [idea] = dealIdeas(src.rows, src.ix, { occasion: src.occasionOf(day), season: seasonOf(day), count: 1, avoid, last, coat: src.coatOf?.(day), seed: `plan|${day}|${deal}` })
  return idea ?? null
}

/**
 * A look for each day, in order, with no top, bottom or one-piece twice in the
 * week while the wardrobe allows: each day steers round what the days before
 * it were given and what the week's looks already hold (`taken`).
 */
export function proposeWeek(src: PlanSource, days: readonly string[], taken: Iterable<string> = []): Record<string, Idea | null> {
  const used = new Set(taken)
  const plan: Record<string, Idea | null> = {}
  for (const day of days) {
    const idea = proposeDay(src, day, used)
    plan[day] = idea
    for (const id of idea?.core ?? []) used.add(id)
  }
  return plan
}

/**
 * Another look for one day of the plan: round what the other days were given
 * and what the week holds, and off the look it had — which it keeps only when
 * the wardrobe has no other for that day.
 */
export function redealDay(src: PlanSource, plan: Readonly<Record<string, Idea | null>>, day: string, taken: Iterable<string>, deal: number): Idea | null {
  const avoid = new Set(taken)
  for (const [d, idea] of Object.entries(plan)) for (const id of idea?.core ?? []) if (d !== day) avoid.add(id)
  const was = plan[day]
  for (const id of was?.core ?? []) avoid.add(id)
  return proposeDay(src, day, avoid, deal, was ? [was.key] : []) ?? was ?? null
}
