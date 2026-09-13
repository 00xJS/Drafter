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
export function buildGroceryList(weekKey, meals, recipes, prev = null, now = new Date().toISOString()) {
  const merged = mergeIngredients(recipesUsed(meals, recipes))
  const prevByKey = new Map((prev?.items ?? []).map(line => [ingredientKey(line.name, line.unit), line]))
  const items = merged.map(row => {
    const key = ingredientKey(row.name, row.unit)
    const old = prevByKey.get(key)
    prevByKey.delete(key)
    const line = {
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
    id: groceryId(weekKey),
    weekKey,
    items,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  }
}

/** The lines on the list: every line but the ones taken off it by hand. */
export function activeGroceryLines(items) {
  return (items ?? []).filter(line => line && !line.removed)
}

/**
 * Take a line off the list. A flag, not a deletion: a deleted line would be
 * put straight back by the next rebuild from the meal plan. The recipes that
 * wanted it are kept with it, so buildGroceryList can tell them from a recipe
 * planned since.
 */
export function removeGroceryLine(line) {
  return { ...line, removed: true, removedRecipeIds: [...(line.recipeIds ?? [])] }
}

/**
 * Put a removed line back as it was. One that no planned recipe needs any more
 * comes back as hand-added, or the next rebuild would drop it again.
 */
export function restoreGroceryLine(line) {
  const next = { ...line }
  delete next.removed
  delete next.removedRecipeIds
  if (!next.manual && !(next.recipeIds ?? []).length) next.manual = true
  return next
}

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
 * happened: added | merged | restored.
 * @param {any[]} items
 * @param {{ name?: unknown, qty?: unknown, unit?: unknown }} input
 * @param {() => string} newId
 */
export function addGroceryItem(items, { name, qty, unit } = {}, newId) {
  const list = items ?? []
  const clean = String(name ?? '').trim()
  const cleanUnit = String(unit ?? '').trim() || undefined
  const amount = qty != null && qty !== '' && Number.isFinite(Number(qty)) ? Number(qty) : undefined
  const pick = matches => {
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
    const line = { id: newId(), name: clean, state: 'need', recipeIds: [], manual: true }
    if (amount !== undefined) line.qty = amount
    if (cleanUnit) line.unit = cleanUnit
    return { items: [...list, line], line, outcome: 'added' }
  }
  const old = list[at]
  const line = old.removed ? { ...restoreGroceryLine(old), state: 'need' } : { ...old, state: 'need' }
  if (amount !== undefined) line.qty = old.removed ? amount : Math.round(((old.qty ?? 0) + amount) * 100) / 100
  const next = [...list]
  next[at] = line
  return { items: next, line, outcome: old.removed ? 'restored' : 'merged' }
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
  // a bought meal has nothing to shop for and nothing to cook, so it reads as
  // where it is coming from rather than as a recipe with an ingredient count
  if (meal.out) return `Tonight: out${meal.title && meal.title !== 'Eating out' ? ` — ${meal.title}` : ''}`
  const recipe = meal.recipeId ? (recipes ?? []).find(r => r.id === meal.recipeId) : null
  const n = recipe?.ingredients?.length ?? 0
  return `Tonight: ${meal.title}${n ? ` (${n} ingredient${n === 1 ? '' : 's'})` : ''}`
}
