import { useState } from 'react'
import { newerStamp } from '../../shared/domain.mts'
import { MEAL_SLOT_META, Meal, MealSide, MealSlot, Place, PlaceCategory, Recipe } from '../types'
import { CookedIndex, MealMain, VisitIndex, lastCookedShort, lastWentShort, mealIsShared, mealLabel, mealSides, mealWithMain, mealWithSide, mealWithoutSide, recipeByName } from '../kitchen'
import { placeByName, placeEmoji, placeFor } from '../places'
import { ConfirmButton } from './ConfirmButton'
import { PlaceKindChooser } from './PlaceKindChooser'

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

/** The meals sides go with: a cooked lunch or dinner. Breakfast is one plate. */
const SIDE_SLOTS: ReadonlySet<MealSlot> = new Set<MealSlot>(['lunch', 'dinner'])

/**
 * Eat out → Somewhere new…: where from, and — for a place not saved yet — what
 * kind of place it is. A name you already have is that place (placeByName), so
 * nothing is asked and Save just uses it; a new one keeps Save disabled until
 * a kind is picked. It holds no state, so the row owns the name and the kind.
 */
export function SomewhereNew({
  name,
  kind,
  places,
  label,
  onName,
  onKind,
  onSave,
  onCancel,
}: {
  name: string
  kind?: PlaceCategory
  places: Place[]
  /** The name field's label, which says which meal it is for. */
  label: string
  onName(name: string): void
  onKind(kind: PlaceCategory): void
  onSave(): void
  onCancel(): void
}) {
  const saved = placeByName(name, places)
  const ready = !!name.trim() && (!!saved || !!kind)
  return (
    <div className="meal-new-place">
      <input
        className="meal-new-place-name"
        autoFocus
        value={name}
        onChange={e => onName(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onSave()
          }
          if (e.key === 'Escape') onCancel()
        }}
        placeholder="Where from?"
        aria-label={label}
      />
      {saved ? (
        <small className="muted meal-new-place-saved">
          Your saved {placeEmoji(saved)} {saved.name}
        </small>
      ) : (
        <PlaceKindChooser value={kind} onChange={onKind} />
      )}
      <button className="btn primary" onClick={onSave} disabled={!ready}>
        Save
      </button>
      <button className="btn subtle" onClick={onCancel}>
        Cancel
      </button>
    </div>
  )
}

