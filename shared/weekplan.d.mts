import { CalendarEvent, MealSlot, Task } from '../src/types'

export interface TargetWeek {
  /** The Sunday it starts on. */
  startKey: string
  /** Its seven days, Sunday first. */
  dayKeys: string[]
  weekKey: string
  /** The week before, whose review holds this week's Top 3. */
  prevWeekKey: string
}

export interface DinnerItem {
  key: string
  date: string
  recipeId: string
  title: string
  why: string
  /** Recipe ids for Swap to cycle through: never another night's pick. */
  alternatives: string[]
  /** The event across the dinner hour, when there is one: the row starts unticked. */
  busy: string | null
  /** The week's one never-cooked recipe. */
  isNew: boolean
}

export interface PersonItem {
  key: string
  personId: string
  title: string
  dueDay: string
  why: string
}

export interface ReschedItem {
  key: string
  taskId: string
  title: string
  fromDue: string
  toDay: string
  why: string
}

export interface BillItem {
  key: string
  taskId: string
  title: string
  dueDay: string
  amount: number | null
  autopay: boolean
}

export interface TopItem {
  key: string
  title: string
  taskId: string | null
}

export interface WeekPlan {
  week: TargetWeek
  dinners: DinnerItem[]
  people: PersonItem[]
  overdue: ReschedItem[]
  bills: BillItem[]
  top3: TopItem[]
}

/** What WeekPlanSheet hands back to the planner to apply (one Undo for all of it). */
export interface AcceptedPlan {
  dinners: { date: string; recipeId?: string; title: string; out?: boolean; placeId?: string }[]
  people: { personId: string; dueDay: string; title: string }[]
  resched: { taskId: string; toDay: string }[]
  wishlist: string[]
  top3: string[]
  dismissed: string[]
}

export interface MealIdea {
  /** idea:<day>:<slot>:<kind>:<id> — stable for the day, for dismissing. */
  key: string
  kind: 'recipe' | 'place'
  id: string
  title: string
  /** "Cooked 6× in six months", "Not cooked in 5 weeks", "Haven't been since 3 May". */
  why: string
}

export interface SlotIdeas {
  slot: MealSlot
  /** False when the slot already has a meal (cooked, eaten out, or out with no place): no ideas then. */
  missing: boolean
  ideas: MealIdea[]
}

export interface MealHistory {
  /** Every recipe, by name. `cookCount` is the last six months; `timesCooked` all of them. */
  recipes: { id: string; name: string; tags: string[]; cookCount: number; timesCooked: number; lastCooked: string | null }[]
  /** Every place you eat at, by name. `outings` is the last six months; `visits` all of them; eaten-out meals count. */
  places: { id: string; name: string; category: string; outings: number; visits: number; lastVisit: string | null }[]
}

export declare function targetWeek(todayKey: string): TargetWeek | null
export declare function proposeWeek(
  items: readonly unknown[],
  o: {
    todayKey: string
    tz?: string
    userId?: string | null
    dismissed?: readonly string[]
    now?: Date
    /** Occurrences from subscribed calendars; our own entries come from `items`. */
    events?: readonly CalendarEvent[]
  },
): WeekPlan | null
export declare function weekPlanSummary(plan: WeekPlan | null | undefined): string | null
export declare function catchUpTask(item: Pick<PersonItem, 'personId' | 'title' | 'dueDay'>, o: { id: string; now?: Date }): Task
export declare function mealIdeasFor(
  items: readonly unknown[],
  o: { dayKey: string; slots?: readonly MealSlot[]; now?: Date; dismissed?: readonly string[]; tz?: string },
): SlotIdeas[]
export declare function mealHistory(items: readonly unknown[], o: { dayKey: string; now?: Date; tz?: string }): MealHistory
