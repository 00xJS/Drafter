import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  GROCERY_STATE_META,
  GroceryLine,
  GroceryList,
  GroceryState,
  MEAL_SLOT_META,
  MEAL_SLOTS,
  Meal,
  MealSlot,
  MealSide,
  Place,
  PlaceCategory,
  Recipe,
  RecipeIngredient,
} from '../types'
import { newerStamp } from '../itemops'
import { weekRange, shiftRange } from '../review'
import { dateKey, uid } from '../utils'
import {
  addGroceryItem,
  buildGroceryList,
  cookStepsRecipeId,
  cookedIndex, visitIndex,
  daysBetween,
  mealsForSlot,
  mealIsShared,
  mealLabel,
  cookedLine,
  NOT_LATELY_DAYS,
  shortDay,
  cookedSummary,
  groceriesForMealDates,
  groceryCounts,
  groceryId,
  heldGroceryLines,
  mealRecipeIds,
  mealSides,
  mealsForWeek,
  newIngredient,
  notLately,
  recipeHasInclude,
  recipeIncludeChips,
  recipeMatchesQuery,
  parseCookSteps,
  removeGroceryLine,
  removedGroceryLines,
  restoreGroceryLine,
  serialiseCookSteps,
  visibleGroceryLines,
  dishMark,
  bareRecipesLine,
  fillQueue,
  groceryGapLine,
  groceryGaps,
} from '../kitchen'
import type { CookedIndex, VisitIndex } from '../kitchen'
import type { ReadRecipe } from '../ai'
import { safeHttpUrl } from '../links'
import { fillRunDone, fillRunWithDraft, newFillRun, recipeWithDraft, splitDraft } from '../recipefill'
import type { DraftIngredient, DraftSplit, FillRun, RecipeDraft } from '../recipefill'
import { useDayKey } from '../useDayKey'
import { haptic, openExternal } from '../native'
import { ConfirmButton } from './ConfirmButton'
import { RecipeCapture, draftNote, linkHost } from './kitchen/RecipeCapture'
import type { CaptureMode } from './kitchen/RecipeCapture'
import { RecipeFillFlow } from './kitchen/RecipeFillFlow'
import { MealSlotRow } from './MealSlotRow'
import { Modal, ModalHead } from './Modal'
import { MealPlanSheet, mealsForPicks, type MealPick } from './MealPlanSheet'
import { RecipeSuggestions } from './RecipeSuggestions'
import { KitchenStats } from './planner/lazy'
import { KITCHEN_TABS, KITCHEN_TAB_KEY, storedKitchenTab, type KitchenTab } from './planner/routes'
import type { CalendarEntry, CalendarEvent, Task } from '../types'

/** The recipe list: every recipe, or "Not lately" — the ones not cooked in a month and not on the plan, longest ago first. */
type RecipeView = 'all' | 'lately'

type RecipeGroup = { title: string; items: Recipe[] }

/** A dish's own emoji, or its first letters — never the default plate on every row. */
function RecipeMark({ recipe }: { recipe: Recipe }) {
  return (
    <span className="kitchen-dish thumb-40 recipe-mark" aria-hidden="true">
      {dishMark(recipe.name, recipe.emoji)}
    </span>
  )
}

/**
 * The cookbook, when you have not searched or filtered: what's already on a
 * meal, what you cooked this month, and the rest you have not made lately.
 */
function groupRecipes(list: Recipe[], cooked: CookedIndex): RecipeGroup[] {
  const planned: Recipe[] = []
  const recent: Recipe[] = []
  const rest: Recipe[] = []
  for (const recipe of list) {
    const row = cooked.byId.get(recipe.id)
    if (row?.nextPlanned) planned.push(recipe)
    else if (row?.lastCooked && daysBetween(row.lastCooked, cooked.dayKey) < NOT_LATELY_DAYS) recent.push(recipe)
    else rest.push(recipe)
  }
  planned.sort((a, b) => {
    const left = cooked.byId.get(a.id)?.nextPlanned ?? ''
    const right = cooked.byId.get(b.id)?.nextPlanned ?? ''
    return left.localeCompare(right) || a.name.localeCompare(b.name)
  })
  recent.sort((a, b) => {
    const left = cooked.byId.get(a.id)?.lastCooked ?? ''
    const right = cooked.byId.get(b.id)?.lastCooked ?? ''
    return right.localeCompare(left) || a.name.localeCompare(b.name)
  })
  rest.sort((a, b) => a.name.localeCompare(b.name))
  return [
    planned.length ? { title: 'On the plan', items: planned } : null,
    recent.length ? { title: 'Cooked lately', items: recent } : null,
    rest.length ? { title: 'Not lately', items: rest } : null,
  ].filter((group): group is RecipeGroup => group !== null)
}

function RecipeCard({
  recipe,
  cooked,
  today,
  onCook,
  onEdit,
}: {
  recipe: Recipe
  cooked: CookedIndex
  today: string
  onCook(recipe: Recipe): void
  onEdit(recipe: Recipe): void
}) {
  const next = cooked.byId.get(recipe.id)?.nextPlanned
  return (
    <li className="recipe-card" onClick={() => onCook(recipe)}>
      <RecipeMark recipe={recipe} />
      <div className="dash-main">
        <button type="button" className="row-open">
          <span className="dash-title">{recipe.name}</span>
        </button>
        <span className="recipe-cooked">{cookedLine(cooked, recipe.id)}</span>
        {next && <span className="recipe-on-plan">On {shortDay(next, today)}</span>}
      </div>
      <button
        type="button"
        className="btn subtle recipe-card-edit"
        onClick={e => {
          e.stopPropagation()
          onEdit(recipe)
        }}
      >
        Edit
      </button>
    </li>
  )
}

const RECIPE_VIEW_KEY = 'drafter:kitchen-recipes'

interface Props {
  /**
   * The signed-in account, null in local mode. A meal and a week's grocery
   * list are one row per member, so their ids carry it: without it two people
   * in a household write the same row and one plan replaces the other.
   */
  myId?: string | null
  /** A household member's display name, for "Maria planned dinner". */
  nameOf?(id: string | undefined): string | null
  /** Just me / Household on a breakfast, lunch or dinner — nobody to share with when this is off. */
  inHousehold?: boolean
  recipes: Recipe[]
  meals: Meal[]
  groceries: GroceryList[]
  /** Where a bought meal can come from; eating there counts as an outing. */
  places: Place[]
  onSave(item: Recipe | Meal | GroceryList): void
  onDelete(id: string): void
  /** Plan or clear a meal. Owned by Planner so the grocery rebuild happens once. */
  onSaveMeal(m: Meal): void
  onClearMeal(id: string): void
  /** Save a new place from the meal picker and hand it back. */
  onCreatePlace(name: string, category: PlaceCategory): Place
  /** Save a new recipe (name only) from the meal picker and hand it back. */
  onCreateRecipe(name: string): Recipe
  /** Open this recipe in cook mode (Today → tonight’s dinner). */
  openRecipe?: Recipe | null
  onOpenRecipeConsumed?(): void
  /** Optional, for "Plan this week's meals": tasks let places you eat at count their outings. */
  tasks?: Task[]
  /** Optional, for "Plan this week's meals": your own events and subscribed ones flag a busy evening. */
  entries?: CalendarEntry[]
  feedEvents?: CalendarEvent[]
  /** Optional: the planner's toast. With it the meal plan's confirmation and Undo go there; without it they stay in the sheet. */
  onToast?(msg: string, undo?: () => void): void
  /** A segment to open on for this visit only (?view=kitchen-stats, a tab tap); consumed, like openRecipe. */
  openTab?: KitchenTab | null
  onOpenTabConsumed?(): void
  /** A day for This week to open on, framed (the Stats lens's dinner calendar); consumed like openTab. */
  openDay?: string | null
  onOpenDayConsumed?(): void
}

