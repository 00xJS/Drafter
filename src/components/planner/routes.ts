import type { IconName } from '../Icon'

// Each tab that shows the same data more than one way holds those ways as
// segments instead of splitting into peer tabs: Home holds the day, the week,
// the journal and the wardrobe; Tasks holds the list, board, bills and notes;
// People holds Places. Desktop and phone then land on the identical six tabs.
//
// Five of them are nouns — things you add to. Stats is the sixth and is not a
// noun but a lens: the only tab you never put anything into, reading across
// every other one. That is why it can join them without competing for the same
// slot, and why the areas that already count themselves (People, Places,
// Kitchen, the Wardrobe) keep their own Stats, which follow that list's search
// and chips. The lens aggregates those and holds the four areas that have
// nowhere else to be counted: tasks, money, habits and the journal.
// Still no More drawer.
export type View = 'home' | 'tasks' | 'calendar' | 'people' | 'kitchen' | 'stats'
export const VIEWS: View[] = ['home', 'tasks', 'calendar', 'people', 'kitchen', 'stats']
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
/** What a link's view names in one of these tables, or null: a table's own
 *  names only, so `?view=constructor` or `?view=__proto__` names nothing. */
export const viewIn = <T>(table: Record<string, T>, view: string | undefined): T | null =>
  view && Object.prototype.hasOwnProperty.call(table, view) ? table[view] : null

/** An inbound link, held as parsed pieces so a replay keeps its provenance. */
export type PendingLink = { host: string; params: URLSearchParams; allowAct?: boolean }

export const VIEW_LABELS: Record<View, string> = {
  home: 'Home',
  tasks: 'Tasks',
  calendar: 'Calendar',
  people: 'People',
  kitchen: 'Kitchen',
  stats: 'Stats',
}

/** The line icon each view carries in the desktop tab strip. */
export const VIEW_ICONS: Record<View, IconName> = {
  home: 'home',
  tasks: 'tasks',
  calendar: 'calendar',
  people: 'people',
  kitchen: 'kitchen',
  stats: 'stats',
}

/** Phone tab bar: the same six tabs as the desktop, no catch-all. Home carries
 *  the day, week, journal and wardrobe; Tasks the board, bills and notes. Stats
 *  sits in the middle, between the things you plan and the things you keep. */
