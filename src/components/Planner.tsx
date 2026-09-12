import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarEntry, CalendarEvent, Meal, PROJECT_COLORS, Person, Place, PlaceCategory, Project, Recipe, STATUS_META, Task, TaskStatus, WorkMode } from '../types'
import { conflictMessage, useItems } from '../store'
import { newerStamp, localMidnightIso, nextOccurrence } from '../itemops'
import { notifyDue } from '../notify'
import { getSupabase } from '../supabase'
import { clearLocalData } from '../idb'
import { projectById } from '../taskutils'
import { entryToEvent, isMirroredTask, pushEventToGoogle, pushEventToMicrosoft, GOOGLE_PUSH_ID, googlePushId, eventStartDate, prepDueFor, useCalendarEvents, useGooglePush, useMicrosoftSync } from '../calendars'
import { parseGithubUrl, setIssueState } from '../github'
import { ProjectPull, boardDateToDue, cancelQueuedPushes, projectSyncEnabled, queueProjectPush, useGithubProjectSync } from '../githubsync'
import { mealWrites } from '../kitchen'
import { useHousehold } from '../household'
import { fmtDateTime, timeAgo, uid } from '../utils'
import { buildCapturedTask, parseCapture, quickCaptureFields } from '../ai'
import { closeExternal, genericRemindersEnabled, haptic, initNative, isAppLockShowing, isNative, localRemindersEnabled, onAppLockCleared, scheduleLocalReminders, clearAppBadge } from '../native'
import { buildLocalReminders, deviceHasServerPush } from '../reminders'
import { fetchPushInfo } from '../push'
import { paramsOf, parseLink } from '../links'
import { appendEntry, entryOn, localDayKey } from '../journal'
import { Board } from './Board'
import { Calendar } from './Calendar'
import { Today } from './Today'
import { Roadmap } from './Roadmap'
import { TasksTable } from './TasksTable'
import { People } from './People'
import { Places } from './Places'
import { Kitchen } from './Kitchen'
import { Review } from './Review'
import { JournalView } from './Journal'
import { Search, type Command } from './Search'
import { AttendancePicker } from './AttendancePicker'
import { TaskEditor } from './TaskEditor'
import { ProjectEditor } from './ProjectEditor'
import { NotesView } from './NotesView'
import { Trash } from './Trash'
import { EventEditor } from './EventEditor'
import { Bills } from './Bills'
import { Settings } from './Settings'
import { Admin } from './Admin'
import { ErrorBoundary } from './ErrorBoundary'
import { Icon, type IconName } from './Icon'
import { PullToRefresh } from './PullToRefresh'
import { fetchAdminMe } from '../admin'
import { forgetRetiredKeys } from '../retiredkeys'

// Each tab that shows the same data more than one way holds those ways as
// segments instead of splitting into peer tabs: Home holds the day, the week
// and the journal; Tasks holds the list, board, bills and notes; People holds
// Places. Desktop and phone then land on the identical five nouns.
type View = 'home' | 'tasks' | 'calendar' | 'people' | 'kitchen'
const VIEWS: View[] = ['home', 'tasks', 'calendar', 'people', 'kitchen']
type CalendarMode = 'month' | 'week' | 'timeline'
const CALENDAR_MODES: CalendarMode[] = ['month', 'week', 'timeline']
type PeopleTab = 'people' | 'places'
/** Home's three time horizons: today's dashboard, the weekly look-back, the journal. */
type HomeTab = 'today' | 'week' | 'journal'
const HOME_TABS: { key: HomeTab; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Week' },
  { key: 'journal', label: 'Journal' },
]
/** The Tasks tab's four segments: the list, the board, the bills, the notes. */
type TasksTab = 'list' | 'board' | 'bills' | 'notes'
const TASKS_TABS: { key: TasksTab; label: string }[] = [
  { key: 'list', label: 'List' },
  { key: 'board', label: 'Board' },
  { key: 'bills', label: 'Bills' },
  { key: 'notes', label: 'Notes' },
]
/** Old inbound links (drafter://…?view=board|bills|notes) still resolve: they
 *  land on the Tasks tab with that segment open. */
const LEGACY_VIEW_TO_TASKS: Record<string, TasksTab> = { board: 'board', bills: 'bills', notes: 'notes' }
/** …and the former Today / Review views land on the matching Home segment. */
const LEGACY_VIEW_TO_HOME: Record<string, HomeTab> = { today: 'today', review: 'week' }

/** An inbound link, held as parsed pieces so a replay keeps its provenance. */
type PendingLink = { host: string; params: URLSearchParams; allowAct?: boolean }

const VIEW_LABELS: Record<View, string> = {
  home: 'Home',
  tasks: 'Tasks',
  calendar: 'Calendar',
  people: 'People',
  kitchen: 'Kitchen',
}

/** The line icon each view carries in the desktop tab strip. */
const VIEW_ICONS: Record<View, IconName> = {
  home: 'home',
  tasks: 'tasks',
  calendar: 'calendar',
  people: 'people',
  kitchen: 'kitchen',
}

/** Phone tab bar: the same five nouns as the desktop, no catch-all. Home carries
 *  the day, week and journal; Tasks the board, bills and notes. */
const COMPACT_TABS: { id: View; icon: IconName; label: string }[] = [
  { id: 'home', icon: 'home', label: 'Home' },
  { id: 'calendar', icon: 'calendar', label: 'Calendar' },
  { id: 'tasks', icon: 'tasks', label: 'Tasks' },
  { id: 'kitchen', icon: 'kitchen', label: 'Kitchen' },
  { id: 'people', icon: 'people', label: 'People' },
]

const CAL_MODE_KEY = 'drafter:calendar-mode'
const TASKS_TAB_KEY = 'drafter:tasks-tab'
const PEOPLE_TAB_KEY = 'drafter:people-tab'

interface Toast {
  msg: string
  undo?: () => void
  /** A confirm step instead of an undo: the button runs `run` (e.g. a web link asking to write into the journal). */
  action?: { label: string; run: () => void }
}

