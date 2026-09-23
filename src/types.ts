import type { PlaceCategory } from '../shared/places.mjs'

export type Platform = 'x' | 'instagram' | 'threads' | 'linkedin' | 'facebook' | 'tiktok' | 'youtube'
export type TaskStatus = 'wishlist' | 'todo' | 'doing' | 'blocked' | 'done' | 'canceled'
export type ProjectStatus = 'active' | 'paused' | 'done' | 'archived'
export type Priority = 'low' | 'normal' | 'high' | 'urgent'
export type RecurrenceFreq = 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly'

export interface Metrics {
  likes?: number
  comments?: number
  shares?: number
  impressions?: number
}

export interface Recurrence {
  freq: RecurrenceFreq
}

export interface Comment {
  id: string
  body: string
  createdAt: string
}

export interface ChecklistItem {
  id: string
  text: string
  done: boolean
}

export interface Milestone {
  id: string
  name: string
  dueAt?: string
  done?: boolean
}

/**
 * A household payment: a bill, a credit card, a subscription, a loan.
 *
 * It rides on a repeating task rather than being its own kind, because a bill
 * IS something due on a date, again and again, with an amount — and a task
 * already gets the calendar, reminders, Today, the Google and Outlook mirrors
 * and overdue handling for free. The amount due is the task's estimateCost and
 * what was actually paid is its actualCost; this only adds what a task lacks.
 */
export type BillKind = 'bill' | 'card' | 'subscription' | 'loan' | 'income'
export const BILL_KINDS: BillKind[] = ['bill', 'card', 'subscription', 'loan', 'income']
export const BILL_KIND_META: Record<BillKind, { label: string; emoji: string }> = {
  bill: { label: 'Bill', emoji: '🧾' },
  card: { label: 'Credit card', emoji: '💳' },
  subscription: { label: 'Subscription', emoji: '🔁' },
  loan: { label: 'Loan or mortgage', emoji: '🏦' },
  income: { label: 'Payday', emoji: '💵' },
}
/** Money coming IN. Every figure that adds money up has to ask, or a payday reads as a cost. */
export const isIncomeKind = (k: BillKind | undefined): boolean => k === 'income'
export interface Bill {
  kind: BillKind
  /** Who is paid: "British Gas", "Amex". On a payday, who pays you: "Acme Ltd". */
  payee?: string
  /** Paid automatically, by direct debit or a card on file. */
  autopay?: boolean
  /**
   * The day of the month it falls due (1-31), kept so a bill due on the 31st
   * goes 31 Jan -> 28 Feb -> 31 Mar instead of settling on the 28th for good.
   */
  day?: number
  /**
   * Whose payday it is, when it is one: a household member's account id. Two
   * people are paid on different days for different amounts, and a household
   * that adds both up without knowing which is whose cannot say whether
   * Thursday is a thin week for one of them (v3.27).
   */
  forMemberId?: string
  /** The account it lands in, or is paid from: an Account's id. */
  accountId?: string
}

/** The social-publishing extension of a task; present only on tasks that are posts. */
export interface Social {
  platforms: Platform[]
  /** Per-platform text overrides; a platform without an entry uses the description. */
  variants?: Partial<Record<Platform, string>>
  metrics?: Partial<Record<Platform, Metrics>>
}

/** Set by the server on read: which account the record belongs to. */
export interface Owned {
  ownerId?: string
  /** A content-free tombstone from "Delete forever": hidden from Trash, never restorable. */
  purged?: boolean
}

