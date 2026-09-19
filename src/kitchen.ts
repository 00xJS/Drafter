import { GroceryLine, GroceryList, GroceryState, MEAL_SLOTS, Meal, MealSide, MealSlot, Place, Recipe, RecipeIngredient, Task } from './types'
import { outingsAt } from './places'
import { weekRange } from './review'
import { daysBetween } from './stats'
import { dateKey } from './utils'
import { newerStamp } from '../shared/domain.mjs'
import { mealHistory } from '../shared/weekplan.mjs'
import {
  MAX_SIDES,
  activeGroceryLines as sharedActiveGroceryLines,
  addGroceryItem as sharedAddGroceryItem,
  buildGroceryList as sharedBuildGroceryList,
  cookedRecipeIds as sharedCookedRecipeIds,
  groceryId as sharedGroceryId,
  ingredientKey as sharedIngredientKey,
  mealAt as sharedMealAt,
  mealId as sharedMealId,
  mealLabel as sharedMealLabel,
  mealRecipeIds as sharedMealRecipeIds,
  mealSides as sharedMealSides,
  mealWithMain as sharedMealWithMain,
  mergeIngredients as sharedMergeIngredients,
  recipesUsed as sharedRecipesUsed,
  removeGroceryLine as sharedRemoveGroceryLine,
  restoreGroceryLine as sharedRestoreGroceryLine,
} from '../shared/kitchen.mjs'
import type { GroceryAddOutcome, MealMain } from '../shared/kitchen.mjs'

// Merging, list building, ids and what a meal cooks live in shared/kitchen.mjs
// so an agent adding "milk" through the MCP server and the Kitchen tab produce
// the same list, and count the same dinners as cooked.

export const groceryId = (weekKey: string, userId?: string | null): string => sharedGroceryId(weekKey, userId)
export const mealId = (date: string, slot: MealSlot, userId?: string | null): string => sharedMealId(date, slot, userId)
/** The row a member writes for a day and slot — a tombstone included — found by day, not by a computed id. */
export const mealAt = (meals: readonly { kind: string }[], date: string, slot: MealSlot, userId?: string | null): Meal | null =>
  sharedMealAt(meals, date, slot, userId)
export const ingredientKey = (name: string, unit?: string): string => sharedIngredientKey(name, unit)
export const mergeIngredients = (recipes: Recipe[]): Omit<GroceryLine, 'id' | 'state'>[] => sharedMergeIngredients(recipes)
/** The recipes these meals cook, sides included: what a grocery list is built from. */
export const recipesUsed = (meals: Meal[], recipes: Recipe[]): Recipe[] => sharedRecipesUsed(meals, recipes)

export type { MealMain }
/** A meal's sides that can be shown. A bought meal has none. */
export const mealSides = (meal: Meal | null | undefined): MealSide[] => sharedMealSides(meal)
/** The saved recipes a meal cooks: its main, then its sides, each once. */
export const mealRecipeIds = (meal: Meal | null | undefined): string[] => sharedMealRecipeIds(meal)
/** What a meal has cooked by `todayKey`, main and sides: the one rule for "cooked" (shared/kitchen.mjs). */
export const cookedRecipeIds = (meal: Meal | null | undefined, todayKey: string): string[] => sharedCookedRecipeIds(meal, todayKey)
/** "Chicken curry with rice and naan"; a meal with no sides is its title alone. */
export const mealLabel = (meal: Pick<Meal, 'title'> & Partial<Meal>): string => sharedMealLabel(meal)
/**
 * A slot's meal with a new main, keeping its notes, and its sides while it is
 * still cooked (shared/kitchen.mjs has the rule; MCP's plan_meal follows it too).
 */
export const mealWithMain = (prev: Meal | null | undefined, at: { date: string; slot: MealSlot }, main: MealMain, now = new Date().toISOString(), owner: string | null = null): Meal =>
  sharedMealWithMain(prev, at, main, now, owner)

const dishKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * The meal with one more side, or null when it has that dish already — as its
 * main or as a side (a recipe by id, a typed dish by name) — has no room for
 * another, or is bought: a takeaway has no sides.
 */
export function mealWithSide(meal: Meal, side: MealSide): Meal | null {
  const title = side.title.trim()
  const sides = mealSides(meal)
  if (!title || meal.out || sides.length >= MAX_SIDES) return null
  if (side.recipeId ? side.recipeId === meal.recipeId : dishKey(title) === dishKey(meal.title)) return null
  if (sides.some(s => (side.recipeId ? s.recipeId === side.recipeId : !s.recipeId && dishKey(s.title) === dishKey(title)))) return null
  const next: MealSide = side.recipeId ? { recipeId: side.recipeId, title } : { title }
  return { ...meal, sides: [...sides, next], updatedAt: newerStamp(meal.updatedAt) }
}

