import type { IconName } from '../Icon'

// Five tabs, and each one answers a different question.
//
//   Home      — what about today
//   Calendar  — when
//   Tasks     — what to do
//   Keep      — who and what you keep: People, Places, Kitchen, Wardrobe
//   Insights  — what it all adds up to
//
// Until v3.29 there were six, and the sixth was an accident of growth rather
// than a decision: People, Kitchen and Stats had each earned a tab by being
// too big for anywhere else, and the Wardrobe had not, so it lived as a page
// hanging off Home beside the Week and the Journal. That left two rules
// running at once — "a big thing gets a tab" and "a thing Home opens is a
// page" — and which one a module got depended on when it was built.
//
// Keep is the one rule: the things you KEEP records about sit together, and
// each is a segment of it. People, Places, Kitchen and the Wardrobe are the
// four, they already each carry their own inner switch (List · Stats, or the
// Kitchen's four), and nothing about what they do changes by moving.
//
// A tab that shows the same data more than one way still holds those ways as
// segments, never as peer tabs. Still no More drawer.
export type View = 'home' | 'tasks' | 'calendar' | 'keep' | 'insights'
export const VIEWS: View[] = ['home', 'tasks', 'calendar', 'keep', 'insights']
export type CalendarMode = 'month' | 'week' | 'day'
export const CALENDAR_MODES: CalendarMode[] = ['month', 'week', 'day']
export type PeopleTab = 'people' | 'places'
/**
 * Home's pages. It held four at v3.28 — the day, the week, the journal and
 * the chat — and holds one at v3.29: Home IS the day.
 *
 * The Wardrobe went to Keep, the Week and the Journal archive to Insights, and
 * the Chat to the top bar. Home keeps the chips that link to all of them,
 * because a chip on the day is not the module: "6 days in a row so far" with a
 * line to write in is Home's, the archive of what you wrote is not.
 */
export type HomeTab = 'today'
export const HOME_TABS: { key: HomeTab; label: string }[] = [{ key: 'today', label: 'Today' }]

/**
 * Insights' three: the figures, what you wrote, and the week you just had.
 *
 * The lens is one of them rather than the whole tab. It shows counts and never
 * text — "nothing you wrote is shown here" is a line the Journal segment of it
 * draws on purpose — so the archive cannot live inside it. It sits beside it.
 */
export type InsightsTab = 'stats' | 'journal' | 'review'
export const INSIGHTS_TABS: { key: InsightsTab; label: string }[] = [
  { key: 'stats', label: 'Stats' },
  { key: 'journal', label: 'Journal' },
  { key: 'review', label: 'Review' },
]
export const INSIGHTS_TAB_KEY = 'drafter:insights-tab'
export const storedInsightsTab = (): InsightsTab => {
  try {
    const saved = localStorage.getItem(INSIGHTS_TAB_KEY)
    return INSIGHTS_TABS.find(t => t.key === saved)?.key ?? 'stats'
  } catch {
    return 'stats'
  }
}

/** Keep's four segments: who you see, where you go, what you eat, what you wear. */
export type KeepTab = 'people' | 'places' | 'kitchen' | 'wardrobe'
export const KEEP_TABS: { key: KeepTab; label: string }[] = [
  { key: 'people', label: 'People' },
  { key: 'places', label: 'Places' },
  { key: 'kitchen', label: 'Kitchen' },
  { key: 'wardrobe', label: 'Wardrobe' },
]
export const KEEP_TAB_KEY = 'drafter:keep-tab'
/** Home → Wardrobe's own switch: the composer, every piece, and the figures.
 *  Not remembered: it opens on the composer, as Home opens on Today. */
export type WardrobeTab = 'outfit' | 'clothes' | 'stats'
export const WARDROBE_TABS: { key: WardrobeTab; label: string }[] = [
  { key: 'outfit', label: 'Outfit' },
  { key: 'clothes', label: 'Clothes' },
  { key: 'stats', label: 'Stats' },
]
/** The Tasks tab's four segments: the list, the board, the money, the notes. */
export type TasksTab = 'list' | 'board' | 'bills' | 'notes'
export const TASKS_TABS: { key: TasksTab; label: string }[] = [
  { key: 'list', label: 'List' },
  { key: 'board', label: 'Board' },
  // the key stays 'bills' so every saved segment and old drafter:// link still
  // lands here; what it holds grew into Finance in v3.27
  { key: 'bills', label: 'Finance' },
  { key: 'notes', label: 'Notes' },
]
/** Old inbound links (drafter://…?view=board|bills|notes) still resolve: they
 *  land on the Tasks tab with that segment open. */
