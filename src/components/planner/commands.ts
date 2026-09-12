import type { Command } from '../Search'
import type { Task } from '../../types'
import { localDayKey } from '../../journal'
import type { HomeTab, PeopleTab, TasksTab, View } from './routes'

/** The moves the palette makes (useNavigation's, or a stand-in in a test). */
export interface PaletteNav {
  goView(v: View): void
  setHomeTab(tab: HomeTab): void
  setView(v: View): void
  openJournal(date?: string): void
  goTasksTab(tab: TasksTab): void
  setPeopleTab(tab: PeopleTab): void
}

/** The editors and sheets the palette opens (useOverlays', or a stand-in). */
export interface PaletteOverlays {
  newTask(preset?: Partial<Task>, opts?: { capture?: boolean }): void
  newProject(): void
  setSettingsOpen(open: boolean): void
}

// The command palette's own rows: the things you can do and the places you can
// go, beside the search results. Navigation lands on the same segment a tab
// tap would; the actions open the same editors the toolbar buttons do.
export function buildPaletteCommands(nav: PaletteNav, overlays: PaletteOverlays): Command[] {
  const { goView, setHomeTab, setView, openJournal, goTasksTab, setPeopleTab } = nav
  const { newTask, newProject, setSettingsOpen } = overlays
  return [
    { id: 'new-task', label: 'New task', icon: 'plus', quick: true, keywords: 'add create', run: () => newTask() },
    // reachable by typing, not a quick action: templates and "draft a plan" still
    // need projects to exist, but adding one has come off the front door
    { id: 'new-project', label: 'New project', icon: 'plus', quick: false, keywords: 'add create', run: newProject },
    { id: 'new-bill', label: 'New bill', icon: 'bills', quick: true, keywords: 'payment money', run: () => newTask({ bill: { kind: 'bill' }, recurrence: { freq: 'monthly' } }, { capture: false }) },
    { id: 'go-home', label: 'Home', icon: 'home', keywords: 'today dashboard', run: () => goView('home') },
    { id: 'go-week', label: 'Week', icon: 'review', keywords: 'review look back', run: () => { setHomeTab('week'); setView('home') } },
    { id: 'go-journal', label: 'Journal', icon: 'journal', keywords: 'diary write', run: () => openJournal(localDayKey()) },
    { id: 'go-tasks', label: 'Tasks', icon: 'tasks', keywords: 'list', run: () => { goTasksTab('list'); setView('tasks') } },
    { id: 'go-board', label: 'Board', icon: 'board', keywords: 'kanban columns', run: () => { goTasksTab('board'); setView('tasks') } },
    { id: 'go-bills', label: 'Bills', icon: 'bills', keywords: 'money payments', run: () => { goTasksTab('bills'); setView('tasks') } },
    { id: 'go-notes', label: 'Notes', icon: 'notes', keywords: 'notepad', run: () => { goTasksTab('notes'); setView('tasks') } },
    { id: 'go-calendar', label: 'Calendar', icon: 'calendar', keywords: 'month week timeline', run: () => setView('calendar') },
    { id: 'go-people', label: 'People', icon: 'people', keywords: 'contacts', run: () => { setPeopleTab('people'); setView('people') } },
    { id: 'go-places', label: 'Places', icon: 'people', keywords: 'restaurants venues', run: () => { setPeopleTab('places'); setView('people') } },
    { id: 'go-kitchen', label: 'Kitchen', icon: 'kitchen', keywords: 'meals recipes groceries', run: () => setView('kitchen') },
    { id: 'go-settings', label: 'Settings', icon: 'settings', keywords: 'preferences calendars reminders', run: () => setSettingsOpen(true) },
  ]
}