export default function Planner() {
  const household = useHousehold()
  const store = useItems(household.myId)
  const [view, setView] = useState<View>('home')
  const [calMode, setCalMode] = useState<CalendarMode>(() => {
    try {
      const saved = localStorage.getItem(CAL_MODE_KEY) as CalendarMode | null
      return saved && CALENDAR_MODES.includes(saved) ? saved : 'month'
    } catch {
      return 'month'
    }
  })
  // The two segmented views remember which half you chose — but only when you
  // chose it. Everything else (a deep link, a nudge, the More sheet) moves the
  // segment for that visit alone, so "Open review" cannot be hijacked by the
  // last time the journal was read, and the People tab cannot get pinned to
  // Places by one search result.
  const storedTasksTab = (): TasksTab => {
    try {
      const t = localStorage.getItem(TASKS_TAB_KEY)
      return t === 'board' || t === 'bills' || t === 'notes' ? t : 'list'
    } catch {
      return 'list'
    }
  }
  const storedPeopleTab = (): PeopleTab => {
    try {
      return localStorage.getItem(PEOPLE_TAB_KEY) === 'places' ? 'places' : 'people'
    } catch {
      return 'people'
    }
  }
  /** Move the Tasks segment for this visit only. */
  const [tasksTab, goTasksTab] = useState<TasksTab>(storedTasksTab)
  /** The project whose notepad the Notes segment is showing; null is the index
   *  of every project's notes. Not persisted: it is a place within a visit,
   *  not a preference, and a remembered pad would reopen on a project the
   *  person may have stopped thinking about. It is the only project selection
   *  left in the app — nothing filters the other views any more. */
  const [notesProjectId, setNotesProjectId] = useState<string | null>(null)
  /** Move the People segment for this visit only. */
  const [peopleTab, goPeopleTab] = useState<PeopleTab>(storedPeopleTab)
  /** Home's segment. It is not persisted: tapping Home always returns to the
   *  day, the app's base surface; Week and Journal are opt-in from there. */
  const [homeTab, setHomeTab] = useState<HomeTab>('today')
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
  const openJournal = (date?: string) => {
    if (date) setJournalOpenDate(date)
    setHomeTab('journal')
    setView('home')
  }
  const [editor, setEditor] = useState<{ task?: Task; preset?: Partial<Task>; capture?: boolean } | null>(null)
  const [projectEditor, setProjectEditor] = useState<{ project?: Project } | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [mineOnly, setMineOnly] = useState<boolean>(() => {
    try {
      return localStorage.getItem('drafter:mine-only') === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('drafter:mine-only', mineOnly ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [mineOnly])
  const inHousehold = !!household.info?.household && (household.info?.members.length ?? 0) > 1
  const [settingsOpen, setSettingsOpen] = useState(false)
  // bumped when a calendar consent flow returns, so an open Settings refetches
  const [settingsNonce, setSettingsNonce] = useState(0)
  const [adminOpen, setAdminOpen] = useState(false)
  const [isOwner, setIsOwner] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [kitchenRecipe, setKitchenRecipe] = useState<Recipe | null>(null)
  const [syncing, setSyncing] = useState(false)
  const toastTimer = useRef<number | undefined>(undefined)

  // the multi-project bar is gone; a filter a device saved before the update
  // must not silently hide tasks, so it is dropped rather than read
  useEffect(() => forgetRetiredKeys(), [])
  useEffect(() => {
    try {
      localStorage.setItem(CAL_MODE_KEY, calMode)
    } catch {
      /* ignore */
    }
  }, [calMode])

  const projectMap = useMemo(() => projectById(store.projects), [store.projects])
  const calendars = useCalendarEvents(store.calendars)
  /**
   * Feed occurrences and our own entries in one list, so the grids draw both
   * with the same code. Ours carry `localId`, which is what lets the day sheet
   * offer Edit on them and not on a read-only feed row.
   */
  const allEvents = useMemo(() => [...calendars.events, ...store.events.map(entryToEvent)], [calendars.events, store.events])
  const sourceMap = useMemo(() => new Map(store.calendars.map(c => [c.id, c])), [store.calendars])
  const myPushId = household.myId ? googlePushId(household.myId) : GOOGLE_PUSH_ID
  const mirroring = store.calendars.some(c => (c.id === myPushId || c.id === GOOGLE_PUSH_ID) && c.enabled)
  const msMirrorIds = useMemo(
    () => store.calendars.filter(c => c.enabled && c.url.startsWith('ms-push:')).map(c => c.url.slice('ms-push:'.length)),
    [store.calendars],
  )
  const googlePush = useGooglePush(
    store.allItems,
    store.projects,
    store.loaded && mirroring,
    changes => applyMirrorChanges(changes, 'Google Calendar'),
    household.myId,
  )

  // Cmd/Ctrl+K opens search from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(o => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Site-owner Admin entry: JWT email vs app_config.owner_email (server-side).
  useEffect(() => {
    const sb = getSupabase()
    if (!sb) return
    let cancelled = false
    const check = () => {
      fetchAdminMe()
        .then(r => {
          if (!cancelled) setIsOwner(!!r.isOwner)
        })
        .catch(() => {
          if (!cancelled) setIsOwner(false)
        })
    }
    sb.auth.getSession().then(({ data }) => {
      if (data.session) check()
    })
    const { data: sub } = sb.auth.onAuthStateChange((_event, session) => {
      if (session) check()
      else setIsOwner(false)
    })
    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
    }
  }, [])

  // Every way in, understood in one place: the PWA share target, ?new=, ?task=,
  // ?view=, a push tap, the drafter:// scheme, and the return from a calendar
  // consent screen. Anything that needs data waits for the store to load.
  const pendingLink = useRef<PendingLink | null>(null)
  // `fromNotification` is the only way an `act=` button is honoured: a reminder's
  // Done writes on arrival, so the web query string and the share target must not
  // be able to ask for it.
  const applyLink = (raw: string | URLSearchParams | PendingLink, hostHint = '', fromNotification = false) => {
    const src: PendingLink =
      raw instanceof URLSearchParams
        ? { host: hostHint, params: raw, allowAct: fromNotification }
        : typeof raw === 'object' && raw && 'params' in raw
          ? { allowAct: fromNotification, ...raw }
          : { ...paramsOf(typeof raw === 'string' ? raw : String(raw)), allowAct: fromNotification }
    const { host, params } = src
    const allowAct = !!src.allowAct
    const parsed = parseLink(params, { host, allowAct })
    if (parsed.oauth) {
      void closeExternal()
      const who = parsed.oauth.provider === 'microsoft' ? 'Outlook' : 'Google Calendar'
      showToast(
        parsed.oauth.ok
          ? `${who} connected — pick the calendars to show in Settings.`
          : `${who} could not be connected (${parsed.oauth.reason ?? 'unknown error'}).`,
      )
      setSettingsNonce(n => n + 1)
      setSettingsOpen(true)
      return
    }
    // Nothing below this line may run behind the lock card: a Done button that
    // fires while the overlay is up would write, toast, and time out unseen.
    if (!store.loaded || isAppLockShowing()) {
      pendingLink.current = { host, params, allowAct }
      return
    }
    if (parsed.view === 'admin') {
      setAdminOpen(true)
      return
    }
    // Every inbound link lands on the view it names. Views that became segments
    // still resolve: board / bills / notes open the Tasks tab on that segment,
    // and the former today / review views open Home on the day or the week.
    if (parsed.view && LEGACY_VIEW_TO_TASKS[parsed.view]) {
      goTasksTab(LEGACY_VIEW_TO_TASKS[parsed.view])
      setView('tasks')
    } else if (parsed.view && LEGACY_VIEW_TO_HOME[parsed.view]) {
      setHomeTab(LEGACY_VIEW_TO_HOME[parsed.view])
      setView('home')
    } else if (parsed.view && (VIEWS as string[]).includes(parsed.view)) {
      setView(parsed.view as View)
    }
    if (parsed.tab === 'journal') {
      // land on today's editor, not just the tab — this is the quick action's route
      openJournal(localDayKey())
    } else if (parsed.tab) {
      goPeopleTab(parsed.tab)
      setView('people')
    }
    if (parsed.journal) {
      // a line from a Shortcut / share lands in today's entry; nothing already written is touched
      const line = parsed.journal
      const write = () => {
        const today = localDayKey()
        const existing = entryOn(journalRef.current, today)
        const next = appendEntry(existing, today, line)
        store.upsert(next)
        showToast(
          'Added to today’s journal',
          existing ? () => store.upsert({ ...existing, updatedAt: newerStamp(next.updatedAt) }) : () => store.remove(next.id),
        )
      }
      // Nothing writes on arrival here. drafter://journal is the owner's own
      // Shortcut, but a page open in Safari can set location.href to the same
      // string and iOS's “Open in Drafter?” prompt says nothing about what is
      // being written — so the line is shown first and lands only on the button.
      // The Shortcut costs one tap; a web page cannot spend it.
      showToast(`Add to today’s journal: “${line.length > 80 ? line.slice(0, 79) + '…' : line}”`, undefined, { label: 'Add', run: write })
      openJournal()
      return
    }
    if (parsed.saw) {
      const person = store.people.find(p => p.id === parsed.saw)
      if (person) {
        const log = () => {
          const now = new Date().toISOString()
          const id = crypto.randomUUID()
          store.upsert({
            kind: 'task',
            id,
            title: `Saw ${person.name}`,
            description: '',
            status: 'done',
            priority: 'normal',
            completedAt: now,
            createdAt: now,
            updatedAt: now,
            tags: ['visit'],
            peopleIds: [person.id],
          })
          showToast(`Logged a visit with ${person.name}`, () => store.remove(id))
        }
        // Only the reminder's own “Saw them” button writes, the same way Done and
        // Tomorrow do below. Reading whose birthday it is — tapping the banner, or
        // any other producer of a ?saw= link — opens People and offers the write.
        if (parsed.act === 'saw') log()
        else showToast(`Log a visit with ${person.name}?`, undefined, { label: 'Saw them', run: log })
        goPeopleTab('people')
        setView('people')
      } else showToast('That person is not on this device yet.')
      return
    }
    if (parsed.task) {
      const t = store.tasks.find(x => x.id === parsed.task)
      if (!t) {
        showToast('That task is not on this device yet — it will appear after the next sync.')
        return
      }
      // Done / Tomorrow came from the reminder's own buttons: do the thing the
      // swipe would have done, and leave its undo toast on screen. A banner can
      // outlive the task it names (finished on another device), and both writes
      // go quiet in that case — so say so rather than open to nothing.
      if (parsed.act === 'done') {
        if (t.status === 'done') showToast('Already done.')
        else changeStatus(t.id, 'done')
      } else if (parsed.act === 'tomorrow') {
        if (t.status === 'done') showToast('Already done — nothing to move.')
        else {
          const tomorrow = new Date()
          tomorrow.setDate(tomorrow.getDate() + 1)
          defer(t.id, tomorrow)
        }
      } else setEditor({ task: t })
      return
    }
    if (parsed.place) {
      // "Been a while" reminders link here. Nothing is written on arrival: the
      // row opens on Places with its history and its Log an outing button.
      const place = store.places.find(p => p.id === parsed.place)
      if (place) openPlace(place.id)
      else showToast('That place is not on this device yet — it will appear after the next sync.')
      return
    }
    if (parsed.capture) {
      // through newTask, so the quick action and the + button file a new task
      // the same way
      newTask(
        {
          title: parsed.capture.title,
          description: parsed.capture.description ?? '',
          link: parsed.capture.link,
          status: 'todo',
          ...(parsed.capture.dueAt ? { dueAt: parsed.capture.dueAt } : {}),
        },
        { capture: !!(parsed.capture.title.trim() || parsed.capture.link || parsed.capture.description) },
      )
    }
  }
  const applyLinkRef = useRef(applyLink)
  applyLinkRef.current = applyLink
  // the deferred "Add" on a web ?journal= link must append to the entry as it is when pressed
  const journalRef = useRef(store.journal)
  journalRef.current = store.journal
  // the latest live tasks, for work that finishes after a later render (the
  // palette's capture enrichment must see an Undo that happened meanwhile)
  const tasksRef = useRef(store.tasks)
  tasksRef.current = store.tasks

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if ([...params.keys()].length) {
      applyLinkRef.current(params)
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])
  useEffect(() => {
    if (!store.loaded || !pendingLink.current) return
    const p = pendingLink.current
    pendingLink.current = null
    applyLinkRef.current(p)
  }, [store.loaded])
  // a link that arrived while the app was locked is replayed the moment it opens
  useEffect(
    () =>
      onAppLockCleared(() => {
        const p = pendingLink.current
        if (!p) return
        pendingLink.current = null
        applyLinkRef.current(p)
      }),
    [],
  )
  // the iOS shell: links, push taps, and a sync whenever the app comes forward
  useEffect(() => {
    // the effect can be torn down before initNative resolves (React's
    // development double-mount does exactly that), and a disposer assigned
    // after the cleanup ran would leave every listener subscribed twice
    let disposed = false
    let dispose: (() => void) | null = null
    void initNative({
      // only a tap on one of our own reminders may carry an `act=` that writes on
      // arrival; a drafter:// link from Safari or a Shortcut still just navigates
      onUrl: (url, fromNotif) => applyLinkRef.current(url, '', !!fromNotif),
      onResume: () => {
        void store.syncNowManual()
        remindersRef.current()
        void clearAppBadge()
      },
    }).then(d => {
      if (disposed) {
        d()
        return
      }
      dispose = d
      // resume does not fire at launch, so a cold start clears the badge here
      void clearAppBadge()
    })
    return () => {
      disposed = true
      dispose?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** A mirrored task moved (or was deleted) in an external calendar. */
  const applyMirrorChanges = (
    changes: { taskId: string; deleted: boolean; start: string | null; updated: string; allDay?: boolean }[],
    source: string,
  ) => {
    let moved = 0
    const undone: { id: string; status: TaskStatus }[] = []
    for (const c of changes) {
      const t = store.tasks.find(x => x.id === c.taskId)
      if (!t || c.updated <= t.updatedAt) continue
      if (c.deleted) {
        // A cancelled event for a task that is no longer mirrored is our OWN
        // delete echoing back, not the owner deleting it in the provider: the
        // mirror removes the event the moment a task leaves the open, dated set
        // (wishlist, due date cleared, done, canceled), and the pull then sees
        // that cancellation. Reading it as "deleted in Google, so done" marked a
        // task done seconds after it was moved to Wishlist. Same rule the server
        // uses to decide what to mirror (lib/google.mjs pushTask `wanted`).
        if (!isMirroredTask(t)) continue
        const change = store.setStatus(t.id, 'done')
        if (change) undone.push({ id: t.id, status: change.prev.status })
        continue
      }
      if (!c.start) continue
      const next = c.allDay
        ? localMidnightIso(/^\d{4}-\d{2}-\d{2}/.exec(c.start)?.[0] ?? c.start.slice(0, 10))
        : new Date(c.start).toISOString()
      if (!next || next === t.dueAt) continue
      // compare all-day by local date key so a 09:00 rewrite is ignored
      if (c.allDay && t.dueAt) {
        const localKey = (iso: string) => {
          const d = new Date(iso)
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        }
        if (localKey(t.dueAt) === next.slice(0, 10) || localKey(t.dueAt) === c.start.slice(0, 10)) continue
      }
      store.upsert({ ...t, dueAt: next, updatedAt: newerStamp(t.updatedAt) })
      moved++
    }
    if (moved) showToast(`${moved} task${moved === 1 ? '' : 's'} moved from ${source}`)
    if (undone.length)
      showToast(`${undone.length} task${undone.length === 1 ? '' : 's'} marked done from ${source}`, () => {
        for (const u of undone) store.setStatus(u.id, u.status)
      })
  }

  const microsoftSync = useMicrosoftSync(
    store.allItems,
    store.projects,
    store.loaded ? msMirrorIds : [],
    changes => applyMirrorChanges(changes, 'Outlook'),
    household.myId,
  )

  // Every view reads this, so the household's Mine / Everyone applies app-wide;
  // there is no project filter any more — the person is always on their one
  // home project, and every view gets the full set.
  const filteredTasks = useMemo(() => {
    if (mineOnly && inHousehold && household.myId) return store.tasks.filter(t => (t.assigneeId ? t.assigneeId === household.myId : t.ownerId === household.myId || !t.ownerId))
    return store.tasks
  }, [store.tasks, mineOnly, inHousehold, household.myId])

  /**
   * Planning a meal always writes its week's grocery list in the same round —
   * see mealWrites. Both the Kitchen tab and the calendar's day sheet go
   * through here so neither can forget it.
   */
  /**
   * A place created while planning a meal: somewhere you ate for the first time
   * gets tracked from the meal picker, instead of a detour to the Places tab.
   * Returns the row so the caller can attach it to the meal in the same tick.
   */
  const createPlaceInline = (name: string, category: PlaceCategory): Place => {
    const now = new Date().toISOString()
    const place: Place = {
      kind: 'place',
      id: uid(),
      name: name.trim(),
      category,
      color: PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)],
      createdAt: now,
      updatedAt: now,
    }
    store.upsert(place)
    return place
  }

  /** The Cook-side mirror of createPlaceInline: save a new dish from just its
   *  name while planning the meal; its ingredients and steps get filled in on
   *  the Kitchen tab later. */
  const createRecipeInline = (name: string): Recipe => {
    const now = new Date().toISOString()
    const recipe: Recipe = {
      kind: 'recipe',
      id: uid(),
      name: name.trim(),
      ingredients: [],
      tags: [],
      createdAt: now,
      updatedAt: now,
    }
    store.upsert(recipe)
    return recipe
  }

  /**
   * Pushes for one entry to one provider run one after another. Without this a
   * quick Undo raced its own delete: the revive's lookup still saw the live copy
   * and patched it, then the DELETE landed, and the provider lost an entry that
   * Drafter still showed. Different entries and providers still run in parallel.
   */
  const mirrorChain = useRef(new Map<string, Promise<unknown>>())
  const enqueueMirror = (key: string, run: () => Promise<unknown>) => {
    const chain = mirrorChain.current
    const tail = (chain.get(key) ?? Promise.resolve()).catch(() => {}).then(run)
    chain.set(key, tail)
    void tail
      .finally(() => {
        if (chain.get(key) === tail) chain.delete(key)
      })
      .catch(() => {})
    return tail
  }

  /** Which event the editor is on: an existing entry, or a new one at this instant. */
  const [eventEditor, setEventEditor] = useState<{ entry?: CalendarEntry; startIso: string; work?: WorkMode } | null>(null)

  /**
   * Write an entry through to every connected mirror: Google when its mirror is
   * on, and EACH enabled Microsoft account — the same fan-out task mirroring
   * uses. Best effort: the row is already saved locally, so a failed mirror
   * costs the copy in the provider, never the entry itself.
   */
  const mirrorEvent = (e: CalendarEntry, opts: { revive?: boolean } = {}) => {
    if (mirroring) void enqueueMirror(`google:${e.id}`, () => pushEventToGoogle(e, opts)).catch(() => {})
    for (const accountId of msMirrorIds) void enqueueMirror(`ms:${accountId}:${e.id}`, () => pushEventToMicrosoft(e, accountId)).catch(() => {})
  }
  /** The same fan-out, awaited, so a run of entries can be fed to the mirrors one at a time. */
  const mirrorEventNow = (e: CalendarEntry) =>
    Promise.allSettled([
      ...(mirroring ? [enqueueMirror(`google:${e.id}`, () => pushEventToGoogle(e))] : []),
      ...msMirrorIds.map(accountId => enqueueMirror(`ms:${accountId}:${e.id}`, () => pushEventToMicrosoft(e, accountId))),
    ]).then(() => undefined)
  /**
   * Save one entry, or a run of repeated work days. Every row lands locally at
   * once; a run is fed to the mirrors one entry at a time, so a dozen work days
   * do not fire two dozen provider calls in the same instant and trip limits.
   */
  const saveEvents = (entries: CalendarEntry[]) => {
    for (const e of entries) store.upsert(e)
    if (entries.length === 1) {
      mirrorEvent(entries[0])
      return
    }
    void (async () => {
      for (const e of entries) await mirrorEventNow(e)
    })()
    showToast(`${entries.length} work days added`)
  }
  const deleteEvent = (id: string) => {
    const gone = store.events.find(e => e.id === id)
    store.remove(id)
    if (gone) mirrorEvent({ ...gone, deletedAt: new Date().toISOString() })
    showToast('Event deleted', () => {
      store.restore([id])
      // Undo has to put it back on the mirrors too, or it lives only in Drafter
      if (gone) mirrorEvent(gone, { revive: true })
    })
  }

  const saveMeal = (m: Meal) => {
    for (const row of mealWrites(m, null, store.meals, store.recipes, store.groceries)) store.upsert(row)
  }
  const clearMeal = (id: string) => {
    for (const row of mealWrites(null, id, store.meals, store.recipes, store.groceries)) store.upsert(row)
    store.remove(id)
  }

  const showToast = (msg: string, undo?: () => void, action?: Toast['action']) => {
    window.clearTimeout(toastTimer.current)
    setToast({ msg, undo, action })
    toastTimer.current = window.setTimeout(() => setToast(null), action ? 15000 : 6000)
  }
  // A local edit that lost a field to another device's edit of the same field:
  // say so, and offer it back — Keep mine writes this device's values again.
  useEffect(
    () => store.onConflict(found => showToast(conflictMessage(found), undefined, { label: 'Keep mine', run: () => store.keepMine(found) })),
    // the engine's own functions, stable for the life of the page
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // due reminders while the app is open (device-local, never a store write)
  const notifyRef = useRef(() => {})
  notifyRef.current = () => {
    notifyDue(store.tasks)
  }
  useEffect(() => {
    notifyRef.current()
    const t = window.setInterval(() => notifyRef.current(), 30_000)
    return () => window.clearInterval(t)
  }, [])

  // iOS: the phone itself fires a notification at each due time and on occasion
  // mornings — no server involved, so it works with no account and the app closed
  const remindersRef = useRef(() => {})
  remindersRef.current = () => {
    if (!isNative() || !localRemindersEnabled()) return
    void (async () => {
      let skipTaskDue = false
      try {
        const info = await fetchPushInfo()
        skipTaskDue = await deviceHasServerPush(info.subscriptions ?? [])
      } catch {
        /* offline / unsigned — keep local due reminders */
      }
      await scheduleLocalReminders(buildLocalReminders(store.tasks, store.people, store.places, new Date(), 30, { skipTaskDue, generic: genericRemindersEnabled() }))
    })()
  }
  useEffect(() => {
    if (!store.loaded) return
    const t = window.setTimeout(() => remindersRef.current(), 1500)
    return () => window.clearTimeout(t)
  }, [store.loaded, store.tasks, store.people, store.places])

  const openTask = (task: Task) => setEditor({ task })
  const newTask = (preset?: Partial<Task>, opts?: { capture?: boolean }) =>
    setEditor({
      preset,
      capture: opts?.capture ?? !!(preset?.title || preset?.link),
    })
  const openProject = (project: Project) => setProjectEditor({ project })
  /**
   * Shift+Enter in the palette: file the line as a task now, no editor. The
   * offline parse lands at once (a keystroke must not wait on /api/ai); the
   * model's fuller reading is merged in afterwards, but only while the task is
   * still there and untouched — never over an Undo or an edit. The first toast
   * said where it went, so a merge that moves it (a project, a date) says so
   * again with its own undo, and a date the toast already announced is kept —
   * the model may add to the task, not contradict what was read out. Bypasses
   * newTask on purpose: a capture lands exactly as typed, with no preset of its own.
   */
  const captureTask = (line: string) => {
    const now = new Date()
    const id = uid()
    const lookup = { projects: store.projects, people: store.people }
    const first = buildCapturedTask(quickCaptureFields(line, now), lookup, { id, now })
    store.upsert(first)
    // Today's Inbox holds only what has neither a project nor a date
    const inbox = !first.projectId && !first.dueAt
    showToast(inbox ? 'Captured to Inbox' : `Captured — due ${fmtDateTime(first.dueAt)}`, () => store.remove(id))
    void parseCapture(line, {
      now,
      projectNames: store.projects.filter(p => p.status === 'active').map(p => p.name),
      personNames: store.people.map(p => p.name),
    })
      .then(parsed => {
        const cur = tasksRef.current.find(t => t.id === id)
        if (!cur || cur.updatedAt !== first.updatedAt) return
        const next = buildCapturedTask(parsed, lookup, { id, now })
        if (first.dueAt) next.dueAt = first.dueAt
        if (JSON.stringify(next) === JSON.stringify(first)) return
        const merged = { ...cur, ...next, createdAt: cur.createdAt, updatedAt: newerStamp(cur.updatedAt) }
        store.upsert(merged)
        const filed = !first.projectId && merged.projectId ? lookup.projects.find(p => p.id === merged.projectId)?.name : undefined
        const dated = !first.dueAt && merged.dueAt ? fmtDateTime(merged.dueAt) : undefined
        if (filed || dated) {
          const msg = filed && dated ? `Filed under ${filed} — due ${dated}` : filed ? `Filed under ${filed}` : `Due ${dated}`
          showToast(msg, () => store.upsert({ ...first, updatedAt: newerStamp(merged.updatedAt) }))
        }
      })
      .catch(() => {
        /* offline / no key — the offline parse already landed */
      })
  }
  /** One-tap "Saw them" with undo — used from Today, Search, and ?saw=. */
  const sawThem = (person: Person) => {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    store.upsert({
      kind: 'task',
      id,
      title: `Saw ${person.name}`,
      description: '',
      status: 'done',
      priority: 'normal',
      completedAt: now,
      createdAt: now,
      updatedAt: now,
      tags: ['visit'],
      peopleIds: [person.id],
    })
    showToast(`Logged a visit with ${person.name}`, () => store.remove(id))
  }
  /** A done task dated at the outing is what "seeing someone / going somewhere" is made of. Returns the task id. */
  const logOuting = (o: { at: string; title: string; peopleIds?: string[]; placeId?: string; description?: string }): string => {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    store.upsert({
      kind: 'task',
      id,
      title: o.title,
      description: o.description ?? '',
      status: 'done',
      priority: 'normal',
      completedAt: o.at,
      createdAt: now,
      updatedAt: now,
      tags: ['visit'],
      peopleIds: o.peopleIds?.length ? o.peopleIds : undefined,
      placeId: o.placeId,
    })
    const who = (o.peopleIds ?? []).map(id => store.people.find(p => p.id === id)?.name).filter(Boolean)
    const where = o.placeId ? store.places.find(p => p.id === o.placeId)?.name : undefined
    const bits = [where, who.length ? `with ${who.join(', ')}` : ''].filter(Boolean)
    showToast(bits.length ? `Logged ${bits.join(' ')}` : `Logged “${o.title}”`, () => store.remove(id))
    return id
  }
  /** One-tap "Went there" from Today's cadence nudge — logged now, undo in the toast. */
  const wentTo = (place: Place) => logOuting({ at: new Date().toISOString(), title: `Went to ${place.name}`, placeId: place.id })
  const logVisit = (person: Person, atIso: string, note: string, placeId?: string) => {
    const placeName = placeId ? store.places.find(p => p.id === placeId)?.name : undefined
    logOuting({
      at: atIso,
      title: note || (placeName ? `${person.name} at ${placeName}` : `Saw ${person.name}`),
      peopleIds: [person.id],
      placeId,
    })
  }
  const planOccasion = (person: Person, kind: 'birthday' | 'anniversary', at: Date) => {
    const due = new Date(at.getFullYear(), at.getMonth(), at.getDate() - 5, 9, 0, 0)
    newTask({
      title: `Gift for ${person.name}'s ${kind}`,
      status: 'todo',
      priority: 'high',
      dueAt: (due.getTime() > Date.now() ? due : new Date(Date.now() + 3_600_000)).toISOString(),
      peopleIds: [person.id],
      tags: ['gift', kind],
      notes: person.notes ? `Ideas from their notes: ${person.notes}` : undefined,
    })
  }
  const [attendance, setAttendance] = useState<CalendarEvent | null>(null)
  const logAttendance = (ev: CalendarEvent, peopleIds: string[], placeId?: string) => {
    if (peopleIds.length === 0 && !placeId) return
    const at = ev.allDay ? new Date(`${ev.start}T12:00`).toISOString() : new Date(ev.start).toISOString()
    logOuting({
      at,
      title: ev.title,
      // the place carries the where; free text only when no place was chosen
      description: ev.location && !placeId ? `At ${ev.location}` : '',
      peopleIds,
      placeId,
    })
  }
  const planWith = (person: Person, title?: string) => newTask({ title: title ?? `Catch up with ${person.name}`, status: 'todo', peopleIds: [person.id], tags: ['visit'] })
  const planAt = (place: Place) => newTask({ title: `Go to ${place.name}`, status: 'todo', placeId: place.id, tags: ['visit'] })
  /** Turn an external event into a prep task due the morning before. */
  const planForEvent = (ev: CalendarEvent) => {
    const when = eventStartDate(ev).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
    newTask({
      title: `Prep: ${ev.title}`,
      status: 'todo',
      dueAt: prepDueFor(ev),
      notes: `For “${ev.title}” on ${when}${ev.location ? ` · ${ev.location}` : ''}`,
    })
  }
  const newProject = () => setProjectEditor({})

  const deleteTask = (t: Task) => {
    store.remove(t.id)
    setEditor(null)
    showToast(`Deleted “${t.title || 'Untitled'}”`, () => store.restore([t.id]))
  }

  const deleteProject = (p: Project) => {
    const count = store.tasks.filter(t => t.projectId === p.id).length
    if (count > 0 && !window.confirm(`Delete “${p.name}”? Its ${count} task${count === 1 ? '' : 's'} stay, unassigned.`)) return
    store.remove(p.id)
    setProjectEditor(null)
    // a deleted project's notepad closes back to the index
    setNotesProjectId(cur => (cur === p.id ? null : cur))
    showToast(`Deleted project “${p.name}”`, () => store.restore([p.id]))
  }

  /** Done in Drafter closes the linked GitHub issue (when the host can write). Quiet on failure. */
  const closeLinkedIssue = (t: Task) => {
    const ref = parseGithubUrl(t.githubUrl)
    if (ref?.type === 'issue') setIssueState(t.githubUrl!, 'close').then(() => showToast(`Closed ${ref.owner}/${ref.repo}#${ref.number} on GitHub`)).catch(() => {})
  }

  /**
   * Mirror a task onto its project's GitHub Projects board (column, and the due
   * date when it moved). Debounced per task so a drag across the board is one
   * mutation, and silent on failure like closeLinkedIssue: GitHub being down
   * must never block a local edit.
   */
  const pushToProjectBoard = (t: Task | undefined) => {
    if (!t?.githubUrl || !t.projectId) return
    queueProjectPush(t, store.projects.find(p => p.id === t.projectId))
  }

  /** The board moved a card: apply it here, newest edit wins, undo in the toast. */
  const applyProjectPulls = (changes: ProjectPull[]) => {
    const undo: { prev: Task; spawnedId?: string }[] = []
    for (const c of changes) {
      const t = store.tasks.find(x => x.id === c.taskId)
      if (!t) continue
      // the reconciler compared the row against the task as it stood when that
      // board was fetched; boards are read one after another, so re-check the
      // stamp here or an edit made during a later fetch loses to an older row
      if (!(Date.parse(c.boardUpdatedAt) > Date.parse(t.updatedAt))) continue
      const next: Task = { ...t }
      if (c.status) next.status = c.status
      if (c.dueDate) next.dueAt = boardDateToDue(c.dueDate, t.dueAt) ?? next.dueAt
      if (next.status === t.status && next.dueAt === t.dueAt) continue
      if (next.status === 'done' && t.status !== 'done') next.completedAt = next.completedAt ?? new Date().toISOString()
      if (next.status !== 'done') next.completedAt = undefined
      const stamped: Task = { ...next, updatedAt: newerStamp(t.updatedAt) }
      // upsert spawns the next occurrence when a recurring task crosses into
      // done, exactly as setStatus does; the id is deterministic, so this is
      // the copy the undo has to take back out again
      const spawnedId = stamped.status === 'done' && t.status !== 'done' && stamped.recurrence ? nextOccurrence(stamped, uid)?.id : undefined
      undo.push({ prev: t, spawnedId })
      store.upsert(stamped)
    }
    if (undo.length === 0) return
    const first = changes.find(c => c.taskId === undo[0].prev.id)
    const what = undo.length === 1 ? `“${undo[0].prev.title || 'Untitled'}”${first?.columnName ? ` → ${first.columnName}` : ''}` : `${undo.length} tasks`
    showToast(`${what} moved from the GitHub board`, () => {
      // undo puts the board back too, or GitHub would keep proposing the move
      for (const u of undo) {
        const restored = { ...u.prev, updatedAt: newerStamp(u.prev.updatedAt) }
        store.upsert(restored)
        pushToProjectBoard(restored)
        if (u.spawnedId) store.remove(u.spawnedId)
      }
    })
  }

  useGithubProjectSync(store.projects, store.tasks, store.loaded && store.projects.some(projectSyncEnabled), applyProjectPulls, msg => showToast(msg))

  // a queued board write outlives the edit that made it by a couple of seconds:
  // drop the pending ones when the planner goes away (sign-out, unmount)
  useEffect(() => cancelQueuedPushes, [])

  const changeStatus = (id: string, status: TaskStatus) => {
    const change = store.setStatus(id, status)
    if (!change) return
    if (status === 'done' && change.prev.status !== 'done') closeLinkedIssue(change.prev)
    // the stored task, not `prev` with a status on it: the board's freshness
    // guard drops a push whose stamp the row already sits after, so pushing the
    // pre-edit stamp would let the first push through and silently swallow
    // every one after it
    pushToProjectBoard(change.next)
    showToast(`Moved to ${STATUS_META[status].label}`, () => {
      // the undo goes to the board too: it supersedes the queued push (same
      // task id, so the timer is replaced), and without it GitHub would keep
      // proposing the move the user just took back
      const restored = { ...change.prev, updatedAt: newerStamp(change.prev.updatedAt) }
      store.upsert(restored)
      pushToProjectBoard(restored)
      if (change.spawnedId) store.remove(change.spawnedId)
    })
  }

  const reschedule = (id: string, day: Date) => {
    const t = store.tasks.find(x => x.id === id)
    if (!t || t.status === 'done') return null
    const prev = { ...t }
    const old = t.dueAt ? new Date(t.dueAt) : null
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), old?.getHours() ?? 9, old?.getMinutes() ?? 0)
    const next: Task = {
      ...t,
      status: t.status === 'wishlist' || t.status === 'canceled' ? 'todo' : t.status,
      dueAt: at.toISOString(),
      updatedAt: newerStamp(t.updatedAt),
    }
    store.upsert(next)
    pushToProjectBoard(next)
    return prev
  }

  const defer = (id: string, day: Date) => {
    const prev = reschedule(id, day)
    if (!prev) return
    const label = day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    // deferring is the one daily gesture with no other confirmation you can feel
    void haptic('light')
    showToast(`Moved to ${label}`, () => {
      const restored = { ...prev, updatedAt: newerStamp(prev.updatedAt) }
      store.upsert(restored)
      pushToProjectBoard(restored)
    })
  }

  const deferAll = (ids: string[], day: Date) => {
    const undos: Task[] = []
    for (const id of ids) {
      const prev = reschedule(id, day)
      if (prev) undos.push(prev)
    }
    if (!undos.length) return
    const label = day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    void haptic('light')
    showToast(`Moved ${undos.length} to ${label}`, () => {
      for (const p of undos) {
        const restored = { ...p, updatedAt: newerStamp(p.updatedAt) }
        store.upsert(restored)
        pushToProjectBoard(restored)
      }
    })
  }

  /**
   * One refresh for both the header pill and the pull-down: the set that runs
   * when the app comes back to the foreground — the items sync, the calendar
   * feeds, and what moved in Google or Outlook. allSettled so one failing feed
   * cannot stop the items sync; each piece reports its own error in its own
   * place. The GitHub board pull and the weather card refresh themselves on
   * foreground and are left to their own timers here.
   */
  const manualSync = async () => {
    setSyncing(true)
    try {
      await Promise.allSettled([store.syncNowManual(), calendars.refresh(), googlePush.pullNow(), microsoftSync.pullNow()])
    } finally {
      setSyncing(false)
    }
  }

  // a map lookup so an id whose project was deleted degrades to the index
  const notesProject = notesProjectId ? projectMap.get(notesProjectId) : undefined

  // The command palette's own rows: the things you can do and the places you can
  // go, beside the search results. Navigation lands on the same segment a tab
  // tap would; the actions open the same editors the toolbar buttons do.
  const paletteCommands: Command[] = [
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

  return (
    <div className="app">
      <header className="topbar">
        {/* the phone hides the wordmark span for width (see styles.css), so the
            name lives on the container and the glyph is decorative — otherwise
            VoiceOver announces the header as "airplane". */}
        <div className="brand" aria-label="Drafter">
          <span className="brand-mark" aria-hidden>
            <Icon name="brand" filled strokeWidth={0} />
          </span>
          <span>Drafter</span>
        </div>
        <nav className="tabs tabs-full" aria-label="Views">
          {(Object.keys(VIEW_LABELS) as View[]).map(v => (
            <button key={v} className={view === v ? 'tab active' : 'tab'} onClick={() => goView(v)}>
              <span className="tab-icon" aria-hidden>
                <Icon name={VIEW_ICONS[v]} />
              </span>
              {VIEW_LABELS[v]}
            </button>
          ))}
        </nav>
        <nav className="tabs tabs-compact" aria-label="Main">
          {COMPACT_TABS.map(t => {
            const active = view === t.id
            return (
              <button
                key={t.id}
                type="button"
                className={active ? 'tab active' : 'tab'}
                aria-current={active ? 'page' : undefined}
                onClick={() => goView(t.id)}
              >
                <span className="tab-icon" aria-hidden>
                  <Icon name={t.icon} />
                </span>
                <span className="tab-label">{t.label}</span>
              </button>
            )
          })}
        </nav>
        <span className="spacer" />
        <button className="sync-btn" onClick={manualSync} aria-label={store.syncInfo.online ? 'Synced — tap to sync now' : 'Offline — tap to retry'}>
          <span className={store.syncInfo.online ? 'sync-dot on' : 'sync-dot'} />
          <span className="sync-label">
            {syncing ? 'Syncing…' : store.syncInfo.pending ? `${store.syncInfo.pending} unsynced` : store.syncInfo.lastAt ? timeAgo(store.syncInfo.lastAt).replace(' ago', '') : 'sync'}
          </span>
        </button>
        <button className="btn subtle icon-btn" aria-label="Search (Cmd/Ctrl+K)" title="Search (Cmd/Ctrl+K)" onClick={() => setSearchOpen(true)}>
          <Icon name="search" size={19} />
        </button>
        <button className="btn subtle icon-btn" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
          <Icon name="settings" size={19} />
        </button>
        {/* hidden below 640px (it pushed "+ New task" off a 375pt header) —
            the phone route is the Admin row in Settings ▸ Data */}
        {isOwner && (
          <button className="btn subtle admin-btn" aria-label="Admin" title="Admin" onClick={() => setAdminOpen(true)}>
            Admin
          </button>
        )}
        <button className="btn primary new-post-btn" onClick={() => newTask()} aria-label="New task" title="New task">
          <span className="new-post-plus" aria-hidden>
            <Icon name="plus" size={18} strokeWidth={2.2} />
          </span>
          <span className="new-post-label">New task</span>
        </button>
      </header>

      {store.syncInfo.authError && (
        <div className="auth-banner">
          Your session expired — changes are staying on this device only.
          <button
            className="btn"
            onClick={async () => {
              await getSupabase()?.auth.signOut()
              await clearLocalData()
              window.location.reload()
            }}
          >
            Sign in again
          </button>
        </div>
      )}

      {/* iOS: drag down from the top of a tab to refresh — the same set the
          foreground resume runs. Off while an editor or sheet owns the screen;
          the day sheet lives inside main and is refused by the touch target. */}
      <PullToRefresh enabled={!editor && !projectEditor && !eventEditor && !attendance && !searchOpen && !settingsOpen && !trashOpen && !adminOpen} onRefresh={manualSync} />

      <main className="content">
        {store.loaded && (
          <ErrorBoundary where={VIEW_LABELS[view]} resetKey={view}>
            {/* Mine is remembered across launches and the switch lives on Tasks,
                so a Home or Calendar that opens already narrowed says so — and
                offers the way off — rather than quietly hiding the others' tasks */}
            {inHousehold && mineOnly && (view === 'home' || view === 'calendar') && (
              <button type="button" className="mine-note" onClick={() => setMineOnly(false)}>
                Showing only your tasks · Show everyone
              </button>
            )}
            {view === 'home' && (
              <>
                {/* one Home across three time horizons: the day, the week’s
                    look-back, and the journal — Today’s dashboard is the base */}
                <div className="people-tab-seg home-seg" role="tablist" aria-label="Home view">
                  <span className="segmented">
                    {HOME_TABS.map(t => (
                      <button
                        key={t.key}
                        type="button"
                        role="tab"
                        aria-selected={homeTab === t.key}
                        className={homeTab === t.key ? 'seg on' : 'seg'}
                        onClick={() => {
                          setHomeTab(t.key)
                          // the journal opens on today’s line, not the list above it
                          if (t.key === 'journal') setJournalOpenDate(localDayKey())
                        }}
                      >
                        {t.label}
                      </button>
                    ))}
                  </span>
                </div>
                {homeTab === 'today' && (
                  <Today
                    tasks={filteredTasks}
                    allTasks={store.tasks}
                    people={store.people}
                    places={store.places}
                    reviews={store.reviews}
                    onPlanWith={planWith}
                    onWentTo={wentTo}
                    onPlanAt={planAt}
                    onPlanOccasion={planOccasion}
                    onSaw={sawThem}
                    onSaveReview={r => store.upsert(r)}
                    projects={store.projects}
                    projectMap={projectMap}
                    events={allEvents}
                    sourceMap={sourceMap}
                    onPlan={planForEvent}
                    onOpen={openTask}
                    onOpenProject={openProject}
                    onNewProject={newProject}
                    onStatus={changeStatus}
                    onDefer={defer}
                    onDeferAll={deferAll}
                    onNew={newTask}
                    meals={store.meals}
                    recipes={store.recipes}
                    onOpenKitchen={() => setView('kitchen')}
                    onOpenReview={() => setHomeTab('week')}
                    onCookRecipe={r => {
                      setKitchenRecipe(r)
                      setView('kitchen')
                    }}
                    journal={store.journal}
                    onSaveJournal={e => store.upsert(e)}
                    onDeleteJournal={id => {
                      store.remove(id)
                      showToast('Journal entry removed', () => store.restore([id]))
                    }}
                    onOpenJournal={() => openJournal(localDayKey())}
                    name={household.info?.me.displayName ?? undefined}
                    habits={store.habits}
                    onSaveHabit={h => store.upsert(h)}
                    onDeleteHabit={id => {
                      store.remove(id)
                      showToast('Habit removed', () => store.restore([id]))
                    }}
                    routines={store.routines}
                    onSaveRoutine={r => store.upsert(r)}
                    onDeleteRoutine={id => {
                      store.remove(id)
                      showToast('Routine removed', () => store.restore([id]))
                    }}
                  />
                )}
                {homeTab === 'week' && (
                  <Review
                    tasks={store.tasks}
                    projects={store.projects}
                    projectMap={projectMap}
                    people={store.people}
                    reviews={store.reviews}
                    journal={store.journal}
                    places={store.places}
                    habits={store.habits}
                    onSaveReview={r => store.upsert(r)}
                    onOpen={openTask}
                    onStatus={changeStatus}
                    onReschedule={(ids, dueAt) => {
                      for (const id of ids) {
                        const t = store.tasks.find(x => x.id === id)
                        if (t) store.upsert({ ...t, dueAt, status: t.status === 'wishlist' ? 'todo' : t.status, updatedAt: newerStamp(t.updatedAt) })
                      }
                      showToast(`Moved ${ids.length} task${ids.length === 1 ? '' : 's'} to Monday`)
                    }}
                    onOpenProject={openProject}
                    onNew={preset => newTask(preset)}
                  />
                )}
                {homeTab === 'journal' && (
                  <JournalView
                    entries={store.journal}
                    people={store.people}
                    onSave={e => store.upsert(e)}
                    onDelete={id => {
                      store.remove(id)
                      showToast('Journal entry removed', () => store.restore([id]))
                    }}
                    openDate={journalOpenDate}
                    onOpenDateConsumed={() => setJournalOpenDate(null)}
                  />
                )}
              </>
            )}
            {view === 'calendar' && (
              <>
                <div className="segmented cal-mode" role="tablist" aria-label="Calendar mode">
                  <button className={calMode === 'month' ? 'seg on' : 'seg'} onClick={() => setCalMode('month')}>
                    Month
                  </button>
                  <button className={calMode === 'week' ? 'seg on' : 'seg'} onClick={() => setCalMode('week')}>
                    Week
                  </button>
                  <button className={calMode === 'timeline' ? 'seg on' : 'seg'} onClick={() => setCalMode('timeline')}>
                    Timeline
                  </button>
                </div>
                {calMode !== 'timeline' ? (
                  <Calendar
                    view={calMode}
                    tasks={filteredTasks}
                    projects={store.projects}
                    projectMap={projectMap}
                    people={store.people}
                    meals={store.meals}
                    recipes={store.recipes}
                    places={store.places}
                    onSaveMeal={saveMeal}
                    onClearMeal={clearMeal}
                    onCreatePlace={createPlaceInline}
                    onCreateRecipe={createRecipeInline}
                    onNewEvent={(startIso, work) => setEventEditor({ startIso, work })}
                    onEditEvent={id => {
                      const entry = store.events.find(e => e.id === id)
                      if (entry) setEventEditor({ entry, startIso: entry.start })
                    }}
                    events={allEvents}
                    sourceMap={sourceMap}
                    onOpen={openTask}
                    onNew={d => newTask({ status: 'todo', dueAt: d })}
                    onReschedule={reschedule}
                    onPlan={planForEvent}
                    onAttendance={ev => setAttendance(ev)}
                    onOpenProject={openProject}
                    onPlanOccasion={planOccasion}
                  />
                ) : (
                  <Roadmap
                    projects={store.projects}
                    tasks={store.tasks}
                    events={allEvents}
                    sourceMap={sourceMap}
                    onOpenProject={openProject}
                    onNewProject={newProject}
                    onOpenTask={openTask}
                  />
                )}
              </>
            )}
            {view === 'tasks' && (
              <>
                {/* one workspace, four lenses on the same project data — the list,
                    the board, the bills and the project notes */}
                <div className="people-tab-seg tasks-seg">
                  <span className="segmented" role="tablist" aria-label="Tasks view">
                    {TASKS_TABS.map(t => (
                      <button key={t.key} type="button" role="tab" aria-selected={tasksTab === t.key} className={tasksTab === t.key ? 'seg on' : 'seg'} onClick={() => setTasksTab(t.key)}>
                        {t.label}
                      </button>
                    ))}
                  </span>
                  {/* whose tasks, not which lens — so a group beside the tablist,
                      not a tab; it narrows Today, the list and the board alike
                      (see filteredTasks) */}
                  {inHousehold && (
                    <span className="segmented mine-seg" role="group" aria-label="Whose tasks">
                      <button type="button" className={mineOnly ? 'seg on' : 'seg'} onClick={() => setMineOnly(true)}>
                        Mine
                      </button>
                      <button type="button" className={!mineOnly ? 'seg on' : 'seg'} onClick={() => setMineOnly(false)}>
                        Everyone
                      </button>
                    </span>
                  )}
                </div>
                {tasksTab === 'list' && (
                  <TasksTable
                    store={store}
                    tasks={filteredTasks}
                    projectMap={projectMap}
                    onOpen={openTask}
                    onNew={newTask}
                    onDelete={deleteTask}
                    onOpenTrash={() => setTrashOpen(true)}
                    trashCount={store.visibleItems.filter(i => i.deletedAt && !i.purged).length}
                  />
                )}
                {tasksTab === 'board' && (
                  <Board
                    tasks={filteredTasks}
                    projects={projectMap}
                    members={household.info?.members ?? []}
                    onOpen={openTask}
                    onStatus={changeStatus}
                    onNew={s => newTask({ status: s })}
                  />
                )}
                {tasksTab === 'bills' && (
                  <Bills
                    tasks={store.tasks}
                    onOpen={openTask}
                    onNew={() => newTask({ bill: { kind: 'bill' }, recurrence: { freq: 'monthly' } }, { capture: false })}
                    // the one completion path with a real undo: it restores the bill and
                    // removes next month's occurrence, so an accidental tap costs nothing
                    onMarkPaid={t => changeStatus(t.id, 'done')}
                  />
                )}
                {tasksTab === 'notes' && (
                  <NotesView
                    projects={store.projects}
                    project={notesProject}
                    getLatest={id => store.projects.find(x => x.id === id)}
                    onSave={p => store.upsert(p)}
                    onSelectProject={id => setNotesProjectId(id)}
                    onBack={() => setNotesProjectId(null)}
                    onNewProject={newProject}
                    onCreateTask={(title, projectId) => newTask({ title, projectId, status: 'todo' })}
                  />
                )}
              </>
            )}
            {view === 'people' && (
              <>
                <div className="people-tab-seg">
                  <span className="segmented">
                    <button
                      type="button"
                      className={peopleTab === 'people' ? 'seg on' : 'seg'}
                      onClick={() => setPeopleTab('people')}
                    >
                      People
                    </button>
                    <button
                      type="button"
                      className={peopleTab === 'places' ? 'seg on' : 'seg'}
                      onClick={() => setPeopleTab('places')}
                    >
                      Places
                    </button>
                  </span>
                </div>
                {peopleTab === 'places' ? (
                  <Places
                    places={store.places}
                    people={store.people}
                    tasks={store.tasks}
                    meals={store.meals}
                    onSave={p => store.upsert(p)}
                    onDelete={id => {
                      store.remove(id)
                      showToast('Removed', () => store.restore([id]))
                    }}
                    onLogOuting={(place, at, note, peopleIds) =>
                      logOuting({
                        at,
                        title: note || `Went to ${place.name}`,
                        placeId: place.id,
                        peopleIds,
                      })
                    }
                    onPlan={planAt}
                    onOpenTask={openTask}
                    openId={placeOpenId}
                    onOpenConsumed={() => setPlaceOpenId(null)}
                    onNewTask={preset => newTask(preset)}
                  />
                ) : (
                  <People
                    people={store.people}
                    places={store.places}
                    tasks={store.tasks}
                    journal={store.journal}
                    onOpenJournal={date => openJournal(date)}
                    onSave={p => store.upsert(p)}
                    onDelete={id => {
                      store.remove(id)
                      showToast('Removed', () => store.restore([id]))
                    }}
                    onSavePlace={p => store.upsert(p)}
                    onLogVisit={logVisit}
                    onPlan={planWith}
                    onOpenTask={openTask}
                  />
                )}
              </>
            )}
            {view === 'kitchen' && (
              <Kitchen
                recipes={store.recipes}
                meals={store.meals}
                groceries={store.groceries}
                places={store.places}
                onSaveMeal={saveMeal}
                onClearMeal={clearMeal}
                onCreatePlace={createPlaceInline}
                onCreateRecipe={createRecipeInline}
                onSave={item => store.upsert(item)}
                onDelete={id => {
                  store.remove(id)
                  showToast('Removed', () => store.restore([id]))
                }}
                openRecipe={kitchenRecipe}
                onOpenRecipeConsumed={() => setKitchenRecipe(null)}
              />
            )}
          </ErrorBoundary>
        )}
      </main>

      {editor && (
        <TaskEditor
          task={editor.task}
          preset={editor.preset}
          capture={editor.capture}
          projects={store.projects}
          people={store.people}
          places={store.places}
          onSavePlace={p => store.upsert(p)}
          members={inHousehold ? household.info!.members : []}
          candidates={store.tasks.filter(t => t.status !== 'canceled' && t.id !== editor.task?.id && (!editor.task?.projectId || t.projectId === editor.task.projectId))}
          getLatest={id => store.tasks.find(x => x.id === id)}
          onSave={t => {
            const before = store.tasks.find(x => x.id === t.id)
            const isNew = !before
            store.upsert(t)
            setEditor(null)
            if (isNew) showToast(`Added “${t.title || 'Untitled'}”`, () => store.remove(t.id))
            if (t.status === 'done' && before?.status !== 'done') closeLinkedIssue(t)
            if (!before || before.status !== t.status || before.dueAt !== t.dueAt) pushToProjectBoard(t)
          }}
          onDiscard={() => showToast('Nothing to save — that task was empty.')}
          onCommit={t => store.upsert(t)}
          onDelete={id => {
            const t = store.tasks.find(x => x.id === id)
            if (t) deleteTask(t)
          }}
          onDuplicate={copy => {
            store.upsert(copy)
            setEditor({ task: copy })
            showToast(`Duplicated “${copy.title || 'Untitled'}”`, () => {
              store.remove(copy.id)
              setEditor(cur => (cur?.task?.id === copy.id ? null : cur))
            })
          }}
          onClose={() => setEditor(null)}
        />
      )}

      {projectEditor && (
        <ProjectEditor
          project={projectEditor.project}
          tasks={projectEditor.project ? store.tasks.filter(t => t.projectId === projectEditor.project!.id) : []}
          getLatest={id => store.projects.find(x => x.id === id)}
          onSave={p => {
            // a new project just closes the editor: the person opened it from
            // Today, the Timeline or the palette and stays put; it shows up in
            // the Board's chips and on the Timeline on its own
            store.upsert(p)
            setProjectEditor(null)
          }}
          onDelete={id => {
            const p = store.projects.find(x => x.id === id)
            if (p) deleteProject(p)
          }}
          onClose={() => setProjectEditor(null)}
          onOpenNotes={p => {
            setProjectEditor(null)
            setNotesProjectId(p.id)
            goTasksTab('notes')
            setView('tasks')
          }}
          templates={store.templates}
          onCreateMany={(p, ts) => {
            store.upsert(p)
            for (const t of ts) store.upsert(t)
            setProjectEditor(null)
            // a template or a drafted plan just made a batch of dated tasks; the
            // board, chips on, is where they show as a group (for this visit
            // only — the toast names the project)
            goTasksTab('board')
            setView('tasks')
            showToast(`${projectEditor.project ? 'Added' : 'Created'} ${ts.length} task${ts.length === 1 ? '' : 's'} in “${p.name}”`)
          }}
          onSaveTemplate={t => {
            store.upsert(t)
            showToast(`Template “${t.name}” saved — pick it when creating a project`)
          }}
        />
      )}

      {attendance && (
        <AttendancePicker
          event={attendance}
          people={store.people}
          places={store.places}
          onSavePlace={p => store.upsert(p)}
          onDone={(ids, placeId) => {
            logAttendance(attendance, ids, placeId)
            setAttendance(null)
          }}
          onClose={() => setAttendance(null)}
        />
      )}

      {searchOpen && (
        <Search
          tasks={store.tasks}
          projects={store.projects}
          people={store.people}
          commands={paletteCommands}
          onOpenTask={openTask}
          onOpenProject={openProject}
          onOpenPerson={() => setView('people')}
          places={store.places}
          onOpenPlace={p => openPlace(p.id)}
          journal={store.journal}
          onOpenJournal={e => openJournal(e.date)}
          onSaw={sawThem}
          onCreateTask={(title, openEditor) => {
            // Enter opens the editor so parseCapture can propose fields;
            // Shift+Enter (openEditor=false) files the line as it is, Undo in the toast
            if (openEditor === false && title.trim()) captureTask(title)
            else newTask({ title, status: 'todo' }, { capture: true })
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {eventEditor && (
        <EventEditor
          entry={eventEditor.entry}
          defaultStartIso={eventEditor.startIso}
          defaultWork={eventEditor.work}
          onSave={saveEvents}
          onDelete={deleteEvent}
          onClose={() => setEventEditor(null)}
        />
      )}

      {trashOpen && (
        <Trash
          items={store.visibleItems}
          projectMap={projectMap}
          onRestore={id => {
            const row = store.allItems.find(x => x.id === id)
            store.restore([id])
            // A restored entry goes back out to the mirrors too, or it lives only in
            // Drafter. Pushed as the live, newer record so the providers take it.
            if (row?.kind === 'event') mirrorEvent({ ...row, deletedAt: undefined, updatedAt: newerStamp(row.updatedAt) }, { revive: true })
            showToast('Restored')
          }}
          onPurge={id => {
            // queued until the server takes it: offline or refused, it stays unsynced and is retried
            void store.purge([id]).then(done => showToast(done ? 'Deleted forever' : 'Deleted here — it will be deleted everywhere at the next sync'))
          }}
          onClose={() => setTrashOpen(false)}
        />
      )}

      {settingsOpen && (
        <Settings
          key={settingsNonce}
          store={store}
          calendars={calendars}
          googlePush={googlePush}
          microsoftSync={microsoftSync}
          household={household}
          onClose={() => setSettingsOpen(false)}
          onOpenAdmin={
            isOwner
              ? () => {
                  setSettingsOpen(false)
                  setAdminOpen(true)
                }
              : undefined
          }
        />
      )}
      {adminOpen && isOwner && <Admin onClose={() => setAdminOpen(false)} />}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.msg}</span>
          {toast.undo && (
            <button
              className="toast-undo"
              onClick={() => {
                toast.undo?.()
                setToast(null)
              }}
            >
              Undo
            </button>
          )}
          {toast.action && (
            <button
              className="toast-undo"
              onClick={() => {
                toast.action?.run()
                setToast(null)
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button className="toast-close" aria-label="Dismiss" onClick={() => setToast(null)}>
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
