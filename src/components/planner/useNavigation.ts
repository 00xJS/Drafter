import { startTransition, useState } from 'react'
import type { GarmentType, Recipe } from '../../types'
import type { ChatSide } from '../Chat'
import { readChatSeen, writeChatSeen } from '../../chat'
import {
  CAL_MODE_KEY,
  INNER_VIEW_KEYS,
  KEEP_TAB_KEY,
  STATS_TAB_KEY,
  TASKS_TAB_KEY,
  storedCalMode,
  storedInnerViews,
  storedKitchenTab,
  storedKeepTab,
  storedStatsTab,
  storedTasksTab,
  type CalendarMode,
  type HomeTab,
  type InnerView,
  type InnerViews,
  type KitchenTab,
  type KeepTab,
  type PeopleTab,
  type StatsTab,
  type TasksTab,
  type View,
  type WardrobeTab,
} from './routes'

/**
 * A way into Home → Wardrobe — the Today card's Pick… and Change, the palette
 * and its search, a link (?view=wardrobe-stats), a piece's worn days, the
 * Calendar, the Week review and Ask:
 * which view, which day, whether to open the piece sheet to add one (of a
 * type) or on one, and a saved outfit to put in the composer's rows. Consumed
 * once by the segment, like journalOpenDate, so no entry point pins it.
 */
