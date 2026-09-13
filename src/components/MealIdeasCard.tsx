import { useMemo, useState } from 'react'
import { MEAL_SLOT_META, Meal, MealSlot, Place, Recipe, Task } from '../types'
import { mealIdeasFor } from '../../shared/weekplan.mjs'
import type { MealIdea, SlotIdeas } from '../../shared/weekplan.mjs'
import { mealWithMain } from '../kitchen'

/** Lunch ideas stop being useful by mid-afternoon, and dinner ideas by the evening. */
export const LUNCH_IDEAS_UNTIL = 14
export const DINNER_IDEAS_UNTIL = 20

/** The slots still worth suggesting at this hour: lunch before 2pm, dinner before 8pm. */
export function ideaSlots(hour: number): MealSlot[] {
  const out: MealSlot[] = []
  if (hour < LUNCH_IDEAS_UNTIL) out.push('lunch')
  if (hour < DINNER_IDEAS_UNTIL) out.push('dinner')
  return out
}

const DISMISS_PREFIX = 'drafter:meal-ideas-dismissed:'
/** "Not today" is remembered on this device for one day, and never synced. */
export const mealIdeasDismissKey = (day: string): string => `${DISMISS_PREFIX}${day}`

export function mealIdeasDismissed(day: string): boolean {
  try {
    return localStorage.getItem(mealIdeasDismissKey(day)) === '1'
  } catch {
    return false
  }
}

/** Hide the ideas for `day`, and forget any older day's "Not today" while we are here. */
export function dismissMealIdeas(day: string): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key?.startsWith(DISMISS_PREFIX) && key !== mealIdeasDismissKey(day)) localStorage.removeItem(key)
    }
    localStorage.setItem(mealIdeasDismissKey(day), '1')
  } catch {}
}

/**
 * The meal a tapped idea plans, written the way the Kitchen's own slot picker
 * writes one (mealWithMain): the day+slot id, a recipe to cook, or a place you
 * eat out at. Pass the slot's current record (a tombstone, say) so the write is
 * stamped newer than it and wins the merge — and so a slot planned meanwhile on
 * another device keeps its notes, and its sides while it is still cooked.
 */
export function mealFromIdea(dayKey: string, slot: MealSlot, idea: MealIdea, existing?: Meal, now = new Date()): Meal {
  const main = idea.kind === 'place' ? { out: true, placeId: idea.id, title: idea.title || 'Eating out' } : { recipeId: idea.id, title: idea.title || MEAL_SLOT_META[slot].label }
  return mealWithMain(existing, { date: dayKey, slot }, main, now.toISOString())
}

/** Today's empty slots that have something to suggest, at the hour `now` falls in. */
export function openMealIdeas(items: readonly unknown[], dayKey: string, now: Date): SlotIdeas[] {
  const slots = ideaSlots(now.getHours())
  if (slots.length === 0) return []
  return mealIdeasFor(items, { dayKey, slots, now }).filter(s => s.missing && s.ideas.length > 0)
}

interface Props {
  /** Today, YYYY-MM-DD. */
  dayKey: string
  now: Date
  meals: Meal[]
  recipes: Recipe[]
  places: Place[]
  /** Every task: outings to a place are done tasks with it attached. */
  tasks: Task[]
  onPlan(dayKey: string, slot: MealSlot, idea: MealIdea): void
}

/**
 * "Lunch & dinner ideas" on Today: when lunch and/or dinner has nothing planned,
 * a few ideas for each — what you have most, and old favourites you have not
 * had for longest — each saying why it is here. A tap plans it (the planner
 * saves it with an Undo); "Not today" hides the card until tomorrow. Lunch
 * ideas go at 2pm and dinner ideas at 8pm, when they could only nag.
 */
export function MealIdeasCard({ dayKey, now, meals, recipes, places, tasks, onPlan }: Props) {
  const [dismissed, setDismissed] = useState(() => mealIdeasDismissed(dayKey))
  // the ideas only change with the records, the day and the hour, never the minute
  const hourStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours()).getTime()
  const groups = useMemo(
    () => openMealIdeas([...meals, ...recipes, ...places, ...tasks], dayKey, new Date(hourStart)),
    [meals, recipes, places, tasks, dayKey, hourStart],
  )
  const emoji = useMemo(() => new Map(recipes.map(r => [r.id, r.emoji])), [recipes])

  if (dismissed || groups.length === 0) return null
  const title = groups.length > 1 ? 'Lunch & dinner ideas' : `${MEAL_SLOT_META[groups[0].slot].label} ideas`

  return (
    <section className="chart-card meal-ideas">
      <header className="chart-head">
        <div>
          <h3>{title}</h3>
          <p className="chart-sub">Nothing planned yet — tap one to put it on today’s menu</p>
        </div>
        <button
          type="button"
          className="btn subtle"
          onClick={() => {
            dismissMealIdeas(dayKey)
            setDismissed(true)
          }}
        >
          Not today
        </button>
      </header>
      {groups.map(g => {
        const slotLabel = MEAL_SLOT_META[g.slot].label
        return (
          <div key={g.slot} className="meal-ideas-slot">
            <h4 className="meal-ideas-label">
              <span aria-hidden>{MEAL_SLOT_META[g.slot].emoji}</span> {slotLabel}
            </h4>
            <ul className="meal-ideas-list">
              {g.ideas.map(idea => (
                <li key={idea.key}>
                  <button
                    type="button"
                    className="meal-idea"
                    aria-label={`${idea.title} — plan for ${slotLabel.toLowerCase()}. ${idea.why}`}
                    onClick={() => onPlan(dayKey, g.slot, idea)}
                  >
                    <span className="meal-idea-title">
                      <span aria-hidden>{idea.kind === 'place' ? '🥡' : emoji.get(idea.id) || '🍳'}</span> {idea.title}
                    </span>
                    <span className="meal-idea-why">{idea.why}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </section>
  )
}