export const LEGACY_VIEW_TO_TASKS: Record<string, TasksTab> = { board: 'board', bills: 'bills', notes: 'notes' }
/** …and the former Today view lands on Home. `?view=review` names Insights’
 *  Review segment now, through LEGACY_VIEW_TO_INSIGHTS. */
export const LEGACY_VIEW_TO_HOME: Record<string, HomeTab> = { today: 'today' }
/**
 * The tabs that stopped being tabs in v3.29. `?view=people`, `?view=places`,
 * `?view=kitchen` and `?view=wardrobe` are in Shortcuts, reminders and the
 * bot's replies, and every one of them still lands on exactly what it named —
 * now as a segment of Keep. `?view=stats` is the same story for Insights and
 * is handled by LEGACY_VIEW, since it names a whole tab and no segment.
 */
export const LEGACY_VIEW_TO_KEEP: Record<string, KeepTab> = { people: 'people', places: 'places', kitchen: 'kitchen', wardrobe: 'wardrobe' }
export const LEGACY_VIEW: Record<string, View> = { stats: 'insights' }
/** …and the two pages that left Home for Insights keep the names they had. */
export const LEGACY_VIEW_TO_INSIGHTS: Record<string, InsightsTab> = { review: 'review', journal: 'journal' }
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
  keep: 'Keep',
  insights: 'Insights',
}

/** The line icon each view carries in the desktop tab strip. */
export const VIEW_ICONS: Record<View, IconName> = {
  home: 'home',
  tasks: 'tasks',
  calendar: 'calendar',
  keep: 'keep',
  insights: 'stats',
}

/** Phone tab bar: the same five tabs as the desktop, no catch-all. The order
 *  runs from the nearest thing to the furthest — today, then when, then what
 *  to do, then what you keep, then what it adds up to. */
export const COMPACT_TABS: { id: View; icon: IconName; label: string }[] = [
  { id: 'home', icon: 'home', label: 'Home' },
  { id: 'calendar', icon: 'calendar', label: 'Calendar' },
  { id: 'tasks', icon: 'tasks', label: 'Tasks' },
  { id: 'keep', icon: 'keep', label: 'Keep' },
  { id: 'insights', icon: 'stats', label: 'Insights' },
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
// Places by one search result, and one day tapped in Stats cannot change
// the Calendar's Month · Week · Day.
export const storedTasksTab = (): TasksTab => {
  try {
    const t = localStorage.getItem(TASKS_TAB_KEY)
    return t === 'board' || t === 'bills' || t === 'notes' ? t : 'list'
  } catch {
    return 'list'
  }
}
/**
 * Which of Keep's four to open on, as last chosen on its own track.
 *
 * Falls back to `drafter:people-tab`, which is where People · Places was
 * remembered before Keep existed: a phone that had been left on Places opens
 * Keep on Places rather than resetting to People. Nothing writes the old key
 * any more, so it decays to "never set" on its own.
 */
export const storedKeepTab = (): KeepTab => {
  try {
    const saved = localStorage.getItem(KEEP_TAB_KEY)
    const hit = KEEP_TABS.find(t => t.key === saved)
    if (hit) return hit.key
    return localStorage.getItem(PEOPLE_TAB_KEY) === 'places' ? 'places' : 'people'
  } catch {
    return 'people'
  }
}
/** The Calendar's Month · Week · Day, as last chosen on its three buttons (a day opened from Stats does not count); the month otherwise. A saved Timeline from before Day was the third tab is the month. */
export const storedCalMode = (): CalendarMode => {
  try {
    const saved = localStorage.getItem(CAL_MODE_KEY)
    return saved === 'week' || saved === 'day' ? saved : 'month'
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
    return KITCHEN_TABS.find(t => t.key === saved)?.key ?? 'week'
  } catch {
    return 'week'
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
