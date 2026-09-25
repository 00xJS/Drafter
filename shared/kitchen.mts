// Kitchen rules shared by the Kitchen tab, the MCP server and the digest:
// grocery merging, list building, ids, and what a meal cooks. Dependency-free ESM.

import type { GroceryLine, GroceryList, Meal, MealSide, MealSlot, Recipe } from '../src/types.ts'
import { newerStamp } from './domain.mts'
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

// ---- quick picks ----------------------------------------------------------------

/**
 * A meal answered in one tap, with no recipe and no place: Leftovers, the one
 * quick pick. A planned meal is one that is eaten — a recipe, leftovers, or a
 * named place to eat out — so the week keeps logging real meals.
 *
 * Leftovers is written as the meal it is, a meal at home with no recipe, so
 * every count that reads meals already knows it: eaten in, never a recipe
 * cooked (cookedRecipeIds), so no dish's "last cooked" moves. It has no sides,
 * no recipe and no cook task, so it adds no grocery line.
 */
export type QuickPick = 'leftovers'
export const QUICK_PICKS: readonly QuickPick[] = ['leftovers']
/** Leftovers' title, its emoji, what the picker says of it, and how a planned one's card says it comes. */
export const QUICK_PICK_META: Readonly<Record<QuickPick, { label: string; emoji: string; hint: string; how: string }>> = {
  leftovers: { label: 'Leftovers', emoji: '🍲', hint: 'At home, nothing new to cook', how: 'Nothing to cook' },
}
const QUICK_SET: ReadonlySet<string> = new Set(QUICK_PICKS)
export const isQuickPick = (v: unknown): v is QuickPick => typeof v === 'string' && QUICK_SET.has(v)

/** A quick pick as a slot's new main, under its own title. */
export function quickMain(kind: QuickPick): MealMain {
  return { quick: kind, title: QUICK_PICK_META[kind].label }
}

/**
 * A meal's sides that can be shown: each with a title, and a saved recipe's id
 * where it is one. A bought meal has none, whatever its row carries, and nor
 * does a quick pick.
 */
export function mealSides(meal: Partial<Meal> | null | undefined): MealSide[] {
  if (!meal || meal.out || meal.quick || !Array.isArray(meal.sides)) return []
  return meal.sides.filter(s => s && typeof s.title === 'string' && s.title.trim())
}

/** The saved recipes a meal cooks — its main, then its sides — each once. A bought meal cooks none, and nor does a quick pick. */
export function mealRecipeIds(meal: Partial<Meal> | null | undefined): string[] {
  if (!meal || meal.out || meal.quick) return []
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

/** What a slot's new main is: a recipe or titled dish to cook, a meal bought out, or a quick pick (quickMain). */
export interface MealMain {
  recipeId?: string
  out?: boolean
  placeId?: string
  quick?: QuickPick
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
  delete next.quick
  if (main.quick) next.quick = main.quick
  else if (main.out) {
    next.out = true
    if (main.placeId) next.placeId = main.placeId
  } else if (main.recipeId) next.recipeId = main.recipeId
  // nothing is cooked for the household once it is bought or a quick pick, so nobody cooks it
  if (main.out || main.quick) delete next.cookId
  const sides = main.out || main.quick ? [] : mealSides(live).filter(s => !main.recipeId || s.recipeId !== main.recipeId)
  if (sides.length) next.sides = sides
  return Object.assign(next, { createdAt: prev?.createdAt ?? now, updatedAt: prev ? newerStamp(prev.updatedAt) : now })
}

/**
 * Who cooks a meal for the household, or nobody: `cookId` counts only on a
 * shared meal that is cooked — not one eaten out or bought, not a quick pick,
 * and not one kept to yourself, where you cook for yourself.
 */
export function mealCook(meal: Pick<Meal, 'shared' | 'out' | 'quick' | 'cookId'> | null | undefined): string | undefined {
  if (!meal || meal.shared !== true || meal.out || meal.quick) return undefined
  return typeof meal.cookId === 'string' && meal.cookId ? meal.cookId : undefined
}

/** Who a meal is for and who cooks it, in place: `shared` left as it is when undefined, `cookId` too ('' for nobody), and a cook only where mealCook would read one. */
function withAudience<T extends Meal | Omit<Meal, 'createdAt' | 'updatedAt'>>(next: T, shared: boolean | undefined, cookId: string | undefined): T {
  if (shared !== undefined) next.shared = shared
  const cook = cookId === undefined ? next.cookId : cookId
  if (cook && mealCook({ ...next, cookId: cook })) next.cookId = cook
  else delete next.cookId
  return next
}

/**
 * A planned meal with who it is for (`shared`) or who cooks it (`cookId`, ''
 * for nobody) changed, stamped: the card's Cooking toggle, the picker's For.
 * Just me takes the cook with it — you cook for yourself.
 */
export function mealAdjusted(meal: Meal, o: { shared?: boolean; cookId?: string }): Meal {
  return withAudience({ ...meal, updatedAt: newerStamp(meal.updatedAt) }, o.shared, o.cookId)
}

/**
 * The meal a pick writes for `userId`: the main chosen (mealWithMain), who it
 * is for (`shared`, left as the row has it when undefined) and who cooks it
 * (`cookId`: a member, '' for nobody, undefined to leave it) — on the
 * member's own row.
 *
 * `prev` is built on only when it is theirs, by mealAt's rule — a legacy row
 * of theirs included, a tombstone too so the pick is stamped past it — and
 * never when it is another member's, whatever its id. A legacy id has nobody
 * in it: Maria's lunch planned before members had rows of their own is
 * `meal~<date>~lunch`, and Joe writing that id for his own lunch that day
 * would be refused by her private row forever, or would replace it. A slot
 * with nothing of the member's gets a new row with them in its id (mealId).
 */
export function mealPicked(
  prev: Meal | null | undefined,
  at: { date: string; slot: MealSlot },
  main: MealMain,
  o: { userId?: string | null; now: string; shared?: boolean; cookId?: string },
): Meal {
  const userId = o.userId ?? null
  const own = prev && (!userId || !prev.ownerId || prev.ownerId === userId) ? prev : null
  return withAudience(mealWithMain(own, at, main, o.now, userId), o.shared, o.cookId)
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
