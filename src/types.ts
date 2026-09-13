export type Platform = 'x' | 'instagram' | 'threads' | 'linkedin' | 'facebook' | 'tiktok' | 'youtube'
/** Pre-v3 post statuses; kept so legacy rows still sanitize. */
export type PostStatus = 'idea' | 'draft' | 'scheduled' | 'posted' | 'canceled'
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
export type BillKind = 'bill' | 'card' | 'subscription' | 'loan'
export const BILL_KINDS: BillKind[] = ['bill', 'card', 'subscription', 'loan']
export const BILL_KIND_META: Record<BillKind, { label: string; emoji: string }> = {
  bill: { label: 'Bill', emoji: '🧾' },
  card: { label: 'Credit card', emoji: '💳' },
  subscription: { label: 'Subscription', emoji: '🔁' },
  loan: { label: 'Loan or mortgage', emoji: '🏦' },
}
export interface Bill {
  kind: BillKind
  /** Who is paid: "British Gas", "Amex". */
  payee?: string
  /** Paid automatically, by direct debit or a card on file. */
  autopay?: boolean
  /**
   * The day of the month it falls due (1-31), kept so a bill due on the 31st
   * goes 31 Jan -> 28 Feb -> 31 Mar instead of settling on the 28th for good.
   */
  day?: number
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
}

/**
 * Where a work day is spent. A work day is a CalendarEntry whose start and end
 * are the working hours: it answers "which days am I home" at a glance, and it
 * is never busy time — you are working, and available, just not in the office.
 */
export type WorkMode = 'home' | 'office'
export const WORK_MODES: WorkMode[] = ['home', 'office']
export const WORK_MODE_META: Record<WorkMode, { label: string; short: string; emoji: string }> = {
  home: { label: 'Working from home', short: 'Home', emoji: '🏠' },
  office: { label: 'In the office', short: 'Office', emoji: '🏢' },
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
  /** Present on a work day: where it is spent. Its start and end are the working hours. */
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

export type PlaceCategory = 'restaurant' | 'fastfood' | 'cafe' | 'bar' | 'outdoors' | 'venue' | 'shop' | 'home' | 'other'
export const PLACE_CATEGORIES: PlaceCategory[] = ['restaurant', 'fastfood', 'cafe', 'bar', 'outdoors', 'venue', 'shop', 'home', 'other']
export const PLACE_CATEGORY_META: Record<PlaceCategory, { label: string; emoji: string }> = {
  restaurant: { label: 'Restaurant', emoji: '🍽️' },
  fastfood: { label: 'Fast food', emoji: '🍔' },
  cafe: { label: 'Café', emoji: '☕' },
  bar: { label: 'Bar', emoji: '🍸' },
  outdoors: { label: 'Outdoors', emoji: '🌳' },
  venue: { label: 'Venue', emoji: '🎭' },
  shop: { label: 'Shop', emoji: '🛍️' },
  home: { label: 'Home', emoji: '🏠' },
  other: { label: 'Other', emoji: '📍' },
}

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

/** A meal planned for a calendar day. One record per day+slot. */
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
  notes?: string
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
 * saves it to its project. Shared with the household, like tasks.
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
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

export type Item = Task | Project | CalendarSource | Person | Place | Review | Template | Recipe | Meal | GroceryList | JournalEntry | CalendarEntry | Habit | Routine | Note

/**
 * The legacy post shape. `toPost` still projects a social task into it so
 * stored posts round-trip without rewriting the database.
 */
export interface Post {
  id: string
  title: string
  body: string
  platforms: Platform[]
  status: PostStatus
  createdAt: string
  updatedAt: string
  scheduledFor?: string
  postedAt?: string
  tags: string[]
  notes?: string
  link?: string
  metrics?: Partial<Record<Platform, Metrics>>
  variants?: Partial<Record<Platform, string>>
  mediaIds?: string[]
  recurrence?: Recurrence
  deletedAt?: string
}

const TASK_TO_POST_STATUS: Record<TaskStatus, PostStatus> = {
  wishlist: 'idea',
  todo: 'draft',
  doing: 'draft',
  blocked: 'draft',
  done: 'posted',
  canceled: 'canceled',
}

/** Social view of a task, or null when the task is not a post. */
export function toPost(t: Task): Post | null {
  if (!t.social) return null
  const status = t.status === 'todo' && t.dueAt ? 'scheduled' : TASK_TO_POST_STATUS[t.status]
  return {
    id: t.id,
    title: t.title,
    body: t.description,
    platforms: t.social.platforms,
    status,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    scheduledFor: t.dueAt,
    postedAt: t.completedAt,
    tags: t.tags,
    notes: t.notes,
    link: t.link,
    metrics: t.social.metrics,
    variants: t.social.variants,
    mediaIds: t.mediaIds,
    recurrence: t.recurrence,
    deletedAt: t.deletedAt,
  }
}

/** Effective text for a platform: its variant if set, else the description. */
export function bodyFor(t: { description: string; social?: Social }, pl: Platform): string {
  const v = t.social?.variants?.[pl]
  return v && v.trim() ? v : t.description
}

export const RECURRENCE_META: Record<RecurrenceFreq, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  quarterly: 'Every 3 months',
  yearly: 'Yearly',
}

