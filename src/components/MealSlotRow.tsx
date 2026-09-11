import { useState } from 'react'
import { MEAL_SLOT_META, PLACE_CATEGORIES, PLACE_CATEGORY_META, Meal, MealSlot, Place, PlaceCategory, Recipe } from '../types'
import { newerStamp } from '../itemops'
import { mealId, recipeByName } from '../kitchen'
import { placeByName } from '../places'

// One control for "what are we eating on this day", used by the Kitchen tab's
// week and by the calendar's day sheet. It lives here rather than in either of
// them because the moment there are two copies they drift, and the thing that
// drifts is which fields a bought meal carries — the same rule that decides
// whether it reaches the grocery list and whether it counts as an outing.

/**
 * Somewhere food comes from, first. Every place stays selectable — a picnic in
 * a park is a real answer to "what are we eating" — but a restaurant should not
 * sit below the swimming pool in the list.
 */
const FOOD_CATEGORIES = new Set(['restaurant', 'fastfood', 'cafe', 'bar'])
export function foodFirst(places: Place[]): Place[] {
  return [...places].sort((a, b) => {
    const fa = FOOD_CATEGORIES.has(a.category) ? 0 : 1
    const fb = FOOD_CATEGORIES.has(b.category) ? 0 : 1
    return fa - fb || a.name.localeCompare(b.name)
  })
}

