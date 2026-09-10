import { MEAL_SLOT_META, Meal, MealSlot, Place, Recipe } from '../types'
import { newerStamp } from '../itemops'
import { mealId } from '../kitchen'

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
const FOOD_CATEGORIES = new Set(['restaurant', 'cafe', 'bar'])
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
  /** Cook mode. Absent on the calendar, where there is nowhere to cook from. */
  onOpenRecipe?(r: Recipe): void
}) {
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
  const current = meal ? (meal.out ? (meal.placeId ? `p:${meal.placeId}` : 'out') : meal.recipeId ? `r:${meal.recipeId}` : '') : ''
  return (
    <div className={'meal-slot' + (slot === 'dinner' ? ' dinner' : '')}>
      <span className="meal-slot-label">
        {meta.emoji} {meta.label}
      </span>
      {recipes.length === 0 && places.length === 0 ? (
        <span className="muted">Add a recipe first</span>
      ) : (
        <select
          value={current}
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
          {recipes.length > 0 && (
            <optgroup label="Cook">
              {recipes.map(r => (
                <option key={r.id} value={`r:${r.id}`}>
                  {r.emoji ? `${r.emoji} ` : ''}
                  {r.name}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Eat out">
            <option value="out">🥡 Out (no place)</option>
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
    </div>
  )
}
