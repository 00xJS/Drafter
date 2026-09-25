import { mealAt, mealId, recipeByName } from '../../kitchen'
import type { Meal, MealSlot, Place, Recipe } from '../../types'

// What "Plan this week's meals" hands back (MealPlanSheet.tsx), and what the
// Kitchen makes of it: on their own, so the Kitchen can apply the picks with
// the sheet itself loaded only when it is opened.

/** What a slot will be: a recipe, a place you eat at, out with no place, or a dish that is not a recipe yet. */
export interface SlotChoice {
  kind: 'recipe' | 'place' | 'out' | 'new'
  /** The recipe's or the place's id. */
  id?: string
  title: string
  why?: string
  /** From the ✨ assistant rather than the ranking. */
  ai?: boolean
}

export interface MealPick {
  date: string
  slot: MealSlot
  choice: SlotChoice
}

/**
 * The meals the accepted picks become. A slot planned meanwhile (another
 * device, the calendar) is never overwritten; a pick whose record has gone is
 * skipped; a new dish reuses a recipe of the same name, or becomes a recipe
 * stub with just its name, like the picker's "Something new…".
 */
export function mealsForPicks(
  picks: readonly MealPick[],
  d: { recipes: Recipe[]; places: Place[]; meals: Meal[]; createRecipe(name: string): Recipe; now: Date; myId?: string | null },
): { meals: Meal[]; created: Recipe[] } {
  const stamp = d.now.toISOString()
  const taken = new Set(d.meals.filter(m => !m.deletedAt).map(m => `${m.date}|${m.slot}`))
  const known = d.recipes.filter(r => !r.deletedAt)
  const created: Recipe[] = []
  const out: Meal[] = []
  for (const { date, slot, choice } of picks) {
    if (taken.has(`${date}|${slot}`)) continue
    let fields: Pick<Meal, 'recipeId' | 'out' | 'placeId' | 'title'> | null = null
    if (choice.kind === 'recipe') {
      const r = known.find(x => x.id === choice.id)
      if (r) fields = { recipeId: r.id, title: r.name }
    } else if (choice.kind === 'place') {
      const p = d.places.find(x => x.id === choice.id && !x.deletedAt)
      if (p) fields = { out: true, placeId: p.id, title: p.name }
    } else if (choice.kind === 'out') {
      fields = { out: true, title: choice.title || 'Eating out' }
    } else if (choice.title.trim()) {
      let r = recipeByName(choice.title, known)
      if (!r) {
        r = d.createRecipe(choice.title.trim())
        known.push(r)
        created.push(r)
      }
      fields = { recipeId: r.id, title: r.name }
    }
    if (!fields) continue
    taken.add(`${date}|${slot}`)
    // a day that already has a row of mine keeps its id, legacy or not
    const had = mealAt(d.meals, date, slot, d.myId)
    out.push({ kind: 'meal', id: had?.id ?? mealId(date, slot, d.myId), date, slot, ...fields, createdAt: stamp, updatedAt: stamp })
  }
  return { meals: out, created }
}
