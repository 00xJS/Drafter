// Kitchen rules shared by the Kitchen tab, the MCP server and the digest:
// grocery merging, list building, ids, and what a meal cooks. Dependency-free ESM.

import type { GroceryLine, GroceryList, Meal, MealSide, MealSlot, Place, Recipe } from '../src/types.ts'
import { newerStamp } from './domain.mts'
import { outingsAt } from './places.mts'
import { weekDayKeys, weekKeyOf } from './weeks.mts'

/**
 * A meal's row, and a week's grocery row, belong to ONE member.
 *
 * They used to be `meal~<date>~<slot>` and `grocery~<week>`, with nobody in
 * them — and `posts` is keyed on `id` alone, so those were one row per day and
 * one row per week for the WHOLE household. When two people planned the same
 * slot their devices wrote the same id; sync_posts keeps the first owner but
 * takes the newer `data`, so one person's lunch silently replaced the other's
 * in the same row. That is what "Maria's lunches were mine" was.
 *
 * With the member in the id there is a row each and nothing to collide. A
 * legacy row is never renamed — renaming is a data migration AND a sync
 * problem, because another device still holds the old id in its cache and
 * would push it straight back. Instead the writers below keep the id of the
 * row they are editing (`prev.id`), so a day that already has a legacy row
 * goes on using it and only new days get a per-member id.
 *
 * `userId` is null in local mode, where there is one member and nothing to
 * collide with; the ids are then exactly what they always were.
 */
export const groceryId = (weekKey: string, userId?: string | null): string => (userId ? `grocery~${weekKey}~${userId}` : `grocery~${weekKey}`)
export const mealId = (date: string, slot: MealSlot, userId?: string | null): string => (userId ? `meal~${date}~${slot}~${userId}` : `meal~${date}~${slot}`)

/** The household-wide ids used before members had their own rows. Still read, never written afresh. */
export const legacyGroceryId = (weekKey: string): string => `grocery~${weekKey}`
export const legacyMealId = (date: string, slot: MealSlot): string => `meal~${date}~${slot}`

/** A record that says it is a meal: every meal row is written with the meal's fields. */
const isMeal = (m: { kind: string }): m is Meal => m.kind === 'meal'

/**
 * The row `userId` writes for this day and slot: theirs, or a legacy row of
 * theirs from before members had their own.
 *
 * A tombstone counts. Both callers want one — a new plan for a slot that was
 * cleared has to be stamped newer than the tombstone to win the merge, and it
 * can only do that if it finds it. Looking the row up by a computed id, which
 * is what they did before, stops working the moment the id carries a member.
 */
export function mealAt(meals: readonly { kind: string }[], date: string, slot: MealSlot, userId?: string | null): Meal | null {
  const mine = (m: Meal) => !userId || !m.ownerId || m.ownerId === userId
  return (meals ?? []).find((m): m is Meal => isMeal(m) && m.date === date && m.slot === slot && mine(m)) ?? null
}

/** Enough sides for any plate; a longer list is somebody's mistake, not a dinner. */
export const MAX_SIDES = 8

/**
 * A meal's sides that can be shown: each with a title, and a saved recipe's id
 * where it is one. A bought meal has none, whatever its row carries.
 */
export function mealSides(meal: Partial<Meal> | null | undefined): MealSide[] {
  if (!meal || meal.out || !Array.isArray(meal.sides)) return []
  return meal.sides.filter(s => s && typeof s.title === 'string' && s.title.trim())
}

/** The saved recipes a meal cooks — its main, then its sides — each once. A bought meal cooks none. */
export function mealRecipeIds(meal: Partial<Meal> | null | undefined): string[] {
  if (!meal || meal.out) return []
  const ids = [meal.recipeId, ...mealSides(meal).map(s => s.recipeId)].filter((id): id is string => typeof id === 'string' && !!id)
  return [...new Set(ids)]
}

/**
 * The recipes a meal has cooked by `todayKey`, main and sides alike. This is
 * the one rule for "cooked" that every count of it goes by — the recipe list's
 * last cooked, the week plan's favourites, list_recipes: a live meal, cooked
 * rather than bought, dated `todayKey` or before. Next Friday's dinner is a
 * plan, not a cook, as next Friday's booking is not yet an outing.
 */
export function cookedRecipeIds(meal: Partial<Meal> | null | undefined, todayKey: string): string[] {
  if (!meal || meal.deletedAt || typeof meal.date !== 'string' || !(meal.date <= todayKey)) return []
  return mealRecipeIds(meal)
}

/** How a meal was had, once it counts: cooked at home, eaten out at a saved place, or bought with no place named. */
export type MealWay = 'cooked' | 'out' | 'bought'

