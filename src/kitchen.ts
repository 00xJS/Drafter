import { GroceryLine, GroceryList, GroceryState, Meal, MealSlot, Recipe, RecipeIngredient } from './types'
import { weekRange } from './review'
import { dateKey } from './utils'
import {
  buildGroceryList as sharedBuildGroceryList,
  groceryId as sharedGroceryId,
  ingredientKey as sharedIngredientKey,
  mealId as sharedMealId,
  mergeIngredients as sharedMergeIngredients,
  recipesUsed as sharedRecipesUsed,
} from '../shared/kitchen.mjs'

// Merging, list building and ids live in shared/kitchen.mjs so an agent adding
// "milk" through the MCP server and the Kitchen tab produce the same list.

export const groceryId = (weekKey: string): string => sharedGroceryId(weekKey)
export const mealId = (date: string, slot: MealSlot): string => sharedMealId(date, slot)
export const ingredientKey = (name: string, unit?: string): string => sharedIngredientKey(name, unit)
export const mergeIngredients = (recipes: Recipe[]): Omit<GroceryLine, 'id' | 'state'>[] => sharedMergeIngredients(recipes)
export const recipesUsed = (meals: Meal[], recipes: Recipe[]): Recipe[] => sharedRecipesUsed(meals, recipes)

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
    arr.sort((a, b) => a.slot.localeCompare(b.slot) || a.title.localeCompare(b.title))
  }
  return map
}

export function dinnerOn(meals: Meal[], day: Date): Meal | undefined {
  const key = dateKey(day)
  return meals.find(m => m.date === key && m.slot === 'dinner') ?? meals.find(m => m.date === key)
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
 */
export function visibleGroceryLines(items: GroceryLine[], filter: GroceryState | 'all', ticked: ReadonlySet<string>): GroceryLine[] {
  if (filter === 'all') return items
  return items.filter(i => i.state === filter || ticked.has(i.id))
}

/** The lines on screen only because they were ticked — what "Clear ticked" removes. */
export function heldGroceryLines(items: GroceryLine[], filter: GroceryState | 'all', ticked: ReadonlySet<string>): GroceryLine[] {
  if (filter === 'all') return []
  return items.filter(i => i.state !== filter && ticked.has(i.id))
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