export interface Task extends Owned {
  kind: 'task'
  id: string
  title: string
  description: string
  status: TaskStatus
  priority: Priority
  projectId?: string
  dueAt?: string
  completedAt?: string
  createdAt: string
  updatedAt: string
  tags: string[]
  notes?: string
  link?: string
  /** A GitHub issue / PR / repo / Projects URL, rendered as a live status card. */
  githubUrl?: string
  checklist?: ChecklistItem[]
  comments?: Comment[]
  /** Ids of images stored in IndexedDB / Supabase Storage. */
  mediaIds?: string[]
  recurrence?: Recurrence
  social?: Social
  /** Present when this task is a household payment: a bill, a card, a subscription, a loan. */
  bill?: Bill
  /** People this task involves; when it's done, it counts as seeing them. */
  peopleIds?: string[]
  /** Where this happened; when the task is done it counts as an outing there. */
  placeId?: string
  /** Files (any type) in the media store. */
  attachments?: Attachment[]
  estimateCost?: number
  actualCost?: number
  /** Ids of tasks that must be done first; the task unblocks itself when they are. */
  blockedBy?: string[]
  /** Household member responsible (a Supabase user id). */
  assigneeId?: string
  /**
   * Who in the household can see it. A new task is private (`false`) until
   * someone shares it, the same as a note. Tasks written before that default
   * carry no flag: the database still reads those as shared, so the board
   * does not empty. Only `true` shares one out loud; `false` withholds it.
   * posts_private_flag keeps a stored `false` when a write omits the field,
   * so an older build cannot publish a private task by saving it.
   */
  shared?: boolean
  /**
   * The local day (YYYY-MM-DD) this task is in today's focus for — set by Plan
   * my day and Shut down. Past values are history and are never cleared, so a
   * finished task still reads as "2 of 3 done" on its day.
   */
  focusOn?: string
  /** The user id that chose that focus; absent in local mode, where there is no one else. */
  focusBy?: string
  /** Tombstone: set instead of hard-deleting so deletes sync and can be undone. */
  deletedAt?: string
}

/**
 * Two-way sync with a GitHub Projects (v2) board, stored on the project that
 * links it. Present (with a status field) means sync is on; the ids are GitHub
 * node ids and are opaque to us. `columns` maps a Drafter status to a board
 * option id, and is read both ways (push on a status change, pull on focus).
 */
export interface GithubProjectSync {
  statusFieldId?: string
  dateFieldId?: string
  columns?: Partial<Record<TaskStatus, string>>
}

