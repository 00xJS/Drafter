// Kitchen rules shared by the Kitchen tab, the MCP server and the digest:
// grocery merging, list building and ids. Dependency-free ESM.

import { weekDayKeys, weekKeyOf } from './weeks.mjs'

export const groceryId = weekKey => `grocery~${weekKey}`
export const mealId = (date, slot) => `meal~${date}~${slot}`

export function ingredientKey(name, unit) {
  return `${String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ')}|${String(unit ?? '').trim().toLowerCase()}`
}

/** One line per ingredient+unit across recipes; quantities add up ("2 onions" + "1 onion"). */
export function mergeIngredients(recipes) {
  const map = new Map()
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

/** Recipes referenced by these meals. */
export function recipesUsed(meals, recipes) {
  const ids = new Set((meals ?? []).map(m => m.recipeId).filter(Boolean))
  return (recipes ?? []).filter(r => ids.has(r.id))
}

/** Build or refresh a week's list. Keeps have/done states and hand-added lines the user already set. */
export function buildGroceryList(weekKey, meals, recipes, prev = null, now = new Date().toISOString()) {
  const merged = mergeIngredients(recipesUsed(meals, recipes))
  const prevByKey = new Map((prev?.items ?? []).map(line => [ingredientKey(line.name, line.unit), line]))
  const items = merged.map(row => {
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

/** Live meals in the Sunday-start week that contains `dateKey`, by day then slot. */
export function mealsInWeekOf(meals, dateKey) {
  const days = new Set(weekDayKeys(dateKey))
  return (meals ?? [])
    .filter(m => m && !m.deletedAt && days.has(m.date))
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.slot).localeCompare(String(b.slot)))
}

/** The week key a meal on `dateKey` belongs to (for its grocery list). */
export function groceryWeekFor(dateKey) {
  return weekKeyOf(dateKey)
}

/** Dinner on a day, or whatever is planned there. */
export function dinnerOn(meals, dateKey) {
  const live = (meals ?? []).filter(m => m && !m.deletedAt && m.date === dateKey)
  return live.find(m => m.slot === 'dinner') ?? live[0] ?? null
}

/** "Tonight: Pasta (7 ingredients)" for the digest, or null. */
export function tonightLine(meals, recipes, dateKey) {
  // dinner only: a day with just lunch planned must not read "Tonight: soup"
  const meal = (meals ?? []).find(m => m && !m.deletedAt && m.date === dateKey && m.slot === 'dinner')
  if (!meal) return null
  const recipe = meal.recipeId ? (recipes ?? []).find(r => r.id === meal.recipeId) : null
  const n = recipe?.ingredients?.length ?? 0
  return `Tonight: ${meal.title}${n ? ` (${n} ingredient${n === 1 ? '' : 's'})` : ''}`
}