export type WardrobeOpen = {
  tab?: WardrobeTab
  date?: string
  add?: GarmentType | true
  garmentId?: string
  outfitId?: string
  /** Open Outfit on this look of the day. */
  wearId?: string
  /** Start a new look on that day — the next change, not an edit of the latest. */
  another?: true
}

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
  const [calMode, showCalMode] = useState<CalendarMode>(storedCalMode)
  /** Move the Calendar's mode for this visit only. */
  const goCalMode = (mode: CalendarMode) => startTransition(() => showCalMode(mode))
  const [tasksTab, showTasksTab] = useState<TasksTab>(storedTasksTab)
  /** Move the Tasks segment for this visit only. */
  const goTasksTab = (tab: TasksTab) => startTransition(() => showTasksTab(tab))
  /** The project whose notepad the Notes segment is showing; null is the index
   *  of every project's notes. Not persisted: it is a place within a visit,
   *  not a preference, and a remembered pad would reopen on a project the
   *  person may have stopped thinking about. It is the only project selection
   *  left in the app — nothing filters the other views any more. */
  const [notesProjectId, setNotesProjectId] = useState<string | null>(null)
  const [keepTab, showKeepTab] = useState<KeepTab>(storedKeepTab)
  /** Move the Keep segment for this visit only. */
  const goKeepTab = (tab: KeepTab) => startTransition(() => showKeepTab(tab))
  /** People's and Places' List · Stats: each segment's own, as last chosen. */
  const [innerViews, showInnerViews] = useState<InnerViews>(storedInnerViews)
  /** Move a segment's List · Stats for this visit only. */
  const goInnerView = (tab: PeopleTab, v: InnerView) => startTransition(() => showInnerViews(cur => (cur[tab] === v ? cur : { ...cur, [tab]: v })))
  /** The Stats lens's segment, as last chosen on its own buttons; a link or the palette moves it for that visit alone. */
  const [statsTab, showStatsTab] = useState<StatsTab>(storedStatsTab)
  const goStatsTab = (tab: StatsTab) => startTransition(() => showStatsTab(tab))
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
  const setKeepTab = (tab: KeepTab) => {
    goKeepTab(tab)
    try {
      localStorage.setItem(KEEP_TAB_KEY, tab)
    } catch {
      /* ignore */
    }
  }
  /** …and the lens's nine — Overview · Tasks · Money · People · Places · Kitchen · Wardrobe · Habits · Journal: its own track, and nothing else. */
  const setStatsTab = (tab: StatsTab) => {
    goStatsTab(tab)
    try {
      localStorage.setItem(STATS_TAB_KEY, tab)
    } catch {
      /* ignore */
    }
  }
  /** …the Calendar's Month · Week · Day: its three buttons, and nothing else. */
  const setCalMode = (mode: CalendarMode) => {
    goCalMode(mode)
    try {
      localStorage.setItem(CAL_MODE_KEY, mode)
    } catch {
      /* ignore */
    }
  }
  /** …and each segment's List · Stats: its own switch, and nothing else. */
  const setInnerView = (tab: PeopleTab, v: InnerView) => {
    goInnerView(tab, v)
    try {
      localStorage.setItem(INNER_VIEW_KEYS[tab], v)
    } catch {
      /* ignore */
    }
  }
  /**
   * Go to a view from a tab bar. A tab tap is the one move that means "wherever
   * I left this", so the segmented views re-read the remembered half rather than
   * keeping whatever a link last set — except Home, which always opens on the day.
   * Kitchen keeps its segment itself, so it is handed the remembered one, as a
   * link hands it Stats: a tap on the tab after Kitchen stats goes back to it.
   */
  const goView = (v: View) => {
    if (v === 'home') setHomeTab('today')
    if (v === 'tasks') goTasksTab(storedTasksTab())
    if (v === 'calendar') goCalMode(storedCalMode())
    if (v === 'keep') {
      goKeepTab(storedKeepTab())
      startTransition(() => showInnerViews(storedInnerViews()))
      // the Kitchen keeps its own segment, so it is handed the remembered one
      // too — always, not only when the tap lands on it, or a one-shot from a
      // link would still be sitting there the next time you moved to it
      setKitchenOpen(storedKitchenTab())
    }
    if (v === 'insights') goStatsTab(storedStatsTab())
    setView(v)
  }
  /** The lens, on one of its segments (a link, the palette), for this visit only. */
  const openLens = (tab?: StatsTab) => {
    if (tab) goStatsTab(tab)
    setView('insights')
  }
  /**
   * Which half of Home → Chat is showing: the household's thread or the
   * assistant's. Remembered for the visit, not saved — landing on the
   * assistant when you meant to answer the person you live with is worse
   * than one extra tap (v3.26).
   */
  const [chatSide, setChatSide] = useState<ChatSide>('household')
  /**
   * The newest household message this DEVICE has shown you, for the badge on
   * Home's Chat button. Per device on purpose: a phone and a laptop each count
   * what they have not put in front of you, and a mark that synced would clear
   * the badge on the wrong screen.
   */
  const [chatSeenAt, setChatSeenAt] = useState(readChatSeen)
  const markChatSeen = (at: string) => {
    if (!at || at === chatSeenAt) return
    setChatSeenAt(at)
    writeChatSeen(at)
  }
  /** A journal day to open for editing (from search or a link); consumed by the view. */
  const [journalOpenDate, setJournalOpenDate] = useState<string | null>(null)
  /** A place row to expand (from search); consumed by the Places view. */
  const [placeOpenId, setPlaceOpenId] = useState<string | null>(null)
  const openPlace = (id?: string) => {
    if (id) setPlaceOpenId(id)
    goKeepTab('places')
    setView('keep')
    // the row it opens is on the list, whichever half the segment was left on
    if (id) goInnerView('places', 'list')
  }
  /** A person's card to open (from search, Ask or a reminder); consumed by the People view. */
  const [personOpenId, setPersonOpenId] = useState<string | null>(null)
  const openPerson = (id?: string) => {
    if (id) setPersonOpenId(id)
    goKeepTab('people')
    setView('keep')
    // the card it opens is on the list, whichever half the segment was left on
    if (id) goInnerView('people', 'list')
  }
  /**
   * "+ Add person" / "+ Add place", asked for on the List · Stats row and
   * consumed once by the view, exactly as personOpenId is. Held here rather
   * than on the tab so the tab holds no state of its own (the filters moved
   * out for the same reason), and so the palette and a link can reach the add
   * form too. Either one lands on the list: the form is over the rows.
   */
  const [addPerson, setAddPerson] = useState(false)
  const [addPlace, setAddPlace] = useState(false)
  const addAPerson = () => {
    setAddPerson(true)
    goKeepTab('people')
    setView('keep')
    goInnerView('people', 'list')
  }
  const addAPlace = () => {
    setAddPlace(true)
    goKeepTab('places')
    setView('keep')
    goInnerView('places', 'list')
  }
  /** A segment's Stats, for this visit only: a tab tap opens the view last chosen.
   *  Reached by ?view=people-stats and ?view=places-stats alone — the links that
   *  shipped before the lens. The palette's People stats and Places stats rows
   *  open the lens now, where every figure lives. */
  const openStats = (tab: PeopleTab) => {
    goKeepTab(tab)
    goInnerView(tab, 'stats')
    setView('keep')
  }
  const openJournal = (date?: string) => {
    if (date) setJournalOpenDate(date)
    setHomeTab('journal')
    setView('home')
  }
  /** A recipe for Kitchen to open (Today's "tonight's dinner"); consumed by the view. */
  const [kitchenRecipe, setKitchenRecipe] = useState<Recipe | null>(null)
  /** A Kitchen segment to open on (?view=kitchen-stats — the palette's Kitchen stats
   *  opens the lens now); consumed by the view, so the segment moves for this visit
   *  only and the one last chosen stays remembered. */
  const [kitchenOpen, setKitchenOpen] = useState<KitchenTab | null>(null)
  const openKitchen = (tab?: KitchenTab) => {
    // with no segment named, the one Kitchen remembers — which is what a tap
    // on the tab gives, and what the palette's Kitchen row has always given
    setKitchenOpen(tab ?? storedKitchenTab())
    goKeepTab('kitchen')
    setView('keep')
  }
  /** A day for This week to open on, framed (the dinner calendar in the Stats lens's Kitchen); consumed by the view, like the segment. */
  const [kitchenDay, setKitchenDay] = useState<string | null>(null)
  const openKitchenDay = (day: string) => {
    setKitchenDay(day)
    setKitchenOpen('week')
    goKeepTab('kitchen')
    setView('keep')
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
  /** Where to land in the wardrobe (the Today card, the palette's Add clothing and
   *  What am I wearing?, ?view=wardrobe-stats); consumed by the segment, which moves
   *  to it even when it is already on screen. The palette's Wardrobe stats row opens
   *  the lens instead. */
  const [wardrobeOpen, setWardrobeOpen] = useState<WardrobeOpen | null>(null)
  const openWardrobe = (o: WardrobeOpen = {}) => {
    setWardrobeOpen(o)
    goKeepTab('wardrobe')
    setView('keep')
  }
  /** A day for the Calendar to open, its day sheet up (the month calendar in People → Stats or Places → Stats); consumed by the view. */
  const [calendarOpenDay, setCalendarOpenDay] = useState<string | null>(null)
  const openCalendarDay = (day: string) => {
    setCalendarOpenDay(day)
    setView('calendar')
  }

  return {
    view,
    setView,
    calMode,
    goCalMode,
    setCalMode,
    tasksTab,
    goTasksTab,
    notesProjectId,
    setNotesProjectId,
    keepTab,
    goKeepTab,
    innerViews,
    goInnerView,
    setInnerView,
    openStats,
    statsTab,
    goStatsTab,
    setStatsTab,
    openLens,
    homeTab,
    setHomeTab,
    setTasksTab,
    setKeepTab,
    goView,
    chatSide,
    setChatSide,
    chatSeenAt,
    markChatSeen,
    journalOpenDate,
    setJournalOpenDate,
    placeOpenId,
    setPlaceOpenId,
    openPlace,
    personOpenId,
    setPersonOpenId,
    openPerson,
    addPerson,
    setAddPerson,
    addAPerson,
    addPlace,
    setAddPlace,
    addAPlace,
    openJournal,
    kitchenRecipe,
    setKitchenRecipe,
    kitchenOpen,
    setKitchenOpen,
    openKitchen,
    kitchenDay,
    setKitchenDay,
    openKitchenDay,
    noteOpenId,
    setNoteOpenId,
    openNote,
    wardrobeOpen,
    setWardrobeOpen,
    openWardrobe,
    calendarOpenDay,
    setCalendarOpenDay,
    openCalendarDay,
  }
}
