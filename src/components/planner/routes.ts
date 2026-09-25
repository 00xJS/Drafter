import type { IconName } from '../Icon'
import type { InsightPeriod } from '../../../shared/insights.mts'

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
 * the chat — and holds one at v3.29: Home IS the day, and draws no segments
 * for it.
 *
 * The Wardrobe went to Keep, the Week and the Journal archive to Insights, and
 * the Chat to the top bar. Home keeps the chips that link to all of them,
 * because a chip on the day is not the module: "6 days in a row so far" with a
 * line to write in is Home's, the archive of what you wrote is not.
 */
export type HomeTab = 'today'

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
 * Insights → Stats: the Highlights, and each area's figures pushed over them.
 *
 * It opened on a track of nine segments — Overview and eight areas — that
 * scrolled off a phone's edge, over a column of tiles many of which said 0.
 * It opens on the Highlights now: a few plain lines about the week, the month
 * or the year (shared/insights.mts), each opening its area. An area's figures
 * are a page you go into and come back from, with ‹ Back (PushedScreen), and
 * the Overview's streaks, area cards and year of days are the This year page.
 *
 * People, Places, Kitchen and the Wardrobe are drawn from THEIR OWN
 * components there, the ones their areas draw, reading the same find boxes
 * and chips (useListFilters), so a figure here and the same figure there can
 * never disagree.
 *
 * Which page is up is not remembered: a tap on the tab lands on the
 * Highlights, as a tab tap lands on the root of any pushed page. A link or the
 * palette opens an area for that visit.
 */
export type StatsArea = 'tasks' | 'money' | 'people' | 'places' | 'kitchen' | 'wardrobe' | 'habits' | 'journal'
/** The chips under the Highlights' head, one per area, in the order shared/insights.mts ranks a tie by. */
export const STATS_AREAS: { key: StatsArea; label: string }[] = [
  { key: 'tasks', label: 'Tasks' },
  { key: 'money', label: 'Money' },
  { key: 'people', label: 'People' },
  { key: 'places', label: 'Places' },
  { key: 'kitchen', label: 'Kitchen' },
  { key: 'wardrobe', label: 'Wardrobe' },
  { key: 'habits', label: 'Habits' },
  { key: 'journal', label: 'Journal' },
]
/** What Insights → Stats shows: the Highlights, one area's figures, or the year. */
export type StatsTab = 'highlights' | StatsArea | 'year'
/** A pushed page's title. */
export const STATS_PAGE_TITLES: Record<Exclude<StatsTab, 'highlights'>, string> = {
  ...(Object.fromEntries(STATS_AREAS.map(a => [a.key, a.label])) as Record<StatsArea, string>),
  year: 'This year',
}
/**
 * Links straight to one area's figures, `stats-<area>` for each, and
 * `stats-year` to the year.
 *
 * The older `people-stats`, `places-stats`, `kitchen-stats` and
 * `wardrobe-stats` are NOT these: they were shipped pointing at the Stats each
 * area keeps inside itself, and they still land there, so no link already in a
 * Shortcut, a reminder or someone's notes changes where it goes. `?view=stats`
 * names no page at all, so it opens the Highlights.
 */
export const VIEW_TO_STATS: Record<string, Exclude<StatsTab, 'highlights'>> = {
  'stats-tasks': 'tasks',
  'stats-money': 'money',
  'stats-people': 'people',
  'stats-places': 'places',
  'stats-kitchen': 'kitchen',
  'stats-wardrobe': 'wardrobe',
  'stats-habits': 'habits',
  'stats-journal': 'journal',
  'stats-year': 'year',
}
/** The Stats page a link's view names, or null. Its own names only, so `?view=constructor` names none. */
export const statsTabOfView = (view: string | undefined): Exclude<StatsTab, 'highlights'> | null => viewIn(VIEW_TO_STATS, view)

/**
 * The period a key names — `2026`, `2026-09`, `2026-W39` — or null for
 * anything else: a notice's target is read with it. The page reads the day
 * the period starts on itself (shared/insights.mts parsePeriodKey), which a
 * week that does not exist fails.
 */
export function periodOfKey(key: string | null | undefined): InsightPeriod | null {
  const k = String(key ?? '')
  if (/^\d{4}$/.test(k)) return 'year'
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(k)) return 'month'
  return /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(k) ? 'week' : null
}

/**
 * The Highlights' Week · Month · Year, as last chosen on its own track. A link
 * (the monthly recap's, `?insights=month&period=2026-09`) moves it for that
 * visit alone.
 */
export const INSIGHTS_PERIOD_KEY = 'drafter:insights-period'
export const storedInsightsPeriod = (): InsightPeriod => {
  try {
    const saved = localStorage.getItem(INSIGHTS_PERIOD_KEY)
    return saved === 'month' || saved === 'year' ? saved : 'week'
  } catch {
    return 'week'
  }
}
