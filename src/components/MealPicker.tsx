import { useMemo, useState } from 'react'
import { weekDayKeys } from '../../shared/weeks.mts'
import { favouritesRotation } from '../../shared/weekplan.mts'
import { initials } from '../household'
import {
  QUICK_PICK_META,
  dayAndSlot,
  daysAgo,
  daysBetween,
  dishMark,
  lastCookedShort,
  lastWentShort,
  mealIsShared,
  mealRecipeIds,
  quickMain,
  recipeByName,
  recipeMatchesQuery,
  weekdayShort,
} from '../kitchen'
import type { CookedIndex, KitchenMember, MealMain, VisitIndex } from '../kitchen'
import { findsPlace, placeByName, placeEmoji, placeFor } from '../places'
import type { Meal, MealSlot, Place, PlaceCategory, Recipe } from '../types'
import { useDayKey } from '../useDayKey'
import { ConfirmButton } from './ConfirmButton'
import { Icon } from './Icon'
import { Modal, ModalHead } from './Modal'
import { PlaceKindChooser } from './PlaceKindChooser'
import { Segmented } from './stats/Segmented'

// "What are we eating?" as a sheet: the one way a meal is chosen, wherever a
// slot is planned — Kitchen → This week's day cards, the calendar's day sheet,
// an assistant's suggested meal and the planning sheets' Pick…. It took over
// from a <select> whose Eat out sat under every recipe, which is why a lunch
// at Chick-fil-A was typed in as a dish rather than chosen as a place.

/**
 * Somewhere food comes from, first. Every place stays selectable — a picnic in
 * a park is a real answer to "what are we eating" — but a restaurant should not
 * sit below the swimming pool in the list.
 */
const FOOD_CATEGORIES = new Set(['restaurant', 'fastfood', 'cafe', 'bar'])
export function foodFirst(places: readonly Place[]): Place[] {
  return places
    .filter(p => !p.deletedAt)
    .sort((a, b) => {
      const fa = FOOD_CATEGORIES.has(a.category) ? 0 : 1
      const fb = FOOD_CATEGORIES.has(b.category) ? 0 : 1
      return fa - fb || a.name.localeCompare(b.name)
    })
}

/**
 * Eat out → Somewhere new…: where from, and — for a place not saved yet — what
 * kind of place it is. A name you already have is that place (placeByName), so
 * nothing is asked and Save just uses it; a new one keeps Save disabled until
 * a kind is picked. It holds no state, so whoever shows it owns the name and the kind.
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
          if (e.key === 'Escape') {
            // the field's own Escape: the sheet under it stays open
            e.stopPropagation()
            onCancel()
          }
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

/** What the picker hands back: the main chosen, who it is for, and who cooks it. */
export interface MealChoice {
  main: MealMain
  /** For: Both of us (true) or Just me (false). Undefined outside a household and on a planning sheet's pick. */
  shared?: boolean
  /** Who cooks it: a member's id, or '' for nobody. Undefined where nobody is asked. */
  cookId?: string
}

type Tab = 'cook' | 'out'
const TABS: readonly { key: Tab; label: string }[] = [
  { key: 'cook', label: 'Cook' },
  { key: 'out', label: 'Eat out' },
]

/** Leftovers: the Cook list's first answer, after Something new…, and nothing to cook. */
const LEFTOVERS = QUICK_PICK_META.leftovers

/** No meals, and nobody to cook with: the defaults, one array each so a memo on them holds. */
const NO_MEALS: readonly Meal[] = []
const NO_MEMBERS: readonly KitchenMember[] = []

/** Which tab a meal is on: eating out's, or cooking's, where Leftovers is too. */
const tabOf = (meal: Meal | undefined): Tab => (meal?.out ? 'out' : 'cook')

interface Props {
  date: string
  slot: MealSlot
  /** The slot's own meal, when it is planned: its choice ticked, and its For and cook where they are. */
  meal?: Meal
  recipes: Recipe[]
  places: Place[]
  /** Every meal there is: what the Cook list's order (the Favourites rotation) is worked out from. */
  meals?: readonly Meal[]
  /** When each recipe was last cooked, said beside it. Without it, the rotation's own last cooked is. */
  cooked?: CookedIndex
  /** When each place was last gone to, said beside it under Eat out. */
  visited?: VisitIndex
  /** A household of two or more: For, and who's cooking. */
  inHousehold?: boolean
  members?: readonly KitchenMember[]
  /** A new meal's For: Both of us or Just me. Unsaid, dinner is for both of you and breakfast and lunch for you. */
  startShared?: boolean
  /** A planning sheet's Pick…: a recipe or a place and nothing else — no For, no cook, no Leftovers. */
  mainOnly?: boolean
  /** A choice tapped. The sheet closes after it. */
  onPick(choice: MealChoice): void
  /** For, or who's cooking, changed on a meal already planned: saved there and then, and the sheet stays open. */
  onAdjust?(change: Omit<MealChoice, 'main'>): void
  /** Remove: the slot's meal taken off. */
  onRemove?(): void
  onCreatePlace(name: string, category: PlaceCategory): Place
  /** Something new…: a dish saved from its name alone, to fill in on the Kitchen tab later. */
  onCreateRecipe?(name: string): Recipe
  /** ★ on a recipe, or off. */
  onStar?(recipe: Recipe): void
  onClose(): void
}

