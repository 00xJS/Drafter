import type { PlannerCtx } from './ctx'
import { Kitchen } from './lazy'

/** Kitchen: recipes, the week's meals and the grocery list. */
export function KitchenScreen({ p }: { p: PlannerCtx }) {
  const { store, showToast, kitchenRecipe, setKitchenRecipe, saveMeal, clearMeal, createPlaceInline, createRecipeInline } = p
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
    />
  )
}