/** The saved places a meal can be eaten out at, by id: the live ones. One in the Trash, or anything else handed in, is none. */
export function savedPlaces(places: readonly Place[]): ReadonlyMap<string, Place> {
  return new Map(places.filter(p => p.kind === 'place' && !p.deletedAt).map(p => [p.id, p]))
}

/**
 * How a meal is had, or is planned to be, whatever its day: eaten out at a
 * place still saved (`places`, as savedPlaces keeps them); bought when it is
 * out with no place named, or at one since deleted; and cooked at home
 * otherwise. The Calendar colours every meal by it, a plan by the way it is
 * planned. When a meal counts is mealWays' rule, below, not this one's.
 */
export function mealWay(meal: Pick<Meal, 'out' | 'placeId'>, places: ReadonlyMap<string, Place>): MealWay {
  if (!meal.out) return 'cooked'
  return meal.placeId && places.has(meal.placeId) ? 'out' : 'bought'
}

/**
 * How each meal that COUNTS was had, by its id — the Kitchen's rule, which
 * Kitchen → Stats, Insights' highlights and the monthly recap all read. Only
 * live meals with a day count. A meal out at a saved place counts once it is
 * one of that place's outings (outingsAt: its day has come here, and midday
 * UTC has too), so the place's card and the Kitchen agree; any other meal once
 * its day (`dayKey`, today on the reader's calendar) has come. A plan is in
 * none of them.
 */
export function mealWays(meals: readonly Meal[], places: ReadonlyMap<string, Place>, now: Date, dayKey: string): Map<string, MealWay> {
  const live = meals.filter(m => m && m.kind === 'meal' && !m.deletedAt && typeof m.date === 'string')
  // each place's own outings, the meals among them, as its card counts them.
  // The meals out are sorted to their places in one pass, so a place is asked
  // about its own meals only, never every meal there is.
  const outBy = new Map<string, Meal[]>()
  for (const m of live) {
    // out at a saved place, so it names one
    if (mealWay(m, places) !== 'out') continue
    const at = outBy.get(m.placeId!) ?? []
    at.push(m)
    outBy.set(m.placeId!, at)
  }
  const out = new Set<string>()
  for (const [id, at] of outBy) for (const o of outingsAt(id, [], at, now)) if (o.kind === 'meal') out.add(o.meal.id)
  const ways = new Map<string, MealWay>()
  for (const m of live) {
    const way = mealWay(m, places)
    if (way === 'out' ? out.has(m.id) : m.date <= dayKey) ways.set(m.id, way)
  }
  return ways
}

/**
 * "Chicken curry with rice and naan": the main's title, then its sides by name.
 * A meal with no sides reads as its title alone, exactly as before sides.
 */
export function mealLabel(meal: Partial<Meal> | null | undefined): string {
  const title = String(meal?.title ?? '')
  const sides = mealSides(meal).map(s => s.title.trim())
  if (sides.length === 0) return title
  const list = sides.length === 1 ? sides[0] : `${sides.slice(0, -1).join(', ')} and ${sides[sides.length - 1]}`
  return title ? `${title} with ${list}` : list
}

/** What a slot's new main is: a recipe or titled dish to cook, or a meal bought out. */
export interface MealMain {
  recipeId?: string
  out?: boolean
  placeId?: string
  title: string
}

/**
 * A slot's meal with a new main: a recipe (or a titled dish) to cook, or a meal
 * bought out, maybe at a place. It starts from the meal already there, so what
 * the new main does not touch — its notes — stays. The sides stay with a meal
 * that is still cooked (the rice still goes with whatever the curry became),
 * less the new main itself, and go when it becomes a bought one: a takeaway has
 * no sides. A tombstone is never built on — a cleared slot's sides went with
 * it — though its stamps are, so the new meal wins the merge. `prev` is the
 * slot's record, live or a tombstone, or nothing; `owner` is the member the
 * row belongs to, only used when there is no prev.
 */
export function mealWithMain(prev: Meal | null | undefined, { date, slot }: { date: string; slot: MealSlot }, main: MealMain, now: string, owner: string | null = null): Meal {
  const live = prev && !prev.deletedAt ? prev : null
  // prev.id, not a fresh one: a day that already has a row keeps it, legacy id and all
  const next: Omit<Meal, 'createdAt' | 'updatedAt'> = { ...(live ?? {}), kind: 'meal', id: prev?.id ?? mealId(date, slot, owner), date, slot, title: main.title }
  delete next.recipeId
  delete next.out
  delete next.placeId
  delete next.sides
  if (main.out) {
    next.out = true
    if (main.placeId) next.placeId = main.placeId
  } else if (main.recipeId) next.recipeId = main.recipeId
  const sides = main.out ? [] : mealSides(live).filter(s => !main.recipeId || s.recipeId !== main.recipeId)
  if (sides.length) next.sides = sides
  return Object.assign(next, { createdAt: prev?.createdAt ?? now, updatedAt: prev ? newerStamp(prev.updatedAt) : now })
}