/**
 * The meal picker: a bottom sheet headed "Thu 24 · Lunch". For — Both of us or
 * Just me — and, for a shared dish, who's cooking; a search over recipes and
 * places; and two tabs. Cook lists Leftovers, then the recipes in the
 * Favourites rotation's order, each with when it was last had; Eat out the
 * saved places, each with when you last went. A tap on any of them saves and
 * closes. Something new… and Somewhere new… save a new recipe or place from
 * here, as the old picker did.
 */
export function MealPicker({
  date,
  slot,
  meal,
  recipes,
  places,
  meals = NO_MEALS,
  cooked,
  visited,
  inHousehold = false,
  members = NO_MEMBERS,
  startShared,
  mainOnly = false,
  onPick,
  onAdjust,
  onRemove,
  onCreatePlace,
  onCreateRecipe,
  onStar,
  onClose,
}: Props) {
  const today = useDayKey()
  const [tab, setTab] = useState<Tab>(() => tabOf(meal))
  // a meal keeps its own For; a new one starts where the slot usually is
  const [forBoth, setForBoth] = useState(() => (meal ? mealIsShared(meal) : (startShared ?? slot === 'dinner')))
  const [cook, setCook] = useState(() => meal?.cookId ?? '')
  const [q, setQ] = useState('')
  // Something new… or Somewhere new…, open in place of the list's first row
  const [adding, setAdding] = useState<null | 'recipe' | 'place'>(null)
  const [newName, setNewName] = useState('')
  const [newKind, setNewKind] = useState<PlaceCategory | undefined>()

  const household = inHousehold && !mainOnly
  const week = useMemo(() => weekDayKeys(date), [date])
  const rotation = useMemo(() => favouritesRotation([...recipes, ...meals], { dayKey: today, week }), [recipes, meals, today, week])
  // the day each recipe is already on this week, for the ones the rotation keeps back
  const plannedOn = useMemo(() => {
    const on = new Map<string, string>()
    for (const m of meals) {
      if (m.deletedAt || !week.includes(m.date)) continue
      for (const id of mealRecipeIds(m)) if (!on.has(id) || m.date < on.get(id)!) on.set(id, m.date)
    }
    return on
  }, [meals, week])
  const eatingPlaces = useMemo(() => foodFirst(places), [places])
  const cooks = members.length > 1 ? members : []

  const current = (c: MealMain) =>
    !!meal && (c.quick ? meal.quick === c.quick : c.out ? !meal.quick && !!meal.out && meal.placeId === c.placeId : !meal.out && !meal.quick && !!c.recipeId && meal.recipeId === c.recipeId)
  const cooksIt = (c: MealMain) => !c.out && !c.quick
  const choose = (main: MealMain) => {
    if (mainOnly || !inHousehold) onPick({ main })
    else onPick({ main, shared: forBoth, cookId: forBoth && cooksIt(main) ? cook : '' })
    onClose()
  }
  const changeFor = (both: boolean) => {
    setForBoth(both)
    // a meal already planned is changed there and then; a new one waits for its choice
    if (meal && onAdjust) onAdjust(both ? { shared: true } : { shared: false, cookId: '' })
  }
  const changeCook = (id: string) => {
    // the one cooking, tapped again, is nobody cooking
    const next = id === cook ? '' : id
    setCook(next)
    if (meal && onAdjust && mealIsShared(meal) && !meal.out && !meal.quick) onAdjust({ cookId: next })
  }

  const hadWords = (r: Recipe, last: string | null) => {
    const on = plannedOn.get(r.id)
    if (on && !current({ recipeId: r.id, title: r.name })) return `on ${weekdayShort(on)}`
    if (cooked) return cooked.byId.get(r.id)?.lastCooked ? lastCookedShort(cooked, r.id) : 'never had'
    return last ? daysAgo(daysBetween(last, today)) : 'never had'
  }
  const wentWords = (p: Place) => (visited ? (visited.lastAt.has(p.id) ? `went ${lastWentShort(visited, p.id)}` : 'never been') : '')

  /** Something new: a name you already have is that recipe; anything else is saved as one, with its name alone. */
  const addRecipe = () => {
    const name = newName.trim()
    if (!name || !onCreateRecipe) return
    const recipe = recipeByName(name, recipes) ?? onCreateRecipe(name)
    choose({ recipeId: recipe.id, title: recipe.name })
  }
  /** Somewhere new: a saved place by that name is used as it is; a new one is saved once its kind is picked. */
  const addPlace = () => {
    const hit = placeFor(newName, newKind, places, onCreatePlace)
    if (hit) choose({ out: true, placeId: hit.place.id, title: hit.place.name })
  }
  const startAdding = (what: 'recipe' | 'place', name = '') => {
    setAdding(what)
    setNewName(name)
    setNewKind(undefined)
  }

  const recipeRow = ({ recipe: r, favourite, lastCooked }: { recipe: Recipe; favourite: boolean; lastCooked: string | null }) => {
    const main = { recipeId: r.id, title: r.name }
    const on = current(main)
    return (
      <li key={`r:${r.id}`} className="meal-pick-item">
        <button type="button" className={on ? 'meal-pick-row on' : 'meal-pick-row'} aria-pressed={on} onClick={() => choose(main)}>
          <span className="meal-pick-mark" aria-hidden="true">
            {dishMark(r.name, r.emoji)}
          </span>
          <span className="meal-pick-name">{r.name}</span>
          <span className="meal-pick-when">{hadWords(r, lastCooked)}</span>
          {on && <Icon name="check" size={16} strokeWidth={2.5} className="meal-pick-tick" />}
        </button>
        {onStar && (
          <button type="button" className={favourite ? 'meal-pick-star on' : 'meal-pick-star'} aria-pressed={favourite} aria-label={`Favourite: ${r.name}`} onClick={() => onStar(r)}>
            <Icon name="star" size={18} filled={favourite} />
          </button>
        )}
      </li>
    )
  }
  const placeRow = (p: Place) => {
    const main = { out: true, placeId: p.id, title: p.name }
    const on = current(main)
    return (
      <li key={`p:${p.id}`} className="meal-pick-item">
        <button type="button" className={on ? 'meal-pick-row on' : 'meal-pick-row'} aria-pressed={on} onClick={() => choose(main)}>
          <span className="meal-pick-mark" aria-hidden="true">
            {placeEmoji(p)}
          </span>
          <span className="meal-pick-name">{p.name}</span>
          <span className="meal-pick-when">{wentWords(p)}</span>
          {on && <Icon name="check" size={16} strokeWidth={2.5} className="meal-pick-tick" />}
        </button>
      </li>
    )
  }
  /** Leftovers, with what it means under its name: a planning sheet's Pick… has none (mainOnly). */
  const leftoversRow = () => {
    const main = quickMain('leftovers')
    const on = current(main)
    return (
      <li key="leftovers" className="meal-pick-item">
        <button type="button" className={on ? 'meal-pick-row leftovers on' : 'meal-pick-row leftovers'} aria-pressed={on} onClick={() => choose(main)}>
          <span className="meal-pick-mark" aria-hidden="true">
            {LEFTOVERS.emoji}
          </span>
          <span className="meal-pick-name">
            {LEFTOVERS.label}
            <small className="meal-pick-hint">{LEFTOVERS.hint}</small>
          </span>
          {on && <Icon name="check" size={16} strokeWidth={2.5} className="meal-pick-tick" />}
        </button>
      </li>
    )
  }
  const newRow = (what: 'recipe' | 'place', label: string, name = '') => (
    <li key={`new:${what}`} className="meal-pick-item">
      <button type="button" className="meal-pick-row new" onClick={() => startAdding(what, name)}>
        <span className="meal-pick-mark" aria-hidden="true">
          <Icon name="plus" size={16} />
        </span>
        <span className="meal-pick-name">{label}</span>
      </button>
    </li>
  )

  const recipeForm = (
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
          if (e.key === 'Escape') {
            e.stopPropagation()
            setAdding(null)
          }
        }}
        placeholder="What are you cooking?"
        aria-label={`Name of the new recipe for ${slot} on ${date}`}
      />
      <button className="btn primary" onClick={addRecipe} disabled={!newName.trim()}>
        Save
      </button>
      <button className="btn subtle" onClick={() => setAdding(null)}>
        Cancel
      </button>
    </div>
  )
  const placeForm = (
    <SomewhereNew
      name={newName}
      kind={newKind}
      places={places}
      label={`Name of the place for ${slot} on ${date}`}
      onName={setNewName}
      onKind={setNewKind}
      onSave={addPlace}
      onCancel={() => setAdding(null)}
    />
  )

  const query = q.trim()
  const needle = query.toLowerCase()
  const found = {
    leftovers: !!query && !mainOnly && LEFTOVERS.label.toLowerCase().includes(needle),
    recipes: query ? rotation.filter(x => recipeMatchesQuery(x.recipe, query)) : [],
    places: query ? eatingPlaces.filter(p => findsPlace(p, needle)) : [],
  }
  const nothingFound = query && !found.leftovers && !found.recipes.length && !found.places.length

  return (
    <Modal onClose={onClose} className="modal meal-pick-sheet">
      <ModalHead title={dayAndSlot(date, slot)} />
      <div className="modal-body">
        {household && (
          <div className="meal-pick-audience">
            <div className="meal-pick-line">
              <span className="meal-pick-label">For</span>
              <Segmented
                role="group"
                label="Who this meal is for"
                className="meal-pick-for"
                items={[
                  { key: 'both', label: 'Both of us' },
                  { key: 'me', label: 'Just me' },
                ]}
                value={forBoth ? 'both' : 'me'}
                onChange={k => changeFor(k === 'both')}
              />
            </div>
            {forBoth && tab === 'cook' && cooks.length > 0 && (
              <div className="meal-pick-line">
                <span className="meal-pick-label">Who’s cooking</span>
                <Segmented
                  role="group"
                  label="Who’s cooking"
                  className={cook ? 'meal-cook-seg' : 'meal-cook-seg unset'}
                  items={cooks.map(m => ({
                    key: m.id,
                    label: (
                      <>
                        <span aria-hidden="true">{initials(m.displayName)}</span>
                        <span className="meal-sr">{m.displayName}</span>
                      </>
                    ),
                  }))}
                  value={cook}
                  onChange={changeCook}
                />
              </div>
            )}
          </div>
        )}
        <input
          type="search"
          className="meal-pick-search"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search recipes and places"
          aria-label="Search recipes and places"
          enterKeyHint="search"
        />
        {!query && <Segmented<Tab> items={TABS} value={tab} onChange={setTab} label="What kind of meal" className="meal-pick-tabs" />}

        {query ? (
          <div className="meal-pick-found">
            {(found.leftovers || found.recipes.length > 0) && (
              <section aria-label="Recipes that match">
                <h3 className="meal-pick-group">Cook</h3>
                <ul className="meal-pick-list">
                  {found.leftovers && leftoversRow()}
                  {found.recipes.map(recipeRow)}
                </ul>
              </section>
            )}
            {found.places.length > 0 && (
              <section aria-label="Places that match">
                <h3 className="meal-pick-group">Eat out</h3>
                <ul className="meal-pick-list">{found.places.map(placeRow)}</ul>
              </section>
            )}
            {nothingFound && <p className="meal-pick-empty">Nothing here matches “{query}”.</p>}
            {adding === 'recipe' ? (
              recipeForm
            ) : adding === 'place' ? (
              placeForm
            ) : (
              <ul className="meal-pick-list">
                {onCreateRecipe && !recipeByName(query, recipes) && newRow('recipe', `Cook “${query}”, something new`, query)}
                {!placeByName(query, places) && newRow('place', `Somewhere new: “${query}”`, query)}
              </ul>
            )}
          </div>
        ) : tab === 'cook' ? (
          <>
            {adding === 'recipe' && recipeForm}
            <ul className="meal-pick-list" aria-label="Recipes">
              {onCreateRecipe && adding !== 'recipe' && newRow('recipe', 'Something new…')}
              {!mainOnly && leftoversRow()}
              {rotation.map(recipeRow)}
            </ul>
            {rotation.length === 0 && !onCreateRecipe && <p className="meal-pick-empty">No recipes yet: add one on Kitchen → Recipes.</p>}
          </>
        ) : (
          <>
            {adding === 'place' && placeForm}
            <ul className="meal-pick-list" aria-label="Places">
              {adding !== 'place' && newRow('place', 'Somewhere new…')}
              {eatingPlaces.map(placeRow)}
            </ul>
          </>
        )}
      </div>
      {meal && onRemove && (
        <footer className="modal-foot meal-pick-foot">
          <ConfirmButton
            className="btn subtle danger"
            confirmLabel="Remove?"
            ariaLabel={`Remove ${meal.title}`}
            onConfirm={() => {
              onRemove()
              onClose()
            }}
          >
            Remove
          </ConfirmButton>
        </footer>
      )}
    </Modal>
  )
}
