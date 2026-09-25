import { useState } from 'react'
import { MEAL_SLOT_META, Meal, MealSide, MealSlot, Place, PlaceCategory, Recipe } from '../types'
import {
  QUICK_PICK_META,
  lastCookedShort,
  mealAdjusted,
  mealIsShared,
  mealLabel,
  mealPicked,
  mealSides,
  mealsForSlot,
  mealWithSide,
  mealWithoutSide,
  recipeByName,
  type CookedIndex,
  type KitchenMember,
  type VisitIndex,
} from '../kitchen'
import { placeEmoji } from '../places'
import { ConfirmButton } from './ConfirmButton'
import { Icon } from './Icon'
import { MealPicker, type MealChoice } from './MealPicker'
import { Segmented } from './stats/Segmented'

// One slot of "what are we eating on this day", as a row: the calendar's day
// sheet, an assistant's suggested meal. What is eaten is chosen in the meal
// picker (MealPicker.tsx), the same sheet Kitchen → This week's day cards
// open, so there is one way to choose a meal and one way it is written
// (mealPicked) — the moment there are two copies they drift, and the thing
// that drifts is which fields a bought meal carries and whose row it lands in.

/** The meals sides go with: a cooked lunch or dinner. Breakfast is one plate. */
const SIDE_SLOTS: ReadonlySet<MealSlot> = new Set<MealSlot>(['lunch', 'dinner'])

/** Whether a meal can have sides: a cooked lunch or dinner, never a bought one or a quick pick. */
export const takesSides = (meal: Meal | undefined, slot: MealSlot): meal is Meal => !!meal && !meal.out && !meal.quick && SIDE_SLOTS.has(slot)

/** "🍛 Chicken curry", "🥡 Nopi", "🍲 Leftovers": what a slot holds, with its mark. */
export function mealShown(meal: Meal, recipes: readonly Recipe[], places: readonly Place[]): { mark: string; label: string } {
  if (meal.quick) return { mark: QUICK_PICK_META[meal.quick].emoji, label: mealLabel(meal) }
  if (meal.out) {
    const place = meal.placeId ? places.find(p => p.id === meal.placeId) : undefined
    return { mark: place ? placeEmoji(place) : '🥡', label: mealLabel(meal) }
  }
  const emoji = meal.recipeId ? recipes.find(r => r.id === meal.recipeId)?.emoji : undefined
  return { mark: emoji ?? '', label: mealLabel(meal) }
}

/**
 * A cooked meal's sides: each a chip with its ✕, + Side to add one, and the
 * form it opens — pick a recipe (added at once) or type a dish, open for the
 * next one (rice, then naan) until Done. Each is a saved recipe, whose
 * ingredients join the grocery list, or just a name, and belongs to the meal.
 * The row and the Kitchen's day card both draw it.
 */