export function Kitchen({ myId = null, nameOf, inHousehold, recipes, meals, groceries, places, onSave, onDelete, onSaveMeal, onClearMeal, onCreatePlace, onCreateRecipe, openRecipe, onOpenRecipeConsumed, tasks, entries, feedEvents, onToast, openTab, onOpenTabConsumed, openDay, onOpenDayConsumed }: Props) {
  // the segment last chosen, unless a way in names one for this visit
  const [seg, setSeg] = useState<KitchenTab>(() => openTab ?? storedKitchenTab())
  const [recipeView, setRecipeView] = useState<RecipeView>(() => {
    try {
      return localStorage.getItem(RECIPE_VIEW_KEY) === 'lately' ? 'lately' : 'all'
    } catch {
      return 'all'
    }
  })
  // Both seeded from the day a way in names, as `seg` is seeded from openTab.
  // The Stats lens's dinner calendar is the only sender, and it always sends
  // from another tab — so the Kitchen MOUNTS with the hand-off already set, and
  // the render-phase reconcile below (which only fires on a change) would never
  // see it. Without these two initialisers the day is consumed and thrown away.
  const [anchor, setAnchor] = useState(() => (openDay ? new Date(`${openDay}T12:00:00`) : new Date()))
  // a day opened from a dinner calendar: This week scrolls to it and frames it
  // until you move off the week or the segment
  const [focusDay, setFocusDay] = useState<string | null>(openDay ?? null)
  // the recipe form, and where Save and Cancel go back to: the list, cook mode
  // on the recipe, the side open over its main, or the Fill them in sheet.
  // Cook mode stays set while its recipe is edited, so it comes back with its
  // meal's sides and its ticks; the sheet's run does the same with its drafts.
  const [editing, setEditing] = useState<{
    recipe: Recipe | 'new'
    from: 'list' | 'cook' | 'side' | 'fill'
    /** Open on Paste or on Import from a link. */
    capture?: CaptureMode
    /** A draft from the Fill them in sheet, filled in and not yet saved. */
    draft?: RecipeDraft
  } | null>(null)
  // "Fill them in": the recipes with no ingredients, drafted one at a time
  const [fillRun, setFillRun] = useState<FillRun | null>(null)
  // cook mode: the recipe, and the meal it was opened from, whose sides it offers
  const [cooking, setCooking] = useState<{ recipe: Recipe; mealId?: string } | null>(null)
  // a side opened from cook mode: drawn over the main, which stays open underneath with its ticks
  const [cookingSide, setCookingSide] = useState<Recipe | null>(null)
  const [q, setQ] = useState('')
  const [include, setInclude] = useState<string | null>(null)
  const [planningMeals, setPlanningMeals] = useState(false)

  /**
   * Today, and the reason this page re-renders at midnight. The anchor below
   * follows it the way the wardrobe's day does: a week the reader stepped to
   * is theirs and stays, but one that is still on what WAS this week moves on
   * — otherwise a grocery list built after midnight is built into last week.
   */
  const today = useDayKey()
  const rolledFrom = useRef(today)
  useEffect(() => {
    if (rolledFrom.current === today) return
    const was = rolledFrom.current
    rolledFrom.current = today
    setAnchor(a => (dateKey(a) === was ? new Date(`${today}T12:00:00`) : a))
  }, [today])

  const week = useMemo(() => weekRange(anchor), [anchor])
  const weekMeals = useMemo(() => mealsForWeek(meals, week.start), [meals, week.start])
  // MY row for the week. A week's list is one row per member now, so picking
  // whichever came first would show — and edit — someone else's.
  const weekLists = useMemo(() => groceries.filter(g => g.weekKey === week.key && !g.deletedAt), [groceries, week.key])
  const grocery = useMemo(() => weekLists.find(g => !myId || !g.ownerId || g.ownerId === myId), [weekLists, myId])
  // everyone's, for the one list the shop is done from
  const householdLists = weekLists
  const cooked = useMemo(() => cookedIndex(recipes, meals, today), [recipes, meals, today])
  // and when each place was last gone to, beside it under Eat out
  const visited = useMemo(() => visitIndex(places, tasks ?? [], meals), [places, tasks, meals])
  const latelyCount = useMemo(() => notLately(recipes, cooked).length, [recipes, cooked])
  // recipes with nothing to shop for, the ones worth filling in first at the front
  const bare = useMemo(() => fillQueue(recipes, cooked), [recipes, cooked])
  const includeChips = useMemo(() => recipeIncludeChips(recipes), [recipes])
  const activeInclude = include && includeChips.some(c => c.label === include) ? include : null

  const filtered = useMemo(() => {
    const found = recipes.filter(r => recipeMatchesQuery(r, q) && (!activeInclude || recipeHasInclude(r, activeInclude)))
    return recipeView === 'lately' ? notLately(found, cooked) : found
  }, [recipes, q, recipeView, cooked, activeInclude])

  const setTab = (s: KitchenTab) => {
    setSeg(s)
    setFocusDay(null)
    try {
      localStorage.setItem(KITCHEN_TAB_KEY, s)
    } catch {
      /* ignore */
    }
  }
  const changeRecipeView = (v: RecipeView) => {
    setRecipeView(v)
    try {
      localStorage.setItem(RECIPE_VIEW_KEY, v)
    } catch {
      /* ignore */
    }
  }
  const cook = (recipe: Recipe, meal?: Meal) => {
    setCookingSide(null)
    setCooking({ recipe, mealId: meal?.id })
  }
  const cookingMeal = cooking?.mealId ? meals.find(m => m.id === cooking.mealId) : undefined

  const persistGroceries = (nextMeals: Meal[], dates: string[], nextRecipes = recipes) => {
    for (const g of groceriesForMealDates(nextMeals, nextRecipes, groceries, dates, undefined, myId)) onSave(g)
  }
  const persistRecipe = (r: Recipe) => {
    const nextRecipes = [...recipes.filter(x => x.id !== r.id), r]
    onSave(r)
    // a side's ingredients are on the list too, so its weeks are rebuilt like a main's
    const dates = meals.filter(m => mealRecipeIds(m).includes(r.id)).map(m => m.date)
    if (dates.length) persistGroceries(meals, dates, nextRecipes)
  }

  // the latest props, for an Undo pressed after this render's closures went stale
  const latest = useRef({ meals, recipes, groceries, onClearMeal, onSave })
  useLayoutEffect(() => {
    latest.current = { meals, recipes, groceries, onClearMeal, onSave }
  })

  /** Fill them in, over these recipes in this order. */
  const startFill = (list: readonly Recipe[]) => {
    if (list.length) setFillRun(newFillRun(list.map(r => r.id)))
  }
  /** The sheet let go of, with a word in the toast when something was saved. */
  const endFill = () => {
    const saved = fillRun?.saved ?? 0
    setFillRun(null)
    if (saved && onToast) onToast(`Filled in ${saved} recipe${saved === 1 ? '' : 's'}`)
  }
  /** A draft saved as it stands: the recipe's empty parts filled, and the grocery weeks that plan it rebuilt. */
  const saveFill = (recipe: Recipe, draft: RecipeDraft) => {
    const now = recipes.find(r => r.id === recipe.id) ?? recipe
    persistRecipe(recipeWithDraft(now, draft))
    setFillRun(run => run && fillRunDone(run, recipe.id, 'saved'))
  }

  /**
   * "Plan this week's meals", accepted: each meal through onSaveMeal (the
   * planner's own path), then the week's grocery list rebuilt once from all of
   * them — one save at a time rebuilds it from a snapshot missing the others.
   * Undo clears what is still as it was planned, drops a new dish's stub that
   * nothing uses and nobody edited, and rebuilds the list again.
   */
  const applyMealPlan = (picks: MealPick[]): { count: number; undo(): void } | null => {
    const { meals: planned, created } = mealsForPicks(picks, { recipes, places, meals, createRecipe: onCreateRecipe, now: new Date(), myId })
    if (planned.length === 0) return null
    for (const m of planned) onSaveMeal(m)
    const dates = planned.map(m => m.date)
    persistGroceries([...meals.filter(m => !planned.some(p => p.id === m.id)), ...planned], dates, [...recipes, ...created])
    return {
      count: planned.length,
      undo: () => {
        const cur = latest.current
        const cleared = new Set(planned.filter(p => cur.meals.some(m => m.id === p.id && m.updatedAt === p.updatedAt)).map(p => p.id))
        for (const id of cleared) cur.onClearMeal(id)
        const rest = cur.meals.filter(m => !cleared.has(m.id))
        for (const r of created) {
          const now = cur.recipes.find(x => x.id === r.id)
          if (now && now.updatedAt === r.updatedAt && !rest.some(m => mealRecipeIds(m).includes(r.id))) cur.onSave({ ...now, deletedAt: new Date().toISOString(), updatedAt: newerStamp(now.updatedAt) })
        }
        for (const g of groceriesForMealDates(rest, cur.recipes, cur.groceries, dates, undefined, myId)) cur.onSave(g)
      },
    }
  }

  // A way in (a link, a tap on the Kitchen tab) moves the segment
  // for this visit only: the one last chosen with its button stays remembered.
  // It moves as Kitchen renders, so the segment it leaves never shows first,
  // even when Kitchen is already on screen; the hand-off is let go of once seen.
  const [seenOpenTab, setSeenOpenTab] = useState(openTab)
  if (openTab !== seenOpenTab) {
    setSeenOpenTab(openTab)
    if (openTab) {
      setSeg(openTab)
      setFocusDay(null)
    }
  }
  useEffect(() => {
    if (openTab) onOpenTabConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTab])
  // …and a day with it, from the Stats lens's dinner calendar: the same landing
  // Stats' own days make, since it is the same calendar
  const [seenOpenDay, setSeenOpenDay] = useState(openDay)
  if (openDay !== seenOpenDay) {
    setSeenOpenDay(openDay)
    if (openDay) {
      setAnchor(new Date(`${openDay}T12:00:00`))
      setFocusDay(openDay)
      setSeg('week')
    }
  }
  useEffect(() => {
    if (openDay) onOpenDayConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openDay])
  // …and a recipe to cook, from Today's Cook on tonight's dinner or the Stats
  // lens's Most cooked. Taken last, so it wins over a segment or a day sent with
  // it; and at mount too, as the Kitchen mostly mounts with it already set.
  const [seenOpenRecipe, setSeenOpenRecipe] = useState<Recipe | null>(null)
  if ((openRecipe ?? null) !== seenOpenRecipe) {
    setSeenOpenRecipe(openRecipe ?? null)
    if (openRecipe) {
      // today's meal with this main, so its sides are in cook mode too
      const meal = meals.find(m => m.date === today && m.slot === 'dinner' && m.recipeId === openRecipe.id) ?? meals.find(m => m.date === today && m.recipeId === openRecipe.id)
      cook(openRecipe, meal)
      // setSeg, not setTab: a way in (Today's Cook, the Stats lens's Most cooked)
      // moves the segment for this visit only. setTab writes KITCHEN_TAB_KEY, so
      // it would leave every later tap of the Kitchen tab opening Recipes instead
      // of the segment the person actually chose.
      setSeg('recipes')
      setFocusDay(null)
    }
  }
  useEffect(() => {
    if (openRecipe) onOpenRecipeConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per ask; the callback is the parent's setter
  }, [openRecipe])
  /** Stats' dinner calendar: that day on This week, scrolled to and framed, for this visit only. */
  const goDay = (day: string) => {
    setAnchor(new Date(`${day}T12:00:00`))
    setFocusDay(day)
    setSeg('week')
  }

  return (
    <div className="kitchen">
      {/* four segments on one row: a phone narrows their thumbs and caps their
          labels (.kitchen-seg), as Home's four are */}
      <div className="people-tab-seg kitchen-seg">
        <span className="segmented">
          {KITCHEN_TABS.map(t => (
            <button key={t.key} className={seg === t.key ? 'seg on' : 'seg'} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </span>
      </div>

      {seg === 'recipes' && (
        <>
          <div className="people-toolbar kitchen-recipes-head">
            <div>
              <h2>Recipes</h2>
              <p className="chart-sub">Tap a dish to cook it.</p>
            </div>
            <div className="kitchen-recipe-compose">
              <button className="btn" onClick={() => setEditing({ recipe: 'new', from: 'list', capture: 'paste' })}>
                Paste a recipe
              </button>
              <button className="btn primary" onClick={() => setEditing({ recipe: 'new', from: 'list' })}>
                + Recipe
              </button>
            </div>
          </div>
          {/* Quiet, and only while it is true: a recipe with no ingredients
              puts nothing on the grocery list, and nothing else says so */}
          {bare.length > 0 && !q.trim() && (
            <div className="kitchen-gap" role="status">
              <p>{bareRecipesLine(bare.length)}</p>
              <button type="button" className="btn" onClick={() => startFill(bare)}>
                {bare.length === 1 ? 'Fill it in' : 'Fill them in'}
              </button>
            </div>
          )}
          {recipes.length > 0 && (
            <div className="kitchen-recipe-tools">
              <input className="filter-q kitchen-recipe-q" value={q} onChange={e => setQ(e.target.value)} placeholder="Search recipes" aria-label="Search recipes" />
              <div className="recipe-view-row">
                {/* "Not lately" answers "what haven't we had in a while": never
                    cooked, or not in a month, and not already planned, longest
                    ago first */}
                <span className="segmented" role="group" aria-label="Which recipes">
                  <button className={recipeView === 'all' ? 'seg on' : 'seg'} aria-pressed={recipeView === 'all'} onClick={() => changeRecipeView('all')}>
                    All {recipes.length}
                  </button>
                  <button className={recipeView === 'lately' ? 'seg on' : 'seg'} aria-pressed={recipeView === 'lately'} onClick={() => changeRecipeView('lately')}>
                    Not lately {latelyCount}
                  </button>
                </span>
                {recipeView === 'lately' && <small className="recipe-view-hint">Not cooked in a month and not planned, longest ago first</small>}
              </div>
              {includeChips.length > 0 && (
                <div className="recipe-includes">
                  <span className="recipe-includes-label" id="recipe-includes-label">
                    Includes
                  </span>
                  <span className="segmented kind-chips" role="group" aria-labelledby="recipe-includes-label">
                    <button type="button" className={!activeInclude ? 'seg on' : 'seg'} aria-pressed={!activeInclude} onClick={() => setInclude(null)}>
                      Any
                    </button>
                    {includeChips.map(c => (
                      <button
                        key={c.label}
                        type="button"
                        className={activeInclude === c.label ? 'seg on' : 'seg'}
                        aria-pressed={activeInclude === c.label}
                        onClick={() => setInclude(activeInclude === c.label ? null : c.label)}
                      >
                        {c.label} {c.count}
                      </button>
                    ))}
                  </span>
                </div>
              )}
            </div>
          )}
          {filtered.length === 0 ? (
            q.trim() ? (
              <p className="empty">No recipe matches that.</p>
            ) : activeInclude ? (
              <p className="empty">
                {recipeView === 'lately' ? 'Nothing not lately includes ' : 'No recipe includes '}
                {activeInclude}.
              </p>
            ) : recipeView === 'lately' && recipes.length > 0 ? (
              <p className="empty">Everything here was cooked in the last month or is on the plan.</p>
            ) : (
              <div className="kitchen-empty">
                <p>Save a dish you cook at home — type it, paste one you already have, or import one from a link.</p>
                <div className="kitchen-empty-actions">
                  <button className="btn" onClick={() => setEditing({ recipe: 'new', from: 'list', capture: 'paste' })}>
                    Paste a recipe
                  </button>
                  <button className="btn primary" onClick={() => setEditing({ recipe: 'new', from: 'list' })}>
                    + Recipe
                  </button>
                </div>
              </div>
            )
          ) : recipeView === 'all' && !q.trim() ? (
            <div className="recipe-book">
              {groupRecipes(filtered, cooked).map(group => (
                <section key={group.title} className="recipe-group">
                  <h3>{group.title}</h3>
                  <ul className="recipe-list">
                    {group.items.map(r => (
                      <RecipeCard
                        key={r.id}
                        recipe={r}
                        cooked={cooked}
                        today={today}
                        onCook={cook}
                        onEdit={r => setEditing({ recipe: r, from: 'list' })}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <ul className="recipe-list">
              {filtered.map(r => (
                <RecipeCard
                  key={r.id}
                  recipe={r}
                  cooked={cooked}
                  today={today}
                  onCook={cook}
                  onEdit={r => setEditing({ recipe: r, from: 'list' })}
                />
              ))}
            </ul>
          )}
          {!q.trim() && !activeInclude && recipeView === 'all' && recipes.length > 0 && (
            <RecipeSuggestions
              recipes={recipes}
              meals={meals}
              onAccept={r => {
                persistRecipe(r)
                cook(r)
              }}
            />
          )}
        </>
      )}

      {seg === 'week' && (
        <WeekPlan
          week={week}
          meals={weekMeals}
          myId={myId}
          nameOf={nameOf}
          inHousehold={inHousehold}
          recipes={recipes}
          places={places}
          cooked={cooked}
          visited={visited}
          focusDay={focusDay}
          today={today}
          onShift={d => {
            setFocusDay(null)
            setAnchor(a => shiftRange(weekRange(a), d).start)
          }}
          onSaveMeal={onSaveMeal}
          onClearMeal={onClearMeal}
          onCreatePlace={onCreatePlace}
          onCreateRecipe={onCreateRecipe}
          onOpenRecipe={cook}
          onPlan={() => setPlanningMeals(true)}
        />
      )}

      {seg === 'week' && planningMeals && (
        <MealPlanSheet
          week={week}
          items={[...recipes, ...meals, ...places, ...(tasks ?? []), ...(entries ?? [])]}
          events={feedEvents}
          recipes={recipes}
          places={places}
          meals={meals}
          onCreatePlace={onCreatePlace}
          onCreateRecipe={onCreateRecipe}
          onApply={applyMealPlan}
          onToast={onToast}
          onClose={() => setPlanningMeals(false)}
        />
      )}

      {seg === 'grocery' && (
        <GroceryPane
          myId={myId}
          householdLists={householdLists}
          week={week}
          meals={weekMeals}
          recipes={recipes}
          grocery={grocery}
          onShift={d => setAnchor(a => shiftRange(weekRange(a), d).start)}
          onSave={onSave}
          onFill={startFill}
        />
      )}

      {/* Stats is a chunk of its own, with the kit it draws with: until it is
          here, a quiet placeholder sits under the segment row */}
      {seg === 'stats' && (
        <Suspense fallback={<div className="view-pending" aria-busy="true" />}>
          <KitchenStats recipes={recipes} meals={meals} groceries={groceries} places={places} onOpenRecipe={r => cook(r)} onGoDay={goDay} />
        </Suspense>
      )}

      {/* Unmounted while its recipe is edited (it keeps its stored ticks for
          that), and back with its meal on Save or Cancel: the step list may
          have changed, and a fresh mount checks the ticks against it */}
      {cooking && editing?.from !== 'cook' && (
        <RecipeCook
          key={cooking.recipe.id}
          recipe={cooking.recipe}
          cooked={cooked}
          sides={mealSides(cookingMeal)}
          recipes={recipes}
          paused={!!cookingSide}
          onOpenSide={setCookingSide}
          onEdit={() => setEditing({ recipe: cooking.recipe, from: 'cook' })}
          onClose={() => {
            setCookingSide(null)
            setCooking(null)
          }}
        />
      )}
      {/* A side from the meal, over the main rather than instead of it: the main
          stays mounted, so the steps ticked on it are still ticked on the way
          back. Editing the side keeps it that way: the form goes over the main,
          which stays paused while the side is set, and Save or Cancel reopens
          the side — so the main is never unmounted with its ticks unwritten */}
      {cooking && cookingSide && editing?.from !== 'side' && (
        <RecipeCook
          key={`side:${cookingSide.id}`}
          recipe={cookingSide}
          cooked={cooked}
          backTo={cooking.recipe.name}
          onEdit={() => setEditing({ recipe: cookingSide, from: 'side' })}
          onClose={() => setCookingSide(null)}
        />
      )}

      {/* Out of the way while Edit has one of its recipes in the editor: the
          run keeps the drafts, so Cancel comes back to the same one */}
      {fillRun && editing?.from !== 'fill' && (
        <RecipeFillFlow
          run={fillRun}
          recipes={recipes}
          onDraft={(id, draft) => setFillRun(run => run && fillRunWithDraft(run, id, draft))}
          onSave={saveFill}
          onEdit={(recipe, draft) => setEditing({ recipe, from: 'fill', draft })}
          onSkip={recipe => setFillRun(run => run && fillRunDone(run, recipe.id, 'skipped'))}
          onStop={endFill}
        />
      )}

      {editing && (
        <RecipeForm
          // a fresh form for each recipe: its fields are seeded once, from the recipe it opened on
          key={editing.recipe === 'new' ? 'new' : editing.recipe.id}
          recipe={editing.recipe === 'new' ? undefined : editing.recipe}
          capture={editing.capture}
          draft={editing.draft}
          onSave={r => {
            persistRecipe(r)
            setEditing(null)
            // back where Edit was pressed, showing what was saved
            if (editing.from === 'fill') setFillRun(run => run && fillRunDone(run, r.id, 'saved'))
            else if (editing.from === 'side') setCookingSide(r)
            else if (editing.from === 'cook') setCooking(c => (c ? { ...c, recipe: r } : { recipe: r }))
            else cook(r)
          }}
          onDelete={
            editing.recipe !== 'new'
              ? id => {
                  onDelete(id)
                  setEditing(null)
                  if (editing.from === 'fill') {
                    setFillRun(run => run && fillRunDone(run, id, 'gone'))
                    return
                  }
                  // a deleted side goes back to its main; anything else leaves cook mode
                  setCookingSide(null)
                  if (editing.from !== 'side') setCooking(null)
                }
              : undefined
          }
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function WeekPlan({
  week,
  meals,
  myId,
  nameOf,
  inHousehold,
  recipes,
  places,
  cooked,
  visited,
  focusDay,
  onShift,
  onSaveMeal,
  onClearMeal,
  onCreatePlace,
  onCreateRecipe,
  onOpenRecipe,
  onPlan,
  today,
}: {
  week: { key: string; start: Date; end: Date; label: string }
  meals: Meal[]
  myId?: string | null
  nameOf?(id: string | undefined): string | null
  inHousehold?: boolean
  recipes: Recipe[]
  places: Place[]
  /** When each recipe was last cooked, beside it in the pickers. */
  cooked: CookedIndex
  /** When each place was last gone to, beside it under Eat out. */
  visited: VisitIndex
  /** A day opened from Stats' dinner calendar: scrolled to and framed. */
  focusDay?: string | null
  /** Today, from the page's own useDayKey, so this grid and the page never disagree about it. */
  today: string
  onShift(delta: number): void
  onCreatePlace(name: string, category: PlaceCategory): Place
  onCreateRecipe(name: string): Recipe
  onSaveMeal(m: Meal): void
  onClearMeal(id: string): void
  onOpenRecipe(r: Recipe, meal: Meal): void
  /** Open "Plan this week's meals". */
  onPlan?(): void
}) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(week.start)
    d.setDate(d.getDate() + i)
    return d
  })
  const keys = days.map(dateKey)
  // dinners still to plan from today on: a past night is not worth proposing
  const emptyDinners = keys.filter(key => key >= today && !meals.some(m => m.date === key && m.slot === 'dinner')).length
  // Breakfast and lunch stay put away until a day has one, or you ask for it —
  // otherwise the week is 21 empty dropdowns and dinner is the one that matters.
  const [extraSlots, setExtraSlots] = useState<Record<string, MealSlot[]>>({})
  // One day at a time. The strip is the week; the pickers are only for the
  // letter you have open, so a slide across the list cannot change Tuesday
  // while you meant to look at Friday.
  const land = (want: string | null | undefined) => (want && keys.includes(want) ? want : keys.includes(today) ? today : keys[0])
  const [picked, setPicked] = useState(() => land(focusDay))
  const swipeFrom = useRef<number | null>(null)
  // week.start is the week on screen (the page's memo, so it is a new one only
  // when the week is moved); a new week or a Stats day replaces the open letter
  const [pickedFor, setPickedFor] = useState({ start: week.start, focusDay })
  if (pickedFor.start !== week.start || pickedFor.focusDay !== focusDay) {
    setPickedFor({ start: week.start, focusDay })
    setPicked(land(focusDay))
  }
  const dinnerOn = (key: string) => {
    const { mine, theirs } = mealsForSlot(meals, key, 'dinner', myId)
    const shown = mine ?? theirs.find(mealIsShared) ?? theirs[0]
    return shown ? mealLabel(shown) : ''
  }
  const showSlot = (key: string, slot: MealSlot, mine?: Meal, theirs: Meal[] = []) =>
    slot === 'dinner' || !!mine || theirs.length > 0 || (extraSlots[key] ?? []).includes(slot)
  const stepDay = (dir: -1 | 1) => {
    const i = keys.indexOf(picked)
    const next = keys[i + dir]
    if (next) setPicked(next)
  }
  const pickedDate = days[keys.indexOf(picked)] ?? days[0]
  const hidden = (['breakfast', 'lunch'] as const).filter(slot => {
    const { mine, theirs } = mealsForSlot(meals, picked, slot, myId)
    return !showSlot(picked, slot, mine, theirs)
  })
  return (
    <>
      <div className="period-bar kitchen-week-head">
        <button className="btn" onClick={() => onShift(-1)} aria-label="Previous week">
          ‹
        </button>
        <h2>{week.label}</h2>
        <button className="btn" onClick={() => onShift(1)} aria-label="Next week">
          ›
        </button>
      </div>
      <nav className="week-strip" aria-label="Dinners this week">
        {days.map(d => {
          const key = dateKey(d)
          const dish = dinnerOn(key)
          const dow = d.toLocaleDateString(undefined, { weekday: 'short' })
          return (
            <button
              key={key}
              type="button"
              className={'week-strip-day' + (key === today ? ' today' : '') + (key === picked ? ' picked' : '') + (dish ? ' set' : '')}
              aria-label={`${dow}${dish ? ` ${dish}` : key < today ? ', no dinner' : ', not planned'}`}
              aria-pressed={key === picked}
              onClick={() => setPicked(key)}
            >
              <span className="week-strip-dow">{d.toLocaleDateString(undefined, { weekday: 'narrow' })}</span>
            </button>
          )
        })}
      </nav>
      {onPlan && emptyDinners > 0 && (recipes.length > 0 || places.length > 0) && (
        <div className="meal-plan-cta">
          <p>
            <strong>
              {emptyDinners === 7 ? 'Nothing planned yet' : `${emptyDinners} dinner${emptyDinners === 1 ? '' : 's'} still to plan`}
            </strong>
            <small>Picks from what you cook most, or ask the assistant when you can’t decide.</small>
          </p>
          <button className="btn primary" onClick={onPlan}>
            Plan this week’s meals
          </button>
        </div>
      )}
      <ul className="meal-week">
        <li
          key={picked}
          id={`meal-day-${picked}`}
          className={'meal-day' + (picked === today ? ' today' : '') + ' picked'}
          onTouchStart={e => {
            swipeFrom.current = e.changedTouches[0].clientX
          }}
          onTouchEnd={e => {
            const from = swipeFrom.current
            swipeFrom.current = null
            if (from == null) return
            const dx = e.changedTouches[0].clientX - from
            if (Math.abs(dx) < 48) return
            stepDay(dx < 0 ? 1 : -1)
          }}
        >
          <div className="meal-day-head">
            <strong>{pickedDate.toLocaleDateString(undefined, { weekday: 'long' })}</strong>
            <span>{pickedDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
          </div>
          {MEAL_SLOTS.map(slot => {
            const { mine, theirs } = mealsForSlot(meals, picked, slot, myId)
            if (!showSlot(picked, slot, mine, theirs)) return null
            return (
            <MealSlotRow
              key={slot}
              date={picked}
              slot={slot}
              meal={mine}
              theirs={theirs}
              nameOf={nameOf}
              inHousehold={inHousehold}
              myId={myId}
              recipes={recipes}
              places={places}
              cooked={cooked}
              visited={visited}
              onSave={onSaveMeal}
              onClear={onClearMeal}
              onCreatePlace={onCreatePlace}
              onCreateRecipe={onCreateRecipe}
              onOpenRecipe={onOpenRecipe}
            />
            )
          })}
          {hidden.length > 0 && (
            <div className="meal-day-extras">
              {hidden.map(slot => (
                <button
                  key={slot}
                  type="button"
                  className="btn subtle"
                  onClick={() => setExtraSlots(m => ({ ...m, [picked]: [...(m[picked] ?? []), slot] }))}
                >
                  + {MEAL_SLOT_META[slot].label}
                </button>
              ))}
            </div>
          )}
        </li>
      </ul>
    </>
  )
}

function GroceryPane({
  week,
  meals,
  recipes,
  grocery,
  householdLists,
  myId,
  onShift,
  onSave,
  onFill,
}: {
  week: { key: string; start: Date; end: Date; label: string }
  meals: Meal[]
  recipes: Recipe[]
  grocery?: GroceryList
  /**
   * Every member's list for this week, mine included. The pane EDITS mine and
   * SHOWS all of them as one list: a week is one row each now, which is what
   * stopped two people overwriting each other, but a shopping list you cannot
   * both read is not a shared shopping list.
   */
  householdLists?: readonly GroceryList[]
  /** Whose list this is: a week's list is one row per member, so a new one carries the member. */
  myId?: string | null
  onShift(delta: number): void
  onSave(g: GroceryList): void
  /** Fill in these recipes (the week's with no ingredients), one at a time. */
  onFill?(recipes: Recipe[]): void
}) {
  const [filter, setFilter] = useState<GroceryState | 'all'>('need')
  // this week's meals whose recipes have nothing to shop for: the reason a list is short or empty
  const gaps = useMemo(() => groceryGaps(meals, recipes), [meals, recipes])
  const [manual, setManual] = useState('')
  // ids ticked since the pane opened. They stay on screen under their old
  // filter so nothing reflows under a thumb mid-aisle and a mis-tap is undone
  // by tapping the right button on the line that is still there.
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set<string>())
  // ids removed since the pane opened, by the same rule: each keeps its slot as
  // a Removed row with Restore until the view is cleaned, so the next line is
  // not pulled up under the thumb that just confirmed the ✕.
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set<string>())
  const list = grocery ?? buildGroceryList(week.key, meals, recipes, null, undefined, myId)
  /**
   * The lines the shop is done from: mine, then everyone else's in the
   * household, each remembering the row it came from so a tick writes back to
   * the right one. Two rows can hold the same ingredient — you both planned
   * something with onions — and they stay two lines rather than being summed,
   * because guessing that 2 + 1 onions is 3 onions for one trolley is exactly
   * the sort of quiet arithmetic that sends you home with too much.
   */
  const all = useMemo(() => {
    const rows = householdLists?.length ? householdLists : [list]
    const mineFirst = [...rows].sort((a, b) => Number(!!b.ownerId === false) - Number(!!a.ownerId === false))
    return mineFirst.flatMap(row => row.items.map(line => ({ line, row })))
  }, [householdLists, list])
  const ownerOf = useMemo(() => new Map(all.map(({ line, row }) => [line.id, row])), [all])
  const items = all.map(({ line }) => line)
  const shown = visibleGroceryLines(items, filter, ticked, gone)
  const held = heldGroceryLines(items, filter, ticked)
  const removed = removedGroceryLines(items)
  // a line taken off the list is in none of these, All included
  const counts = groceryCounts(list.items)

  // a new week is a new shop: nothing carries over but the list itself
  const [shopFor, setShopFor] = useState(week.key)
  if (shopFor !== week.key) {
    setShopFor(week.key)
    setTicked(new Set<string>())
    setGone(new Set<string>())
  }

  const patch = (next: GroceryList) => onSave({ ...next, updatedAt: newerStamp(next.updatedAt) })
  /**
   * Change a line on the row that holds it, which is not always mine.
   *
   * The shop is done from one list; the lines behind it belong to whoever
   * planned the meal that wanted them. Ticking Maria's onions has to write to
   * Maria's row — a household peer may write a grocery row, so this is allowed
   * — and writing it to mine would have ticked nothing at all.
   */
  const patchLine = (id: string, change: (line: GroceryLine) => GroceryLine) => {
    const row = ownerOf.get(id) ?? list
    patch({ ...row, items: row.items.map(i => (i.id === id ? change(i) : i)) })
  }

  const setState = (id: string, state: GroceryState) => {
    void haptic('light') // eyes-free confirmation: the row deliberately does not move
    setTicked(prev => new Set(prev).add(id))
    patchLine(id, i => ({ ...i, state }))
  }

  /** The ✕'s second tap. A flag, not a deletion, so the next rebuild from the meal plan cannot put it back. */
  const remove = (id: string) => {
    void haptic('light')
    setGone(prev => new Set(prev).add(id))
    patchLine(id, removeGroceryLine)
  }

  /** Back on the list as it was. One removed in this session comes back in the slot it kept. */
  const restore = (id: string) => {
    if (gone.has(id)) setTicked(prev => new Set(prev).add(id))
    patchLine(id, restoreGroceryLine)
  }

  const clearView = () => {
    setTicked(new Set<string>())
    setGone(new Set<string>())
  }

  /** A deliberate filter change is the user asking for a clean view. */
  const changeFilter = (f: GroceryState | 'all') => {
    // re-tapping the chip that is already on is a miss, not a request: it must
    // not sweep every held line off screen with no undo
    if (f === filter) return
    setFilter(f)
    clearView()
  }

  const addManual = () => {
    const name = manual.trim()
    if (!name) return
    // add_grocery_item's rule: a name already on the list goes back to Need
    // rather than in twice, and one that was removed comes back
    patch({ ...list, id: list.id ?? groceryId(week.key, myId), weekKey: week.key, items: addGroceryItem(list.items, { name }, uid).items })
    setManual('')
  }

  const amount = (line: GroceryLine) => (line.qty != null ? `${line.qty}${line.unit ? ' ' + line.unit : ''} ` : '')

  return (
    <>
      <div className="people-toolbar">
        <h2>Grocery list</h2>
      </div>
      <div className="period-bar kitchen-grocery-week">
        <button className="btn" onClick={() => onShift(-1)} aria-label="Previous week">
          ‹
        </button>
        <span className="kitchen-week-label period-label">{week.label}</span>
        <button className="btn" onClick={() => onShift(1)} aria-label="Next week">
          ›
        </button>
        <button
          className="btn primary"
          onClick={() => onSave(buildGroceryList(week.key, meals, recipes, grocery, newerStamp(grocery?.updatedAt)))}
        >
          Build from this week
        </button>
      </div>
      <p className="field-hint">
        Pulls ingredients from recipes planned this week and merges duplicates (two onion recipes become one line). Tick Have if
        it’s already in the house, Need if you’re buying, Got it once it’s in the cart.
      </p>
      {gaps.meals.length > 0 && (
        <div className="kitchen-gap" role="status">
          <p>{groceryGapLine(gaps)}</p>
          {onFill && (
            <button type="button" className="btn" onClick={() => onFill(gaps.recipes)}>
              {gaps.recipes.length === 1 ? 'Fill it in' : 'Fill them in'}
            </button>
          )}
        </div>
      )}
      {counts.all === 0 && shown.length === 0 ? (
        // with planned meals that have no ingredients, the line above is the whole story
        removed.length || !gaps.meals.length ? (
          <p className="empty">
            {removed.length
              ? 'Nothing on the list. The lines you took off it are under Removed, at the bottom.'
              : 'No ingredients yet. Plan dinners on This week, then tap Build from this week.'}
          </p>
        ) : null
      ) : (
        <>
          <div className="grocery-filter-row">
            <div className="segmented">
              {(['need', 'have', 'done', 'all'] as const).map(f => (
                <button key={f} className={filter === f ? 'seg on' : 'seg'} onClick={() => changeFilter(f)}>
                  {f === 'all' ? `All ${counts.all}` : `${GROCERY_STATE_META[f].label} ${counts[f]}`}
                </button>
              ))}
            </div>
            {/* always rendered: appearing on the first tick would grow this
                wrapping row by a line and push the whole list down under the
                thumb, which is the reflow the held lines exist to prevent. The
                phone hides it with `visibility`, so the line is reserved. It
                un-holds ticked lines and lets go of the Removed rows' slots;
                it changes no line. Its count is ticked lines only: a removed
                line is in no count. */}
            <button
              className="btn subtle grocery-clear"
              disabled={held.length === 0 && !shown.some(line => line.removed)}
              onClick={clearView}
            >
              {held.length ? `Clear ticked (${held.length})` : 'Clear ticked'}
            </button>
          </div>
          <ul className="grocery-list">
            {shown.map(line =>
              line.removed ? (
                <li key={line.id} className="grocery-line removed">
                  <div className="dash-main">
                    <span className="dash-title">
                      {amount(line)}
                      {line.name}
                    </span>
                    <span className="dash-meta">Removed</span>
                  </div>
                  {/* where the state buttons were and built the same way, so
                      the row keeps its height and the list below stays put */}
                  <span className="segmented grocery-states">
                    <button className="seg" onClick={() => restore(line.id)}>
                      Restore<span className="grocery-sr"> {line.name}</span>
                    </button>
                  </span>
                </li>
              ) : (
                <li key={line.id} className={'grocery-line ' + line.state}>
                  <div className="dash-main">
                    <span className="dash-title">
                      {amount(line)}
                      {line.name}
                    </span>
                    <span className="dash-meta">
                      {line.manual ? 'Added by hand' : line.recipeIds.length ? `${line.recipeIds.length} recipe${line.recipeIds.length === 1 ? '' : 's'}` : ''}
                    </span>
                  </div>
                  <span className="segmented grocery-states">
                    {/* the row deliberately stays put when tapped, and the only
                        visual cue is a strike-through — aria-pressed is what tells
                        a screen reader the tick landed, and on which line */}
                    {(['have', 'need', 'done'] as const).map(s => (
                      <button
                        key={s}
                        aria-pressed={line.state === s}
                        className={line.state === s ? 'seg on' : 'seg'}
                        onClick={() => setState(line.id, s)}
                      >
                        {GROCERY_STATE_META[s].label}
                      </button>
                    ))}
                  </span>
                  {/* two-step like every delete: the first tap arms it, a
                      second within four seconds takes the line off. The name
                      is in the button for a screen reader ("Remove Milk"). */}
                  <ConfirmButton className="btn subtle grocery-remove" confirmLabel="Remove?" onConfirm={() => remove(line.id)}>
                    <span aria-hidden="true">✕</span>
                    <span className="grocery-sr">Remove {line.name}</span>
                  </ConfirmButton>
                </li>
              ),
            )}
          </ul>
        </>
      )}
      <div className="check-add">
        <input value={manual} onChange={e => setManual(e.target.value)} placeholder="Milk, paper towels…" onKeyDown={e => e.key === 'Enter' && addManual()} />
        <button className="btn" onClick={addManual} disabled={!manual.trim()}>
          Add item
        </button>
      </div>
      {removed.length > 0 && (
        <details className="grocery-removed">
          <summary>Removed ({removed.length})</summary>
          <ul className="grocery-removed-list">
            {removed.map(line => (
              <li key={line.id} className="grocery-removed-line">
                <div className="dash-main">
                  <span className="dash-title">
                    {amount(line)}
                    {line.name}
                  </span>
                  <span className="dash-meta">
                    {line.manual
                      ? 'Added by hand'
                      : line.recipeIds.length
                        ? `${line.recipeIds.length} recipe${line.recipeIds.length === 1 ? '' : 's'}`
                        : 'No planned recipe needs it'}
                  </span>
                </div>
                <button className="btn" onClick={() => restore(line.id)}>
                  Restore<span className="grocery-sr"> {line.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  )
}

/**
 * "Source · allrecipes.com ↗": the page a recipe was imported from, opened
 * outside the app (Safari's sheet on the iPhone, a new tab on the web) so cook
 * mode and its ticks stay where they are. Nothing unless it is http(s).
 */
export function RecipeSource({ url }: { url?: string }) {
  const href = safeHttpUrl(url)
  if (!href) return null
  return (
    <p className="recipe-source">
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        title={href}
        onClick={e => {
          e.preventDefault()
          void openExternal(href)
        }}
      >
        Source · {linkHost(href) || 'the web'} <span aria-hidden="true">↗</span>
      </a>
    </p>
  )
}

const COOK_STEPS_KEY = 'drafter:cook-steps'

/**
 * Keep the screen awake while cook mode is open.
 *
 * RecipeCook is the one screen that is read, not touched, for minutes: with
 * Auto-Lock at 30s the phone dies between steps and every step costs a Face ID
 * with oily hands. The Screen Wake Lock API needs no plugin and no entitlement
 * (WKWebView from iOS 16.4), but iOS releases the sentinel whenever the app
 * backgrounds — hence the release listener that nulls it and the re-acquire on
 * the way back in. If a device turns out not to honour it, the fallback is
 * `UIApplication.shared.isIdleTimerDisabled` behind a four-line plugin.
 */
function useScreenAwake(): void {
  useEffect(() => {
    const api = navigator.wakeLock
    if (!api) return
    let live = true
    let pending = false
    let lock: WakeLockSentinel | null = null
    const dropped = () => {
      lock = null
    }
    const acquire = () => {
      // `pending` matters: a request is async, so a second visibilitychange
      // before it settles would otherwise take out a lock we then leak
      if (!live || lock || pending || document.visibilityState !== 'visible') return
      pending = true
      api
        .request('screen')
        .then(sentinel => {
          pending = false
          if (!live) {
            void sentinel.release().catch(() => {})
            return
          }
          lock = sentinel
          sentinel.addEventListener('release', dropped)
        })
        .catch(() => {
          /* denied, unsupported, or the tab lost visibility mid-request */
          pending = false
        })
    }
    const onVisibility = () => acquire()
    acquire()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      live = false
      document.removeEventListener('visibilitychange', onVisibility)
      lock?.removeEventListener('release', dropped)
      void lock?.release().catch(() => {})
      lock = null
    }
  }, [])
}

export function RecipeCook({
  recipe,
  cooked,
  sides = [],
  recipes = [],
  paused = false,
  backTo,
  onOpenSide,
  onEdit,
  onClose,
}: {
  recipe: Recipe
  /** For "Cooked 5 times · last Thu 20 Aug". */
  cooked: CookedIndex
  /** The sides of the meal cook mode was opened from: each saved recipe opens over this one. */
  sides?: MealSide[]
  /** Where a side's recipe is found. */
  recipes?: Recipe[]
  /** A side is open over this recipe, or being edited from there, and holds the one ticked-steps record while it is. */
  paused?: boolean
  /** Set on a side: the main it goes back to, which Done says. */
  backTo?: string
  onOpenSide?(r: Recipe): void
  onEdit(): void
  onClose(): void
}) {
  // the stored ticks are step INDEXES, so they only mean anything against the
  // step list they were made on: Edit mid-cook, insert a step, come back, and
  // index 2 is a different instruction. The count fingerprints the record.
  const stepCount = recipe.steps?.length ?? 0
  const [done, setDone] = useState<Record<number, boolean>>(() => {
    try {
      const saved = parseCookSteps(localStorage.getItem(COOK_STEPS_KEY), recipe.id, Date.now(), stepCount)
      return Object.fromEntries(saved.map(n => [n, true]))
    } catch {
      return {}
    }
  })
  useScreenAwake()
  // survive a jetsam kill at the hob: sessionStorage would go with the WebView
  // when the shell relaunches, so this is localStorage with a same-day stamp
  useEffect(() => {
    // a side open over this recipe holds the one record while it is on screen;
    // closing it runs this again, and this recipe's ticks are written back
    if (paused) return
    try {
      const raw = serialiseCookSteps(recipe.id, done, Date.now(), stepCount)
      if (raw) localStorage.setItem(COOK_STEPS_KEY, raw)
      // untick everything and the record goes — but only ours. Opening a side
      // dish to check a temperature must not wipe the main's ticked steps.
      else if (cookStepsRecipeId(localStorage.getItem(COOK_STEPS_KEY)) === recipe.id) localStorage.removeItem(COOK_STEPS_KEY)
    } catch {
      /* private mode, or the quota is full: the steps are just not remembered */
    }
  }, [recipe.id, stepCount, done, paused])
  // Leaving the Kitchen tab unmounts this without going through close(), and an
  // abandoned cook is no more remembered than a finished one: without this,
  // reopening the recipe later today came back four steps struck through with
  // nothing to explain it. A jetsam kill runs no cleanup, which is exactly the
  // case the record is for. Edit is not a departure — it comes straight back —
  // so it keeps the ticks (and parseCookSteps still discards them if the step
  // list changed under them).
  const keepOnUnmount = useRef(false)
  useEffect(
    () => () => {
      if (keepOnUnmount.current) return
      try {
        if (cookStepsRecipeId(localStorage.getItem(COOK_STEPS_KEY)) === recipe.id) localStorage.removeItem(COOK_STEPS_KEY)
      } catch {
        /* nothing was stored to begin with */
      }
    },
    [recipe.id],
  )
  // Closing is finishing. Only a kill is remembered, so cooking the same thing
  // again tonight opens clean instead of fully struck through with no way back.
  const close = () => {
    try {
      if (cookStepsRecipeId(localStorage.getItem(COOK_STEPS_KEY)) === recipe.id) localStorage.removeItem(COOK_STEPS_KEY)
    } catch {
      /* nothing was stored to begin with */
    }
    onClose()
  }
  return (
    <Modal onClose={close} className="modal recipe-cook">
      <ModalHead
        title={
          <>
            {recipe.emoji ? `${recipe.emoji} ` : ''}
            {recipe.name}
          </>
        }
      />
      <div className="modal-body">
        <p className="recipe-cook-meta">
          {recipe.servings ? `${recipe.servings} servings` : 'No yield set'}
          {recipe.ingredients.length > 0 && ` · ${recipe.ingredients.length} ingredient${recipe.ingredients.length === 1 ? '' : 's'}`}
          {recipe.steps?.length ? ` · ${recipe.steps.length} step${recipe.steps.length === 1 ? '' : 's'}` : ''}
          {recipe.tags.length > 0 && ` · ${recipe.tags.join(', ')}`}
        </p>
        <p className="recipe-cook-history">{cookedSummary(cooked, recipe.id)}</p>
        <RecipeSource url={recipe.sourceUrl} />
        {sides.length > 0 && (
          <div className="field">
            <span>Sides</span>
            <ul className="cook-sides">
              {sides.map((s, i) => {
                const r = s.recipeId ? recipes.find(x => x.id === s.recipeId) : undefined
                return (
                  <li key={`${i}:${s.recipeId ?? s.title}`}>
                    {r && onOpenSide ? (
                      <button type="button" className="btn" onClick={() => onOpenSide(r)} aria-label={`Open ${s.title}`}>
                        {r.emoji ? `${r.emoji} ` : ''}
                        {s.title} <span aria-hidden="true">›</span>
                      </button>
                    ) : (
                      <span className="cook-side-dish">{s.title}</span>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
        {recipe.ingredients.length > 0 && (
          <div className="field">
            <span>Ingredients</span>
            <ul className="recipe-ings">
              {recipe.ingredients.map(i => (
                <li key={i.id}>
                  {i.qty != null ? `${i.qty}${i.unit ? ' ' + i.unit : ''} ` : ''}
                  {i.name}
                </li>
              ))}
            </ul>
          </div>
        )}
        {recipe.steps && recipe.steps.length > 0 ? (
          <div className="field">
            <span>Steps</span>
            <ol className="recipe-steps">
              {recipe.steps.map((step, i) => (
                <li key={i} className={done[i] ? 'done' : undefined}>
                  {/* a ticked step is only struck through, so aria-pressed is
                      the whole announcement for a screen reader */}
                  <button
                    type="button"
                    aria-pressed={!!done[i]}
                    className="recipe-step"
                    onClick={() => setDone(d => ({ ...d, [i]: !d[i] }))}
                  >
                    <span className="recipe-step-n">{i + 1}</span>
                    <span>{step}</span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <p className="muted">No steps yet — tap Edit to add how you cook it.</p>
        )}
        {recipe.notes && <p className="recipe-notes">{recipe.notes}</p>}
      </div>
      <footer className="modal-foot">
        <button
          className="btn"
          onClick={() => {
            keepOnUnmount.current = true
            onEdit()
          }}
        >
          Edit
        </button>
        <span className="spacer" />
        <button className="btn primary" onClick={close}>
          {backTo ? `Back to ${backTo}` : 'Done'}
        </button>
      </footer>
    </Modal>
  )
}

/** Editor rows for ingredients read or drafted elsewhere, each with a row id of its own. */
function ingredientRows(list: readonly DraftIngredient[]): RecipeIngredient[] {
  return list.map(i => ({ ...newIngredient(), name: i.name, ...(i.qty !== undefined ? { qty: i.qty } : {}), ...(i.unit ? { unit: i.unit } : {}) }))
}

/** What each row's quantity box shows for rows that arrive whole. */
const qtyTexts = (rows: readonly RecipeIngredient[]) => Object.fromEntries(rows.map(r => [r.id, r.qty != null ? String(r.qty) : '']))

/** "2 cup flour" for a list of the draft's ingredients. */
const ingredientLabel = (i: DraftIngredient) => `${i.qty !== undefined ? `${i.qty}${i.unit ? ' ' + i.unit : ''} ` : ''}${i.name}`

/**
 * The parts of a draft that would have replaced something the recipe already
 * had: shown beside it, and used only when the cook says so.
 */
function DraftSpare({ spare, onIngredients, onSteps, onDismiss }: { spare: DraftSplit['spare']; onIngredients(): void; onSteps(): void; onDismiss(): void }) {
  return (
    <div className="recipe-draft-spare">
      {spare.ingredients && (
        <div className="recipe-draft-part">
          <p>
            <strong>The draft’s ingredients</strong> · {spare.ingredients.map(ingredientLabel).join(', ')}
          </p>
          <button type="button" className="btn" onClick={onIngredients}>
            Use these instead
          </button>
        </div>
      )}
      {spare.steps && (
        <div className="recipe-draft-part">
          <p>
            <strong>The draft’s steps</strong>
          </p>
          <ol>
            {spare.steps.map((s, n) => (
              <li key={n}>{s}</li>
            ))}
          </ol>
          <button type="button" className="btn" onClick={onSteps}>
            Use these instead
          </button>
        </div>
      )}
      <button type="button" className="btn subtle" onClick={onDismiss}>
        Keep mine
      </button>
    </div>
  )
}

function RecipeForm({
  recipe,
  capture,
  draft,
  onSave,
  onDelete,
  onClose,
}: {
  recipe?: Recipe
  /** Open on Paste or on Import from a link — the list's doors, not a blank form first. */
  capture?: CaptureMode
  /** A draft from Fill them in: filled into the empty parts, the rest shown beside them. */
  draft?: RecipeDraft
  onSave(r: Recipe): void
  onDelete?(id: string): void
  onClose(): void
}) {
  // what the form opens with, worked out once: the recipe as saved, and a
  // handed-over draft where it fills something empty
  const [start] = useState(() => {
    const own = recipe?.ingredients ?? []
    const ownSteps = (recipe?.steps ?? []).join('\n')
    const has = { ingredients: own.some(i => i.name.trim()), steps: ownSteps.trim() !== '' }
    const split = draft ? splitDraft(has, draft) : null
    const rows = split?.fill.ingredients ? ingredientRows(split.fill.ingredients) : own.length ? own : [newIngredient()]
    return {
      rows,
      steps: split?.fill.steps ? split.fill.steps.join('\n') : ownSteps,
      servings: recipe?.servings != null ? String(recipe.servings) : draft?.servings ? String(draft.servings) : '4',
      spare: split && (split.spare.ingredients || split.spare.steps) ? split.spare : null,
      note: draft ? draftNote(has, draft) : '',
    }
  })
  const [name, setName] = useState(recipe?.name ?? '')
  const [emoji, setEmoji] = useState(recipe?.emoji ?? '')
  const [servings, setServings] = useState(start.servings)
  const [ingredients, setIngredients] = useState<RecipeIngredient[]>(start.rows)
  /**
   * What is TYPED in each quantity box, which is not the same thing as the
   * number it will become.
   *
   * The box used to render `ing.qty` and parse every keystroke, so a decimal
   * could not be typed at all: "0" parsed to 0 and rendered "0"; the "." made
   * "0." which parses to 0, so React drove the box back to "0" and ate the
   * point; "5" then landed as 5. A half cup was saved as five, and nothing
   * said so — the grocery list just added up ten times the flour.
   */
  const [qtyText, setQtyText] = useState<Record<string, string>>(() => qtyTexts(start.rows))
  const [steps, setSteps] = useState(start.steps)
  const [tags, setTags] = useState((recipe?.tags ?? []).join(', '))
  const [notes, setNotes] = useState(recipe?.notes ?? '')
  // where it was imported from; the Source link in cook mode
  const [sourceUrl, setSourceUrl] = useState(recipe?.sourceUrl ?? '')
  // a draft's parts that would have replaced what is here, waiting for a choice
  const [spare, setSpare] = useState<DraftSplit['spare'] | null>(start.spare)

  const has = { ingredients: ingredients.some(i => i.name.trim() !== ''), steps: steps.trim() !== '' }
  // an answer arrives after an await: it lands on what the fields hold then
  const now = useRef({ has, servings })
  useLayoutEffect(() => {
    now.current = { has, servings }
  })

  const setRows = (rows: RecipeIngredient[]) => {
    setQtyText(t => ({ ...t, ...qtyTexts(rows) }))
    setIngredients(rows)
  }

  /**
   * A pasted or imported recipe into the fields. It fills them in and stops
   * there — the cook reads what it found and presses Save, as with every other
   * ✨ in the app. Anything already typed is kept: a blank row list is
   * replaced, a started one is added to.
   */
  const applyFound = (found: ReadRecipe & { sourceUrl?: string }) => {
    if (found.name) setName(n => (n.trim() ? n : found.name))
    if (found.servings) setServings(String(found.servings))
    if (found.ingredients.length) {
      const rows = ingredientRows(found.ingredients)
      setQtyText(t => ({ ...t, ...qtyTexts(rows) }))
      setIngredients(list => (list.every(i => !i.name.trim()) ? rows : [...list.filter(i => i.name.trim()), ...rows]))
    }
    if (found.steps.length) setSteps(s => (s.trim() ? `${s.trim()}\n${found.steps.join('\n')}` : found.steps.join('\n')))
    if (found.sourceUrl) setSourceUrl(found.sourceUrl)
  }

  /** ✨ Fill in's draft: the empty parts filled, the others kept, with the draft's version beside them. */
  const applyDraft = (d: RecipeDraft) => {
    const split = splitDraft(now.current.has, d)
    if (split.fill.ingredients) setRows(ingredientRows(split.fill.ingredients))
    if (split.fill.steps) setSteps(split.fill.steps.join('\n'))
    if (!now.current.servings.trim() && d.servings) setServings(String(d.servings))
    setSpare(split.spare.ingredients || split.spare.steps ? split.spare : null)
  }

  const takeSpareIngredients = () => {
    if (!spare?.ingredients) return
    setRows(ingredientRows(spare.ingredients))
    setSpare(spare.steps ? { steps: spare.steps } : null)
  }
  const takeSpareSteps = () => {
    if (!spare?.steps) return
    setSteps(spare.steps.join('\n'))
    setSpare(spare.ingredients ? { ingredients: spare.ingredients } : null)
  }

  const stepLines = steps
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
  const tagList = tags
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)

  const save = () => {
    if (!name.trim()) return
    const stamp = new Date().toISOString()
    const n = Number(servings)
    onSave({
      kind: 'recipe',
      id: recipe?.id ?? uid(),
      name: name.trim(),
      emoji: emoji.trim() || undefined,
      servings: Number.isFinite(n) && n > 0 ? Math.round(n) : undefined,
      ingredients: ingredients.filter(i => i.name.trim()),
      steps: stepLines,
      tags: tagList,
      notes: notes.trim() || undefined,
      sourceUrl: safeHttpUrl(sourceUrl) || undefined,
      createdAt: recipe?.createdAt ?? stamp,
      updatedAt: recipe ? newerStamp(recipe.updatedAt) : stamp,
    })
  }

  const setIng = (id: string, patch: Partial<RecipeIngredient>) => setIngredients(list => list.map(i => (i.id === id ? { ...i, ...patch } : i)))
  /** A quantity a shopping list can add up: a real, positive, sane number, or nothing at all. */
  const asQty = (text: string): number | undefined => {
    const n = Number(text)
    return text.trim() && Number.isFinite(n) && n > 0 && n <= 10_000 ? n : undefined
  }
  const typeQty = (id: string, text: string) => {
    setQtyText(t => ({ ...t, [id]: text }))
    setIng(id, { qty: asQty(text) })
  }
  // the list's Paste and Import doors open a NEW recipe on them
  const openOn = recipe ? undefined : capture
  const servingCount = Number(servings)

  return (
    <Modal onClose={onClose}>
      <ModalHead title={recipe ? `Edit ${recipe.name}` : 'New recipe'} />
      <div className="modal-body">
        <RecipeCapture
          name={name}
          has={has}
          hints={{
            name,
            servings: Number.isFinite(servingCount) && servingCount > 0 ? servingCount : undefined,
            tags: tagList,
            ingredients: ingredients.map(i => i.name.trim()).filter(Boolean),
            notes,
            steps: stepLines,
          }}
          openOn={openOn}
          note={start.note}
          onFound={applyFound}
          onDraft={applyDraft}
        />
        {spare && <DraftSpare spare={spare} onIngredients={takeSpareIngredients} onSteps={takeSpareSteps} onDismiss={() => setSpare(null)} />}
        <div className="field-row">
          <label className="field emoji-field">
            <span>Icon</span>
            <input value={emoji} onChange={e => setEmoji(e.target.value)} placeholder="🍝" maxLength={4} />
          </label>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Friday pizza" autoFocus={!openOn} />
          </label>
          <label className="field" style={{ maxWidth: 90 }}>
            <span>Servings</span>
            <input inputMode="numeric" value={servings} onChange={e => setServings(e.target.value)} />
          </label>
        </div>
        <div className="field">
          <span>Ingredients</span>
          {ingredients.map(ing => (
            <div key={ing.id} className="ing-row">
              <input
                className="ing-qty"
                inputMode="decimal"
                // the typed text, not the parsed number: see qtyText
                value={qtyText[ing.id] ?? (ing.qty != null ? String(ing.qty) : '')}
                onChange={e => typeQty(ing.id, e.target.value)}
                placeholder="1"
              />
              <input className="ing-unit" value={ing.unit ?? ''} onChange={e => setIng(ing.id, { unit: e.target.value })} placeholder="cup" />
              <input
                className="ing-name"
                value={ing.name}
                onChange={e => setIng(ing.id, { name: e.target.value })}
                placeholder="onion"
              />
            </div>
          ))}
          <button type="button" className="btn subtle" onClick={() => setIngredients(list => [...list, newIngredient()])}>
            + Ingredient
          </button>
        </div>
        <label className="field">
          <span>Steps (one per line)</span>
          <textarea rows={5} value={steps} onChange={e => setSteps(e.target.value)} placeholder="Brown the mince…" />
        </label>
        <label className="field">
          <span>Tags</span>
          <input value={tags} onChange={e => setTags(e.target.value)} placeholder="chicken, beef, freezer" />
          <small className="field-hint">The cookbook can open just the chicken ones, or any other tag you add.</small>
        </label>
        <label className="field">
          <span>Notes</span>
          <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Kids like extra cheese. Leftovers freeze." />
        </label>
        {safeHttpUrl(sourceUrl) && (
          <div className="recipe-source-row">
            <RecipeSource url={sourceUrl} />
            <button type="button" className="btn subtle" onClick={() => setSourceUrl('')}>
              Remove link
            </button>
          </div>
        )}
      </div>
      <footer className="modal-foot">
        {recipe && onDelete && (
          <ConfirmButton className="btn subtle danger" confirmLabel="Click again to remove" onConfirm={() => onDelete(recipe.id)}>
            Delete
          </ConfirmButton>
        )}
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={save} disabled={!name.trim()}>
          Save
        </button>
      </footer>
    </Modal>
  )
}
