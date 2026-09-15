import type { Command } from '../Search'
import type { Task } from '../../types'
import { localDayKey } from '../../journal'
import { storedInnerView, type HomeTab, type InnerView, type PeopleTab, type TasksTab, type View } from './routes'
import type { Sheet } from './useOverlays'
import type { WardrobeOpen } from './useNavigation'

/** The moves the palette makes (useNavigation's, or a stand-in in a test). */
export interface PaletteNav {
  goView(v: View): void
  setHomeTab(tab: HomeTab): void
  setView(v: View): void
  openJournal(date?: string): void
  goTasksTab(tab: TasksTab): void
  setPeopleTab(tab: PeopleTab): void
  /** A segment of People's List · Stats, for this visit only. */
  goInnerView(tab: PeopleTab, v: InnerView): void
  openWardrobe(o?: WardrobeOpen): void
  /** A segment of People on its Stats, for this visit only. */
  openStats(tab: PeopleTab): void
}

/** The editors and sheets the palette opens (useOverlays', or a stand-in). */
export interface PaletteOverlays {
  newTask(preset?: Partial<Task>, opts?: { capture?: boolean }): void
  setSettingsOpen(open: boolean): void
  openSheet(sheet: Sheet): void
}

/** Plan my day is offered before you type until noon… */
export const PLAN_DAY_QUICK_UNTIL = 12
/** …and Shut down from five in the evening, when Today's strip starts offering it too. */
export const SHUT_DOWN_QUICK_FROM = 17

// The command palette's own rows: the things you can do and the places you can
// go, beside the search results. Navigation lands on the same segment a tab
// tap would; the actions open the same editors the toolbar buttons do. `now`
// decides which of the day's routines is a quick action. There is no New
// project: there is one ongoing project, and nothing starts a second.
export function buildPaletteCommands(nav: PaletteNav, overlays: PaletteOverlays, now: Date = new Date()): Command[] {
  const { goView, setHomeTab, setView, openJournal, goTasksTab, setPeopleTab, goInnerView, openWardrobe, openStats } = nav
  const { newTask, setSettingsOpen, openSheet } = overlays
  const hour = now.getHours()
  /** People or Places, remembered as its button would, on the List or Stats last chosen there: a one-shot People stats does not linger. */
  const goPeople = (tab: PeopleTab) => {
    setPeopleTab(tab)
    goInnerView(tab, storedInnerView(tab))
    setView('people')
  }
  return [
    { id: 'new-task', label: 'New task', icon: 'plus', quick: true, keywords: 'add create', run: () => newTask() },
    // the day's two routines open over wherever you are, as Settings does
    { id: 'plan-day', label: 'Plan my day', icon: 'today', quick: hour < PLAN_DAY_QUICK_UNTIL, keywords: 'morning focus today', run: () => openSheet({ kind: 'day' }) },
    { id: 'shut-down', label: 'Shut down', icon: 'journal', quick: hour >= SHUT_DOWN_QUICK_FROM, keywords: 'evening wrap close tomorrow', run: () => openSheet({ kind: 'shutdown' }) },
    // the week ahead, and a question about your own planner: typed for, not offered empty
    { id: 'plan-week', label: 'Plan next week', icon: 'review', quick: false, keywords: 'week ahead meals dinners catch up sunday', run: () => openSheet({ kind: 'week' }) },
    { id: 'ask', label: 'Ask Drafter', icon: 'search', quick: false, keywords: 'question answer ai assistant', run: () => openSheet({ kind: 'ask' }) },
    // today's look, and a piece to add: typed for too. A photo picker has to open
    // inside the tap itself, and the palette runs through a lazy chunk first, so
    // Add clothing lands on the sheet's big photo target rather than the picker.
    { id: 'log-wear', label: 'What am I wearing?', icon: 'wardrobe', quick: false, keywords: 'outfit today log clothes', run: () => openWardrobe({ date: localDayKey() }) },
    { id: 'add-clothing', label: 'Add clothing', icon: 'camera', quick: false, keywords: 'photo garment top bottom shirt', run: () => openWardrobe({ tab: 'clothes', add: true }) },
    { id: 'new-bill', label: 'New bill', icon: 'bills', quick: true, keywords: 'payment money', run: () => newTask({ bill: { kind: 'bill' }, recurrence: { freq: 'monthly' } }, { capture: false }) },
    { id: 'go-home', label: 'Home', icon: 'home', keywords: 'today dashboard', run: () => goView('home') },
    { id: 'go-week', label: 'Week', icon: 'review', keywords: 'review look back', run: () => { setHomeTab('week'); setView('home') } },
    { id: 'go-journal', label: 'Journal', icon: 'journal', keywords: 'diary write', run: () => openJournal(localDayKey()) },
    { id: 'go-wardrobe', label: 'Wardrobe', icon: 'wardrobe', keywords: 'clothes outfit closet wear', run: () => openWardrobe() },
    { id: 'go-tasks', label: 'Tasks', icon: 'tasks', keywords: 'list', run: () => { goTasksTab('list'); setView('tasks') } },
    { id: 'go-board', label: 'Board', icon: 'board', keywords: 'kanban columns', run: () => { goTasksTab('board'); setView('tasks') } },
    { id: 'go-bills', label: 'Bills', icon: 'bills', keywords: 'money payments', run: () => { goTasksTab('bills'); setView('tasks') } },
    { id: 'go-notes', label: 'Notes', icon: 'notes', keywords: 'notepad', run: () => { goTasksTab('notes'); setView('tasks') } },
    // on the mode last chosen, as a tab tap opens it, not one a day from People → Stats left for its visit
    { id: 'go-calendar', label: 'Calendar', icon: 'calendar', keywords: 'month week timeline', run: () => goView('calendar') },
    { id: 'go-people', label: 'People', icon: 'people', keywords: 'contacts', run: () => goPeople('people') },
    { id: 'go-places', label: 'Places', icon: 'people', keywords: 'restaurants venues', run: () => goPeople('places') },
    // a segment's figures, for this visit: the next tab tap opens the view last chosen
    { id: 'go-people-stats', label: 'People stats', icon: 'people', keywords: 'insights figures most seen often together streak podium catch up birthdays year', run: () => openStats('people') },
    { id: 'go-kitchen', label: 'Kitchen', icon: 'kitchen', keywords: 'meals recipes groceries', run: () => setView('kitchen') },
    { id: 'go-settings', label: 'Settings', icon: 'settings', keywords: 'preferences calendars reminders', run: () => setSettingsOpen(true) },
  ]
}
