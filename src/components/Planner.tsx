import { useEffect, useMemo } from 'react'
import { useItems } from '../store'
import { newerStamp } from '../itemops'
import { getSupabase } from '../supabase'
import { clearLocalData } from '../idb'
import { projectById } from '../taskutils'
import { useHousehold } from '../household'
import { Kitchen } from './Kitchen'
import { Search } from './Search'
import { AttendancePicker } from './AttendancePicker'
import { TaskEditor } from './TaskEditor'
import { ProjectEditor } from './ProjectEditor'
import { Trash } from './Trash'
import { EventEditor } from './EventEditor'
import { Settings } from './Settings'
import { Admin } from './Admin'
import { ErrorBoundary } from './ErrorBoundary'
import { PullToRefresh } from './PullToRefresh'
import { forgetRetiredKeys } from '../retiredkeys'
import { buildPaletteCommands } from './planner/commands'
import type { PlannerCtx } from './planner/ctx'
import { CalendarScreen } from './planner/CalendarScreen'
import { HomeScreen } from './planner/HomeScreen'
import { PeopleScreen } from './planner/PeopleScreen'
import { VIEW_LABELS } from './planner/routes'
import { TasksScreen } from './planner/TasksScreen'
import { Toast } from './planner/Toast'
import { TopBar } from './planner/TopBar'
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
  const mine = useMineOnly({ store, household })

  // the multi-project bar is gone; a filter a device saved before the update
  // must not silently hide tasks, so it is dropped rather than read
  useEffect(() => forgetRetiredKeys(), [])
  const nav = useNavigation()
  const toaster = useToast({ store })
  const { showToast } = toaster

  const projectMap = useMemo(() => projectById(store.projects), [store.projects])
  const cal = useCalendarSync({ store, household, showToast })
  const overlays = useOverlays()
  const owner = useOwner()

  const { applyLinkRef } = useDeepLinks({
    store,
    showToast,
    ...nav,
    ...overlays,
    // useTaskActions makes these further down, so its GitHub effects still
    // mount last; a link only ever runs after render, when both exist
    changeStatus: (id, status) => taskActions.changeStatus(id, status),
    defer: (id, day) => taskActions.defer(id, day),
  })
  useNativeShell({ store, applyLinkRef })

  const lifeActions = useLifeActions({ store, showToast, newTask: overlays.newTask })
  const taskActions = useTaskActions({
    store,
    showToast,
    setEditor: overlays.setEditor,
    setProjectEditor: overlays.setProjectEditor,
    setNotesProjectId: nav.setNotesProjectId,
  })

  // Everything the top bar, the screens and the overlays read, rebuilt every
  // render and handed down as one prop (see planner/ctx.ts).
  const p: PlannerCtx = {
    store,
    household,
    projectMap,
    paletteCommands: buildPaletteCommands(nav, overlays),
    ...mine,
    ...nav,
    ...toaster,
    ...cal,
    ...overlays,
    ...owner,
    ...lifeActions,
    ...taskActions,
  }
  // read inline below until each screen and the overlays move into planner/
  const { paletteCommands, mineOnly, setMineOnly, inHousehold } = p
  const { view, setView, goTasksTab, setNotesProjectId } = p
  const { openPlace, openJournal, kitchenRecipe, setKitchenRecipe } = p
  const { toast, setToast, calendars, googlePush, microsoftSync, mirrorEvent, saveEvents, deleteEvent, manualSync } = p
  const { editor, setEditor, projectEditor, setProjectEditor, trashOpen, setTrashOpen, searchOpen, setSearchOpen, settingsOpen, setSettingsOpen, settingsNonce } = p
  const { adminOpen, setAdminOpen, eventEditor, setEventEditor, attendance, setAttendance, openTask, newTask, openProject, anyOpen, isOwner } = p
  const { createPlaceInline, createRecipeInline, saveMeal, clearMeal, sawThem, logAttendance } = p
  const { captureTask, deleteTask, deleteProject, closeLinkedIssue, pushToProjectBoard } = p

  return (
    <div className="app">
      <TopBar p={p} />

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
            {view === 'home' && <HomeScreen p={p} />}
            {view === 'calendar' && <CalendarScreen p={p} />}
            {view === 'tasks' && <TasksScreen p={p} />}
            {view === 'people' && <PeopleScreen p={p} />}
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