/** The meal without the side at `index` (of mealSides). With none left it has no sides field, like a meal from before sides. */
export function mealWithoutSide(meal: Meal, index: number): Meal {
  const sides = mealSides(meal).filter((_, i) => i !== index)
  const next: Meal = { ...meal, updatedAt: newerStamp(meal.updatedAt) }
  if (sides.length) next.sides = sides
  else delete next.sides
  return next
}

// ---- when a recipe was last cooked ----------------------------------------------

/** A recipe's cooking as of a day: how many meals cooked it, as the main or a side, the latest, and the next one planned. */
export interface Cooked {
  timesCooked: number
  lastCooked: string | null
  /** The first day after this one with a meal on the plan that cooks it, as the main or a side. */
  nextPlanned: string | null
}

/** Every recipe's Cooked as of `dayKey`, by id. Worked out once per screen and handed to each row that shows it. */
export interface CookedIndex {
  dayKey: string
  byId: ReadonlyMap<string, Cooked>
}

/**
 * When each recipe was last cooked, and how often: mealHistory's numbers
 * (shared/weekplan.mjs), the ones the week plan and the assistant read — counted
 * by cookedRecipeIds' rule, sides included. And when it is next on the plan: the
 * earliest live meal after `dayKey` that cooks it (mealRecipeIds, so never a
 * bought one).
 */
export function cookedIndex(recipes: readonly Recipe[], meals: readonly Meal[], dayKey: string): CookedIndex {
  const next = new Map<string, string>()
  for (const m of meals) {
    if (m.deletedAt || !(m.date > dayKey)) continue
    for (const id of mealRecipeIds(m)) {
      const cur = next.get(id)
      if (!cur || m.date < cur) next.set(id, m.date)
    }
  }
  const byId = new Map(
    mealHistory([...recipes, ...meals], { dayKey }).recipes.map(r => [r.id, { timesCooked: r.timesCooked, lastCooked: r.lastCooked, nextPlanned: next.get(r.id) ?? null }]),
  )
  return { dayKey, byId }
}

/** Whole days from one day key to another: the Stats rules' own (src/stats.ts), under the name Kitchen has always used. */
export { daysBetween }