export function MealSlotRow({
  date,
  slot,
  meal,
  theirs,
  nameOf,
  inHousehold,
  myId,
  recipes,
  places,
  cooked,
  visited,
  mainOnly,
  onSave,
  onClear,
  onCreatePlace,
  onCreateRecipe,
  onOpenRecipe,
}: {
  date: string
  slot: MealSlot
  meal?: Meal
  /** Other household members' plans for this slot. Named, not edited. */
  theirs?: Meal[]
  nameOf?(id: string | undefined): string | null
  /** A household slot can be shared as a task the other member can do. */
  inHousehold?: boolean
  myId?: string | null
  recipes: Recipe[]
  /** Somewhere a bought meal can come from; also what makes it count as an outing. */
  places: Place[]
  /** When each recipe was last cooked, said beside it in the pickers. Without it they read names only. */
  cooked?: CookedIndex
  /** When each place was last gone to, said beside it under Eat out as a recipe's last cooked is. */
  visited?: VisitIndex
  /**
   * The planning sheets' Pick…: choose the main and nothing else. Their meal is
   * a stand-in for a pick, so a side added to it would have nowhere to go.
   */
  mainOnly?: boolean
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
  /** Cook mode, with the meal so its sides are a tap away. Absent on the calendar, where there is nowhere to cook from. */
  onOpenRecipe?(r: Recipe, meal: Meal): void
}) {
  // which inline form is open, if any: a place to eat out, a recipe to cook, or a side
  const [add, setAdd] = useState<null | 'place' | 'recipe' | 'side'>(null)
  const [newName, setNewName] = useState('')
  // the kind of somewhere new: none until picked, so Save waits for it
  const [newCategory, setNewCategory] = useState<PlaceCategory | undefined>()
  const [ownPlan, setOwnPlan] = useState(false)
  const meta = MEAL_SLOT_META[slot]
  const slotName = meta.label.toLowerCase()
  /**
   * One control, two ways to answer "what are we eating": a recipe you cook, or
   * a place you get it from. Values are prefixed so the two id spaces cannot
   * collide, and `out` alone records a bought meal with no place named. The
   * meal there is built on, not replaced: its notes stay, and its sides stay
   * while it is still cooked (mealWithMain).
   */
  const write = (main: MealMain) => {
    const next = mealWithMain(meal, { date, slot }, main)
    // A new household meal stays Just me until you pick Household. A slot that
    // already has an answer keeps the one it has, including a v3.21 meal with
    // no flag — that one is already on the other person's week.
    if (inHousehold && next.shared === undefined && !meal) next.shared = false
    onSave(next)
  }
  const mine = !meal?.ownerId || !myId || meal.ownerId === myId
  const share = (m: Meal, shared: boolean) => onSave({ ...m, shared, updatedAt: newerStamp(m.updatedAt) })
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
   * three spellings of the same restaurant and the counts mean nothing — and
   * asks nothing more. A genuinely new one is saved only once its kind is
   * picked (placeFor): no kind is assumed for it.
   */
  const addPlace = () => {
    const hit = placeFor(newName, newCategory, places, onCreatePlace)
    if (!hit) return
    write({ out: true, placeId: hit.place.id, title: hit.place.name })
    setAdd(null)
    setNewName('')
    setNewCategory(undefined)
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

  // Sides: what goes with a cooked lunch or dinner. Each is a saved recipe (its
  // ingredients join the grocery list) or just a name, and belongs to the meal.
  const sides = mainOnly ? [] : mealSides(meal)
  const canSide = !!meal && !meal.out && SIDE_SLOTS.has(slot) && !mainOnly
  const sideChoices = recipes.filter(r => r.id !== meal?.recipeId && !sides.some(s => s.recipeId === r.id))
  const addSide = (side: MealSide) => {
    const next = meal ? mealWithSide(meal, side) : null
    if (next) onSave(next)
  }
  /** A typed side. A name you already have is that recipe, as it is for Something new…; anything else stays a name. */
  const addTypedSide = () => {
    const name = newName.trim()
    if (!name) return
    const r = recipeByName(name, recipes)
    addSide(r ? { recipeId: r.id, title: r.name } : { title: name })
    setNewName('')
  }

  const when = (r: Recipe) => (cooked ? ` · ${lastCookedShort(cooked, r.id)}` : '')
  const emojiOf = (id?: string) => {
    const e = id ? recipes.find(r => r.id === id)?.emoji : undefined
    return e ? `${e} ` : ''
  }
  const current = meal ? (meal.out ? (meal.placeId ? `p:${meal.placeId}` : 'out') : meal.recipeId ? `r:${meal.recipeId}` : '') : ''
  // A dinner they already shared is tonight's dinner. The empty picker made it
  // look like the slot still needed an answer, and Share sat on both rows.
  const household = !meal ? theirs?.find(mealIsShared) : undefined
  const extras = (theirs ?? []).filter(m => m.id !== household?.id)
  const showPicker = !!meal || ownPlan || !household
  const who = (id: string | undefined) => nameOf?.(id) || 'Household'
  return (
    <div className={'meal-slot' + (slot === 'dinner' ? ' dinner' : '')}>
      <span className="meal-slot-label">
        {meta.emoji} {meta.label}
      </span>
      {household && !showPicker && (
        <div className="meal-household-plan">
          <strong>{mealLabel(household)}</strong>
          <small className="muted">{who(household.ownerId)} shared this with the household</small>
          <button type="button" className="btn subtle" onClick={() => setOwnPlan(true)}>
            Plan my own
          </button>
        </div>
      )}
      {showPicker &&
        (recipes.length === 0 && places.length === 0 && !onCreateRecipe ? (
          <span className="muted">Add a recipe first</span>
        ) : (
          <select
            value={current}
            onChange={e => {
              if (e.target.value === 'new') {
                setNewCategory(undefined)
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
                setOwnPlan(false)
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
                    {/* when each was last cooked, to choose by — but not on the one
                        chosen: the closed picker is the day's dinner on the week,
                        and "Curry · 3 weeks ago" there would read as that night */}
                    {`r:${r.id}` === current ? '' : when(r)}
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
                  {visited && `p:${p.id}` !== current ? ` · ${lastWentShort(visited, p.id)}` : ''}
                </option>
              ))}
            </optgroup>
          </select>
        ))}
      {extras.length > 0 && (
        <ul className="meal-household" aria-label="Household plans">
          {extras.map(m => (
            <li key={m.id}>
              {who(m.ownerId)}: {mealLabel(m)}
              {mealIsShared(m) && <small className="muted"> · shared with the household</small>}
            </li>
          ))}
        </ul>
      )}
      {inHousehold && meal && mine && (
        <div className="meal-audience" role="group" aria-label={`Who sees ${slotName} on ${date}`}>
          <span className="muted">Who sees this</span>
          <span className="segmented meal-audience-seg">
            <button type="button" className={!mealIsShared(meal) ? 'seg on' : 'seg'} aria-pressed={!mealIsShared(meal)} onClick={() => share(meal, false)}>
              Just me
            </button>
            <button type="button" className={mealIsShared(meal) ? 'seg on' : 'seg'} aria-pressed={mealIsShared(meal)} onClick={() => share(meal, true)}>
              Household
            </button>
          </span>
          <small className="field-hint">
            {mealIsShared(meal) ? 'On their week too, and as a cook task.' : 'Only on your week.'}
          </small>
        </div>
      )}
      {(showPicker ? meal : household)?.recipeId && onOpenRecipe && (
        <button
          className="btn subtle"
          onClick={() => {
            const shown = showPicker ? meal : household
            const r = shown?.recipeId ? recipes.find(x => x.id === shown.recipeId) : undefined
            if (r && shown) onOpenRecipe(r, shown)
          }}
        >
          Cook
        </button>
      )}
      {(showPicker ? meal : household)?.out && <span className="meal-out-chip">🥡 Out</span>}
      {canSide && (
        <button
          type="button"
          className="btn subtle meal-side-add"
          aria-expanded={add === 'side'}
          aria-label={`Add a side to ${slotName} on ${date}`}
          onClick={() => {
            setNewName('')
            setAdd(a => (a === 'side' ? null : 'side'))
          }}
        >
          + Side
        </button>
      )}

      {sides.length > 0 && (
        <div className="meal-sides">
          <span className="meal-sides-with" aria-hidden="true">
            with
          </span>
          <ul aria-label={`Sides with ${slotName} on ${date}`}>
            {sides.map((s, i) => (
              <li key={`${i}:${s.recipeId ?? s.title}`} className="meal-side">
                <span className="meal-side-name">
                  {emojiOf(s.recipeId)}
                  {s.title}
                </span>
                {/* two steps like every ✕: the first tap arms it */}
                <ConfirmButton
                  className="btn subtle meal-side-remove"
                  confirmLabel="Remove?"
                  ariaLabel={`Remove ${s.title}`}
                  onConfirm={() => {
                    if (meal) onSave(mealWithoutSide(meal, i))
                  }}
                >
                  <span aria-hidden="true">✕</span>
                </ConfirmButton>
              </li>
            ))}
          </ul>
        </div>
      )}

      {add === 'place' && (
        <SomewhereNew
          name={newName}
          kind={newCategory}
          places={places}
          label={`Name of the place for ${slotName} on ${date}`}
          onName={setNewName}
          onKind={setNewCategory}
          onSave={addPlace}
          onCancel={() => setAdd(null)}
        />
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
            aria-label={`Name of the new recipe for ${slotName} on ${date}`}
          />
          <button className="btn primary" onClick={addRecipe} disabled={!newName.trim()}>
            Save
          </button>
          <button className="btn subtle" onClick={() => setAdd(null)}>
            Cancel
          </button>
        </div>
      )}

      {/* A side: pick a recipe (added at once) or type a dish. The form stays
          open for the next one — rice, then naan — until Done. No autofocus:
          on a phone the keyboard would cover the recipe picker. */}
      {add === 'side' && canSide && (
        <div className="meal-new-place meal-side-form">
          {sideChoices.length > 0 && (
            <select
              className="meal-side-pick"
              value=""
              onChange={e => {
                const r = recipes.find(x => x.id === e.target.value)
                if (r) addSide({ recipeId: r.id, title: r.name })
              }}
              aria-label={`A recipe to have with ${slotName} on ${date}`}
            >
              <option value="">Pick a recipe…</option>
              {sideChoices.map(r => (
                <option key={r.id} value={r.id}>
                  {r.emoji ? `${r.emoji} ` : ''}
                  {r.name}
                  {when(r)}
                </option>
              ))}
            </select>
          )}
          <input
            className="meal-new-place-name"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addTypedSide()
              }
              if (e.key === 'Escape') setAdd(null)
            }}
            placeholder={sideChoices.length > 0 ? 'or type one' : 'Garlic bread, salad…'}
            aria-label={`A side to have with ${slotName} on ${date}, by name`}
          />
          <button className="btn" onClick={addTypedSide} disabled={!newName.trim()}>
            Add
          </button>
          <button className="btn subtle" onClick={() => setAdd(null)}>
            Done
          </button>
        </div>
      )}
    </div>
  )
}
