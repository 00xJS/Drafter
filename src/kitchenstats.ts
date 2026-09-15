import { weekKeyStart } from '../shared/weeks.mjs'
import { cookedIndex, cookedRecipeIds, ingredientKey, mealSides, notLately, type CookedIndex } from './kitchen'
import { outingsAt } from './places'
import { countDays, dayStreaks, daysWithin, inWindow, monthBuckets, monthsAndTrend, topN, type DayWindow, type Streaks } from './stats'
import type { GroceryList, Meal, MealSlot, Place, Recipe } from './types'
import { dateKey } from './utils'

/*
 * Kitchen → Stats, counted: pure, no DOM, worked out once per render and
 * drawn by the Stats kit (components/stats). Every figure goes by the
 * Kitchen's own rules, so it agrees with the Recipes list and This week:
 *
 * - A recipe was cooked on a day by cookedRecipeIds (shared/kitchen.mjs): a
 *   live meal, cooked rather than bought, dated today or before, with the
 *   recipe as its main or a side — the rule behind "Last cooked 3 weeks ago
 *   · 5 times". The podium and the bars count its days, so lunch and dinner
 *   from one pot are one; the Recipes list's times count its meals, and the
 *   two part only when a recipe was had twice in one day.
 * - A meal was eaten out by outingsAt (shared/places.mjs): out, at a saved
 *   place, its day come. Each is one of that place's outings, as its card
 *   counts them.
 * - A meal out with no place named ("Out, no place"), or at one since
 *   deleted, was bought. Any other meal, a dish typed with no recipe
 *   included, was cooked at home once its day had come.
 *
 * Kitchen has no Mine / Everyone: its recipes, meals and grocery lists are
 * the household's and the tab shows all of them, so nothing here reads who
 * planned what. Only the kitchen's own kinds count; anything else handed in
 * counts for nothing.
 */

/** How a meal was had, once it counts: cooked at home, eaten out at a saved place, or bought with no place named. */
export type MealWay = 'cooked' | 'out' | 'bought'

/** The three, in the order every chart, bar and key draws them. */
export const MEAL_WAYS: readonly { key: MealWay; label: string }[] = [
  { key: 'cooked', label: 'Cooked' },
  { key: 'out', label: 'Eaten out' },
  { key: 'bought', label: 'Bought' },
]

/** The kitchen as of now, worked out once: what every figure below reads. */
export interface KitchenIndex {
  /** Today on this device, and the instant a meal eaten out is counted against (outingsAt). */
  dayKey: string
  now: Date
  /** The live recipes, and each by its id. */
  recipes: readonly Recipe[]
  recipeById: ReadonlyMap<string, Recipe>
  /** The live meals, and the saved places by id. */
  meals: readonly Meal[]
  places: ReadonlyMap<string, Place>
  /** The Recipes list's own index: when each recipe was last cooked, how often, and when it is next planned. */
  cooked: CookedIndex
  /** The days each recipe was cooked, as the main or a side, newest first: a day it was cooked twice is one day. */
  days: ReadonlyMap<string, readonly string[]>
  /** How each meal that counts was had, by its id. A plan is in none, nor is a meal out whose outing has not come. */
  ways: ReadonlyMap<string, MealWay>
}

