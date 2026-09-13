import { GroceryLine, GroceryList, GroceryState, MEAL_SLOTS, Meal, MealSlot, Recipe, RecipeIngredient } from './types'
import { weekRange } from './review'
import { dateKey } from './utils'
import {
  activeGroceryLines as sharedActiveGroceryLines,
  addGroceryItem as sharedAddGroceryItem,
  buildGroceryList as sharedBuildGroceryList,
  groceryId as sharedGroceryId,
  ingredientKey as sharedIngredientKey,
  mealId as sharedMealId,
  mergeIngredients as sharedMergeIngredients,
  recipesUsed as sharedRecipesUsed,
  removeGroceryLine as sharedRemoveGroceryLine,
  restoreGroceryLine as sharedRestoreGroceryLine,
} from '../shared/kitchen.mjs'
import type { GroceryAddOutcome } from '../shared/kitchen.mjs'

// Merging, list building and ids live in shared/kitchen.mjs so an agent adding
// "milk" through the MCP server and the Kitchen tab produce the same list.

export const groceryId = (weekKey: string): string => sharedGroceryId(weekKey)
export const mealId = (date: string, slot: MealSlot): string => sharedMealId(date, slot)
export const ingredientKey = (name: string, unit?: string): string => sharedIngredientKey(name, unit)
export const mergeIngredients = (recipes: Recipe[]): Omit<GroceryLine, 'id' | 'state'>[] => sharedMergeIngredients(recipes)
export const recipesUsed = (meals: Meal[], recipes: Recipe[]): Recipe[] => sharedRecipesUsed(meals, recipes)

/**
 * Where Swap moves in a slot's cycle of choices (its pick, then the
 * alternatives): the first after `current` that no other ticked slot has, so a
 * week never gets one dish twice. Null when every other choice is taken. Both
 * planning sheets use it: their alternatives can overlap from night to night.
 */
export function nextSwap(cycle: readonly string[], current: number, taken: ReadonlySet<string>): number | null {
  for (let step = 1; step < cycle.length; step++) {
    const i = (current + step) % cycle.length
    if (!taken.has(cycle[i])) return i
  }
  return null
}

/** The lines on the list: every line but the ones taken off it by hand. */
export const activeGroceryLines = (items: GroceryLine[]): GroceryLine[] => sharedActiveGroceryLines(items)
/** Take a line off the list, remembering the recipes that wanted it (see buildGroceryList). */
export const removeGroceryLine = (line: GroceryLine): GroceryLine => sharedRemoveGroceryLine(line)
/** Put a removed line back as it was. */
export const restoreGroceryLine = (line: GroceryLine): GroceryLine => sharedRestoreGroceryLine(line)
/** Add a line by name: never twice, and a removed line comes back instead of a copy. */
export const addGroceryItem = (
  items: GroceryLine[],
  input: { name: string; qty?: number | null; unit?: string | null },
  newId: () => string,
): { items: GroceryLine[]; line: GroceryLine; outcome: GroceryAddOutcome } => sharedAddGroceryItem(items, input, newId)

/**
 * A recipe matched by name, case- and space-insensitively — so planning
 * "Something new" with a dish you already have reuses that recipe instead of
 * making a second copy of it, the same rule places follow (see placeByName).
 */