export interface Project extends Owned {
  kind: 'project'
  id: string
  name: string
  description?: string
  color: string
  emoji?: string
  status: ProjectStatus
  startAt?: string
  targetAt?: string
  milestones?: Milestone[]
  githubUrl?: string
  /** Set when the linked GitHub Projects board mirrors task status / due dates. */
  githubProjectSync?: GithubProjectSync
  /** Legacy Markdown notes (pre rich text); converted into notesHtml on first open. */
  notes?: string
  /** Rich-text notes as a sanitized HTML subset; photos reference the media store by id. */
  notesHtml?: string
  /** Pinned in Tasks → Notes: the notepad sits at the top of the list with the pinned notes. */
  notesPinned?: boolean
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

/** A subscribed external calendar (Google secret address, iCloud share link, any ICS feed). */
export interface CalendarSource extends Owned {
  kind: 'calendar'
  id: string
  name: string
  url: string
  color: string
  enabled: boolean
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

/** One concrete occurrence of an external event, as returned by /api/calendars. */
export interface CalendarEvent {
  id: string
  sourceId: string
  title: string
  /** ISO datetime, or YYYY-MM-DD for all-day events. */
  start: string
  /** Exclusive end: ISO datetime, or YYYY-MM-DD for all-day events. */
  end: string
  allDay: boolean
  location?: string
  /**
   * Set when this row is a CalendarEntry of ours rather than a feed occurrence.
   * Projecting our own entries into this shape lets every grid, pill and day row
   * draw them with the code that already exists; this field is what tells the
   * calendar it may also EDIT this one.
   */
  localId?: string
  /** Set when the entry is a work day, so the calendar draws it as a day badge instead of an item. */
  work?: WorkMode
  /**
   * Who wrote the entry this was projected from, when it is one of ours. A
   * work day is the clearest case: two people in a household keep different
   * hours, and the calendar drew the first one it found on a day as though it
   * were yours (v3.24). Absent on a feed occurrence, and on a row this device
   * has written but not yet synced — which is this device's own either way.
   */
  ownerId?: string
}

/**
 * What the day is: home or the office (working hours, available), or Off / a
 * holiday (the whole day, not at work). A CalendarEntry with `work` set is
 * drawn as a day badge, never as an item among the day's events.
 */
export type WorkMode = 'home' | 'office' | 'off' | 'holiday'
export const WORK_MODES: WorkMode[] = ['home', 'office', 'off', 'holiday']
/** Home and the office: you are working. Off and a holiday are the day away. */
export const isWorkingMode = (m?: WorkMode): m is 'home' | 'office' => m === 'home' || m === 'office'
export const WORK_MODE_META: Record<WorkMode, { label: string; short: string; emoji: string }> = {
  home: { label: 'Working from home', short: 'Home', emoji: '🏠' },
  office: { label: 'In the office', short: 'Office', emoji: '🏢' },
  off: { label: 'PTO / Off', short: 'Off', emoji: '🌴' },
  holiday: { label: 'Holiday', short: 'Holiday', emoji: '🎉' },
}

/**
 * A calendar entry you wrote yourself, as opposed to CalendarEvent above, which
 * is a read-only occurrence projected from a subscribed feed.
 *
 * This is what blocks out 2-3pm: unlike a task it has a real start AND end, so
 * it occupies a slot instead of marking a single moment. `start`/`end` follow
 * exactly the CalendarEvent convention — ISO datetimes, or YYYY-MM-DD with an
 * EXCLUSIVE end when allDay — so a local entry can be rendered by the same code
 * that draws everything else on the grid.
 */
export interface CalendarEntry extends Owned {
  kind: 'event'
  id: string
  title: string
  /** ISO datetime, or YYYY-MM-DD when allDay. */
  start: string
  /** Exclusive end: ISO datetime, or YYYY-MM-DD when allDay. */
  end: string
  allDay: boolean
  location?: string
  notes?: string
  projectId?: string
  peopleIds?: string[]
  /** Present on a work day: home or office hours, or an Off / holiday day. */
  work?: WorkMode
  /** On a time block made from a task (Plan my day): the task it is time for. */
  taskId?: string
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

export type PersonGroup = 'family' | 'friends' | 'other'
export const PERSON_GROUPS: PersonGroup[] = ['family', 'friends', 'other']
export const PERSON_GROUP_META: Record<PersonGroup, string> = { family: 'Family', friends: 'Friends', other: 'Other' }

/** Target days between visits. */
export type Cadence = 7 | 14 | 30 | 60 | 90 | 180
export const CADENCE_META: Record<Cadence, string> = {
  7: 'Every week',
  14: 'Every 2 weeks',
  30: 'Monthly',
  60: 'Every 2 months',
  90: 'Every 3 months',
  180: 'Twice a year',
}

export interface Attachment {
  id: string
  name: string
  type: string
  size: number
}

/** Someone you want to keep close. Visits are done tasks with them attached. */
export interface Person extends Owned {
  kind: 'person'
  id: string
  name: string
  emoji?: string
  color: string
  group: PersonGroup
  cadenceDays?: number
  notes?: string
  /** YYYY-MM-DD (year optional as 0000). */
  birthday?: string
  anniversary?: string
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

// The categories and their labels live in shared/places.mjs: one list for the
// app and the MCP server, so an assistant can save every kind the app offers.
export type { PlaceCategory }
export { PLACE_CATEGORIES, PLACE_CATEGORY_META } from '../shared/places.mjs'

/** Somewhere you go. Outings are done tasks with the place attached — same rule as people. */
export interface Place extends Owned {
  kind: 'place'
  id: string
  name: string
  emoji?: string
  color: string
  category: PlaceCategory
  /**
   * Optional return rhythm ("we said monthly"), the same Cadence values people
   * use. Absent = never nag: a place with no cadence is never due or overdue.
   */
  cadenceDays?: number
  notes?: string
  /** Where it is, on one line ("21 Warwick St, London"). Open in Maps searches it, and an event whose location holds it is at this place. */
  address?: string
  /**
   * A pin from "I'm here" or the editor's Pin this spot. Optional: a place
   * is still a place with only a name. Both ends or neither; five decimals.
   */
  lat?: number
  lon?: number
  /** Other names it goes by ("Pret" for Pret A Manger): an event's location, a question or an assistant finds the place by any of them. */
  aliases?: string[]
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

/** A saved weekly/monthly review: top priorities, reflections, the AI summary. */
export interface Review extends Owned {
  kind: 'review'
  id: string
  period: 'week' | 'month'
  /** 2026-W37 or 2026-09 */
  key: string
  top: string[]
  /** Per Top-3 line: ticked off on Today / in the following review. */
  topDone?: boolean[]
  reflections?: string
  summary?: string
  /** When Sunday's automatic draft took its one try at this week, whether or not the model answered. */
  draftedAt?: string
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

export interface TemplateTask {
  title: string
  description?: string
  /** Days after the project start. */
  offsetDays?: number
  priority?: Priority
  checklist?: string[]
  tags?: string[]
}

export interface TemplateMilestone {
  name: string
  offsetDays: number
}

/** A reusable project blueprint. */
export interface Template extends Owned {
  kind: 'template'
  id: string
  name: string
  emoji?: string
  color: string
  description?: string
  tasks: TemplateTask[]
  milestones?: TemplateMilestone[]
  notesHtml?: string
  /** Suggested length in days (drives the target date). */
  durationDays?: number
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

export type RecipeIngredient = {
  id: string
  name: string
  qty?: number
  unit?: string
}

export interface Recipe extends Owned {
  kind: 'recipe'
  id: string
  name: string
  emoji?: string
  servings?: number
  ingredients: RecipeIngredient[]
  steps?: string[]
  tags: string[]
  notes?: string
  /** The web page it was imported from (http or https only), shown as its Source. */
  sourceUrl?: string
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

export type MealSlot = 'breakfast' | 'lunch' | 'dinner'
export const MEAL_SLOTS: MealSlot[] = ['breakfast', 'lunch', 'dinner']
export const MEAL_SLOT_META: Record<MealSlot, { label: string; emoji: string }> = {
  breakfast: { label: 'Breakfast', emoji: '🍳' },
  lunch: { label: 'Lunch', emoji: '🥪' },
  dinner: { label: 'Dinner', emoji: '🍽️' },
}

/** A dish served with a meal's main: a saved recipe, or just a name ("garlic bread"). */
export interface MealSide {
  /** The saved recipe, when the side is one: its ingredients join the grocery list and cooking it counts. */
  recipeId?: string
  title: string
}

/** A meal planned for a calendar day. One record per member per day+slot. */
export interface Meal extends Owned {
  kind: 'meal'
  id: string
  /** YYYY-MM-DD */
  date: string
  slot: MealSlot
  recipeId?: string
  /**
   * Bought rather than cooked — takeaway, a delivery, or a meal out. A day with
   * one still answers "what are we eating", contributes nothing to the grocery
   * list, and once the day has passed counts as an outing at `placeId`.
   */
  out?: boolean
  /** Where an `out` meal came from. A place row, so eating there is an outing. */
  placeId?: string
  title: string
  /**
   * What goes with the main on a cooked meal: the rice with the curry. Part of
   * the meal rather than a slot of its own, so a dinner with sides is still one
   * dinner. Absent on a bought meal and on every meal planned before sides.
   */
  sides?: MealSide[]
  notes?: string
  /**
   * Shared with the household as a plan they can do. Breakfast, lunch and
   * dinner all use this: absent means the week can still see it (every meal
   * written before the option existed), and only `true` writes the cook task.
   * `false` keeps the slot to its owner. Either member can turn sharing on;
   * only the owner can turn it off.
   */
  shared?: boolean
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

export type GroceryState = 'need' | 'have' | 'done'
export const GROCERY_STATES: GroceryState[] = ['need', 'have', 'done']
export const GROCERY_STATE_META: Record<GroceryState, { label: string }> = {
  need: { label: 'Need' },
  have: { label: 'Have' },
  done: { label: 'Got it' },
}

export interface GroceryLine {
  id: string
  name: string
  qty?: number
  unit?: string
  state: GroceryState
  /** Recipe ids this line was generated from; empty when added by hand. */
  recipeIds: string[]
  manual?: boolean
  /**
   * Taken off the list by hand. The line stays in `items` so a rebuild from
   * the meal plan does not put it straight back; it is left out of the list,
   * the counts and every bulk action, and listed under "Removed" with Restore.
   */
  removed?: boolean
  /**
   * The recipes that wanted this line when it was removed. A rebuild that finds
   * a recipe not in here brings the line back as need (shared/kitchen.mjs).
   */
  removedRecipeIds?: string[]
}

/** One grocery list per week (`id` = grocery~{weekKey}). */
export interface GroceryList extends Owned {
  kind: 'grocery'
  id: string
  weekKey: string
  items: GroceryLine[]
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

/** How the day felt, 1 (rough) to 5 (great). Optional on every entry. */
export type Mood = 1 | 2 | 3 | 4 | 5
export const MOODS: Mood[] = [1, 2, 3, 4, 5]
export const MOOD_META: Record<Mood, { label: string; emoji: string }> = {
  1: { label: 'Rough', emoji: '😞' },
  2: { label: 'Meh', emoji: '😕' },
  3: { label: 'Okay', emoji: '😐' },
  4: { label: 'Good', emoji: '🙂' },
  5: { label: 'Great', emoji: '😄' },
}

/**
 * One day's journal entry (`id` = journal~YYYY-MM-DD~random). Personal: like
 * reviews and calendars it is never shown to other household members. Several
 * entries for one day can exist (two devices offline) and are all kept.
 */
export interface JournalEntry extends Owned {
  kind: 'journal'
  id: string
  /** YYYY-MM-DD */
  date: string
  body: string
  mood?: Mood
  /** People this day was about (optional). */
  peopleIds?: string[]
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

/**
 * A habit you want to keep: a thing to do on its scheduled days, ticked once a
 * day, with a streak. Personal like the journal. Completions live on the record
 * as a list of day keys rather than a row each, so a habit is one record and a
 * tick is one small write — the streak is computed, never stored.
 */
export interface Habit extends Owned {
  kind: 'habit'
  id: string
  name: string
  emoji?: string
  color?: string
  /** Weekdays it is due, 0=Sun … 6=Sat. Empty or absent means every day. */
  days?: number[]
  /** Days it was done, each YYYY-MM-DD. */
  done: string[]
  /** Order on the Today card. */
  order?: number
  createdAt: string
  updatedAt: string
  deletedAt?: string
  /** Kept but no longer counted or shown on Today. */
  archivedAt?: string
}

export type RoutineWhen = 'morning' | 'evening' | 'anytime'
export const ROUTINE_WHENS: RoutineWhen[] = ['morning', 'evening', 'anytime']

export interface RoutineStep {
  id: string
  text: string
}

/**
 * A routine is a short checklist you run at a time of day — the morning start,
 * the wind-down before bed. Personal like a habit, and stored the same way: one
 * record, with each tick a 'YYYY-MM-DD|stepId' key on it. Because a tick names
 * its day, tomorrow simply has no ticks yet — the list starts fresh with no
 * reset job, and yesterday's run is still on the record if anything wants it.
 */
export interface Routine extends Owned {
  kind: 'routine'
  id: string
  name: string
  when: RoutineWhen
  /** The steps in order. Ids stay stable across an edit so ticks survive it. */
  steps: RoutineStep[]
  /** Each 'YYYY-MM-DD|stepId'. */
  ticks: string[]
  /** Order on the Today card. */
  order?: number
  createdAt: string
  updatedAt: string
  deletedAt?: string
  /** Kept but no longer shown on Today. */
  archivedAt?: string
}

/**
 * A note: one titled page of rich text. Before notes existed each project had a
 * single pad (Project.notesHtml); those pads are never rewritten into notes —
 * the Notes screen lists each non-empty one beside these records and still
 * saves it to its project.
 *
 * A note is YOURS until you share it. Notes used to be household-wide like
 * tasks, which is the wrong default for the one place people write things down
 * without deciding who they are for. `shared` is the whole of that decision,
 * and the database enforces it: a peer's query cannot return a note without it
 * (v3.16).
 */
export interface Note extends Owned {
  kind: 'note'
  id: string
  /** May be empty on a note that so far is only text; the UI calls it "Untitled note". */
  title: string
  /** The sanitized HTML subset Project.notesHtml stores (src/richtext.ts); photos are <img data-media="id">. */
  body: string
  /** The project it is about, if any. A note with none is a household note. */
  projectId?: string
  /** Kept at the top of the list. */
  pinned?: boolean
  /**
   * Visible to the rest of the household. Absent means no — a note is private
   * until its owner says otherwise, and only its owner can say so.
   */
  shared?: boolean
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

/** What a piece of clothing is. The order is the composer's, top to toe, and the slot order everywhere. */
export type GarmentType = 'top' | 'bottom' | 'onepiece' | 'outerwear' | 'shoes' | 'accessory'
export const GARMENT_TYPES: GarmentType[] = ['top', 'bottom', 'onepiece', 'outerwear', 'shoes', 'accessory']
export const GARMENT_TYPE_META: Record<GarmentType, { label: string; plural: string }> = {
  top: { label: 'Top', plural: 'Tops' },
  bottom: { label: 'Bottom', plural: 'Bottoms' },
  onepiece: { label: 'One-piece', plural: 'One-pieces' },
  outerwear: { label: 'Outerwear', plural: 'Outerwear' },
  shoes: { label: 'Shoes', plural: 'Shoes' },
  accessory: { label: 'Accessory', plural: 'Accessories' },
}
/** What makes a look a look: top(s) and bottom(s), or a one-piece. */
export const CORE_TYPES: GarmentType[] = ['top', 'bottom', 'onepiece']
/** Most pieces an outfit or a look can hold. */
export const MAX_PIECES = 12
/** The longest note a look keeps: a word or a phrase ("wedding"), not a diary. */
export const LOOK_NOTE_MAX = 120
/** Optional names for a look on a day that already has another — stickers, not slots. */
export const LOOK_NAME_HINTS = ['Morning', 'Gym', 'Going out', 'Home'] as const
/** The seasons a piece can be marked for, in the year's order. A piece marked for none is for any. */
export type Season = 'spring' | 'summer' | 'autumn' | 'winter'
export const SEASONS: Season[] = ['spring', 'summer', 'autumn', 'winter']
export const SEASON_META: Record<Season, { label: string }> = {
  spring: { label: 'Spring' },
  summer: { label: 'Summer' },
  autumn: { label: 'Autumn' },
  winter: { label: 'Winter' },
}
/** What a piece is worn for: Work or Days off. A piece marked for neither is for Anytime, the default. */
export type Occasion = 'work' | 'personal'
export const OCCASIONS: Occasion[] = ['work', 'personal']
export const OCCASION_META: Record<Occasion, { label: string }> = {
  work: { label: 'Work' },
  // the stored value stays 'personal': it reads as Days off
  personal: { label: 'Days off' },
}

/** One piece of clothing. Personal, like the journal: never a household peer's to read. */
export interface Garment extends Owned {
  kind: 'garment'
  id: string
  /** '' only on a tombstone. */
  name: string
  type: GarmentType
  /** 1200px JPEG in the media store: personal/<user id>/<uid> (a bare uid in local mode). */
  photoId?: string
  /** 360px JPEG, same shape: rows, the grid and Today use it. */
  thumbId?: string
  /** The back, for a piece whose logo or print is there: a 1200px photo and its 360px thumbnail, the same shape as the front's. */
  backPhotoId?: string
  backThumbId?: string
  /** Shown back first: the back is the main picture and the front the inset. Only with a back photo. */
  showBack?: true
  /** Worn for work or for days off ('personal'); absent is anytime. */
  occasion?: Occasion
  /** #rrggbb sampled from the photo: the placeholder, the tints, the name suggestion. */
  color?: string
  notes?: string
  /** Starred: marked in the rows and in Clothes, which can show only these. */
  favourite?: boolean
  /** Your own words for it, lowercased ("work", "gym"): a Clothes filter. A set field, so two devices' tags both stay. */
  tags?: string[]
  /** The seasons it is for; none means any season. */
  seasons?: Season[]
  /** What it cost, in whole dollars (formatMoney shows it): the sheet's cost per wear. */
  price?: number
  createdAt: string
  updatedAt: string
  deletedAt?: string
  /** Retired (given away, worn out): keeps its history, leaves the composer, Today and the not-worn lists. */
  archivedAt?: string
}

/** A saved combination: garment ids only, never copied names. */
export interface Outfit extends Owned {
  kind: 'outfit'
  id: string
  /** Absent: the UI names it by its pieces. */
  name?: string
  /**
   * In composer order, 1..MAX_PIECES. Not a set field (shared/merge.mjs): it
   * merges as ONE value, so two devices' edits raise a conflict instead of a
   * union nobody chose.
   */
  garmentIds: string[]
  /** Starred: first under the composer, and marked there. */
  favourite?: boolean
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

/**
 * One look worn on a local day: id wear~YYYY-MM-DD~<10 random chars>, like a
 * journal entry's. A day can hold several, in the order you changed (morning,
 * then going out, then home); every figure counts distinct days. A look put
 * together for a day still to come is `planned`, and counts in no figure until
 * it is confirmed worn; one whose day passes unconfirmed stays out of them.
 * `note` is an optional name on that look ("Morning"), not a required slot.
 */
export interface Wear extends Owned {
  kind: 'wear'
  id: string
  /** YYYY-MM-DD, a local day key. */
  date: string
  /** 0..MAX_PIECES, merged as one value like an outfit's; an empty look counts as nothing. */
  garmentIds: string[]
  /** A word on the look: "wedding". */
  note?: string
  /** Planned ahead and not yet confirmed worn. */
  planned?: true
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

/** What kind of account a balance is kept for. */
export type AccountType = 'checking' | 'savings' | 'credit' | 'investment' | 'cash'
export const ACCOUNT_TYPES: AccountType[] = ['checking', 'savings', 'credit', 'investment', 'cash']
export const ACCOUNT_TYPE_META: Record<AccountType, { label: string; emoji: string; liability?: true }> = {
  checking: { label: 'Checking', emoji: '🏦' },
  savings: { label: 'Savings', emoji: '🐖' },
  credit: { label: 'Credit card', emoji: '💳', liability: true },
  investment: { label: 'Investment', emoji: '📈' },
  cash: { label: 'Cash', emoji: '💵' },
}

/** One balance you typed in, on the day it was true. */
export interface BalanceCheck {
  /** YYYY-MM-DD, a local day key. */
  on: string
  /** What it held. On a credit account this is what is OWED, a positive number. */
  amount: number
}

/**
 * An account you keep a balance for (v3.27).
 *
 * Drafter never connects to a bank and never will: an account here is a name,
 * a kind, and the balances you have typed in over time. That is enough to
 * answer the question the Bills view could not — "is there enough in there
 * before the 3rd?" — and it is the whole of this feature's contact with the
 * outside world.
 *
 * The household's, like a bill: two people who share the rent share the
 * picture. `memberId` says whose it is when only one of them uses it.
 *
 * The check-ins live on the row. That is last-write-wins, like every other
 * record here: two people typing a balance for the SAME account in the same
 * minute would keep one of the two. A balance is a once-a-week thing done by
 * one person, so that is the right trade against a row per check-in — and
 * `on` is a day key, so re-typing a day replaces it rather than doubling it.
 */
export interface Account extends Owned {
  kind: 'account'
  id: string
  name: string
  type: AccountType
  /** Whose it is; absent means the household's. */
  memberId?: string
  /** Newest last, one per day. */
  balances: BalanceCheck[]
  /** Left out of the totals without being deleted: an account you closed. */
  archivedAt?: string
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

/**
 * One message in the household's chat.
 *
 * The household's, by kind — there is no per-record sharing here, because a
 * message nobody else can read is not a message. One row per message, never
 * edited after it is written, so two people typing at once cannot overwrite
 * each other the way a growing array under last-write-wins would.
 *
 * The id carries the instant it was written (`message~<iso>~<10 random>`), as
 * a journal entry's carries its day: the list sorts on the id alone, and two
 * devices offline in the same second still write two rows.
 */
export interface Message extends Owned {
  kind: 'message'
  id: string
  /** What was said. Plain text — a chat is not a document. */
  body: string
  /** A record this message is about, so "about the shopping" can open it. */
  about?: { kind: 'task' | 'event' | 'meal' | 'note'; id: string; label: string }
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

/** The longest one message can be: a paragraph, not a document. */
export const MESSAGE_MAX = 2000

/**
 * One turn of the conversation with Drafter's assistant — yours or its.
 *
 * PERSONAL, and deliberately a different kind from `message`: asking the
 * assistant what your week looks like is not something to say to the
 * household, and a household chat that fills up with one person's questions
 * to a model is not a household chat any more. The two never share a thread.
 *
 * One row per turn, like a message, for the same reason.
 */
export interface ChatTurn extends Owned {
  kind: 'chat'
  id: string
  /** Who said it. */
  role: 'you' | 'drafter'
  text: string
  /** On an answer: the references it cited (T3, J1), for the chips under it. */
  cites?: string[]
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

/**
 * What a snooze can be put on. A person and a place are records of ours; an
 * event is whatever Today's "Coming up" listed, which is usually an occurrence
 * from a subscribed calendar and has no record here to write a field on.
 */
export type SnoozeTarget = 'person' | 'place' | 'event'

/**
 * A nudge put off rather than answered: "not this fortnight", not "seen".
 *
 * PERSONAL, and that is the whole point of it: whose nudge it is decides whose
 * snooze it is. Maria putting her mother off for two weeks is not Joseph
 * saying he has called her, any more than Maria's work day is his.
 *
 * One row per thing, keyed `snooze~<target>~<targetId>`, so putting the same
 * nudge off again overwrites instead of piling rows up. A row is spent once
 * `until` has passed; nothing sweeps it, because rewriting the same id is how
 * the next snooze is made.
 */
export interface Snooze extends Owned {
  kind: 'snooze'
  id: string
  target: SnoozeTarget
  /** The person's or place's id; for an event, the occurrence id Today listed. */
  targetId: string
  /** ISO instant the nudge comes back. */
  until: string
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

/** How long a nudge can be put off for. Never "forever": every one of these comes back. */
export const SNOOZE_OPTIONS: { days: number; label: string; short: string }[] = [
  { days: 7, label: 'a week', short: '1w' },
  { days: 14, label: 'two weeks', short: '2w' },
  { days: 30, label: 'a month', short: '1m' },
  { days: 90, label: 'three months', short: '3m' },
]

export type Item = Task | Project | CalendarSource | Person | Place | Review | Template | Recipe | Meal | GroceryList | JournalEntry | CalendarEntry | Habit | Routine | Note | Garment | Outfit | Wear | Snooze | Message | ChatTurn | Account

export const RECURRENCE_META: Record<RecurrenceFreq, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  quarterly: 'Every 3 months',
  yearly: 'Yearly',
}

export const PLATFORMS: Platform[] = ['x', 'instagram', 'threads', 'linkedin', 'facebook', 'tiktok', 'youtube']

export const TASK_STATUSES: TaskStatus[] = ['wishlist', 'todo', 'doing', 'blocked', 'done', 'canceled']

/** Kanban columns — these are the statuses you pick. Blocked/canceled remain valid on old rows. */
export const BOARD_STATUSES: TaskStatus[] = ['wishlist', 'todo', 'doing', 'done']

/** Status picker options: board columns, plus current if it's a legacy blocked/canceled value. */
export function pickerStatuses(current: TaskStatus): TaskStatus[] {
  if (BOARD_STATUSES.includes(current)) return BOARD_STATUSES
  return [...BOARD_STATUSES, current]
}

/* The badge tables below hold theme tokens, not colours: each tone is a text
   colour on its own tint, defined for light and dark in src/styles/01-base.css. */
export const STATUS_META: Record<TaskStatus, { label: string; color: string; bg: string }> = {
  wishlist: { label: 'Wishlist', color: 'var(--tone-violet)', bg: 'var(--tone-violet-bg)' },
  todo: { label: 'To do', color: 'var(--tone-amber)', bg: 'var(--tone-amber-bg)' },
  doing: { label: 'Doing', color: 'var(--tone-sky)', bg: 'var(--tone-sky-bg)' },
  blocked: { label: 'Blocked', color: 'var(--tone-rose)', bg: 'var(--tone-rose-bg)' },
  done: { label: 'Done', color: 'var(--tone-green)', bg: 'var(--tone-green-bg)' },
  canceled: { label: 'Canceled', color: 'var(--tone-grey)', bg: 'var(--tone-grey-bg)' },
}

/** Statuses that still need work — the "open" set every due-date view cares about. */
export const OPEN_STATUSES: TaskStatus[] = ['todo', 'doing', 'blocked']

export const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent']

export const PRIORITY_META: Record<Priority, { label: string; color: string; glyph: string; rank: number }> = {
  low: { label: 'Low', color: 'var(--tone-grey)', glyph: '▽', rank: 0 },
  normal: { label: 'Normal', color: 'var(--prio-normal)', glyph: '—', rank: 1 },
  high: { label: 'High', color: 'var(--prio-high)', glyph: '▲', rank: 2 },
  urgent: { label: 'Urgent', color: 'var(--danger)', glyph: '‼', rank: 3 },
}

export const PROJECT_STATUSES: ProjectStatus[] = ['active', 'paused', 'done', 'archived']

export const PROJECT_STATUS_META: Record<ProjectStatus, { label: string; color: string; bg: string }> = {
  active: { label: 'Active', color: 'var(--tone-sky)', bg: 'var(--tone-sky-bg)' },
  paused: { label: 'Paused', color: 'var(--tone-amber)', bg: 'var(--tone-amber-bg)' },
  done: { label: 'Done', color: 'var(--tone-green)', bg: 'var(--tone-green-bg)' },
  archived: { label: 'Archived', color: 'var(--tone-grey)', bg: 'var(--tone-grey-bg)' },
}

export const PROJECT_COLORS = ['#f97316', '#fbbf24', '#34d399', '#22d3ee', '#818cf8', '#f472b6', '#f87171', '#94a3b8']

export { SOCIAL_PROJECT_ID } from '../shared/domain.mjs'
