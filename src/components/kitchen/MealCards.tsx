import { useState } from 'react'
import type { RotationPick } from '../../../shared/weekplan.mts'
import { initials } from '../../household'
import {
  QUICK_PICKS,
  QUICK_PICK_META,
  daysAgo,
  daysBetween,
  mealAdjusted,
  mealCook,
  mealIsShared,
  mealLabel,
  mealPicked,
  mealSides,
  mealWho,
  quickMain,
  type CookedIndex,
  type KitchenMember,
  type MealMain,
  type VisitIndex,
} from '../../kitchen'
import { MEAL_SLOT_META, type Meal, type MealSlot, type Place, type PlaceCategory, type Recipe } from '../../types'
import { MealPicker, type MealChoice } from '../MealPicker'
import { MealSides, mealShown, takesSides } from '../MealSlotRow'
import { Segmented } from '../stats/Segmented'

// Kitchen → This week, the day open under the strip: a card for each meal.
// A planned one says what it is, big, who it is for and who cooks it, with
// Start cooking and its sides; an empty one offers the Favourites rotation's
// ideas and the quick picks, one tap each, and Choose… for the meal picker.

/** Who's cooking, J or M: the household's members as one track. The one cooking, tapped again, is nobody. */
function CookToggle({ meal, members, onChange }: { meal: Meal; members: readonly KitchenMember[]; onChange(cookId: string): void }) {
  const cook = mealCook(meal) ?? ''
  return (
    <div className="meal-card-cooking">
      <span className="meal-card-label" aria-hidden="true">
        Cooking
      </span>
      <Segmented
        role="group"
        label={`Who’s cooking ${meal.title}`}
        className={cook ? 'meal-cook-seg' : 'meal-cook-seg unset'}
        items={members.map(m => ({
          key: m.id,
          label: (
            <>
              <span aria-hidden="true">{initials(m.displayName)}</span>
              <span className="meal-sr">{m.displayName}</span>
            </>
          ),
        }))}
        value={cook}
        onChange={id => onChange(id === cook ? '' : id)}
      />
    </div>
  )
}

interface CardProps {
  date: string
  slot: MealSlot
  /** Today: tonight's recipe says Start cooking. */
  today: string
  /** The row this member writes for the slot, when there is one. */
  mine?: Meal
  /** Everyone else's plans for the slot that can be seen: a meal kept to yourself never is. */
  theirs: readonly Meal[]
  /** The Favourites rotation's first few for the slot (rotationIdeas), offered while it is empty. */
  ideas: readonly RotationPick[]
  recipes: Recipe[]
  places: Place[]
  /** Every meal: the picker's Cook list order is worked out from them. */
  meals: readonly Meal[]
  cooked: CookedIndex
  visited: VisitIndex
  myId?: string | null
  inHousehold?: boolean
  members: readonly KitchenMember[]
  nameOf?(id: string | undefined): string | null
  /** A meal chosen for the slot: `before` is what the slot held, for the Undo. */
  onPlan(next: Meal, before: Meal | undefined): void
  /** Who it is for, who cooks it or its sides changed: saved as it is. */
  onAdjust(next: Meal): void
  onRemove(meal: Meal): void
  onCreatePlace(name: string, category: PlaceCategory): Place
  onCreateRecipe(name: string): Recipe
  onOpenRecipe(r: Recipe, meal: Meal): void
  onStar(r: Recipe): void
}

/**
 * One meal of the day open on This week, as a card. Planned: the meal's
 * title, who it is for and how it comes ("Both of you · Maria cooks"), who is
 * cooking a shared dish, Start cooking on a recipe, and its sides and notes;
 * a meal someone else shared keeps "Plan my own" for a night you are eating
 * something else. Empty: a dashed card of one-tap ideas and quick picks, and
 * Choose… for the picker.
 */