export function kitchenIndex(recipes: readonly Recipe[], meals: readonly Meal[], places: readonly Place[], now: Date = new Date()): KitchenIndex {
  const dayKey = dateKey(now)
  const liveRecipes = recipes.filter(r => r.kind === 'recipe' && !r.deletedAt)
  const liveMeals = meals.filter(m => m.kind === 'meal' && !m.deletedAt && typeof m.date === 'string')
  const livePlaces = places.filter(p => p.kind === 'place' && !p.deletedAt)
  const days = new Map<string, Set<string>>()
  for (const m of liveMeals) {
    for (const id of cookedRecipeIds(m, dayKey)) {
      const set = days.get(id) ?? new Set<string>()
      set.add(m.date)
      days.set(id, set)
    }
  }
  // eaten out: each place's own outings, the meals among them, as its card
  // counts them. The meals out are sorted to their places in one pass, so a
  // place is asked about its own meals only, never every meal there is.
  const placeById = new Map(livePlaces.map(p => [p.id, p]))
  const outBy = new Map<string, Meal[]>()
  for (const m of liveMeals) {
    if (!m.out || !m.placeId || !placeById.has(m.placeId)) continue
    const at = outBy.get(m.placeId) ?? []
    at.push(m)
    outBy.set(m.placeId, at)
  }
  const out = new Set<string>()
  for (const [id, at] of outBy) for (const o of outingsAt(id, [], at, now)) if (o.kind === 'meal') out.add(o.meal.id)
  const ways = new Map<string, MealWay>()
  for (const m of liveMeals) {
    if (out.has(m.id)) ways.set(m.id, 'out')
    else if (m.date > dayKey) continue
    else if (!m.out) ways.set(m.id, 'cooked')
    // out at a saved place but not an outing yet (its day has come here, and not yet at midday UTC): it counts once it is one
    else if (!m.placeId || !placeById.has(m.placeId)) ways.set(m.id, 'bought')
  }
  return {
    dayKey,
    now,
    recipes: liveRecipes,
    recipeById: new Map(liveRecipes.map(r => [r.id, r])),
    meals: liveMeals,
    places: placeById,
    cooked: cookedIndex(liveRecipes, liveMeals, dayKey),
    days: new Map([...days].map(([id, set]) => [id, [...set].sort().reverse()])),
    ways,
  }
}

/** The first day a recipe was cooked, or null for one never cooked. */
export function firstCooked(ix: KitchenIndex, id: string): string | null {
  const days = ix.days.get(id)
  return days?.length ? days[days.length - 1] : null
}

// ---- the tiles -------------------------------------------------------------------

export interface KitchenTiles {
  recipes: number
  /** Under the Recipes list's Not lately: never cooked, or not in a month, and not planned. */
  notLately: number
  /** Recipes first cooked this year. */
  newThisYear: number
  /** Days this month so far with a meal cooked at home, of the days there have been. */
  cookedDays: number
  daysThisMonth: number
  /** Meals this month eaten out at a place, and bought with none named. */
  eatenOut: number
  bought: number
}

/** The tiles: the recipes, and how many are under Not lately; the new this year; and this month so far. */
export function kitchenTiles(ix: KitchenIndex): KitchenTiles {
  const month = ix.dayKey.slice(0, 7)
  const year = ix.dayKey.slice(0, 4)
  const had = (way: MealWay) => ix.meals.filter(m => m.date.startsWith(month) && ix.ways.get(m.id) === way)
  return {
    recipes: ix.recipes.length,
    notLately: notLately(ix.recipes, ix.cooked).length,
    newThisYear: ix.recipes.filter(r => firstCooked(ix, r.id)?.startsWith(year)).length,
    cookedDays: new Set(had('cooked').map(m => m.date)).size,
    daysThisMonth: Number(ix.dayKey.slice(8, 10)),
    eatenOut: had('out').length,
    bought: had('bought').length,
  }
}

/**
 * Home-cooked dinners in a row (dayStreaks): the run reaching tonight, or last
 * night while tonight waits, and the best there has been; and whether tonight
 * counts yet. A dinner planned for tonight is cooked by the Kitchen's rule.
 */
export function dinnerStreaks(ix: KitchenIndex): Streaks & { today: boolean } {
  const days = ix.meals.filter(m => m.slot === 'dinner' && ix.ways.get(m.id) === 'cooked').map(m => m.date)
  return { ...dayStreaks(days, ix.dayKey), today: days.includes(ix.dayKey) }
}

// ---- the recipes -----------------------------------------------------------------

/** A recipe ranked by the days it was cooked in a window, and the last of them. */
export interface CookedRow {
  recipe: Recipe
  count: number
  last: string
}

/**
 * The recipes cooked on the most days in the window, most first; a tie goes to
 * the one cooked last, then A–Z (topN), and two of one name cooked last on one
 * day go by their ids, so the order never rests on the store's.
 */
