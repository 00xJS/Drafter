import { useEffect, useMemo, useState } from 'react'
import {
  GROCERY_STATE_META,
  GroceryLine,
  GroceryList,
  GroceryState,
  MEAL_SLOT_META,
  MEAL_SLOTS,
  Meal,
  MealSlot,
  Recipe,
  RecipeIngredient,
} from '../types'
import { newerStamp } from '../itemops'
import { weekRange, shiftRange } from '../review'
import { dateKey, uid } from '../utils'
import { buildGroceryList, dinnerOn, groceriesForMealDates, groceryId, mealId, mealsForWeek, newIngredient } from '../kitchen'
import { ConfirmButton } from './ConfirmButton'

type Seg = 'recipes' | 'week' | 'grocery'
const SEG_KEY = 'drafter:kitchen-tab'

interface Props {
  recipes: Recipe[]
  meals: Meal[]
  groceries: GroceryList[]
  onSave(item: Recipe | Meal | GroceryList): void
  onDelete(id: string): void
  /** Open this recipe in cook mode (Today → tonight’s dinner). */
  openRecipe?: Recipe | null
  onOpenRecipeConsumed?(): void
}

export function Kitchen({ recipes, meals, groceries, onSave, onDelete, openRecipe, onOpenRecipeConsumed }: Props) {
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
  const persistMeal = (m: Meal) => {
    const nextMeals = [...meals.filter(x => x.id !== m.id), m]
    onSave(m)
    persistGroceries(nextMeals, [m.date])
  }
  const clearMeal = (id: string) => {
    const meal = meals.find(m => m.id === id)
    onDelete(id)
    if (meal) persistGroceries(meals.filter(x => x.id !== id), [meal.date])
  }
  const persistRecipe = (r: Recipe) => {
    const nextRecipes = [...recipes.filter(x => x.id !== r.id), r]
    onSave(r)
    const dates = meals.filter(m => m.recipeId === r.id).map(m => m.date)
    if (dates.length) persistGroceries(meals, dates, nextRecipes)
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
          {filtered.length === 0 ? (
            <p className="empty">Save dishes you cook at home. Plan them onto the week, then build a grocery list from what’s for dinner.</p>
          ) : (
            <ul className="recipe-list">
              {filtered.map(r => (
                <li key={r.id} className="recipe-card" onClick={() => setCooking(r)}>
                  <span className="recipe-emoji">{r.emoji || '🍽️'}</span>
                  <div className="dash-main">
                    <span className="dash-title">{r.name}</span>
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
          onShift={d => setAnchor(a => shiftRange(weekRange(a), d).start)}
          onSaveMeal={persistMeal}
          onClearMeal={clearMeal}
          onOpenRecipe={r => setCooking(r)}
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
  onShift,
  onSaveMeal,
  onClearMeal,
  onOpenRecipe,
}: {
  week: { key: string; start: Date; end: Date; label: string }
  meals: Meal[]
  recipes: Recipe[]
  onShift(delta: number): void
  onSaveMeal(m: Meal): void
  onClearMeal(id: string): void
  onOpenRecipe(r: Recipe): void
}) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(week.start)
    d.setDate(d.getDate() + i)
    return d
  })
  const today = dateKey(new Date())
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
                  onSave={onSaveMeal}
                  onClear={onClearMeal}
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

function MealSlotRow({
  date,
  slot,
  meal,
  recipes,
  onSave,
  onClear,
  onOpenRecipe,
}: {
  date: string
  slot: MealSlot
  meal?: Meal
  recipes: Recipe[]
  onSave(m: Meal): void
  onClear(id: string): void
  onOpenRecipe(r: Recipe): void
}) {
  const meta = MEAL_SLOT_META[slot]
  const pick = (recipeId: string) => {
    const r = recipes.find(x => x.id === recipeId)
    const now = new Date().toISOString()
    onSave({
      kind: 'meal',
      id: mealId(date, slot),
      date,
      slot,
      recipeId: recipeId || undefined,
      title: r?.name || meal?.title || meta.label,
      createdAt: meal?.createdAt ?? now,
      updatedAt: meal ? newerStamp(meal.updatedAt) : now,
    })
  }
  return (
    <div className={'meal-slot' + (slot === 'dinner' ? ' dinner' : '')}>
      <span className="meal-slot-label">
        {meta.emoji} {meta.label}
      </span>
      {recipes.length === 0 ? (
        <span className="muted">Add a recipe first</span>
      ) : (
        <select
          value={meal?.recipeId ?? ''}
          onChange={e => {
            if (!e.target.value) {
              if (meal) onClear(meal.id)
              return
            }
            pick(e.target.value)
          }}
          aria-label={`${meta.label} on ${date}`}
        >
          <option value="">—</option>
          {recipes.map(r => (
            <option key={r.id} value={r.id}>
              {r.emoji ? `${r.emoji} ` : ''}
              {r.name}
            </option>
          ))}
        </select>
      )}
      {meal?.recipeId && (
        <button
          className="btn subtle"
          onClick={() => {
            const r = recipes.find(x => x.id === meal.recipeId)
            if (r) onOpenRecipe(r)
          }}
        >
          Cook
        </button>
      )}
    </div>
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
  const list = grocery ?? buildGroceryList(week.key, meals, recipes, null)
  const shown = filter === 'all' ? list.items : list.items.filter(i => i.state === filter)
  const counts = {
    need: list.items.filter(i => i.state === 'need').length,
    have: list.items.filter(i => i.state === 'have').length,
    done: list.items.filter(i => i.state === 'done').length,
  }

  const patch = (next: GroceryList) => onSave({ ...next, updatedAt: newerStamp(next.updatedAt) })

  const setState = (id: string, state: GroceryState) => {
    patch({ ...list, items: list.items.map(i => (i.id === id ? { ...i, state } : i)) })
  }

  const addManual = () => {
    const name = manual.trim()
    if (!name) return
    const line: GroceryLine = { id: uid(), name, state: 'need', recipeIds: [], manual: true }
    patch({ ...list, id: groceryId(week.key), weekKey: week.key, items: [...list.items, line] })
    setManual('')
  }

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
          onClick={() => onSave(buildGroceryList(week.key, meals, recipes, grocery))}
        >
          Build from this week
        </button>
      </div>
      <p className="field-hint">
        Pulls ingredients from recipes planned this week and merges duplicates (two onion recipes become one line). Tick Have if
        it’s already in the house, Need if you’re buying, Got it once it’s in the cart.
      </p>
      {list.items.length === 0 ? (
        <p className="empty">No ingredients yet. Plan dinners on This week, then tap Build from this week.</p>
      ) : (
        <>
          <div className="segmented">
            {(['need', 'have', 'done', 'all'] as const).map(f => (
              <button key={f} className={filter === f ? 'seg on' : 'seg'} onClick={() => setFilter(f)}>
                {f === 'all' ? `All ${list.items.length}` : `${GROCERY_STATE_META[f].label} ${counts[f]}`}
              </button>
            ))}
          </div>
          <ul className="grocery-list">
            {shown.map(line => (
              <li key={line.id} className={'grocery-line ' + line.state}>
                <div className="dash-main">
                  <span className="dash-title">
                    {line.qty != null ? `${line.qty}${line.unit ? ' ' + line.unit : ''} ` : ''}
                    {line.name}
                  </span>
                  <span className="dash-meta">
                    {line.manual ? 'Added by hand' : line.recipeIds.length ? `${line.recipeIds.length} recipe${line.recipeIds.length === 1 ? '' : 's'}` : ''}
                  </span>
                </div>
                <span className="segmented grocery-states">
                  {(['have', 'need', 'done'] as const).map(s => (
                    <button key={s} className={line.state === s ? 'seg on' : 'seg'} onClick={() => setState(line.id, s)}>
                      {GROCERY_STATE_META[s].label}
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="check-add">
        <input value={manual} onChange={e => setManual(e.target.value)} placeholder="Milk, paper towels…" onKeyDown={e => e.key === 'Enter' && addManual()} />
        <button className="btn" onClick={addManual} disabled={!manual.trim()}>
          Add item
        </button>
      </div>
    </>
  )
}

function RecipeCook({ recipe, onEdit, onClose }: { recipe: Recipe; onEdit(): void; onClose(): void }) {
  const [done, setDone] = useState<Record<number, boolean>>({})
  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal recipe-cook" role="dialog" aria-modal="true">
        <header className="modal-head">
          <h2>
            {recipe.emoji ? `${recipe.emoji} ` : ''}
            {recipe.name}
          </h2>
          <button className="btn subtle" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
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
                    <button type="button" className="recipe-step" onClick={() => setDone(d => ({ ...d, [i]: !d[i] }))}>
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
          <button className="btn" onClick={onEdit}>
            Edit
          </button>
          <span className="spacer" />
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
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
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <header className="modal-head">
          <h2>{recipe ? `Edit ${recipe.name}` : 'New recipe'}</h2>
          <button className="btn subtle" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
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
      </div>
    </div>
  )
}

export function tonightDinner(meals: Meal[], recipes: Recipe[], day = new Date()): { meal: Meal; recipe?: Recipe } | null {
  const meal = dinnerOn(meals, day)
  if (!meal) return null
  return { meal, recipe: recipes.find(r => r.id === meal.recipeId) }
}
