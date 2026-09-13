import { PROJECT_COLORS, type CalendarEvent, type GroceryList, type Meal, type Person, type Place, type PlaceCategory, type Recipe } from '../../types'
import type { Store } from '../../store'
import { eventStartDate, prepDueFor } from '../../calendars'
import { mealWrites } from '../../kitchen'
import { uid } from '../../utils'
import type { useOverlays } from './useOverlays'
import type { useToast } from './useToast'

interface Deps {
  store: Store
  showToast: ReturnType<typeof useToast>['showToast']
  newTask: ReturnType<typeof useOverlays>['newTask']
}

/** The grocery lists once `rows` are written: each rebuilt list replaces its week's. */
function afterWrites(lists: GroceryList[], rows: (Meal | GroceryList)[]): GroceryList[] {
  const rebuilt = rows.filter((r): r is GroceryList => r.kind === 'grocery')
  return [...lists.filter(g => !rebuilt.some(r => r.weekKey === g.weekKey)), ...rebuilt]
}

/**
 * The home side of the day: meals and the grocery lists they write, places and
 * dishes named on the fly, visits and outings logged with an undo, and the
 * tasks that plan them.
 */
export function useLifeActions({ store, showToast, newTask }: Deps) {
  /**
   * A place created while planning a meal: somewhere you ate for the first time
   * gets tracked from the meal picker, instead of a detour to the Places tab.
   * Returns the row so the caller can attach it to the meal in the same tick.
   */
  const createPlaceInline = (name: string, category: PlaceCategory): Place => {
    const now = new Date().toISOString()
    const place: Place = {
      kind: 'place',
      id: uid(),
      name: name.trim(),
      category,
      color: PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)],
      createdAt: now,
      updatedAt: now,
    }
    store.upsert(place)
    return place
  }

  /** The Cook-side mirror of createPlaceInline: save a new dish from just its
   *  name while planning the meal; its ingredients and steps get filled in on
   *  the Kitchen tab later. */
  const createRecipeInline = (name: string): Recipe => {
    const now = new Date().toISOString()
    const recipe: Recipe = {
      kind: 'recipe',
      id: uid(),
      name: name.trim(),
      ingredients: [],
      tags: [],
      createdAt: now,
      updatedAt: now,
    }
    store.upsert(recipe)
    return recipe
  }

  /**
   * Planning a meal always writes its week's grocery list in the same round —
   * see mealWrites. The Kitchen tab, the calendar's day sheet and Today's meal
   * ideas all go through here so none can forget it. Several meals at once
   * (Plan my day's lunch and dinner, and their Undo) fold: the store's lists do
   * not change until the next render, so each list is rebuilt on top of the one
   * before it — rebuilt from the store's instead, the second would drop the
   * first meal's ingredients.
   */
  const saveMeals = (next: Meal[]) => {
    let meals = store.meals
    let lists = store.groceries
    for (const m of next) {
      const rows = mealWrites(m, null, meals, store.recipes, lists)
      for (const row of rows) store.upsert(row)
      meals = [...meals.filter(x => x.id !== m.id), m]
      lists = afterWrites(lists, rows)
    }
  }
  const clearMeals = (ids: string[]) => {
    let meals = store.meals
    let lists = store.groceries
    for (const id of ids) {
      const rows = mealWrites(null, id, meals, store.recipes, lists)
      for (const row of rows) store.upsert(row)
      store.remove(id)
      meals = meals.filter(x => x.id !== id)
      lists = afterWrites(lists, rows)
    }
  }
  const saveMeal = (m: Meal) => saveMeals([m])
  const clearMeal = (id: string) => clearMeals([id])

  /** One-tap "Saw them" with undo — used from Today, Search, and ?saw=. */
  const sawThem = (person: Person) => {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    store.upsert({
      kind: 'task',
      id,
      title: `Saw ${person.name}`,
      description: '',
      status: 'done',
      priority: 'normal',
      completedAt: now,
      createdAt: now,
      updatedAt: now,
      tags: ['visit'],
      peopleIds: [person.id],
    })
    showToast(`Logged a visit with ${person.name}`, () => store.remove(id))
  }
  /** A done task dated at the outing is what "seeing someone / going somewhere" is made of. Returns the task id. */
  const logOuting = (o: { at: string; title: string; peopleIds?: string[]; placeId?: string; description?: string }): string => {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    store.upsert({
      kind: 'task',
      id,
      title: o.title,
      description: o.description ?? '',
      status: 'done',
      priority: 'normal',
      completedAt: o.at,
      createdAt: now,
      updatedAt: now,
      tags: ['visit'],
      peopleIds: o.peopleIds?.length ? o.peopleIds : undefined,
      placeId: o.placeId,
    })
    const who = (o.peopleIds ?? []).map(id => store.people.find(p => p.id === id)?.name).filter(Boolean)
    const where = o.placeId ? store.places.find(p => p.id === o.placeId)?.name : undefined
    const bits = [where, who.length ? `with ${who.join(', ')}` : ''].filter(Boolean)
    showToast(bits.length ? `Logged ${bits.join(' ')}` : `Logged “${o.title}”`, () => store.remove(id))
    return id
  }
  /** One-tap "Went there" from Today's cadence nudge — logged now, undo in the toast. */
  const wentTo = (place: Place) => logOuting({ at: new Date().toISOString(), title: `Went to ${place.name}`, placeId: place.id })
  const logVisit = (person: Person, atIso: string, note: string, placeId?: string) => {
    const placeName = placeId ? store.places.find(p => p.id === placeId)?.name : undefined
    logOuting({
      at: atIso,
      title: note || (placeName ? `${person.name} at ${placeName}` : `Saw ${person.name}`),
      peopleIds: [person.id],
      placeId,
    })
  }
  const planOccasion = (person: Person, kind: 'birthday' | 'anniversary', at: Date) => {
    const due = new Date(at.getFullYear(), at.getMonth(), at.getDate() - 5, 9, 0, 0)
    newTask({
      title: `Gift for ${person.name}'s ${kind}`,
      status: 'todo',
      priority: 'high',
      dueAt: (due.getTime() > Date.now() ? due : new Date(Date.now() + 3_600_000)).toISOString(),
      peopleIds: [person.id],
      tags: ['gift', kind],
      notes: person.notes ? `Ideas from their notes: ${person.notes}` : undefined,
    })
  }
  const logAttendance = (ev: CalendarEvent, peopleIds: string[], placeId?: string) => {
    if (peopleIds.length === 0 && !placeId) return
    const at = ev.allDay ? new Date(`${ev.start}T12:00`).toISOString() : new Date(ev.start).toISOString()
    logOuting({
      at,
      title: ev.title,
      // the place carries the where; free text only when no place was chosen
      description: ev.location && !placeId ? `At ${ev.location}` : '',
      peopleIds,
      placeId,
    })
  }
  const planWith = (person: Person, title?: string) => newTask({ title: title ?? `Catch up with ${person.name}`, status: 'todo', peopleIds: [person.id], tags: ['visit'] })
  const planAt = (place: Place) => newTask({ title: `Go to ${place.name}`, status: 'todo', placeId: place.id, tags: ['visit'] })
  /** Turn an external event into a prep task due the morning before. */
  const planForEvent = (ev: CalendarEvent) => {
    const when = eventStartDate(ev).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
    newTask({
      title: `Prep: ${ev.title}`,
      status: 'todo',
      dueAt: prepDueFor(ev),
      notes: `For “${ev.title}” on ${when}${ev.location ? ` · ${ev.location}` : ''}`,
    })
  }

  return { createPlaceInline, createRecipeInline, saveMeal, clearMeal, saveMeals, clearMeals, sawThem, logOuting, wentTo, logVisit, planOccasion, logAttendance, planWith, planAt, planForEvent }
}