/** "today", "yesterday", "5 days ago", "3 weeks ago", "4 months ago": how long ago, as the meal plan says it. */
export function daysAgo(days: number): string {
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  if (days < 60) return `${Math.round(days / 7)} weeks ago`
  return `${Math.round(days / 30)} months ago`
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Thu 20 Aug", with the year when it is not `todayKey`'s. A day key is a day, so no zone can move it. */
export function shortDay(key: string, todayKey: string): string {
  const [y, m, d] = key.split('-').map(Number)
  const weekday = WEEKDAY_SHORT[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return `${weekday} ${d} ${MONTH_SHORT[m - 1]}${key.slice(0, 4) === todayKey.slice(0, 4) ? '' : ` ${y}`}`
}

const times = (n: number) => `${n} time${n === 1 ? '' : 's'}`

/** "3 weeks ago", or "new" for a recipe never cooked: beside each recipe in the meal pickers. */
export function lastCookedShort(ix: CookedIndex, id: string): string {
  const c = ix.byId.get(id)
  return c?.lastCooked ? daysAgo(daysBetween(c.lastCooked, ix.dayKey)) : 'new'
}

/** Every place's last outing as of `dayKey`, as a day key by id: the pickers' counterpart to CookedIndex. */
export interface VisitIndex {
  dayKey: string
  lastAt: ReadonlyMap<string, string>
}

/**
 * When each place was last gone to: its newest outing (outingsAt), a done task
 * there or a meal eaten out there, never one still to come — the Places tab's
 * "Last went" in the meal pickers' words.
 */
export function visitIndex(places: readonly Place[], tasks: readonly Task[], meals: readonly Meal[], now: Date = new Date()): VisitIndex {
  const lastAt = new Map<string, string>()
  for (const p of places) {
    const last = outingsAt(p.id, tasks as Task[], meals as Meal[], now)[0]
    if (last) lastAt.set(p.id, dateKey(new Date(last.at)))
  }
  return { dayKey: dateKey(now), lastAt }
}

/** "3 days ago", or "new" for somewhere never been: beside each place in the meal pickers, as lastCookedShort is beside a recipe. */
export function lastWentShort(ix: VisitIndex, placeId: string): string {
  const last = ix.lastAt.get(placeId)
  return last ? daysAgo(daysBetween(last, ix.dayKey)) : 'new'
}

/** "Last cooked 3 weeks ago · 5 times", or "Not cooked yet": the recipe list's line, in the Places tab's words. */
export function cookedLine(ix: CookedIndex, id: string): string {
  const c = ix.byId.get(id)
  if (!c?.lastCooked) return 'Not cooked yet'
  return `Last cooked ${daysAgo(daysBetween(c.lastCooked, ix.dayKey))} · ${times(c.timesCooked)}`
}

/** "Cooked 5 times · last Thu 20 Aug", or "Never cooked yet": a recipe's own line in cook mode. */
export function cookedSummary(ix: CookedIndex, id: string): string {
  const c = ix.byId.get(id)
  if (!c?.lastCooked) return 'Never cooked yet'
  return `Cooked ${times(c.timesCooked)} · last ${shortDay(c.lastCooked, ix.dayKey)}`
}

/** A recipe not cooked in this many days is not cooked lately. */
export const NOT_LATELY_DAYS = 30

/**
 * The recipe list's "Not lately": recipes never cooked or not cooked in
 * NOT_LATELY_DAYS, longest ago first — the never-cooked by name, then the rest
 * from the oldest last cook. It is where to look for what to plan next, so a
 * recipe already on the plan ahead, as the main or a side, is not in it: the
 * week plan cools one down the same way.
 */
export function notLately(recipes: readonly Recipe[], ix: CookedIndex): Recipe[] {
  const last = (r: Recipe) => ix.byId.get(r.id)?.lastCooked ?? ''
  return recipes
    .filter(r => !ix.byId.get(r.id)?.nextPlanned && (!last(r) || daysBetween(last(r), ix.dayKey) >= NOT_LATELY_DAYS))
    .sort((a, b) => last(a).localeCompare(last(b)) || a.name.localeCompare(b.name))
}

/**
 * Proteins and staples the cookbook can open by: a name, a tag, or an
 * ingredient that mentions one. Short words stay whole ("egg" is not eggplant);
 * longer ones take a prefix so "chicken breast" and "beefy" still count.
 */
const INCLUDE_RULES = [
  { key: 'chicken', label: 'Chicken', mode: 'prefix' },
  { key: 'beef', label: 'Beef', mode: 'prefix' },
  { key: 'steak', label: 'Beef', mode: 'prefix' },
  { key: 'pork', label: 'Pork', mode: 'prefix' },
  { key: 'turkey', label: 'Turkey', mode: 'prefix' },
  { key: 'fish', label: 'Fish', mode: 'word' },
  { key: 'salmon', label: 'Fish', mode: 'prefix' },
  { key: 'tuna', label: 'Fish', mode: 'word' },
  { key: 'shrimp', label: 'Shrimp', mode: 'prefix' },
  { key: 'pasta', label: 'Pasta', mode: 'prefix' },
  { key: 'spaghetti', label: 'Pasta', mode: 'prefix' },
  { key: 'rice', label: 'Rice', mode: 'word' },
  { key: 'bean', label: 'Beans', mode: 'word' },
  { key: 'cheese', label: 'Cheese', mode: 'prefix' },
  { key: 'egg', label: 'Eggs', mode: 'word' },
  { key: 'tofu', label: 'Tofu', mode: 'prefix' },
] as const

const INCLUDE_EDGE = '(^|[^\\p{L}\\p{N}])'

function mentionsInclude(hay: string, rule: (typeof INCLUDE_RULES)[number]): boolean {
  const body = rule.mode === 'word' ? `${rule.key}s?(?=$|[^\\p{L}\\p{N}])` : rule.key
  return new RegExp(`${INCLUDE_EDGE}${body}`, 'iu').test(hay)
}

function recipeHaystack(recipe: Recipe): string {
  return [recipe.name, ...recipe.tags, ...recipe.ingredients.map(i => i.name)].join('\n')
}

/** What a recipe includes, for the cookbook's Chicken / Beef / … chips. A tag that is not one of those is its own chip. */
export function recipeIncludes(recipe: Recipe): string[] {
  const hay = recipeHaystack(recipe)
  const keys = new Set<string>()
  for (const rule of INCLUDE_RULES) {
    if (mentionsInclude(hay, rule)) keys.add(rule.label)
  }
  for (const tag of recipe.tags) {
    const t = tag.trim()
    if (!t) continue
    const fold = INCLUDE_RULES.find(r => r.key === t.toLowerCase() || r.label.toLowerCase() === t.toLowerCase())
    keys.add(fold?.label ?? t)
  }
  return [...keys]
}

export function recipeHasInclude(recipe: Recipe, label: string): boolean {
  return recipeIncludes(recipe).some(k => k.toLowerCase() === label.toLowerCase())
}

/** The Includes chips: only what at least one recipe actually has, commonest first. */
export function recipeIncludeChips(recipes: readonly Recipe[]): { label: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const recipe of recipes) {
    for (const key of recipeIncludes(recipe)) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/** Name, tags, or an ingredient — so typing "chicken" finds a dish you have only listed it on. */
export function recipeMatchesQuery(recipe: Recipe, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  if (recipe.name.toLowerCase().includes(needle)) return true
  if (recipe.tags.some(t => t.toLowerCase().includes(needle))) return true
  return recipe.ingredients.some(i => i.name.toLowerCase().includes(needle))
}

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
export const buildGroceryList = (weekKey: string, meals: Meal[], recipes: Recipe[], prev?: GroceryList | null, now = new Date().toISOString(), owner: string | null = null): GroceryList =>
  sharedBuildGroceryList(weekKey, meals, recipes, prev ?? null, now, owner)

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

/**
 * One slot on one day: the row this member writes, and everyone else's plans
 * for the same slot. Two people can both plan Friday dinner without sharing
 * an id; Kitchen edits `mine` and names `theirs`.
 */
export function mealsForSlot(meals: readonly Meal[], date: string, slot: MealSlot, myId?: string | null): { mine?: Meal; theirs: Meal[] } {
  const on = meals.filter(m => !m.deletedAt && m.date === date && m.slot === slot)
  const mine = mealAt(on, date, slot, myId) ?? undefined
  // A peer's private slot stays off this list. Absent `shared` is the week's
  // food (v3.21), and only an explicit `false` withholds it.
  return { mine, theirs: on.filter(m => m.id !== mine?.id && m.shared !== false) }
}

/** The household task a shared breakfast, lunch or dinner writes. */
export const cookTaskId = (mealId: string): string => `task~cook~${mealId}`

const SLOT_HOUR: Record<MealSlot, number> = { breakfast: 8, lunch: 12, dinner: 18 }

/** Only an explicit Share writes the task — a meal on the week is not enough. */
export const mealIsShared = (meal: Pick<Meal, 'shared'>): boolean => meal.shared === true

export function cookTaskFor(meal: Meal, now = new Date().toISOString()): Task {
  const [y, mo, d] = meal.date.split('-').map(Number)
  const hour = SLOT_HOUR[meal.slot] ?? 18
  const due = Number.isFinite(y) ? new Date(y, mo - 1, d, hour, 0, 0).toISOString() : now
  const verb = meal.out ? 'Eat' : 'Cook'
  const when = meal.slot
  return {
    kind: 'task',
    id: cookTaskId(meal.id),
    title: `${verb} ${when}: ${mealLabel(meal)}`,
    description: 'Planned in Kitchen for the household.',
    status: 'todo',
    priority: 'normal',
    dueAt: due,
    createdAt: now,
    updatedAt: now,
    tags: ['meal'],
    placeId: meal.out ? meal.placeId : undefined,
    shared: true,
  }
}

/**
 * Tonight's meal, its recipe and the recipes of its sides. Today and the
 * briefing strip read it, so it lives here rather than in the Kitchen view,
 * which can then load on its own.
 */
export function plateFor(meal: Meal, recipes: Recipe[]): { meal: Meal; recipe?: Recipe; sides: Recipe[] } {
  const sides = mealSides(meal).flatMap(s => recipes.filter(r => s.recipeId && r.id === s.recipeId).slice(0, 1))
  return { meal, recipe: recipes.find(r => r.id === meal.recipeId), sides }
}

export function tonightDinner(meals: Meal[], recipes: Recipe[], day = new Date()): { meal: Meal; recipe?: Recipe; sides: Recipe[] } | null {
  const meal = dinnerOn(meals, day)
  if (!meal) return null
  return plateFor(meal, recipes)
}

/** Every planned slot on that day, in breakfast / lunch / dinner order — Today
 *  shows the day's food here so Kitchen is the week plan, not a second today. */
export function platesOn(meals: Meal[], recipes: Recipe[], day = new Date()): { meal: Meal; recipe?: Recipe; sides: Recipe[] }[] {
  const key = dateKey(day)
  return (mealsByDay(meals).get(key) ?? []).filter(m => !m.deletedAt).map(m => plateFor(m, recipes))
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
  owner: string | null = null,
): GroceryList[] {
  // the member's own row for the week: a week has one each now, and rebuilding
  // from someone else's would hand them your lines
  const mine = (g: GroceryList) => !owner || !g.ownerId || g.ownerId === owner
  return weeksForDates(dates).map(({ key, start }) =>
    buildGroceryList(key, mealsForWeek(meals, start), recipes, groceries.find(g => g.weekKey === key && mine(g)), now, owner),
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