export function ingredientKey(name: unknown, unit?: unknown): string {
  return `${String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ')}|${String(unit ?? '').trim().toLowerCase()}`
}

/** One line per ingredient+unit across recipes; quantities add up ("2 onions" + "1 onion"). */
export function mergeIngredients(recipes: readonly Recipe[]): Omit<GroceryLine, 'id' | 'state'>[] {
  const map = new Map<string, { name: string; qty: number | undefined; unit: string | undefined; recipeIds: string[] }>()
  for (const recipe of recipes ?? []) {
    for (const ing of recipe.ingredients ?? []) {
      const name = String(ing.name ?? '').trim()
      if (!name) continue
      const unit = String(ing.unit ?? '').trim() || undefined
      const key = ingredientKey(name, unit)
      const cur = map.get(key)
      if (!cur) {
        map.set(key, { name, qty: ing.qty, unit, recipeIds: [recipe.id] })
        continue
      }
      if (ing.qty != null && cur.qty != null) cur.qty = Math.round((cur.qty + ing.qty) * 100) / 100
      else if (ing.qty != null && cur.qty == null) cur.qty = ing.qty
      if (!cur.recipeIds.includes(recipe.id)) cur.recipeIds.push(recipe.id)
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Recipes these meals cook, sides included: what the grocery list is built from. */
export function recipesUsed(meals: readonly Meal[], recipes: readonly Recipe[]): Recipe[] {
  const ids = new Set((meals ?? []).flatMap(m => mealRecipeIds(m)))
  return (recipes ?? []).filter(r => ids.has(r.id))
}

/**
 * Build or refresh a week's list. Keeps have/done states, hand-added lines and
 * lines taken off the list that the user already set.
 *
 * A removed line stays removed while only the recipes that wanted it when it
 * was removed (`removedRecipeIds`) still want it: rebuilding, or clearing a
 * dish and planning it again, must not put it straight back. A recipe planned
 * since is a new reason to buy it, so the line comes back as need. A removed
 * line no planned recipe needs any more is kept too, flag and all — dropping
 * it would bring it back the next time that recipe is planned.
 */
export function buildGroceryList(
  weekKey: string,
  meals: readonly Meal[],
  recipes: readonly Recipe[],
  prev: GroceryList | null = null,
  now: string = new Date().toISOString(),
  owner: string | null = null,
): GroceryList {
  const merged = mergeIngredients(recipesUsed(meals, recipes))
  const prevByKey = new Map((prev?.items ?? []).map(line => [ingredientKey(line.name, line.unit), line]))
  const items = merged.map((row): GroceryLine => {
    const key = ingredientKey(row.name, row.unit)
    const old = prevByKey.get(key)
    prevByKey.delete(key)
    const line: GroceryLine = {
      id: old?.id ?? `g~${key}`,
      name: row.name,
      qty: row.qty,
      unit: row.unit,
      state: old && !old.manual ? old.state : 'need',
      recipeIds: row.recipeIds,
    }
    if (!old?.removed) return line
    const before = new Set(old.removedRecipeIds ?? [])
    if (row.recipeIds.some(id => !before.has(id))) return { ...line, state: 'need' }
    return { ...line, removed: true, removedRecipeIds: [...before] }
  })
  for (const leftover of prevByKey.values()) {
    if (leftover.manual) items.push(leftover)
    else if (leftover.removed) items.push({ ...leftover, recipeIds: [] })
  }
  items.sort((a, b) => a.name.localeCompare(b.name))
  return {
    kind: 'grocery',
    id: prev?.id ?? groceryId(weekKey, owner),
    weekKey,
    items,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  }
}

/** The lines on the list: every line but the ones taken off it by hand. */
export function activeGroceryLines(items: readonly GroceryLine[]): GroceryLine[] {
  return (items ?? []).filter(line => line && !line.removed)
}

/**
 * Take a line off the list. A flag, not a deletion: a deleted line would be
 * put straight back by the next rebuild from the meal plan. The recipes that
 * wanted it are kept with it, so buildGroceryList can tell them from a recipe
 * planned since.
 */
export function removeGroceryLine(line: GroceryLine): GroceryLine {
  return { ...line, removed: true, removedRecipeIds: [...(line.recipeIds ?? [])] }
}

/**
 * Put a removed line back as it was. One that no planned recipe needs any more
 * comes back as hand-added, or the next rebuild would drop it again.
 */
export function restoreGroceryLine(line: GroceryLine): GroceryLine {
  const next = { ...line }
  delete next.removed
  delete next.removedRecipeIds
  if (!next.manual && !(next.recipeIds ?? []).length) next.manual = true
  return next
}

export type GroceryAddOutcome = 'added' | 'merged' | 'restored'

/**
 * Add a line by name — the Kitchen tab's add box and the MCP server's
 * add_grocery_item both come through here, so they cannot disagree.
 *
 * A name already on the list is never added twice: that line goes back to
 * need, and a quantity in the same unit adds to it. A name that was taken off
 * the list restores that line rather than making a second one, back as need
 * (a quantity given now replaces the one it had). With no unit and no
 * quantity, which is all the add box has, the name alone matches — typing
 * "salt" brings back "1 tsp Salt". Lines on the list win over removed ones.
 *
 * Returns the new items, the line added or changed, and which of the three
 * happened: added | merged | restored. What is typed comes in as it was
 * typed, and is read here.
 */
export function addGroceryItem(
  items: readonly GroceryLine[],
  { name, qty, unit }: { name?: unknown; qty?: unknown; unit?: unknown } = {},
  newId: () => string,
): { items: GroceryLine[]; line: GroceryLine; outcome: GroceryAddOutcome } {
  const list = items ?? []
  const clean = String(name ?? '').trim()
  const cleanUnit = String(unit ?? '').trim() || undefined
  const amount = qty != null && qty !== '' && Number.isFinite(Number(qty)) ? Number(qty) : undefined
  const pick = (matches: (line: GroceryLine) => boolean) => {
    const live = list.findIndex(l => !l.removed && matches(l))
    return live !== -1 ? live : list.findIndex(l => l.removed && matches(l))
  }
  const key = ingredientKey(clean, cleanUnit)
  let at = pick(l => ingredientKey(l.name, l.unit) === key)
  if (at === -1 && cleanUnit === undefined && amount === undefined) {
    const nameOnly = ingredientKey(clean)
    at = pick(l => ingredientKey(l.name) === nameOnly)
  }
  if (at === -1) {
    const line: GroceryLine = { id: newId(), name: clean, state: 'need', recipeIds: [], manual: true }
    if (amount !== undefined) line.qty = amount
    if (cleanUnit) line.unit = cleanUnit
    return { items: [...list, line], line, outcome: 'added' }
  }
  const old = list[at]
  const line: GroceryLine = old.removed ? { ...restoreGroceryLine(old), state: 'need' } : { ...old, state: 'need' }
  if (amount !== undefined) line.qty = old.removed ? amount : Math.round(((old.qty ?? 0) + amount) * 100) / 100
  const next = [...list]
  next[at] = line
  return { items: next, line, outcome: old.removed ? 'restored' : 'merged' }
}

/** Live meals in the Sunday-start week that contains `dateKey`, by day then slot. */
export function mealsInWeekOf(meals: readonly Meal[], dateKey: string): Meal[] {
  const days = new Set(weekDayKeys(dateKey))
  return (meals ?? [])
    .filter(m => m && !m.deletedAt && days.has(m.date))
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.slot).localeCompare(String(b.slot)))
}

/** The week key a meal on `dateKey` belongs to (for its grocery list). */
export function groceryWeekFor(dateKey: string): string | null {
  return weekKeyOf(dateKey)
}

/** Dinner on a day, or whatever is planned there. */
export function dinnerOn(meals: readonly Meal[], dateKey: string): Meal | null {
  const live = (meals ?? []).filter(m => m && !m.deletedAt && m.date === dateKey)
  return live.find(m => m.slot === 'dinner') ?? live[0] ?? null
}

/** "Tonight: Pasta with garlic bread (7 ingredients)" for the digest, or null. */
export function tonightLine(meals: readonly Meal[], recipes: readonly Recipe[], dateKey: string): string | null {
  // dinner only: a day with just lunch planned must not read "Tonight: soup"
  const meal = (meals ?? []).find(m => m && !m.deletedAt && m.date === dateKey && m.slot === 'dinner')
  if (!meal) return null
  // a bought meal has nothing to shop for and nothing to cook, so it reads as
  // where it is coming from rather than as a recipe with an ingredient count
  if (meal.out) return `Tonight: out${meal.title && meal.title !== 'Eating out' ? ` — ${meal.title}` : ''}`
  // the main's ingredients, and each side recipe's
  const byId = new Map((recipes ?? []).map(r => [r.id, r]))
  const n = mealRecipeIds(meal).reduce((sum, id) => sum + (byId.get(id)?.ingredients?.length ?? 0), 0)
  return `Tonight: ${mealLabel(meal)}${n ? ` (${n} ingredient${n === 1 ? '' : 's'})` : ''}`
}