export function MealDayCard({
  date,
  slot,
  today,
  mine,
  theirs,
  ideas,
  recipes,
  places,
  meals,
  cooked,
  visited,
  myId,
  inHousehold,
  members,
  nameOf,
  onPlan,
  onAdjust,
  onRemove,
  onCreatePlace,
  onCreateRecipe,
  onOpenRecipe,
  onStar,
}: CardProps) {
  // the picker, open on the slot's own meal, or for a plan of your own beside a shared one
  const [picking, setPicking] = useState<null | 'slot' | 'own'>(null)
  const meta = MEAL_SLOT_META[slot]
  const slotName = meta.label.toLowerCase()
  // a meal someone shared answers the slot until you plan your own
  const shown = mine ?? theirs.find(mealIsShared)
  const extras = theirs.filter(m => m.id !== shown?.id)
  const cooks = inHousehold && members.length > 1 ? members : []
  /** A main for the slot, in this member's own row (mealPicked), and who it is for and who cooks it. */
  const plan = (main: MealMain, o: Omit<MealChoice, 'main'> = {}) => onPlan(mealPicked(mine, { date, slot }, main, { userId: myId, now: new Date().toISOString(), ...o }), mine)
  // a new meal from a chip is for whom the picker would start it for: dinner both of you, the rest you
  const fresh: Omit<MealChoice, 'main'> = inHousehold ? { shared: slot === 'dinner' } : {}

  const picker = picking && (
    <MealPicker
      date={date}
      slot={slot}
      meal={picking === 'slot' ? mine : undefined}
      recipes={recipes}
      places={places}
      meals={meals}
      cooked={cooked}
      visited={visited}
      inHousehold={inHousehold}
      members={members}
      startShared={picking === 'own' ? false : undefined}
      onPick={choice => plan(choice.main, { shared: choice.shared, cookId: choice.cookId })}
      onAdjust={change => mine && onAdjust(mealAdjusted(mine, change))}
      onRemove={picking === 'slot' && mine ? () => onRemove(mine) : undefined}
      onCreatePlace={onCreatePlace}
      onCreateRecipe={onCreateRecipe}
      onStar={onStar}
      onClose={() => setPicking(null)}
    />
  )
  const others =
    extras.length > 0 ? (
      <ul className="meal-household" aria-label="Household plans">
        {extras.map(m => (
          <li key={m.id}>
            {nameOf?.(m.ownerId) || 'Household'}: {mealLabel(m)}
            {mealIsShared(m) && <small className="muted"> · shared with the household</small>}
          </li>
        ))}
      </ul>
    ) : null

  if (!shown) {
    const why = (i: RotationPick) => {
      const last = cooked.byId.get(i.recipe.id)?.lastCooked
      const had = last ? `last had ${daysAgo(daysBetween(last, cooked.dayKey))}` : 'never had'
      return i.favourite ? `A favourite, ${had}` : had[0].toUpperCase() + had.slice(1)
    }
    return (
      <section className="meal-card empty" aria-label={meta.label}>
        <header className="meal-card-head">
          <span className="meal-card-slot">
            <span aria-hidden="true">{meta.emoji}</span> {meta.label}
          </span>
        </header>
        {ideas.length > 0 && (
          <div className="meal-card-chips" role="group" aria-label={`Ideas for ${slotName}`}>
            {ideas.map(i => (
              <button key={i.recipe.id} type="button" className={i.favourite ? 'meal-chip idea fav' : 'meal-chip idea'} title={why(i)} onClick={() => plan({ recipeId: i.recipe.id, title: i.recipe.name }, fresh)}>
                {i.favourite && (
                  <span className="meal-chip-star" aria-hidden="true">
                    ★
                  </span>
                )}
                {i.recipe.name}
              </button>
            ))}
          </div>
        )}
        <div className="meal-card-chips" role="group" aria-label={`Quick picks for ${slotName}`}>
          {QUICK_PICKS.map(k => (
            <button key={k} type="button" className="meal-chip quick" onClick={() => plan(quickMain(k), fresh)}>
              <span aria-hidden="true">{QUICK_PICK_META[k].emoji}</span> {QUICK_PICK_META[k].label}
            </button>
          ))}
        </div>
        <button type="button" className="btn meal-card-choose" aria-haspopup="dialog" onClick={() => setPicking('slot')}>
          Choose…
        </button>
        {others}
        {picker}
      </section>
    )
  }

  const isMine = shown === mine
  const { mark } = mealShown(shown, recipes, places)
  const recipe = shown.recipeId && !shown.out && !shown.quick ? recipes.find(r => r.id === shown.recipeId && !r.deletedAt) : undefined
  // who cooks: a dish shared with the household, in a household of two or more
  const canCook = cooks.length > 0 && mealIsShared(shown) && !shown.out && !shown.quick
  const who = mealWho(shown, { mine: isMine, myId, inHousehold, nameOf })
  const hasSides = mealSides(shown).length > 0 || (isMine && takesSides(shown, slot))
  return (
    <section className={'meal-card' + (slot === 'dinner' ? ' dinner' : '')} aria-label={meta.label}>
      <header className="meal-card-head">
        <span className="meal-card-slot">
          <span aria-hidden="true">{meta.emoji}</span> {meta.label}
        </span>
        {isMine && (
          <button type="button" className="meal-card-change" aria-haspopup="dialog" aria-label={`Change ${slotName}`} onClick={() => setPicking('slot')}>
            Change
          </button>
        )}
      </header>
      <p className="meal-card-title">
        {mark && (
          <span className="meal-card-mark" aria-hidden="true">
            {mark}
          </span>
        )}
        {shown.title}
      </p>
      {who && <p className="meal-card-who">{who}</p>}
      {(canCook || recipe) && (
        <div className="meal-card-actions">
          {canCook && <CookToggle meal={shown} members={cooks} onChange={id => onAdjust(mealAdjusted(shown, { cookId: id }))} />}
          {recipe && (
            <button type="button" className={date === today ? 'btn primary meal-card-cook' : 'btn meal-card-cook'} onClick={() => onOpenRecipe(recipe, shown)}>
              {date === today ? 'Start cooking' : 'Cook'}
            </button>
          )}
        </div>
      )}
      {hasSides && (
        <div className="meal-card-sides">
          <MealSides meal={shown} date={date} slot={slot} recipes={recipes} cooked={cooked} editable={isMine} onSave={onAdjust} />
        </div>
      )}
      {shown.notes && <p className="meal-card-notes">{shown.notes}</p>}
      {others}
      {!isMine && (
        <p className="meal-card-own">
          Not eating this?{' '}
          <button type="button" className="meal-card-link" aria-haspopup="dialog" onClick={() => setPicking('own')}>
            Plan my own
          </button>
        </p>
      )}
      {picker}
    </section>
  )
}
