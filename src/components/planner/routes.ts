import type { IconName } from '../Icon'

// Each tab that shows the same data more than one way holds those ways as
// segments instead of splitting into peer tabs: Home holds the day, the week
// and the journal; Tasks holds the list, board, bills and notes; People holds
// Places. Desktop and phone then land on the identical five nouns.
export type View = 'home' | 'tasks' | 'calendar' | 'people' | 'kitchen'
export const VIEWS: View[] = ['home', 'tasks', 'calendar', 'people', 'kitchen']
export type CalendarMode = 'month' | 'week' | 'timeline'
export const CALENDAR_MODES: CalendarMode[] = ['month', 'week', 'timeline']
export type PeopleTab = 'people' | 'places'
/** Home's three time horizons: today's dashboard, the weekly look-back, the journal. */
export type HomeTab = 'today' | 'week' | 'journal'
export const HOME_TABS: { key: HomeTab; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Week' },
  { key: 'journal', label: 'Journal' },
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
/** …and the former Today / Review views land on the matching Home segment. */
export const LEGACY_VIEW_TO_HOME: Record<string, HomeTab> = { today: 'today', review: 'week' }

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
 *  the day, week and journal; Tasks the board, bills and notes. */
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
// chose it. Everything else (a deep link, a nudge, the More sheet) moves the
// segment for that visit alone, so "Open review" cannot be hijacked by the
// last time the journal was read, and the People tab cannot get pinned to
// Places by one search result.
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
