import { memberName } from '../../household'
import { trashedLine } from '../../itemops'
import type { PlannerCtx } from './ctx'

/** Kitchen: recipes, the week's meals, the grocery list and the figures. */
export function KitchenScreen({ p }: { p: PlannerCtx }) {
  const { Kitchen } = p.views
  const { store, upsert, remove, restore, household, showToast, kitchenRecipe, setKitchenRecipe, kitchenOpen, setKitchenOpen, kitchenDay, setKitchenDay, saveMeal, clearMeal, createPlaceInline, createRecipeInline, calendars } = p
  return (
    <Kitchen
      myId={store.myId}
      nameOf={id => memberName(household.info, id)}
      inHousehold={p.inHousehold}
      // who's cooking a shared dish: J or M on its card and in the picker
      members={p.inHousehold ? (household.info?.members ?? []) : []}
      recipes={store.recipes}
      // drafts made overnight for the bare ones: Fill them in shows a waiting one at once
      recipeDrafts={store.recipeDrafts}
      meals={store.meals}
      groceries={store.groceries}
      places={store.places}
      onSaveMeal={saveMeal}
      onClearMeal={clearMeal}
      onCreatePlace={createPlaceInline}
      onCreateRecipe={createRecipeInline}
      onSave={item => upsert(item)}
      onDelete={id => {
        // a recipe, from its form: said by its name, as every move to the Trash is
        const recipe = store.recipes.find(r => r.id === id)
        remove(id)
        showToast(trashedLine(recipe?.name, 'Recipe'), () => restore([id]))
      }}
      openRecipe={kitchenRecipe}
      onOpenRecipeConsumed={() => setKitchenRecipe(null)}
      // a segment the palette or a link named (Kitchen stats), for this visit only
      openTab={kitchenOpen}
      onOpenTabConsumed={() => setKitchenOpen(null)}
      openDay={kitchenDay}
      onOpenDayConsumed={() => setKitchenDay(null)}
      // for Plan this week's meals: outings at places counted from tasks too, a
      // busy evening flagged from your own events and subscribed calendars, and
      // the confirmation with its Undo in the planner's toast
      tasks={store.tasks}
      entries={store.events}
      feedEvents={calendars.events}
      onToast={showToast}
    />
  )
}
