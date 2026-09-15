import type { IconName } from '../Icon'

// Each tab that shows the same data more than one way holds those ways as
// segments instead of splitting into peer tabs: Home holds the day, the week,
// the journal and the wardrobe; Tasks holds the list, board, bills and notes;
// People holds Places. Desktop and phone then land on the identical five nouns.
export type View = 'home' | 'tasks' | 'calendar' | 'people' | 'kitchen'
export const VIEWS: View[] = ['home', 'tasks', 'calendar', 'people', 'kitchen']
export type CalendarMode = 'month' | 'week' | 'timeline'
export const CALENDAR_MODES: CalendarMode[] = ['month', 'week', 'timeline']
export type PeopleTab = 'people' | 'places'
/** Home's four segments: today's dashboard, the weekly look-back, the journal, and what you wear. */
export type HomeTab = 'today' | 'week' | 'journal' | 'wardrobe'
export const HOME_TABS: { key: HomeTab; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Week' },
  { key: 'journal', label: 'Journal' },
  { key: 'wardrobe', label: 'Wardrobe' },
]
/** Home → Wardrobe's own switch: the composer, every piece, and the figures.
 *  Not remembered: it opens on the composer, as Home opens on Today. */
export type WardrobeTab = 'outfit' | 'clothes' | 'stats'
export const WARDROBE_TABS: { key: WardrobeTab; label: string }[] = [
  { key: 'outfit', label: 'Outfit' },
  { key: 'clothes', label: 'Clothes' },
  { key: 'stats', label: 'Stats' },
]
/** The Tasks tab's four segments: the list, the board, the bills, the notes. */
export type TasksTab = 'list' | 'board' | 'bills' | 'notes'
export const TASKS_TABS: { key: TasksTab; label: string }[] = [
  { key: 'list', label: 'List' },
  { key: 'board', label: 'Board' },
  { key: 'bills', label: 'Bills' },
  { key: 'notes', label: 'Notes' },
]
/** Old inbound links (drafter://…?view=board|bills|notes) still resolve: they
 *  land on the Tasks tab with that segment open. */
export const LEGACY_VIEW_TO_TASKS: Record<string, TasksTab> = { board: 'board', bills: 'bills', notes: 'notes' }
/** …and the former Today / Review views land on the matching Home segment.
 *  The wardrobe was never a view; `?view=wardrobe` is simply its link. */
export const LEGACY_VIEW_TO_HOME: Record<string, HomeTab> = { today: 'today', review: 'week', wardrobe: 'wardrobe' }

/** An inbound link, held as parsed pieces so a replay keeps its provenance. */
export type PendingLink = { host: string; params: URLSearchParams; allowAct?: boolean }

export const VIEW_LABELS: Record<View, string> = {
  home: 'Home',
  tasks: 'Tasks',
  calendar: 'Calendar',
  people: 'People',
  kitchen: 'Kitchen',
}

/** The line icon each view carries in the desktop tab strip. */
export const VIEW_ICONS: Record<View, IconName> = {
  home: 'home',
  tasks: 'tasks',
  calendar: 'calendar',
  people: 'people',
  kitchen: 'kitchen',
}

/** Phone tab bar: the same five nouns as the desktop, no catch-all. Home carries
 *  the day, week, journal and wardrobe; Tasks the board, bills and notes. */
export const COMPACT_TABS: { id: View; icon: IconName; label: string }[] = [
  { id: 'home', icon: 'home', label: 'Home' },
  { id: 'calendar', icon: 'calendar', label: 'Calendar' },
  { id: 'tasks', icon: 'tasks', label: 'Tasks' },
  { id: 'kitchen', icon: 'kitchen', label: 'Kitchen' },
  { id: 'people', icon: 'people', label: 'People' },
]

export const CAL_MODE_KEY = 'drafter:calendar-mode'
export const TASKS_TAB_KEY = 'drafter:tasks-tab'
export const PEOPLE_TAB_KEY = 'drafter:people-tab'

export interface Toast {
  msg: string
  undo?: () => void
  /** A confirm step instead of an undo: the button runs `run` (e.g. a web link asking to write into the journal). */
  action?: { label: string; run: () => void }
}

// The two segmented views remember which half you chose — but only when you
// chose it. Everything else (a deep link, a nudge, the palette's Board or
// Notes) moves the segment for that visit alone, so a template's new tasks
// shown on the Board cannot leave Tasks opening there, and the People tab
// cannot get pinned to Places by one search result.
export const storedTasksTab = (): TasksTab => {
  try {
    const t = localStorage.getItem(TASKS_TAB_KEY)
    return t === 'board' || t === 'bills' || t === 'notes' ? t : 'list'
  } catch {
    return 'list'
  }
}
export const storedPeopleTab = (): PeopleTab => {
  try {
    return localStorage.getItem(PEOPLE_TAB_KEY) === 'places' ? 'places' : 'people'
  } catch {
    return 'people'
  }
}

/** Kitchen's four segments: the recipes, the week's meals, the grocery list and
 *  the figures. Kitchen remembers the one chosen by its buttons, as Tasks does. */
export type KitchenTab = 'recipes' | 'week' | 'grocery' | 'stats'
export const KITCHEN_TABS: { key: KitchenTab; label: string }[] = [
  { key: 'recipes', label: 'Recipes' },
  { key: 'week', label: 'This week' },
  { key: 'grocery', label: 'Grocery' },
  { key: 'stats', label: 'Stats' },
]
export const KITCHEN_TAB_KEY = 'drafter:kitchen-tab'
export const storedKitchenTab = (): KitchenTab => {
  try {
    const saved = localStorage.getItem(KITCHEN_TAB_KEY)
    return KITCHEN_TABS.find(t => t.key === saved)?.key ?? 'recipes'
  } catch {
    return 'recipes'
  }
}
/** Links to a Kitchen segment, as `?view=wardrobe` is one to Home's: `?view=kitchen-stats`
 *  opens Kitchen on Stats, for that visit only. */
export const VIEW_TO_KITCHEN: Record<string, KitchenTab> = { 'kitchen-stats': 'stats' }
/** The Kitchen segment a link's view names, or null. Its own names only, so `?view=constructor` names none. */
export const kitchenTabOfView = (view: string | undefined): KitchenTab | null =>
  view && Object.prototype.hasOwnProperty.call(VIEW_TO_KITCHEN, view) ? VIEW_TO_KITCHEN[view] : null
