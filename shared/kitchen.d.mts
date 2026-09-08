import { GroceryLine, GroceryList, Meal, MealSlot, Recipe } from '../src/types'

export declare function groceryId(weekKey: string): string
export declare function mealId(date: string, slot: MealSlot): string
export declare function ingredientKey(name: string, unit?: string): string
export declare function mergeIngredients(recipes: Recipe[]): Omit<GroceryLine, 'id' | 'state'>[]
export declare function recipesUsed(meals: Meal[], recipes: Recipe[]): Recipe[]
export declare function buildGroceryList(weekKey: string, meals: Meal[], recipes: Recipe[], prev?: GroceryList | null, now?: string): GroceryList
export declare function mealsInWeekOf(meals: Meal[], dateKey: string): Meal[]
export declare function groceryWeekFor(dateKey: string): string | null
export declare function dinnerOn(meals: Meal[], dateKey: string): Meal | null
export declare function tonightLine(meals: Meal[], recipes: Recipe[], dateKey: string): string | null