export function recipeByName(name: string | null | undefined, recipes: Recipe[]): Recipe | undefined {
  const key = (name ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (!key) return undefined
  return recipes.find(r => !r.deletedAt && r.name.trim().toLowerCase().replace(/\s+/g, ' ') === key)
}

/** Build or refresh a week's list. Keeps have/done/manual lines the user already set. */
export const buildGroceryList = (weekKey: string, meals: Meal[], recipes: Recipe[], prev?: GroceryList | null, now = new Date().toISOString()): GroceryList =>
  sharedBuildGroceryList(weekKey, meals, recipes, prev ?? null, now)

export function mealsInRange(meals: Meal[], start: Date, end: Date): Meal[] {
  const from = dateKey(start)
  const to = dateKey(new Date(end.getTime() - 1))
  return meals.filter(m => m.date >= from && m.date <= to).sort((a, b) => a.date.localeCompare(b.date) || a.slot.localeCompare(b.slot))
}

export function mealsForWeek(meals: Meal[], around = new Date()): Meal[] {
  const { start, end } = weekRange(around)
  return mealsInRange(meals, start, end)
}

export function mealsByDay(meals: Meal[]): Map<string, Meal[]> {
  const map = new Map<string, Meal[]>()
  for (const m of meals) {
    const arr = map.get(m.date) ?? []
    arr.push(m)
    map.set(m.date, arr)
  }
  for (const arr of map.values()) {
    // the day's order, not the alphabet's — sorting the slot names put dinner above lunch
    arr.sort((a, b) => MEAL_SLOTS.indexOf(a.slot) - MEAL_SLOTS.indexOf(b.slot) || a.title.localeCompare(b.title))
  }
  return map
}

export function dinnerOn(meals: Meal[], day: Date): Meal | undefined {
  const key = dateKey(day)
  return meals.find(m => m.date === key && m.slot === 'dinner') ?? meals.find(m => m.date === key)
}

/** Tonight's meal and its recipe. Today and the briefing strip read it, so it lives here rather than in the Kitchen view, which can then load on its own. */
export function tonightDinner(meals: Meal[], recipes: Recipe[], day = new Date()): { meal: Meal; recipe?: Recipe } | null {
  const meal = dinnerOn(meals, day)
  if (!meal) return null
  return { meal, recipe: recipes.find(r => r.id === meal.recipeId) }
}

/** Unique Sunday-start weeks that contain these YYYY-MM-DD meal dates. */
export function weeksForDates(dates: string[]): { key: string; start: Date }[] {
  const map = new Map<string, Date>()
  for (const date of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const range = weekRange(new Date(`${date}T12:00:00`))
    if (!map.has(range.key)) map.set(range.key, range.start)
  }
  return [...map.entries()].map(([key, start]) => ({ key, start }))
}

/**
 * Rebuild grocery lists for the weeks those meal dates fall in.
 * Planning a dinner on the phone then writes a list the web grocery tab can sync.
 */
export function groceriesForMealDates(
  meals: Meal[],
  recipes: Recipe[],
  groceries: GroceryList[],
  dates: string[],
  now = new Date().toISOString(),
): GroceryList[] {
  return weeksForDates(dates).map(({ key, start }) =>
    buildGroceryList(key, mealsForWeek(meals, start), recipes, groceries.find(g => g.weekKey === key), now),
  )
}

/**
 * Everything that must be written when a meal is planned or cleared: the meal
 * row itself (or nothing, when clearing) AND the rebuilt grocery list for its
 * week.
 *
 * This exists so the Kitchen tab and the calendar's day sheet cannot disagree.
 * A meal saved without rebuilding the list leaves the shop list stale on every
 * other device — the invariant DEVELOPMENT.md calls out — and that is easy to
 * forget the second time someone wires up a meal picker.
 */
export function mealWrites(
  next: Meal | null,
  clearedId: string | null,
  meals: Meal[],
  recipes: Recipe[],
  groceries: GroceryList[],
): (Meal | GroceryList)[] {
  const withoutOld = meals.filter(m => m.id !== (next?.id ?? clearedId))
  const nextMeals = next ? [...withoutOld, next] : withoutOld
  const date = next?.date ?? meals.find(m => m.id === clearedId)?.date
  if (!date) return next ? [next] : []
  return [...(next ? [next] : []), ...groceriesForMealDates(nextMeals, recipes, groceries, [date])]
}

export function newIngredient(): RecipeIngredient {
  return { id: Math.random().toString(36).slice(2, 10), name: '' }
}

/**
 * The lines to show under a grocery filter.
 *
 * The list opens on `need`, so ticking a line used to drop it out of view the
 * instant it was tapped: every row below jumped up a full thumb-height under a
 * finger that was already aiming, and a mis-tap silently marked the wrong thing
 * bought. Lines ticked in this session stay exactly where they were — struck
 * through by `.grocery-line.done` and still carrying their three buttons, which
 * is the undo. `ticked` is session state, cleared on a week or filter change.
 *
 * Lines taken off the list are never among them — except one removed in this
 * session, whose id is in `kept`: removing a line is a tap mid-aisle too, so
 * it keeps its slot (drawn as a Removed row with Restore) rather than pulling
 * the next line up under the thumb that just confirmed. Its `removed` flag is
 * what tells the pane to draw it that way.
 */
export function visibleGroceryLines(
  items: GroceryLine[],
  filter: GroceryState | 'all',
  ticked: ReadonlySet<string>,
  kept: ReadonlySet<string> = new Set<string>(),
): GroceryLine[] {
  return items.filter(i => (i.removed ? kept.has(i.id) : filter === 'all' || i.state === filter || ticked.has(i.id)))
}

/** The lines on screen only because they were ticked — what "Clear ticked" counts. Never a removed line. */
export function heldGroceryLines(items: GroceryLine[], filter: GroceryState | 'all', ticked: ReadonlySet<string>): GroceryLine[] {
  if (filter === 'all') return []
  return items.filter(i => !i.removed && i.state !== filter && ticked.has(i.id))
}

/** The lines taken off the list, for the "Removed (n)" disclosure. */
export function removedGroceryLines(items: GroceryLine[]): GroceryLine[] {
  return items.filter(i => i.removed)
}

/** How many lines each filter holds. A removed line is in none of them, All included. */
export function groceryCounts(items: GroceryLine[]): Record<GroceryState | 'all', number> {
  const counts: Record<GroceryState | 'all', number> = { need: 0, have: 0, done: 0, all: 0 }
  for (const line of items) {
    if (line.removed) continue
    counts[line.state] += 1
    counts.all += 1
  }
  return counts
}

/**
 * Cook mode's ticked steps, kept outside React so a jetsam kill at the hob does
 * not reset a half-cooked recipe. One record at a time is enough — a main and a
 * side are cooked together, but only the recipe on screen is being ticked — so
 * every writer checks whose record is there before clearing it. The stamp keeps
 * a list from coming back ticked days later.
 */
export const COOK_STEPS_TTL_MS = 12 * 60 * 60 * 1000

/**
 * Step indexes to restore for `recipeId`, or none if the record is stale,
 * foreign, junk, or was written against a different set of steps.
 *
 * The record stores indexes, so it is only meaningful against the step list it
 * was written for: edit the recipe mid-cook — insert a step at the top, delete
 * one — and index 2 is now a different instruction. `steps` is that list's
 * length, and a mismatch throws the record away rather than striking through
 * work that has not been done.
 */
export function parseCookSteps(raw: string | null, recipeId: string, now: number, steps: number, ttlMs = COOK_STEPS_TTL_MS): number[] {
  if (!raw) return []
  let saved: unknown
  try {
    saved = JSON.parse(raw)
  } catch {
    return []
  }
  if (!saved || typeof saved !== 'object') return []
  const rec = saved as { id?: unknown; at?: unknown; steps?: unknown; done?: unknown }
  if (rec.id !== recipeId) return []
  if (rec.steps !== steps) return []
  if (typeof rec.at !== 'number' || now - rec.at > ttlMs) return []
  if (!Array.isArray(rec.done)) return []
  return rec.done.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0)
}

/**
 * Whose record is in the store, ignoring the TTL — junk reads as none.
 *
 * Cook a main, tick three steps, then open the side dish to check a temperature:
 * the side mounts with nothing ticked, and clearing on that alone would delete
 * the main's progress. Callers clear only when this returns their own recipe.
 */
export function cookStepsRecipeId(raw: string | null): string | null {
  if (!raw) return null
  try {
    const rec = JSON.parse(raw) as { id?: unknown }
    return typeof rec?.id === 'string' ? rec.id : null
  } catch {
    return null
  }
}

/**
 * The record to store, or null when nothing is ticked and the entry should go.
 *
 * `steps` is how many steps the recipe had when the ticks were made — the
 * fingerprint `parseCookSteps` checks before trusting the indexes.
 */
export function serialiseCookSteps(recipeId: string, done: Record<number, boolean>, now: number, steps: number): string | null {
  const ticked = Object.keys(done)
    .filter(k => done[Number(k)])
    .map(Number)
    .filter(n => Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b)
  if (!ticked.length) return null
  return JSON.stringify({ id: recipeId, at: now, steps, done: ticked })
}
