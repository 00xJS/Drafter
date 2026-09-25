import type { Command } from '../Search'
import type { Task } from '../../types'
import { localDayKey } from '../../journal'
import { storedInnerView, type InnerView, type KeepTab, type KitchenTab, type PeopleTab, type StatsTab, type TasksTab, type View } from './routes'
import type { Sheet } from './useOverlays'
import type { WardrobeOpen } from './useNavigation'

/** The moves the palette makes (useNavigation's, or a stand-in in a test). */
export interface PaletteNav {
  goView(v: View): void
  setView(v: View): void
  openJournal(date?: string): void
  /** The week you just had — Insights' Review segment. */
  openReview(): void
  goTasksTab(tab: TasksTab): void
  setKeepTab(tab: KeepTab): void
  /** A segment of People's List · Stats, for this visit only. */
  goInnerView(tab: PeopleTab, v: InnerView): void
  openWardrobe(o?: WardrobeOpen): void
  /** Keep's Kitchen, on the segment it remembers. */
  openKitchen(tab?: KitchenTab): void
  /** Insights → Stats, on the page named for this visit only, or on its Highlights. Every "… stats" row lands here. */
  openLens(tab?: StatsTab): void
  /** Tasks → Finance with its Check in sheet up. */
  openFinanceCheckIn(): void
  /** Tasks → Finance with + Bill's sheet up. */
  openFinanceBill(): void
}

