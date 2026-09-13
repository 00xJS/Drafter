import { GroceryLine, GroceryList, Meal, MealSide, MealSlot, Recipe } from '../src/types.js'

export declare function groceryId(weekKey: string): string
export declare function mealId(date: string, slot: MealSlot): string
export declare const MAX_SIDES: number
export declare function mealSides(meal: Partial<Meal> | null | undefined): MealSide[]
export declare function mealRecipeIds(meal: Partial<Meal> | null | undefined): string[]
export declare function cookedRecipeIds(meal: Partial<Meal> | null | undefined, todayKey: string): string[]
export declare function mealLabel(meal: Partial<Meal> | null | undefined): string
/** What a slot's new main is: a recipe or titled dish to cook, or a meal bought out. */
export interface MealMain {
  recipeId?: string
  out?: boolean
  placeId?: string
  title: string
}
export declare function mealWithMain(prev: Meal | null | undefined, at: { date: string; slot: MealSlot }, main: MealMain, now: string): Meal
export declare function ingredientKey(name: string, unit?: string): string
export declare function mergeIngredients(recipes: Recipe[]): Omit<GroceryLine, 'id' | 'state'>[]
export declare function recipesUsed(meals: Meal[], recipes: Recipe[]): Recipe[]
export declare function buildGroceryList(weekKey: string, meals: Meal[], recipes: Recipe[], prev?: GroceryList | null, now?: string): GroceryList
export declare function activeGroceryLines(items: GroceryLine[]): GroceryLine[]
export declare function removeGroceryLine(line: GroceryLine): GroceryLine
export declare function restoreGroceryLine(line: GroceryLine): GroceryLine
export type GroceryAddOutcome = 'added' | 'merged' | 'restored'
export declare function addGroceryItem(
  items: GroceryLine[],
  input: { name: string; qty?: number | null; unit?: string | null },
  newId: () => string,
): { items: GroceryLine[]; line: GroceryLine; outcome: GroceryAddOutcome }
export declare function mealsInWeekOf(meals: Meal[], dateKey: string): Meal[]
export declare function groceryWeekFor(dateKey: string): string | null
export declare function dinnerOn(meals: Meal[], dateKey: string): Meal | null
export declare function tonightLine(meals: Meal[], recipes: Recipe[], dateKey: string): string | null