export const COMPACT_TABS: { id: View; icon: IconName; label: string }[] = [
  { id: 'home', icon: 'home', label: 'Home' },
  { id: 'calendar', icon: 'calendar', label: 'Calendar' },
  { id: 'tasks', icon: 'tasks', label: 'Tasks' },
  { id: 'stats', icon: 'stats', label: 'Stats' },
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

// The segmented views remember which half you chose — but only when you
// chose it. Everything else (a deep link, a nudge, the palette's Board or
// Notes, a day opened from People → Stats or Places → Stats) moves the
// segment for that visit alone, so a template's new tasks shown on the Board
// cannot leave Tasks opening there, the People tab cannot get pinned to
// Places by one search result, and one day tapped in Stats cannot move the
// Calendar off the Timeline.
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
/** The Calendar's Month · Week · Timeline, as last chosen on its three buttons (a day opened from Stats does not count); the month otherwise. */
export const storedCalMode = (): CalendarMode => {
  try {
    const saved = localStorage.getItem(CAL_MODE_KEY) as CalendarMode | null
    return saved && CALENDAR_MODES.includes(saved) ? saved : 'month'
  } catch {
    return 'month'
  }
}

/** People's and Places' own switch: the list, or its figures. Each segment
 *  remembers its own, chosen on its buttons; a link, the palette or a search
 *  result moves it for that visit alone, as it moves the segments. */
export type InnerView = 'list' | 'stats'
export const INNER_VIEWS: { key: InnerView; label: string }[] = [
  { key: 'list', label: 'List' },
  { key: 'stats', label: 'Stats' },
]
export type InnerViews = Record<PeopleTab, InnerView>
export const INNER_VIEW_KEYS: Record<PeopleTab, string> = { people: 'drafter:people-view', places: 'drafter:places-view' }
export const storedInnerView = (tab: PeopleTab): InnerView => {
  try {
    return localStorage.getItem(INNER_VIEW_KEYS[tab]) === 'stats' ? 'stats' : 'list'
  } catch {
    return 'list'
  }
}
export const storedInnerViews = (): InnerViews => ({ people: storedInnerView('people'), places: storedInnerView('places') })

/** A Stats view's own link, as `?view=kitchen-stats` and `?view=wardrobe-stats`
 *  open Kitchen and Home → Wardrobe on theirs: `?view=people-stats` and
 *  `?view=places-stats` open that segment of People on its Stats, for that visit. */
export const STATS_VIEW_TO_PEOPLE: Record<string, PeopleTab> = { 'people-stats': 'people', 'places-stats': 'places' }
/** The segment a link's view opens on its Stats, or null. Its own names only, so `?view=constructor` names none. */
export const peopleTabOfStatsView = (view: string | undefined): PeopleTab | null => viewIn(STATS_VIEW_TO_PEOPLE, view)

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
/** Links to a Kitchen segment, as `?view=wardrobe-stats` is one to the Wardrobe's: `?view=kitchen-stats`
 *  opens Kitchen on Stats, for that visit only. */
export const VIEW_TO_KITCHEN: Record<string, KitchenTab> = { 'kitchen-stats': 'stats' }
/** The Kitchen segment a link's view names, or null. Its own names only, so `?view=constructor` names none. */
export const kitchenTabOfView = (view: string | undefined): KitchenTab | null => viewIn(VIEW_TO_KITCHEN, view)

/** Links to one of Home → Wardrobe's own views, as `?view=kitchen-stats` is one to Kitchen's:
 *  `?view=wardrobe-stats` opens the Wardrobe on Stats, for that visit only. `?view=wardrobe`
 *  names none of them, so it still opens on today's composer. */
export const VIEW_TO_WARDROBE: Record<string, WardrobeTab> = { 'wardrobe-stats': 'stats' }
/** The Wardrobe view a link's view names, or null. Its own names only, so `?view=constructor` names none. */
export const wardrobeTabOfView = (view: string | undefined): WardrobeTab | null => viewIn(VIEW_TO_WARDROBE, view)

/**
 * The Stats lens's own segments — every figure the app keeps, in one tab.
 *
 * Overview reads across all of them. The rest are one per area: the four that
 * had nowhere else to be counted (what you finish, what you pay, what you keep
 * up, what you write) and the four that keep Stats of their own inside their
 * area too (People, Places, Kitchen, the Wardrobe). Those four are drawn HERE,
 * not linked to: the lens is where you go to look at figures, and being sent
 * to another tab to see half of them is the thing it exists to fix. They are
 * the same components their own areas draw, reading the same find boxes and
 * chips (useListFilters), so a figure here and the same figure there can never
 * disagree.
 *
 * Remembered like Tasks' and Kitchen's, on its own track only: a link or the
 * palette moves it for that visit alone.
 */
export type StatsTab = 'overview' | 'tasks' | 'money' | 'people' | 'places' | 'kitchen' | 'wardrobe' | 'habits' | 'journal'
export const STATS_TABS: { key: StatsTab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'money', label: 'Money' },
  { key: 'people', label: 'People' },
  { key: 'places', label: 'Places' },
  { key: 'kitchen', label: 'Kitchen' },
  { key: 'wardrobe', label: 'Wardrobe' },
  { key: 'habits', label: 'Habits' },
  { key: 'journal', label: 'Journal' },
]
export const STATS_TAB_KEY = 'drafter:stats-tab'
export const storedStatsTab = (): StatsTab => {
  try {
    const saved = localStorage.getItem(STATS_TAB_KEY)
    return STATS_TABS.find(t => t.key === saved)?.key ?? 'overview'
  } catch {
    return 'overview'
  }
}
/**
 * Links straight to one of the lens's segments, `stats-<segment>` for each.
 *
 * The older `people-stats`, `places-stats`, `kitchen-stats` and
 * `wardrobe-stats` are NOT these: they were shipped pointing at the Stats each
 * area keeps inside itself, and they still land there, so no link already in a
 * Shortcut, a reminder or someone's notes changes where it goes. `?view=stats`
 * names no segment at all, so it opens the lens on the one last chosen — as
 * `?view=kitchen` does.
 */
export const VIEW_TO_STATS: Record<string, StatsTab> = {
  'stats-tasks': 'tasks',
  'stats-money': 'money',
  'stats-people': 'people',
  'stats-places': 'places',
  'stats-kitchen': 'kitchen',
  'stats-wardrobe': 'wardrobe',
  'stats-habits': 'habits',
  'stats-journal': 'journal',
}
/** The lens segment a link's view names, or null. Its own names only, so `?view=constructor` names none. */
export const statsTabOfView = (view: string | undefined): StatsTab | null => viewIn(VIEW_TO_STATS, view)