export function mostCooked(ix: KitchenIndex, window: DayWindow, n = 10): CookedRow[] {
  const rows = ix.recipes.map(recipe => {
    const days = ix.days.get(recipe.id) ?? []
    return { recipe, count: daysWithin(days, ix.dayKey, window), last: days[0] ?? '' }
  })
  const sameName = (a: CookedRow, b: CookedRow) => a.recipe.name.localeCompare(b.recipe.name) === 0
  return topN(rows, n, {
    count: r => r.count,
    name: r => r.recipe.name,
    tie: (a, b) => b.last.localeCompare(a.last) || (sameName(a, b) ? a.recipe.id.localeCompare(b.recipe.id) : 0),
  })
}

/** Not lately's cooked half: cooked before, not in a month, and not planned, the longest ago first (notLately). */
export function notCookedLately(ix: KitchenIndex): Recipe[] {
  return notLately(ix.recipes, ix.cooked).filter(r => ix.cooked.byId.get(r.id)?.lastCooked)
}

/** Not lately's other half: never cooked and not planned, by name (notLately). */
export function neverCooked(ix: KitchenIndex): Recipe[] {
  return notLately(ix.recipes, ix.cooked).filter(r => !ix.cooked.byId.get(r.id)?.lastCooked)
}

/**
 * A dish as a day of the calendar or a thumbnail shows it: its recipe's emoji,
 * else the first letters of its name — "CC" for Chicken curry, "La" for
 * Lasagne — and the Recipes list's plate for a name with no letters at all.
 */
export function dishMark(name: string, emoji?: string): string {
  const own = emoji?.trim()
  if (own) return own
  const words = name
    .split(/\s+/)
    .map(w => w.match(/[\p{L}\p{N}]/gu) ?? [])
    .filter(letters => letters.length > 0)
  if (words.length === 0) return '🍽️'
  if (words.length === 1) return words[0][0].toUpperCase() + (words[0][1] ?? '').toLowerCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

// ---- the days --------------------------------------------------------------------

/**
 * A day's dinner as the calendar draws it: the meal, how it was had, and the
 * place it was eaten at. With no `way` it is a dinner out whose outing has not
 * come yet (outingsAt's midday UTC, which east of UTC+11 is after midnight
 * here): a plan until then, as the tiles, the shares and the place's card have it.
 */
export interface DayDinner {
  meal: Meal
  way?: MealWay
  place?: Place
}

/**
 * The dinner on each day up to today, drawn as it was had (ix.ways): cooked,
 * out at a saved place, or bought. A day still to come shows none: its dinner
 * is a plan.
 */
export function dinnerDays(ix: KitchenIndex): ReadonlyMap<string, DayDinner> {
  const days = new Map<string, DayDinner>()
  for (const m of ix.meals) {
    if (m.slot !== 'dinner' || m.date > ix.dayKey) continue
    const place = m.out && m.placeId ? ix.places.get(m.placeId) : undefined
    days.set(m.date, { meal: m, way: ix.ways.get(m.id), place })
  }
  return days
}

/** A day filed at its local midday, as the wardrobe files a day logged, so its month and its trend are this device's. */
function localMidday(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 12).toISOString()
}

/** A year by month, January first: the meals had each way, and the days with one cooked at home. */
export interface MealMonths {
  cooked: number[]
  out: number[]
  bought: number[]
  /** Days with a meal cooked at home each month, the year's total, and the 90-day trend (monthsAndTrend). */
  homeDays: { months: number[]; total: number; trend: number }
}

export function mealMonths(ix: KitchenIndex, year: number): MealMonths {
  const had = (way: MealWay) => ix.meals.filter(m => ix.ways.get(m.id) === way).map(m => ({ at: localMidday(m.date) }))
  const cooked = had('cooked')
  return {
    cooked: monthBuckets(cooked, year),
    out: monthBuckets(had('out'), year),
    bought: monthBuckets(had('bought'), year),
    homeDays: monthsAndTrend(cooked, year, ix.now, countDays),
  }
}

/** How a slot's meals were had in a window, and how many there were. */
export interface Shares {
  cooked: number
  out: number
  bought: number
  total: number
}

/** A slot's meals in the window (inWindow), by how each was had. */
export function slotShares(ix: KitchenIndex, slot: MealSlot, window: DayWindow): Shares {
  const shares: Shares = { cooked: 0, out: 0, bought: 0, total: 0 }
  for (const m of ix.meals) {
    const way = ix.ways.get(m.id)
    if (!way || m.slot !== slot || !inWindow(m.date, ix.dayKey, window)) continue
    shares[way]++
    shares.total++
  }
  return shares
}

