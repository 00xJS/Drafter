import { useEffect, useMemo, useRef, useState } from 'react'
import {
  GROCERY_STATE_META,
  GroceryLine,
  GroceryList,
  GroceryState,
  MEAL_SLOTS,
  Meal,
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
  groceriesForMealDates,
  groceryCounts,
  groceryId,
  heldGroceryLines,
  mealsForWeek,
  newIngredient,
  parseCookSteps,
  removeGroceryLine,
  removedGroceryLines,
  restoreGroceryLine,
  serialiseCookSteps,
  visibleGroceryLines,
} from '../kitchen'
import { haptic } from '../native'
import { ConfirmButton } from './ConfirmButton'
import { MealSlotRow } from './MealSlotRow'
import { Modal, ModalHead } from './Modal'
import { MealPlanSheet, mealsForPicks, type MealPick } from './MealPlanSheet'
import { RecipeSuggestions } from './RecipeSuggestions'
import type { CalendarEntry, CalendarEvent, Task } from '../types'

type Seg = 'recipes' | 'week' | 'grocery'
const SEG_KEY = 'drafter:kitchen-tab'

interface Props {
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
}

export function Kitchen({ recipes, meals, groceries, places, onSave, onDelete, onSaveMeal, onClearMeal, onCreatePlace, onCreateRecipe, openRecipe, onOpenRecipeConsumed, tasks, entries, feedEvents, onToast }: Props) {
  const [seg, setSeg] = useState<Seg>(() => {
    try {
      const saved = localStorage.getItem(SEG_KEY) as Seg | null
      return saved === 'week' || saved === 'grocery' || saved === 'recipes' ? saved : 'recipes'
    } catch {
      return 'recipes'
    }
  })
  const [anchor, setAnchor] = useState(() => new Date())
  const [editing, setEditing] = useState<Recipe | 'new' | null>(null)
  const [cooking, setCooking] = useState<Recipe | null>(null)
  const [q, setQ] = useState('')
  const [planningMeals, setPlanningMeals] = useState(false)

  const week = useMemo(() => weekRange(anchor), [anchor])
  const weekMeals = useMemo(() => mealsForWeek(meals, week.start), [meals, week.start])
  const grocery = groceries.find(g => g.weekKey === week.key && !g.deletedAt)

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return recipes
    return recipes.filter(r => r.name.toLowerCase().includes(needle) || r.tags.some(t => t.toLowerCase().includes(needle)))
  }, [recipes, q])

  const setTab = (s: Seg) => {
    setSeg(s)
    try {
      localStorage.setItem(SEG_KEY, s)
    } catch {
      /* ignore */
    }
  }

  const persistGroceries = (nextMeals: Meal[], dates: string[], nextRecipes = recipes) => {
    for (const g of groceriesForMealDates(nextMeals, nextRecipes, groceries, dates)) onSave(g)
  }
  const persistRecipe = (r: Recipe) => {
    const nextRecipes = [...recipes.filter(x => x.id !== r.id), r]
    onSave(r)
    const dates = meals.filter(m => m.recipeId === r.id).map(m => m.date)
    if (dates.length) persistGroceries(meals, dates, nextRecipes)
  }

  // the latest props, for an Undo pressed after this render's closures went stale
  const latest = useRef({ meals, recipes, groceries, onClearMeal, onSave })
  latest.current = { meals, recipes, groceries, onClearMeal, onSave }

  /**
   * "Plan this week's meals", accepted: each meal through onSaveMeal (the
   * planner's own path), then the week's grocery list rebuilt once from all of
   * them — one save at a time rebuilds it from a snapshot missing the others.
   * Undo clears what is still as it was planned, drops a new dish's stub that
   * nothing uses and nobody edited, and rebuilds the list again.
   */
  const applyMealPlan = (picks: MealPick[]): { count: number; undo(): void } | null => {
    const { meals: planned, created } = mealsForPicks(picks, { recipes, places, meals, createRecipe: onCreateRecipe, now: new Date() })
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
          if (now && now.updatedAt === r.updatedAt && !rest.some(m => m.recipeId === r.id)) cur.onSave({ ...now, deletedAt: new Date().toISOString(), updatedAt: newerStamp(now.updatedAt) })
        }
        for (const g of groceriesForMealDates(rest, cur.recipes, cur.groceries, dates)) cur.onSave(g)
      },
    }
  }

  useEffect(() => {
    if (!openRecipe) return
    setCooking(openRecipe)
    setTab('recipes')
    onOpenRecipeConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRecipe])

  return (
    <div className="kitchen">
      <div className="people-tab-seg">
        <span className="segmented">
          {(['recipes', 'week', 'grocery'] as const).map(s => (
            <button key={s} className={seg === s ? 'seg on' : 'seg'} onClick={() => setTab(s)}>
              {s === 'recipes' ? 'Recipes' : s === 'week' ? 'This week' : 'Grocery'}
            </button>
          ))}
        </span>
      </div>

      {seg === 'recipes' && (
        <>
          <div className="people-toolbar">
            <h2>Recipes</h2>
            <input className="filter-q" value={q} onChange={e => setQ(e.target.value)} placeholder="Search recipes" />
            <button className="btn primary" onClick={() => setEditing('new')}>
              + Recipe
            </button>
          </div>
          {!q.trim() && (
            <RecipeSuggestions
              recipes={recipes}
              meals={meals}
              onAccept={r => {
                persistRecipe(r)
                setCooking(r)
              }}
            />
          )}
          {filtered.length === 0 ? (
            <p className="empty">Save dishes you cook at home. Plan them onto the week, then build a grocery list from what’s for dinner.</p>
          ) : (
            <ul className="recipe-list">
              {filtered.map(r => (
                <li key={r.id} className="recipe-card" onClick={() => setCooking(r)}>
                  <span className="recipe-emoji">{r.emoji || '🍽️'}</span>
                  <div className="dash-main">
                    <button type="button" className="row-open">
                      <span className="dash-title">{r.name}</span>
                    </button>
                    <span className="dash-meta">
                      {r.servings ? `${r.servings} servings` : 'No yield set'}
                      {r.ingredients.length > 0 && ` · ${r.ingredients.length} ingredient${r.ingredients.length === 1 ? '' : 's'}`}
                      {r.steps?.length ? ` · ${r.steps.length} step${r.steps.length === 1 ? '' : 's'}` : ''}
                      {r.tags.length > 0 && ` · ${r.tags.join(', ')}`}
                    </span>
                    {r.ingredients.length > 0 && (
                      <span className="recipe-preview">
                        {r.ingredients
                          .slice(0, 4)
                          .map(i => i.name)
                          .join(' · ')}
                        {r.ingredients.length > 4 ? '…' : ''}
                      </span>
                    )}
                  </div>
                  <button
                    className="btn subtle"
                    onClick={e => {
                      e.stopPropagation()
                      setEditing(r)
                    }}
                  >
                    Edit
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {seg === 'week' && (
        <WeekPlan
          week={week}
          meals={weekMeals}
          recipes={recipes}
          places={places}
          onShift={d => setAnchor(a => shiftRange(weekRange(a), d).start)}
          onSaveMeal={onSaveMeal}
          onClearMeal={onClearMeal}
          onCreatePlace={onCreatePlace}
          onCreateRecipe={onCreateRecipe}
          onOpenRecipe={r => setCooking(r)}
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
          week={week}
          meals={weekMeals}
          recipes={recipes}
          grocery={grocery}
          onShift={d => setAnchor(a => shiftRange(weekRange(a), d).start)}
          onSave={onSave}
        />
      )}

      {cooking && (
        <RecipeCook
          key={cooking.id}
          recipe={cooking}
          onEdit={() => {
            setEditing(cooking)
            setCooking(null)
          }}
          onClose={() => setCooking(null)}
        />
      )}

      {editing && (
        <RecipeForm
          recipe={editing === 'new' ? undefined : editing}
          onSave={r => {
            persistRecipe(r)
            setEditing(null)
            setCooking(r)
          }}
          onDelete={
            editing !== 'new'
              ? id => {
                  onDelete(id)
                  setEditing(null)
                  setCooking(null)
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
  recipes,
  places,
  onShift,
  onSaveMeal,
  onClearMeal,
  onCreatePlace,
  onCreateRecipe,
  onOpenRecipe,
  onPlan,
}: {
  week: { key: string; start: Date; end: Date; label: string }
  meals: Meal[]
  recipes: Recipe[]
  places: Place[]
  onShift(delta: number): void
  onCreatePlace(name: string, category: PlaceCategory): Place
  onCreateRecipe(name: string): Recipe
  onSaveMeal(m: Meal): void
  onClearMeal(id: string): void
  onOpenRecipe(r: Recipe): void
  /** Open "Plan this week's meals". */
  onPlan?(): void
}) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(week.start)
    d.setDate(d.getDate() + i)
    return d
  })
  const today = dateKey(new Date())
  // dinners still to plan from today on: a past night is not worth proposing
  const emptyDinners = days.map(dateKey).filter(key => key >= today && !meals.some(m => m.date === key && m.slot === 'dinner')).length
  return (
    <>
      <div className="people-toolbar">
        <h2>This week’s meals</h2>
        <button className="btn" onClick={() => onShift(-1)} aria-label="Previous week">
          ‹
        </button>
        <span className="kitchen-week-label">{week.label}</span>
        <button className="btn" onClick={() => onShift(1)} aria-label="Next week">
          ›
        </button>
      </div>
      <p className="field-hint">Dinner is the default. Breakfast and lunch are optional. These also show on the calendar.</p>
      {onPlan && emptyDinners > 0 && (recipes.length > 0 || places.length > 0) && (
        <div className="meal-plan-cta">
          <p>
            <strong>
              {emptyDinners === 7 ? 'Nothing planned yet' : `${emptyDinners} dinner${emptyDinners === 1 ? '' : 's'} still to plan`}
            </strong>
            <small>Build the week together: picks from what you cook most, or ask the assistant when you can’t decide.</small>
          </p>
          <button className="btn primary" onClick={onPlan}>
            Plan this week’s meals
          </button>
        </div>
      )}
      <ul className="meal-week">
        {days.map(d => {
          const key = dateKey(d)
          return (
            <li key={key} className={'meal-day' + (key === today ? ' today' : '')}>
              <div className="meal-day-head">
                <strong>{d.toLocaleDateString(undefined, { weekday: 'short' })}</strong>
                <span>{d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
              </div>
              {MEAL_SLOTS.map(slot => (
                <MealSlotRow
                  key={slot}
                  date={key}
                  slot={slot}
                  meal={meals.find(m => m.date === key && m.slot === slot)}
                  recipes={recipes}
                  places={places}
                  onSave={onSaveMeal}
                  onClear={onClearMeal}
                  onCreatePlace={onCreatePlace}
                  onCreateRecipe={onCreateRecipe}
                  onOpenRecipe={onOpenRecipe}
                />
              ))}
            </li>
          )
        })}
      </ul>
    </>
  )
}

function GroceryPane({
  week,
  meals,
  recipes,
  grocery,
  onShift,
  onSave,
}: {
  week: { key: string; start: Date; end: Date; label: string }
  meals: Meal[]
  recipes: Recipe[]
  grocery?: GroceryList
  onShift(delta: number): void
  onSave(g: GroceryList): void
}) {
  const [filter, setFilter] = useState<GroceryState | 'all'>('need')
  const [manual, setManual] = useState('')
  // ids ticked since the pane opened. They stay on screen under their old
  // filter so nothing reflows under a thumb mid-aisle and a mis-tap is undone
  // by tapping the right button on the line that is still there.
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set<string>())
  // ids removed since the pane opened, by the same rule: each keeps its slot as
  // a Removed row with Restore until the view is cleaned, so the next line is
  // not pulled up under the thumb that just confirmed the ✕.
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set<string>())
  const list = grocery ?? buildGroceryList(week.key, meals, recipes, null)
  const shown = visibleGroceryLines(list.items, filter, ticked, gone)
  const held = heldGroceryLines(list.items, filter, ticked)
  const removed = removedGroceryLines(list.items)
  // a line taken off the list is in none of these, All included
  const counts = groceryCounts(list.items)

  // a new week is a new shop: nothing carries over but the list itself
  useEffect(() => {
    setTicked(new Set<string>())
    setGone(new Set<string>())
  }, [week.key])

  const patch = (next: GroceryList) => onSave({ ...next, updatedAt: newerStamp(next.updatedAt) })
  const patchLine = (id: string, change: (line: GroceryLine) => GroceryLine) =>
    patch({ ...list, items: list.items.map(i => (i.id === id ? change(i) : i)) })

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
    patch({ ...list, id: groceryId(week.key), weekKey: week.key, items: addGroceryItem(list.items, { name }, uid).items })
    setManual('')
  }

  const amount = (line: GroceryLine) => (line.qty != null ? `${line.qty}${line.unit ? ' ' + line.unit : ''} ` : '')

  return (
    <>
      <div className="people-toolbar">
        <h2>Grocery list</h2>
        <button className="btn" onClick={() => onShift(-1)} aria-label="Previous week">
          ‹
        </button>
        <span className="kitchen-week-label">{week.label}</span>
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
      {counts.all === 0 && shown.length === 0 ? (
        <p className="empty">
          {removed.length
            ? 'Nothing on the list. The lines you took off it are under Removed, at the bottom.'
            : 'No ingredients yet. Plan dinners on This week, then tap Build from this week.'}
        </p>
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

function RecipeCook({ recipe, onEdit, onClose }: { recipe: Recipe; onEdit(): void; onClose(): void }) {
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
    try {
      const raw = serialiseCookSteps(recipe.id, done, Date.now(), stepCount)
      if (raw) localStorage.setItem(COOK_STEPS_KEY, raw)
      // untick everything and the record goes — but only ours. Opening a side
      // dish to check a temperature must not wipe the main's ticked steps.
      else if (cookStepsRecipeId(localStorage.getItem(COOK_STEPS_KEY)) === recipe.id) localStorage.removeItem(COOK_STEPS_KEY)
    } catch {
      /* private mode, or the quota is full: the steps are just not remembered */
    }
  }, [recipe.id, stepCount, done])
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
          Done
        </button>
      </footer>
    </Modal>
  )
}

function RecipeForm({
  recipe,
  onSave,
  onDelete,
  onClose,
}: {
  recipe?: Recipe
  onSave(r: Recipe): void
  onDelete?(id: string): void
  onClose(): void
}) {
  const [name, setName] = useState(recipe?.name ?? '')
  const [emoji, setEmoji] = useState(recipe?.emoji ?? '')
  const [servings, setServings] = useState(recipe?.servings != null ? String(recipe.servings) : '4')
  const [ingredients, setIngredients] = useState<RecipeIngredient[]>(recipe?.ingredients.length ? recipe.ingredients : [newIngredient()])
  const [steps, setSteps] = useState((recipe?.steps ?? []).join('\n'))
  const [tags, setTags] = useState((recipe?.tags ?? []).join(', '))
  const [notes, setNotes] = useState(recipe?.notes ?? '')

  const save = () => {
    if (!name.trim()) return
    const now = new Date().toISOString()
    const n = Number(servings)
    onSave({
      kind: 'recipe',
      id: recipe?.id ?? uid(),
      name: name.trim(),
      emoji: emoji.trim() || undefined,
      servings: Number.isFinite(n) && n > 0 ? Math.round(n) : undefined,
      ingredients: ingredients.filter(i => i.name.trim()),
      steps: steps
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean),
      tags: tags
        .split(',')
        .map(t => t.trim())
        .filter(Boolean),
      notes: notes.trim() || undefined,
      createdAt: recipe?.createdAt ?? now,
      updatedAt: recipe ? newerStamp(recipe.updatedAt) : now,
    })
  }

  const setIng = (id: string, patch: Partial<RecipeIngredient>) => setIngredients(list => list.map(i => (i.id === id ? { ...i, ...patch } : i)))

  return (
    <Modal onClose={onClose}>
      <ModalHead title={recipe ? `Edit ${recipe.name}` : 'New recipe'} />
      <div className="modal-body">
        <div className="field-row">
          <label className="field emoji-field">
            <span>Icon</span>
            <input value={emoji} onChange={e => setEmoji(e.target.value)} placeholder="🍝" maxLength={4} />
          </label>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Friday pizza" autoFocus />
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
                value={ing.qty ?? ''}
                onChange={e => setIng(ing.id, { qty: e.target.value ? Number(e.target.value) : undefined })}
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
          <input value={tags} onChange={e => setTags(e.target.value)} placeholder="quick, chicken, freezer" />
        </label>
        <label className="field">
          <span>Notes</span>
          <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Kids like extra cheese. Leftovers freeze." />
        </label>
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
