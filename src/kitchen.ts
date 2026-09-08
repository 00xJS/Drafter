import { GroceryLine, GroceryList, Meal, MealSlot, Recipe, RecipeIngredient } from './types'
import { weekRange } from './review'
import { dateKey } from './utils'

export const groceryId = (weekKey: string) => `grocery~${weekKey}`
export const mealId = (date: string, slot: MealSlot) => `meal~${date}~${slot}`

export function ingredientKey(name: string, unit?: string): string {
  return `${name.trim().toLowerCase().replace(/\s+/g, ' ')}|${(unit ?? '').trim().toLowerCase()}`
}

export function mergeIngredients(recipes: Recipe[]): Omit<GroceryLine, 'id' | 'state'>[] {
  const map = new Map<string, { name: string; qty?: number; unit?: string; recipeIds: string[] }>()
  for (const recipe of recipes) {
    for (const ing of recipe.ingredients) {
      const name = ing.name.trim()
      if (!name) continue
      const unit = ing.unit?.trim() || undefined
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

export function mealsInRange(meals: Meal[], start: Date, end: Date): Meal[] {
  const from = dateKey(start)
  const to = dateKey(new Date(end.getTime() - 1))
  return meals.filter(m => m.date >= from && m.date <= to).sort((a, b) => a.date.localeCompare(b.date) || a.slot.localeCompare(b.slot))
}

export function mealsForWeek(meals: Meal[], around = new Date()): Meal[] {
  const { start, end } = weekRange(around)
  return mealsInRange(meals, start, end)
}

export function recipesUsed(meals: Meal[], recipes: Recipe[]): Recipe[] {
  const ids = new Set(meals.map(m => m.recipeId).filter((id): id is string => !!id))
  return recipes.filter(r => ids.has(r.id))
}

/** Build or refresh a week's list. Keeps have/done/manual lines the user already set. */
export function buildGroceryList(weekKey: string, meals: Meal[], recipes: Recipe[], prev?: GroceryList | null, now = new Date().toISOString()): GroceryList {
  const merged = mergeIngredients(recipesUsed(meals, recipes))
  const prevByKey = new Map((prev?.items ?? []).map(line => [ingredientKey(line.name, line.unit), line]))
  const items: GroceryLine[] = merged.map(row => {
    const key = ingredientKey(row.name, row.unit)
    const old = prevByKey.get(key)
    prevByKey.delete(key)
    return {
      id: old?.id ?? `g~${key}`,
      name: row.name,
      qty: row.qty,
      unit: row.unit,
      state: old && !old.manual ? old.state : 'need',
      recipeIds: row.recipeIds,
    }
  })
  for (const leftover of prevByKey.values()) {
    if (leftover.manual) items.push(leftover)
  }
  items.sort((a, b) => a.name.localeCompare(b.name))
  return {
    kind: 'grocery',
    id: groceryId(weekKey),
    weekKey,
    items,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  }
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

export function newIngredient(): RecipeIngredient {
  return { id: Math.random().toString(36).slice(2, 10), name: '' }
}