// ---- what goes with what ---------------------------------------------------------

/** A side as it is paired: a saved recipe by its id, a dish typed by its name. */
export interface PairedSide {
  key: string
  name: string
  count: number
}

/** A main, how many meals it was cooked as the main of, and its sides most often. */
export interface Pairing {
  main: Recipe
  meals: number
  sides: PairedSide[]
}

const dishKey = (title: string) => title.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * The sides most often served with the mains cooked most (Meal.sides): the
 * `n` mains cooked as the main of the most meals that ever had a side, each
 * with its `per` sides most often, by how many of its meals had them. A saved
 * side goes by its recipe's name today, a typed one by its latest spelling —
 * unless it is typed as a saved recipe is named (recipeByName's rule: case
 * and spaces aside), when it is that recipe, so "rice" and Rice are one side.
 */
export function goesWith(ix: KitchenIndex, n = 5, per = 3): Pairing[] {
  // recipeByName, once: the first live recipe of each name, in the store's order
  const named = new Map<string, Recipe>()
  for (const r of ix.recipes) if (!named.has(dishKey(r.name))) named.set(dishKey(r.name), r)
  const mains = new Map<string, { meals: number; sides: Map<string, PairedSide & { at: string }> }>()
  for (const m of ix.meals) {
    if (ix.ways.get(m.id) !== 'cooked' || !m.recipeId || !ix.recipeById.has(m.recipeId)) continue
    const main = mains.get(m.recipeId) ?? { meals: 0, sides: new Map() }
    main.meals++
    const seen = new Set<string>()
    for (const s of mealSides(m)) {
      const recipeId = s.recipeId || named.get(dishKey(s.title))?.id
      if (recipeId === m.recipeId) continue
      const key = recipeId ? `r:${recipeId}` : `t:${dishKey(s.title)}`
      if (seen.has(key)) continue
      seen.add(key)
      const name = (recipeId && ix.recipeById.get(recipeId)?.name) || s.title.trim()
      const cur = main.sides.get(key)
      if (!cur) main.sides.set(key, { key, name, count: 1, at: m.date })
      else {
        cur.count++
        if (m.date > cur.at) Object.assign(cur, { at: m.date, name })
      }
    }
    mains.set(m.recipeId, main)
  }
  const rows = [...mains]
    .filter(([, main]) => main.sides.size > 0)
    .map(([id, main]) => ({
      main: ix.recipeById.get(id)!,
      meals: main.meals,
      sides: topN([...main.sides.values()], per, { count: s => s.count, name: s => s.name }).map(({ key, name, count }) => ({ key, name, count })),
    }))
  return topN(rows, n, { count: r => r.meals, name: r => r.main.name })
}

// ---- the grocery lists -----------------------------------------------------------

/** An item by how many weekly lists it was on, and the latest week it was. */
export interface BoughtRow {
  key: string
  name: string
  count: number
  last: string
}

/**
 * The grocery items on the most weekly lists whose week began in the window:
 * a line on the list to buy, never one taken off it or one you already had
 * (Have). An item is its name, whatever the unit, so two lines of it on one
 * list are one week; a list for a week still to come is in no window.
 */
export function mostBought(groceries: readonly GroceryList[], dayKey: string, window: DayWindow, n = 10): BoughtRow[] {
  const rows = new Map<string, BoughtRow>()
  for (const list of groceries) {
    if (list.kind !== 'grocery' || list.deletedAt) continue
    const week = weekKeyStart(list.weekKey)
    if (!week || !inWindow(week, dayKey, window)) continue
    const seen = new Set<string>()
    for (const line of list.items ?? []) {
      const name = String(line?.name ?? '').trim()
      if (!name || line.removed || line.state === 'have') continue
      const key = ingredientKey(name)
      if (seen.has(key)) continue
      seen.add(key)
      const cur = rows.get(key)
      if (!cur) rows.set(key, { key, name, count: 1, last: week })
      else {
        cur.count++
        if (week > cur.last) Object.assign(cur, { last: week, name })
      }
    }
  }
  return topN([...rows.values()], n, { count: r => r.count, name: r => r.name, tie: (a, b) => b.last.localeCompare(a.last) })
}
