import { useEffect, useMemo } from 'react'
import { useItems } from '../store'
import { newerStamp } from '../itemops'
import { getSupabase } from '../supabase'
import { clearLocalData } from '../idb'
import { projectById } from '../taskutils'
import { useHousehold } from '../household'
import { timeAgo } from '../utils'
import { localDayKey } from '../journal'
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
import { Search } from './Search'
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
import { buildPaletteCommands } from './planner/commands'
import { COMPACT_TABS, HOME_TABS, TASKS_TABS, VIEW_ICONS, VIEW_LABELS, type View } from './planner/routes'
import { Toast } from './planner/Toast'
import { useCalendarSync } from './planner/useCalendarSync'
import { useDeepLinks } from './planner/useDeepLinks'
import { useLifeActions } from './planner/useLifeActions'
import { useMineOnly } from './planner/useMineOnly'
import { useNativeShell } from './planner/useNativeShell'
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

  const { applyLinkRef } = useDeepLinks({
    store,
    showToast,
    setSettingsNonce,
    setSettingsOpen,
    setAdminOpen,
    setEditor,
    newTask,
    goTasksTab,
    goPeopleTab,
    setHomeTab,
    setView,
    openJournal,
    openPlace,
    // useTaskActions makes these further down, so its GitHub effects still
    // mount last; a link only ever runs after render, when both exist
    changeStatus: (id, status) => changeStatus(id, status),
    defer: (id, day) => defer(id, day),
  })
  useNativeShell({ store, applyLinkRef })

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

  const paletteCommands = buildPaletteCommands({ goView, setHomeTab, setView, openJournal, goTasksTab, setPeopleTab }, { newTask, newProject, setSettingsOpen })

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