export function MealSides({
  meal,
  date,
  slot,
  recipes,
  cooked,
  editable = true,
  onSave,
}: {
  meal: Meal
  date: string
  slot: MealSlot
  recipes: Recipe[]
  cooked?: CookedIndex
  /** False on a meal that is somebody else's: its sides are shown, not changed. */
  editable?: boolean
  onSave(m: Meal): void
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const slotName = MEAL_SLOT_META[slot].label.toLowerCase()
  const sides = mealSides(meal)
  const canSide = editable && takesSides(meal, slot)
  const sideChoices = recipes.filter(r => r.id !== meal.recipeId && !sides.some(s => s.recipeId === r.id))
  const when = (r: Recipe) => (cooked ? ` · ${lastCookedShort(cooked, r.id)}` : '')
  const emojiOf = (id?: string) => {
    const e = id ? recipes.find(r => r.id === id)?.emoji : undefined
    return e ? `${e} ` : ''
  }
  const addSide = (side: MealSide) => {
    const next = mealWithSide(meal, side)
    if (next) onSave(next)
  }
  /** A typed side. A name you already have is that recipe, as it is for Something new…; anything else stays a name. */
  const addTyped = () => {
    const typed = name.trim()
    if (!typed) return
    const r = recipeByName(typed, recipes)
    addSide(r ? { recipeId: r.id, title: r.name } : { title: typed })
    setName('')
  }
  return (
    <>
      {canSide && (
        <button
          type="button"
          className="btn subtle meal-side-add"
          aria-expanded={open}
          aria-label={`Add a side to ${slotName} on ${date}`}
          onClick={() => {
            setName('')
            setOpen(o => !o)
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
                {editable && (
                  <ConfirmButton className="btn subtle meal-side-remove" confirmLabel="Remove?" ariaLabel={`Remove ${s.title}`} onConfirm={() => onSave(mealWithoutSide(meal, i))}>
                    <span aria-hidden="true">✕</span>
                  </ConfirmButton>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* No autofocus: on a phone the keyboard would cover the recipe picker */}
      {open && canSide && (
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
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addTyped()
              }
              if (e.key === 'Escape') setOpen(false)
            }}
            placeholder={sideChoices.length > 0 ? 'or type one' : 'Garlic bread, salad…'}
            aria-label={`A side to have with ${slotName} on ${date}, by name`}
          />
          <button className="btn" onClick={addTyped} disabled={!name.trim()}>
            Add
          </button>
          <button className="btn subtle" onClick={() => setOpen(false)}>
            Done
          </button>
        </div>
      )}
    </>
  )
}

/** What the picker on one slot needs: the day, the slot, what can be chosen and where a pick is written. */
interface SlotPickerProps {
  date: string
  slot: MealSlot
  /** The slot's meal as it stands: a pick replaces your own, and never builds on somebody else's (mealPicked). */
  meal?: Meal
  inHousehold?: boolean
  myId?: string | null
  members?: readonly KitchenMember[]
  recipes: Recipe[]
  places: Place[]
  meals?: readonly Meal[]
  cooked?: CookedIndex
  visited?: VisitIndex
  mainOnly?: boolean
  /** Who a new plan is for, when the slot has a say in it: false for a plan of your own beside one the household shares. */
  startShared?: boolean
  onSave(m: Meal): void
  onClear(id: string): void
  onCreatePlace(name: string, category: PlaceCategory): Place
  onCreateRecipe?(name: string): Recipe
  onStar?(recipe: Recipe): void
  onClose(): void
}

/**
 * The meal picker on one slot of one day, and the one way its pick is written
 * (mealPicked): the row's Choose… and Plan my own, and the calendar's + → Meal,
 * which opens it straight onto that day's dinner.
 */
export function SlotPicker({ date, slot, meal, myId, onSave, onClear, onClose, ...rest }: SlotPickerProps) {
  // only ever your own row is written: another member's is named, never built on
  const own = !meal?.ownerId || !myId || meal.ownerId === myId ? meal : undefined
  const pick = (choice: MealChoice) => onSave(mealPicked(own, { date, slot }, choice.main, { userId: myId, now: new Date().toISOString(), shared: choice.shared, cookId: choice.cookId }))
  return (
    <MealPicker
      {...rest}
      date={date}
      slot={slot}
      meal={own}
      onPick={pick}
      onAdjust={change => own && onSave(mealAdjusted(own, change))}
      onRemove={own ? () => onClear(own.id) : undefined}
      onClose={onClose}
    />
  )
}

/**
 * The slot a + → Meal opens on a day: its dinner — yours, or a plan of your
 * own when the household already shares one — as the day sheet's row would.
 */
export function dinnerPick(meals: readonly Meal[], date: string, myId: string | null | undefined): { meal?: Meal; startShared?: boolean } {
  const { mine, theirs } = mealsForSlot(meals, date, 'dinner', myId)
  return mine ? { meal: mine } : { startShared: theirs.some(mealIsShared) ? false : undefined }
}

export function MealSlotRow({
  date,
  slot,
  meal,
  theirs,
  nameOf,
  inHousehold,
  myId,
  members,
  recipes,
  places,
  meals,
  cooked,
  visited,
  mainOnly,
  onSave,
  onClear,
  onCreatePlace,
  onCreateRecipe,
  onOpenRecipe,
  onStar,
}: {
  date: string
  slot: MealSlot
  meal?: Meal
  /** Other household members' plans for this slot. Named, not edited. */
  theirs?: Meal[]
  nameOf?(id: string | undefined): string | null
  /** A household slot says who it is for, and a shared dish who cooks it. */
  inHousehold?: boolean
  myId?: string | null
  /** The household, for Who's cooking in the picker. */
  members?: readonly KitchenMember[]
  recipes: Recipe[]
  /** Somewhere a bought meal can come from; also what makes it count as an outing. */
  places: Place[]
  /** Every meal, for the picker's Cook list order (the Favourites rotation). */
  meals?: readonly Meal[]
  /** When each recipe was last cooked, said beside it in the picker. */
  cooked?: CookedIndex
  /** When each place was last gone to, said beside it under Eat out. */
  visited?: VisitIndex
  /**
   * An assistant's suggested meal: choose the main and nothing else. Its meal
   * is a stand-in for a pick, so a side added to it would have nowhere to go.
   */
  mainOnly?: boolean
  onSave(m: Meal): void
  onClear(id: string): void
  /** Somewhere new…: a brand-new place saved and handed back. */
  onCreatePlace(name: string, category: PlaceCategory): Place
  /** Something new…: a brand-new recipe saved from its name and handed back. */
  onCreateRecipe?(name: string): Recipe
  /** Cook mode, with the meal so its sides are a tap away. Absent on the calendar, where there is nowhere to cook from. */
  onOpenRecipe?(r: Recipe, meal: Meal): void
  /** ★ a recipe from the picker's Cook list. */
  onStar?(recipe: Recipe): void
}) {
  // the picker, open: on the slot's own meal, or for a plan of your own beside theirs
  const [picking, setPicking] = useState<null | 'slot' | 'own'>(null)
  const meta = MEAL_SLOT_META[slot]
  const slotName = meta.label.toLowerCase()
  // only ever your own row is written: another member's is named, never built on (mealPicked)
  const mine = !meal?.ownerId || !myId || meal.ownerId === myId
  // A dinner they already shared is tonight's dinner. The empty picker made it
  // look like the slot still needed an answer, and Share sat on both rows.
  const household = !meal ? theirs?.find(mealIsShared) : undefined
  const extras = (theirs ?? []).filter(m => m.id !== household?.id)
  const showPicker = !!meal || !household
  const who = (id: string | undefined) => nameOf?.(id) || 'Household'
  const shown = showPicker ? meal : household
  const shownMark = meal ? mealShown(meal, recipes, places) : null
  // a pick is its main alone: the sides of the meal it stands in for have nowhere to go
  const chosen = meal ? (mainOnly ? meal.title : mealLabel(meal)) : ''
  return (
    <div className={'meal-slot' + (slot === 'dinner' ? ' dinner' : '')}>
      <span className="meal-slot-label">
        {meta.emoji} {meta.label}
      </span>
      {household && !showPicker && (
        <div className="meal-household-plan">
          <strong>{mealLabel(household)}</strong>
          <small className="muted">{who(household.ownerId)} shared this with the household</small>
          <button type="button" className="btn subtle" onClick={() => setPicking('own')}>
            Plan my own
          </button>
        </div>
      )}
      {showPicker && (
        <button
          type="button"
          className={meal ? 'meal-slot-choose set' : 'meal-slot-choose'}
          aria-haspopup="dialog"
          aria-label={`${meta.label} on ${date}: ${chosen || 'choose'}`}
          onClick={() => setPicking('slot')}
        >
          {meal && shownMark ? (
            <span className="meal-slot-chosen">
              {shownMark.mark && <span aria-hidden="true">{shownMark.mark} </span>}
              {chosen}
            </span>
          ) : (
            <span className="meal-slot-placeholder">Choose…</span>
          )}
          <Icon name="chevron" size={14} className="meal-slot-chevron" />
        </button>
      )}
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
      {inHousehold && meal && mine && !mainOnly && (
        <div className="meal-audience">
          <span className="muted" aria-hidden="true">
            For
          </span>
          <Segmented
            role="group"
            label={`Who ${slotName} on ${date} is for`}
            className="meal-audience-seg"
            items={[
              { key: 'both', label: 'Both of us' },
              { key: 'me', label: 'Just me' },
            ]}
            value={mealIsShared(meal) ? 'both' : 'me'}
            onChange={k => onSave(mealAdjusted(meal, k === 'both' ? { shared: true } : { shared: false, cookId: '' }))}
          />
          <small className="field-hint">{mealIsShared(meal) ? 'On their week too, and as a cook task.' : 'Only on your week.'}</small>
        </div>
      )}
      {shown?.recipeId && !shown.out && !shown.quick && onOpenRecipe && (
        <button
          className="btn subtle"
          onClick={() => {
            const r = recipes.find(x => x.id === shown.recipeId)
            if (r) onOpenRecipe(r, shown)
          }}
        >
          Cook
        </button>
      )}
      {shown?.out && !shown.quick && <span className="meal-out-chip">🥡 Out</span>}
      {meal && !mainOnly && <MealSides meal={meal} date={date} slot={slot} recipes={recipes} cooked={cooked} editable={mine} onSave={onSave} />}
      {picking && (
        <SlotPicker
          date={date}
          slot={slot}
          meal={picking === 'slot' ? meal : undefined}
          myId={myId}
          recipes={recipes}
          places={places}
          meals={meals}
          cooked={cooked}
          visited={visited}
          inHousehold={inHousehold}
          members={members}
          startShared={picking === 'own' ? false : undefined}
          mainOnly={mainOnly}
          onSave={onSave}
          onClear={onClear}
          onCreatePlace={onCreatePlace}
          onCreateRecipe={onCreateRecipe}
          onStar={onStar}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  )
}