/** The editors and sheets the palette opens (useOverlays', or a stand-in). */
export interface PaletteOverlays {
  newTask(preset?: Partial<Task>, opts?: { capture?: boolean }): void
  setPushed(to: 'settings' | 'chat' | null): void
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
  const { goView, setView, openJournal, openReview, goTasksTab, setKeepTab, goInnerView, openWardrobe, openKitchen, openLens, openFinanceCheckIn, openFinanceBill } = nav
  const { newTask, setPushed, openSheet } = overlays
  const hour = now.getHours()
  /** People or Places — two of Keep's four — remembered as its button would,
   *  on the List or Stats last chosen there: a one-shot People stats or Places
   *  stats does not linger. */
  const goPeople = (tab: PeopleTab) => {
    setKeepTab(tab)
    goInnerView(tab, storedInnerView(tab))
    setView('keep')
  }
  return [
    { id: 'new-task', label: 'New task', icon: 'plus', quick: true, keywords: 'add create', run: () => newTask() },
    // the day's two routines open over wherever you are, as Settings does
    { id: 'plan-day', label: 'Plan my day', icon: 'today', quick: hour < PLAN_DAY_QUICK_UNTIL, keywords: 'morning focus today', run: () => openSheet({ kind: 'day' }) },
    { id: 'shut-down', label: 'Shut down', icon: 'journal', quick: hour >= SHUT_DOWN_QUICK_FROM, keywords: 'evening wrap close tomorrow', run: () => openSheet({ kind: 'shutdown' }) },
    // the week ahead, and a question about your own planner: typed for, not offered empty
    { id: 'plan-week', label: 'Plan next week', icon: 'review', quick: false, keywords: 'week ahead meals dinners catch up sunday', run: () => openSheet({ kind: 'week' }) },
    { id: 'ask', label: 'Ask Drafter', icon: 'search', quick: false, keywords: 'question answer ai assistant', run: () => openSheet({ kind: 'ask' }) },
    { id: 'im-here', label: "I'm here", icon: 'people', quick: false, keywords: 'nearby now outing visit log place with where', run: () => openSheet({ kind: 'imhere' }) },
    // today's look, and a piece to add: typed for too. A photo picker has to open
    // inside the tap itself, and the palette runs through a lazy chunk first, so
    // Add clothing lands on the sheet's big photo target rather than the picker.
    { id: 'log-wear', label: 'What am I wearing?', icon: 'wardrobe', quick: false, keywords: 'outfit today log clothes', run: () => openWardrobe({ date: localDayKey() }) },
    { id: 'add-clothing', label: 'Add clothing', icon: 'camera', quick: false, keywords: 'photo garment top bottom shirt', run: () => openWardrobe({ tab: 'clothes', add: true }) },
    // Finance's own + Bill, with its templates and the date it will not save without, as Check in balances opens Finance's Check in
    { id: 'new-bill', label: 'New bill', icon: 'bills', quick: true, keywords: 'payment money', run: () => openFinanceBill() },
    // what each account holds, typed in: typed for rather than offered, as the weekly check-in's own reminder offers it
    { id: 'check-in', label: 'Check in balances', icon: 'bills', quick: false, keywords: 'money accounts balance finance safe spend', run: () => openFinanceCheckIn() },
    { id: 'go-home', label: 'Home', icon: 'home', keywords: 'today dashboard', run: () => goView('home') },
    { id: 'go-week', label: 'Week', icon: 'review', keywords: 'review look back', run: () => openReview() },
    { id: 'go-journal', label: 'Journal', icon: 'journal', keywords: 'diary write', run: () => openJournal(localDayKey()) },
    { id: 'go-wardrobe', label: 'Wardrobe', icon: 'wardrobe', keywords: 'clothes outfit closet wear', run: () => openWardrobe() },
    { id: 'go-tasks', label: 'Tasks', icon: 'tasks', keywords: 'list', run: () => { goTasksTab('list'); setView('tasks') } },
    { id: 'go-board', label: 'Board', icon: 'board', keywords: 'kanban columns', run: () => { goTasksTab('board'); setView('tasks') } },
    { id: 'go-bills', label: 'Finance', icon: 'bills', keywords: 'money bills payments paydays accounts savings', run: () => { goTasksTab('bills'); setView('tasks') } },
    { id: 'go-notes', label: 'Notes', icon: 'notes', keywords: 'notepad', run: () => { goTasksTab('notes'); setView('tasks') } },
    // on the mode last chosen, as a tab tap opens it, not one a day from a Stats view left for its visit
    { id: 'go-calendar', label: 'Calendar', icon: 'calendar', keywords: 'month week day', run: () => goView('calendar') },
    { id: 'go-people', label: 'People', icon: 'people', keywords: 'contacts', run: () => goPeople('people') },
    { id: 'go-places', label: 'Places', icon: 'people', keywords: 'restaurants venues', run: () => goPeople('places') },
    // Every figure in the app lives in Insights → Stats, so every "… stats" row
    // lands there, on that area's page, for this visit only. The areas keep
    // their own Stats beside their lists — that is where you reach them while
    // you are narrowing one — and `?view=people-stats` and the other three
    // still go THERE, because a link already in a Shortcut or a reminder must
    // not quietly change where it lands.
    { id: 'go-people-stats', label: 'People stats', icon: 'stats', keywords: 'insights figures most seen often together streak podium catch up birthdays year', run: () => openLens('people') },
    { id: 'go-places-stats', label: 'Places stats', icon: 'stats', keywords: 'insights figures outings most visited where we go', run: () => openLens('places') },
    // where you last left it, as a tab tap opens it, not the Stats a Kitchen stats left for its visit
    { id: 'go-kitchen', label: 'Kitchen', icon: 'kitchen', keywords: 'meals recipes groceries', run: () => openKitchen() },
    { id: 'go-kitchen-stats', label: 'Kitchen stats', icon: 'stats', keywords: 'most cooked eaten out bought streak dinners insights figures', run: () => openLens('kitchen') },
    { id: 'go-wardrobe-stats', label: 'Wardrobe stats', icon: 'stats', keywords: 'most worn never worn cost per wear streak uniform photo calendar repeated outfits insights figures', run: () => openLens('wardrobe') },
    // the Highlights, as a tab tap opens them…
    { id: 'go-stats', label: 'Stats', icon: 'stats', keywords: 'figures insights highlights numbers charts overview trends how am i doing', run: () => goView('insights') },
    // …the year, which the Overview became…
    { id: 'go-year-stats', label: 'This year', icon: 'stats', keywords: 'year overview streaks heat grid days figures insights', run: () => openLens('year') },
    // …and the four areas whose figures live nowhere else
    { id: 'go-task-stats', label: 'Task stats', icon: 'stats', keywords: 'finished done throughput overdue by tag priority weekday streak figures', run: () => openLens('tasks') },
    { id: 'go-money-stats', label: 'Money stats', icon: 'stats', keywords: 'spending paid payee subscriptions budget outgoings figures', run: () => openLens('money') },
    { id: 'go-habit-stats', label: 'Habit stats', icon: 'stats', keywords: 'streaks kept consistency clean days figures', run: () => openLens('habits') },
    { id: 'go-journal-stats', label: 'Journal stats', icon: 'stats', keywords: 'mood words entries streak figures', run: () => openLens('journal') },
    { id: 'go-settings', label: 'Settings', icon: 'settings', keywords: 'preferences calendars reminders', run: () => setPushed('settings') },
  ]
}