export function MealSlotRow({
  date,
  slot,
  meal,
  recipes,
  places,
  onSave,
  onClear,
  onCreatePlace,
  onCreateRecipe,
  onOpenRecipe,
}: {
  date: string
  slot: MealSlot
  meal?: Meal
  recipes: Recipe[]
  /** Somewhere a bought meal can come from; also what makes it count as an outing. */
  places: Place[]
  onSave(m: Meal): void
  onClear(id: string): void
  /**
   * Save a brand-new place and hand it back, so somewhere you ate for the first
   * time can be recorded here instead of in a detour to the Places tab.
   */
  onCreatePlace(name: string, category: PlaceCategory): Place
  /**
   * Save a brand-new recipe from just its name and hand it back, so a dish you
   * are cooking for the first time can be planned here — ingredients and steps
   * filled in later on the Kitchen tab — instead of a detour to add it first.
   * The mirror of onCreatePlace for the Cook side.
   */
  onCreateRecipe?(name: string): Recipe
  /** Cook mode. Absent on the calendar, where there is nowhere to cook from. */
  onOpenRecipe?(r: Recipe): void
}) {
  // which inline "new…" form is open, if any: a place to eat out, or a recipe to cook
  const [add, setAdd] = useState<null | 'place' | 'recipe'>(null)
  const [newName, setNewName] = useState('')
  const [newCategory, setNewCategory] = useState<PlaceCategory>('restaurant')
  const meta = MEAL_SLOT_META[slot]
  /**
   * One control, two ways to answer "what are we eating": a recipe you cook, or
   * a place you get it from. Values are prefixed so the two id spaces cannot
   * collide, and `out` alone records a bought meal with no place named.
   */
  const write = (fields: Partial<Meal> & { title: string }) => {
    const now = new Date().toISOString()
    onSave({
      kind: 'meal',
      id: mealId(date, slot),
      date,
      slot,
      createdAt: meal?.createdAt ?? now,
      updatedAt: meal ? newerStamp(meal.updatedAt) : now,
      ...fields,
    } as Meal)
  }
  const pick = (value: string) => {
    if (value.startsWith('r:')) {
      const r = recipes.find(x => x.id === value.slice(2))
      write({ recipeId: r?.id, title: r?.name || meta.label })
      return
    }
    if (value === 'out') {
      write({ out: true, title: 'Eating out' })
      return
    }
    if (value.startsWith('p:')) {
      const p = places.find(x => x.id === value.slice(2))
      write({ out: true, placeId: p?.id, title: p?.name || 'Eating out' })
    }
  }

  /**
   * Somewhere new. Typing a name that already exists reuses that place rather
   * than making a second copy of it — otherwise a fortnight of takeaways leaves
   * three spellings of the same restaurant and the counts mean nothing.
   */
  const addPlace = () => {
    const name = newName.trim()
    if (!name) return
    const place = placeByName(name, places) ?? onCreatePlace(name, newCategory)
    write({ out: true, placeId: place.id, title: place.name })
    setAdd(null)
    setNewName('')
    setNewCategory('restaurant')
  }

  /**
   * Something new to cook. Like Somewhere new, a name you already have reuses
   * that recipe rather than making a second copy; a genuinely new one is saved
   * with just its name, ready to gain ingredients and steps on the Kitchen tab.
   */
  const addRecipe = () => {
    const name = newName.trim()
    if (!name || !onCreateRecipe) return
    const recipe = recipeByName(name, recipes) ?? onCreateRecipe(name)
    write({ recipeId: recipe.id, title: recipe.name })
    setAdd(null)
    setNewName('')
  }
  const current = meal ? (meal.out ? (meal.placeId ? `p:${meal.placeId}` : 'out') : meal.recipeId ? `r:${meal.recipeId}` : '') : ''
  return (
    <div className={'meal-slot' + (slot === 'dinner' ? ' dinner' : '')}>
      <span className="meal-slot-label">
        {meta.emoji} {meta.label}
      </span>
      {recipes.length === 0 && places.length === 0 && !onCreateRecipe ? (
        <span className="muted">Add a recipe first</span>
      ) : (
        <select
          value={current}
          onChange={e => {
            if (e.target.value === 'new') {
              setAdd('place')
              return
            }
            if (e.target.value === 'new-recipe') {
              setAdd('recipe')
              return
            }
            setAdd(null)
            if (!e.target.value) {
              if (meal) onClear(meal.id)
              return
            }
            pick(e.target.value)
          }}
          aria-label={`${meta.label} on ${date}`}
        >
          <option value="">—</option>
          {(recipes.length > 0 || onCreateRecipe) && (
            <optgroup label="Cook">
              {onCreateRecipe && <option value="new-recipe">➕ Something new…</option>}
              {recipes.map(r => (
                <option key={r.id} value={`r:${r.id}`}>
                  {r.emoji ? `${r.emoji} ` : ''}
                  {r.name}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Eat out">
            <option value="new">➕ Somewhere new…</option>
            <option value="out">🥡 Out, no place</option>
            {foodFirst(places).map(p => (
              <option key={p.id} value={`p:${p.id}`}>
                {p.emoji ? `${p.emoji} ` : '🥡 '}
                {p.name}
              </option>
            ))}
          </optgroup>
        </select>
      )}
      {meal?.recipeId && onOpenRecipe && (
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
      {meal?.out && <span className="meal-out-chip">🥡 Out</span>}

      {add === 'place' && (
        <div className="meal-new-place">
          <input
            className="meal-new-place-name"
            autoFocus
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addPlace()
              }
              if (e.key === 'Escape') setAdd(null)
            }}
            placeholder="Where from?"
            aria-label={`Name of the place for ${meta.label.toLowerCase()} on ${date}`}
          />
          <select
            value={newCategory}
            onChange={e => setNewCategory(e.target.value as PlaceCategory)}
            aria-label="Kind of place"
          >
            {PLACE_CATEGORIES.map(c => (
              <option key={c} value={c}>
                {PLACE_CATEGORY_META[c].emoji} {PLACE_CATEGORY_META[c].label}
              </option>
            ))}
          </select>
          <button className="btn primary" onClick={addPlace} disabled={!newName.trim()}>
            Save
          </button>
          <button className="btn subtle" onClick={() => setAdd(null)}>
            Cancel
          </button>
        </div>
      )}

      {add === 'recipe' && (
        <div className="meal-new-place">
          <input
            className="meal-new-place-name"
            autoFocus
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addRecipe()
              }
              if (e.key === 'Escape') setAdd(null)
            }}
            placeholder="What are you cooking?"
            aria-label={`Name of the new recipe for ${meta.label.toLowerCase()} on ${date}`}
          />
          <button className="btn primary" onClick={addRecipe} disabled={!newName.trim()}>
            Save
          </button>
          <button className="btn subtle" onClick={() => setAdd(null)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