export const PLATFORMS: Platform[] = ['x', 'instagram', 'threads', 'linkedin', 'facebook', 'tiktok', 'youtube']

export const PLATFORM_META: Record<Platform, { label: string; short: string; color: string; charLimit: number }> = {
  x: { label: 'X (Twitter)', short: 'X', color: '#52525b', charLimit: 280 },
  instagram: { label: 'Instagram', short: 'IG', color: '#db2777', charLimit: 2200 },
  threads: { label: 'Threads', short: 'TH', color: '#6b7280', charLimit: 500 },
  linkedin: { label: 'LinkedIn', short: 'LI', color: '#0a66c2', charLimit: 3000 },
  facebook: { label: 'Facebook', short: 'FB', color: '#1877f2', charLimit: 63206 },
  tiktok: { label: 'TikTok', short: 'TT', color: '#475569', charLimit: 2200 },
  youtube: { label: 'YouTube', short: 'YT', color: '#dc2626', charLimit: 5000 },
}

export const TASK_STATUSES: TaskStatus[] = ['wishlist', 'todo', 'doing', 'blocked', 'done', 'canceled']

/** Kanban columns — these are the statuses you pick. Blocked/canceled remain valid on old rows. */
export const BOARD_STATUSES: TaskStatus[] = ['wishlist', 'todo', 'doing', 'done']

/** Status picker options: board columns, plus current if it's a legacy blocked/canceled value. */
export function pickerStatuses(current: TaskStatus): TaskStatus[] {
  if (BOARD_STATUSES.includes(current)) return BOARD_STATUSES
  return [...BOARD_STATUSES, current]
}

export const STATUS_META: Record<TaskStatus, { label: string; color: string; bg: string }> = {
  wishlist: { label: 'Wishlist', color: '#c4b5fd', bg: 'rgba(139, 92, 246, 0.2)' },
  todo: { label: 'To do', color: '#fcd34d', bg: 'rgba(245, 158, 11, 0.18)' },
  doing: { label: 'Doing', color: '#7dd3fc', bg: 'rgba(14, 165, 233, 0.2)' },
  blocked: { label: 'Blocked', color: '#fda4af', bg: 'rgba(244, 63, 94, 0.2)' },
  done: { label: 'Done', color: '#86efac', bg: 'rgba(34, 197, 94, 0.18)' },
  canceled: { label: 'Canceled', color: '#9ca3af', bg: 'rgba(148, 163, 184, 0.16)' },
}

/** Statuses that still need work — the "open" set every due-date view cares about. */
export const OPEN_STATUSES: TaskStatus[] = ['todo', 'doing', 'blocked']

export const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent']

export const PRIORITY_META: Record<Priority, { label: string; color: string; glyph: string; rank: number }> = {
  low: { label: 'Low', color: '#9ca3af', glyph: '▽', rank: 0 },
  normal: { label: 'Normal', color: '#b3b8c4', glyph: '—', rank: 1 },
  high: { label: 'High', color: '#fb923c', glyph: '▲', rank: 2 },
  urgent: { label: 'Urgent', color: '#f87171', glyph: '‼', rank: 3 },
}

export const PROJECT_STATUSES: ProjectStatus[] = ['active', 'paused', 'done', 'archived']

export const PROJECT_STATUS_META: Record<ProjectStatus, { label: string; color: string; bg: string }> = {
  active: { label: 'Active', color: '#7dd3fc', bg: 'rgba(14, 165, 233, 0.2)' },
  paused: { label: 'Paused', color: '#fcd34d', bg: 'rgba(245, 158, 11, 0.18)' },
  done: { label: 'Done', color: '#86efac', bg: 'rgba(34, 197, 94, 0.18)' },
  archived: { label: 'Archived', color: '#9ca3af', bg: 'rgba(148, 163, 184, 0.16)' },
}

export const PROJECT_COLORS = ['#f97316', '#fbbf24', '#34d399', '#22d3ee', '#818cf8', '#f472b6', '#f87171', '#94a3b8']

export { engagement, impressions, SOCIAL_PROJECT_ID } from '../shared/domain.mjs'

/** Progress of a project's tasks: done vs everything that isn't canceled. */
export function projectProgress(tasks: Task[]): { done: number; total: number; pct: number } {
  const live = tasks.filter(t => t.status !== 'canceled')
  const done = live.filter(t => t.status === 'done').length
  return { done, total: live.length, pct: live.length === 0 ? 0 : Math.round((done / live.length) * 100) }
}
