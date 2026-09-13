// Kitchen rules shared by the Kitchen tab, the MCP server and the digest:
// grocery merging, list building, ids, and what a meal cooks. Dependency-free ESM.

import { newerStamp } from './domain.mjs'
import { weekDayKeys, weekKeyOf } from './weeks.mjs'

export const groceryId = weekKey => `grocery~${weekKey}`
export const mealId = (date, slot) => `meal~${date}~${slot}`

/** Enough sides for any plate; a longer list is somebody's mistake, not a dinner. */
export const MAX_SIDES = 8

/**
 * A meal's sides that can be shown: each with a title, and a saved recipe's id
 * where it is one. A bought meal has none, whatever its row carries.
 */
export function mealSides(meal) {
  if (!meal || meal.out || !Array.isArray(meal.sides)) return []
  return meal.sides.filter(s => s && typeof s.title === 'string' && s.title.trim())
}

/** The saved recipes a meal cooks — its main, then its sides — each once. A bought meal cooks none. */
export function mealRecipeIds(meal) {
  if (!meal || meal.out) return []
  const ids = [meal.recipeId, ...mealSides(meal).map(s => s.recipeId)].filter(id => typeof id === 'string' && id)
  return [...new Set(ids)]
}

/**
 * The recipes a meal has cooked by `todayKey`, main and sides alike. This is
 * the one rule for "cooked" that every count of it goes by — the recipe list's
 * last cooked, the week plan's favourites, list_recipes: a live meal, cooked
 * rather than bought, dated `todayKey` or before. Next Friday's dinner is a
 * plan, not a cook, as next Friday's booking is not yet an outing.
 */
export function cookedRecipeIds(meal, todayKey) {
  if (!meal || meal.deletedAt || typeof meal.date !== 'string' || !(meal.date <= todayKey)) return []
  return mealRecipeIds(meal)
}

/**
 * "Chicken curry with rice and naan": the main's title, then its sides by name.
 * A meal with no sides reads as its title alone, exactly as before sides.
 */
export function mealLabel(meal) {
  const title = String(meal?.title ?? '')
  const sides = mealSides(meal).map(s => s.title.trim())
  if (sides.length === 0) return title
  const list = sides.length === 1 ? sides[0] : `${sides.slice(0, -1).join(', ')} and ${sides[sides.length - 1]}`
  return title ? `${title} with ${list}` : list
}

/**
 * A slot's meal with a new main: a recipe (or a titled dish) to cook, or a meal
 * bought out, maybe at a place. It starts from the meal already there, so what
 * the new main does not touch — its notes — stays. The sides stay with a meal
 * that is still cooked (the rice still goes with whatever the curry became),
 * less the new main itself, and go when it becomes a bought one: a takeaway has
 * no sides. A tombstone is never built on — a cleared slot's sides went with
 * it — though its stamps are, so the new meal wins the merge.
 * @param {any} prev the slot's record, live or a tombstone, or nothing
 * @param {{ date: string, slot: string }} at
 * @param {{ recipeId?: string, out?: boolean, placeId?: string, title: string }} main
 * @param {string} now
 */
export function mealWithMain(prev, { date, slot }, main, now) {
  const live = prev && !prev.deletedAt ? prev : null
  const next = { ...(live ?? {}), kind: 'meal', id: mealId(date, slot), date, slot, title: main.title }
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
  next.createdAt = prev?.createdAt ?? now
  next.updatedAt = prev ? newerStamp(prev.updatedAt) : now
  return next
}

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

/** Recipes these meals cook, sides included: what the grocery list is built from. */
export function recipesUsed(meals, recipes) {
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

/** "Tonight: Pasta with garlic bread (7 ingredients)" for the digest, or null. */
export function tonightLine(meals, recipes, dateKey) {
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
