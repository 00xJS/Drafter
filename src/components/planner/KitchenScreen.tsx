import type { PlannerCtx } from './ctx'
import { Kitchen } from './lazy'

/** Kitchen: recipes, the week's meals, the grocery list and the figures. */
export function KitchenScreen({ p }: { p: PlannerCtx }) {
  const { store, showToast, kitchenRecipe, setKitchenRecipe, kitchenOpen, setKitchenOpen, saveMeal, clearMeal, createPlaceInline, createRecipeInline, calendars } = p
  return (
    <Kitchen
      recipes={store.recipes}
      meals={store.meals}
      groceries={store.groceries}
      places={store.places}
      onSaveMeal={saveMeal}
      onClearMeal={clearMeal}
      onCreatePlace={createPlaceInline}
      onCreateRecipe={createRecipeInline}
      onSave={item => store.upsert(item)}
      onDelete={id => {
        store.remove(id)
        showToast('Removed', () => store.restore([id]))
      }}
      openRecipe={kitchenRecipe}
      onOpenRecipeConsumed={() => setKitchenRecipe(null)}
      // a segment the palette or a link named (Kitchen stats), for this visit only
      openTab={kitchenOpen}
      onOpenTabConsumed={() => setKitchenOpen(null)}
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
