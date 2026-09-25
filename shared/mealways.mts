// How each meal was had — cooked at home, eaten out at a saved place, or
// bought with no place named — and which meals count yet: the Kitchen's rule,
// which Kitchen → Stats, the Calendar's meal colours, Insights' highlights and
// the monthly recap (netlify/functions/lib/recap.mjs) all read. Dependency-free
// ESM. A module of its own rather than a part of kitchen.mts, which the first
// paint loads for Today: only the views that count meals need this.

import type { Meal, Place } from '../src/types.ts'
import { mealWasHad } from './kitchen.mts'
import { outingsAt } from './places.mts'

/** How a meal was had, once it counts: cooked at home, eaten out at a saved place, or bought with no place named. */
export type MealWay = 'cooked' | 'out' | 'bought'

/** The saved places a meal can be eaten out at, by id: the live ones. One in the Trash, or anything else handed in, is none. */
export function savedPlaces(places: readonly Place[]): ReadonlyMap<string, Place> {
  return new Map(places.filter(p => p.kind === 'place' && !p.deletedAt).map(p => [p.id, p]))
}

/**
 * How a meal is had, or is planned to be, whatever its day: eaten out at a
 * place still saved (`places`, as savedPlaces keeps them); bought when it is
 * out with no place named, or at one since deleted; and cooked at home
 * otherwise. The Calendar colours every meal by it, a plan by the way it is
 * planned. When a meal counts is mealWays' rule, below, not this one's.
 */
export function mealWay(meal: Pick<Meal, 'out' | 'placeId'>, places: ReadonlyMap<string, Place>): MealWay {
  if (!meal.out) return 'cooked'
  return meal.placeId && places.has(meal.placeId) ? 'out' : 'bought'
}

/**
 * How each meal that COUNTS was had, by its id — the Kitchen's rule, which
 * Kitchen → Stats, Insights' highlights and the monthly recap all read. Only
 * live meals with a day count, and only meals had: a Fend for yourself night
 * answers the slot but is nobody's meal (mealWasHad). A meal out at a saved
 * place counts once it is one of that place's outings (outingsAt: its day has
 * come here, and midday UTC has too), so the place's card and the Kitchen
 * agree; any other meal once its day (`dayKey`, today on the reader's
 * calendar) has come. A plan is in none of them.
 */
export function mealWays(meals: readonly Meal[], places: ReadonlyMap<string, Place>, now: Date, dayKey: string): Map<string, MealWay> {
  const live = meals.filter(m => m && m.kind === 'meal' && !m.deletedAt && typeof m.date === 'string' && mealWasHad(m))
  // each place's own outings, the meals among them, as its card counts them.
  // The meals out are sorted to their places in one pass, so a place is asked
  // about its own meals only, never every meal there is.
  const outBy = new Map<string, Meal[]>()
  for (const m of live) {
    // out at a saved place, so it names one
    if (mealWay(m, places) !== 'out') continue
    const at = outBy.get(m.placeId!) ?? []
    at.push(m)
    outBy.set(m.placeId!, at)
  }
  const out = new Set<string>()
  for (const [id, at] of outBy) for (const o of outingsAt(id, [], at, now)) if (o.kind === 'meal') out.add(o.meal.id)
  const ways = new Map<string, MealWay>()
  for (const m of live) {
    const way = mealWay(m, places)
    if (way === 'out' ? out.has(m.id) : m.date <= dayKey) ways.set(m.id, way)
  }
  return ways
}
