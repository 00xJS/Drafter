import { useEffect, useMemo, useRef } from 'react'
import { useItems } from '../store'
import { newerStamp } from '../itemops'
import { notifyDue } from '../notify'
import { getSupabase } from '../supabase'
import { clearLocalData } from '../idb'
import { projectById } from '../taskutils'
import { useHousehold } from '../household'
import { timeAgo } from '../utils'
import { closeExternal, genericRemindersEnabled, initNative, isAppLockShowing, isNative, localRemindersEnabled, onAppLockCleared, scheduleLocalReminders, clearAppBadge } from '../native'
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
import { Icon } from './Icon'
import { PullToRefresh } from './PullToRefresh'
import { forgetRetiredKeys } from '../retiredkeys'
import { COMPACT_TABS, HOME_TABS, LEGACY_VIEW_TO_HOME, LEGACY_VIEW_TO_TASKS, TASKS_TABS, VIEW_ICONS, VIEW_LABELS, VIEWS, type PendingLink, type View } from './planner/routes'
import { Toast } from './planner/Toast'
import { useCalendarSync } from './planner/useCalendarSync'
import { useLifeActions } from './planner/useLifeActions'
import { useMineOnly } from './planner/useMineOnly'
import { useNavigation } from './planner/useNavigation'
import { useOverlays } from './planner/useOverlays'
import { useOwner } from './planner/useOwner'
import { useTaskActions } from './planner/useTaskActions'
import { useToast } from './planner/useToast'

export default function Planner() {
  const household = useHousehold()
  const store = useItems(household.myId)
  const { mineOnly, setMineOnly, inHousehold, filteredTasks } = useMineOnly({ store, household })

  // the multi-project bar is gone; a filter a device saved before the update
  // must not silently hide tasks, so it is dropped rather than read
  useEffect(() => forgetRetiredKeys(), [])
  const {
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
    openJournal,
    kitchenRecipe,
    setKitchenRecipe,
  } = useNavigation()
  const { toast, setToast, showToast } = useToast({ store })

  const projectMap = useMemo(() => projectById(store.projects), [store.projects])
  const { calendars, allEvents, sourceMap, googlePush, microsoftSync, mirrorEvent, saveEvents, deleteEvent, syncing, manualSync } = useCalendarSync({ store, household, showToast })

  const {
    editor,
    setEditor,
    projectEditor,
    setProjectEditor,
    trashOpen,
    setTrashOpen,
    searchOpen,
    setSearchOpen,
    settingsOpen,
    setSettingsOpen,
    settingsNonce,
    setSettingsNonce,
    adminOpen,
    setAdminOpen,
    eventEditor,
    setEventEditor,
    attendance,
    setAttendance,
    openTask,
    newTask,
    openProject,
    newProject,
    anyOpen,
  } = useOverlays()

  const { isOwner } = useOwner()

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

  const { createPlaceInline, createRecipeInline, saveMeal, clearMeal, sawThem, logOuting, wentTo, logVisit, planOccasion, logAttendance, planWith, planAt, planForEvent } = useLifeActions({
    store,
    showToast,
    newTask,
  })

  const { captureTask, deleteTask, deleteProject, closeLinkedIssue, pushToProjectBoard, changeStatus, reschedule, defer, deferAll } = useTaskActions({
    store,
    showToast,
    setEditor,
    setProjectEditor,
    setNotesProjectId,
  })

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
        {/* the phone hides the wordmark span for width (src/styles/08-responsive.css), so the
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
      <PullToRefresh enabled={!anyOpen} onRefresh={manualSync} />

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

      <Toast toast={toast} setToast={setToast} />
    </div>
  )
}
