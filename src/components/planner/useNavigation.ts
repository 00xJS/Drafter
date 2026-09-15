import { startTransition, useEffect, useState } from 'react'
import type { GarmentType, Recipe } from '../../types'
import {
  CAL_MODE_KEY,
  CALENDAR_MODES,
  PEOPLE_TAB_KEY,
  TASKS_TAB_KEY,
  storedPeopleTab,
  storedTasksTab,
  type CalendarMode,
  type HomeTab,
  type KitchenTab,
  type PeopleTab,
  type TasksTab,
  type View,
  type WardrobeTab,
} from './routes'

/**
 * A way into Home → Wardrobe — the Today card's Pick… and Change, the palette
 * and its search, a piece's worn days, the Calendar, the Week review and Ask:
 * which view, which day, whether to open the piece sheet to add one (of a
 * type) or on one, and a saved outfit to put in the composer's rows. Consumed
 * once by the segment, like journalOpenDate, so no entry point pins it.
 */
export type WardrobeOpen = { tab?: WardrobeTab; date?: string; add?: GarmentType | true; garmentId?: string; outfitId?: string }

/**
 * Where the shell is: the tab, the segment inside each tab, and the one-shot
 * "open this" hand-offs (a journal day, a place row, a recipe) that a view
 * consumes when it mounts.
 *
 * Every move between tabs and segments is a transition: when the next view's
 * chunk has not arrived yet, React keeps the current screen up instead of
 * blanking it, and swaps once it can. Warmed chunks never suspend, so after
 * the first moments of a launch this changes nothing you can see.
 */
export function useNavigation() {
  const [view, showView] = useState<View>('home')
  const setView = (v: View) => startTransition(() => showView(v))
  const [calMode, showCalMode] = useState<CalendarMode>(() => {
    try {
      const saved = localStorage.getItem(CAL_MODE_KEY) as CalendarMode | null
      return saved && CALENDAR_MODES.includes(saved) ? saved : 'month'
    } catch {
      return 'month'
    }
  })
  const setCalMode = (mode: CalendarMode) => startTransition(() => showCalMode(mode))
  const [tasksTab, showTasksTab] = useState<TasksTab>(storedTasksTab)
  /** Move the Tasks segment for this visit only. */
  const goTasksTab = (tab: TasksTab) => startTransition(() => showTasksTab(tab))
  /** The project whose notepad the Notes segment is showing; null is the index
   *  of every project's notes. Not persisted: it is a place within a visit,
   *  not a preference, and a remembered pad would reopen on a project the
   *  person may have stopped thinking about. It is the only project selection
   *  left in the app — nothing filters the other views any more. */
  const [notesProjectId, setNotesProjectId] = useState<string | null>(null)
  const [peopleTab, showPeopleTab] = useState<PeopleTab>(storedPeopleTab)
  /** Move the People segment for this visit only. */
  const goPeopleTab = (tab: PeopleTab) => startTransition(() => showPeopleTab(tab))
  /** Home's segment. It is not persisted: tapping Home always returns to the
   *  day, the app's base surface; Week, Journal and Wardrobe are opt-in from there. */
  const [homeTab, showHomeTab] = useState<HomeTab>('today')
  const setHomeTab = (tab: HomeTab) => startTransition(() => showHomeTab(tab))
  /** Remember the choice: the segment buttons, and nothing else. */
  const setTasksTab = (tab: TasksTab) => {
    goTasksTab(tab)
    try {
      localStorage.setItem(TASKS_TAB_KEY, tab)
    } catch {
      /* ignore */
    }
  }
  const setPeopleTab = (tab: PeopleTab) => {
    goPeopleTab(tab)
    try {
      localStorage.setItem(PEOPLE_TAB_KEY, tab)
    } catch {
      /* ignore */
    }
  }
  /**
   * Go to a view from a tab bar. A tab tap is the one move that means "wherever
   * I left this", so the segmented views re-read the remembered half rather than
   * keeping whatever a link last set — except Home, which always opens on the day.
   */
  const goView = (v: View) => {
    if (v === 'home') setHomeTab('today')
    if (v === 'tasks') goTasksTab(storedTasksTab())
    if (v === 'people') goPeopleTab(storedPeopleTab())
    setView(v)
  }
  /** A journal day to open for editing (from search or a link); consumed by the view. */
  const [journalOpenDate, setJournalOpenDate] = useState<string | null>(null)
  /** A place row to expand (from search); consumed by the Places view. */
  const [placeOpenId, setPlaceOpenId] = useState<string | null>(null)
  const openPlace = (id?: string) => {
    if (id) setPlaceOpenId(id)
    goPeopleTab('places')
    setView('people')
  }
  /** A person's card to open (from search, Ask or a reminder); consumed by the People view. */
  const [personOpenId, setPersonOpenId] = useState<string | null>(null)
  const openPerson = (id?: string) => {
    if (id) setPersonOpenId(id)
    goPeopleTab('people')
    setView('people')
  }
  const openJournal = (date?: string) => {
    if (date) setJournalOpenDate(date)
    setHomeTab('journal')
    setView('home')
  }
  /** A recipe for Kitchen to open (Today's "tonight's dinner"); consumed by the view. */
  const [kitchenRecipe, setKitchenRecipe] = useState<Recipe | null>(null)
  /** A Kitchen segment to open on (the palette's Kitchen stats, ?view=kitchen-stats); consumed
   *  by the view, so the segment moves for this visit only and the one last chosen stays remembered. */
  const [kitchenOpen, setKitchenOpen] = useState<KitchenTab | null>(null)
  const openKitchen = (tab?: KitchenTab) => {
    if (tab) setKitchenOpen(tab)
    setView('kitchen')
  }
  /** A note for Tasks → Notes to open (the palette's search); consumed by the view. */
  const [noteOpenId, setNoteOpenId] = useState<string | null>(null)
  const openNote = (id: string) => {
    // a pad on screen wins over a note, so close it first
    setNotesProjectId(null)
    setNoteOpenId(id)
    goTasksTab('notes')
    setView('tasks')
  }
  /** Where to land in the wardrobe (the Today card, the palette); consumed by the segment. */
  const [wardrobeOpen, setWardrobeOpen] = useState<WardrobeOpen | null>(null)
  const openWardrobe = (o: WardrobeOpen = {}) => {
    setWardrobeOpen(o)
    setHomeTab('wardrobe')
    setView('home')
  }

  useEffect(() => {
    try {
      localStorage.setItem(CAL_MODE_KEY, calMode)
    } catch {
      /* ignore */
    }
  }, [calMode])

  return {
    view,
    setView,
    calMode,
    setCalMode,
    tasksTab,
    goTasksTab,
    notesProjectId,
    setNotesProjectId,
    peopleTab,
    goPeopleTab,
    homeTab,
    setHomeTab,
    setTasksTab,
    setPeopleTab,
    goView,
    journalOpenDate,
    setJournalOpenDate,
    placeOpenId,
    setPlaceOpenId,
    openPlace,
    personOpenId,
    setPersonOpenId,
    openPerson,
    openJournal,
    kitchenRecipe,
    setKitchenRecipe,
    kitchenOpen,
    setKitchenOpen,
    openKitchen,
    noteOpenId,
    setNoteOpenId,
    openNote,
    wardrobeOpen,
    setWardrobeOpen,
    openWardrobe,
  }
}
