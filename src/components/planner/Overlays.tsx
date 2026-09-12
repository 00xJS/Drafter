import { Suspense, type ReactNode } from 'react'
import { newerStamp } from '../../itemops'
import { ErrorBoundary } from '../ErrorBoundary'
import type { PlannerCtx } from './ctx'
import { Admin, AttendancePicker, EventEditor, ProjectEditor, Search, Settings, TaskEditor, Trash } from './lazy'

/**
 * One overlay's own boundaries. Until its chunk lands nothing is shown (after
 * the launch warm-up that is never), and a chunk that fails or an editor that
 * throws takes down that overlay alone, not the planner under it — App.tsx
 * has no boundary of its own.
 */
function Layer({ name, children }: { name: string; children: ReactNode }) {
  return (
    <ErrorBoundary where={name}>
      <Suspense fallback={null}>{children}</Suspense>
    </ErrorBoundary>
  )
}

/** Whatever sits over the screen: the task, project and event editors, the attendance picker, search, trash, settings and Admin. */
export function Overlays({ p }: { p: PlannerCtx }) {
  const { store, household, projectMap, paletteCommands, inHousehold, showToast } = p
  const { setView, goTasksTab, setNotesProjectId, openPlace, openJournal } = p
  const { editor, setEditor, projectEditor, setProjectEditor, attendance, setAttendance, eventEditor, setEventEditor } = p
  const { searchOpen, setSearchOpen, trashOpen, setTrashOpen, settingsOpen, setSettingsOpen, settingsNonce, adminOpen, setAdminOpen, isOwner } = p
  const { openTask, newTask, openProject, sawThem, logAttendance, captureTask, deleteTask, deleteProject, closeLinkedIssue, pushToProjectBoard } = p
  const { calendars, googlePush, microsoftSync, mirrorEvent, saveEvents, deleteEvent } = p
  return (
    <>
      {editor && (
        <Layer name="the task editor">
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
        </Layer>
      )}

      {projectEditor && (
        <Layer name="the project editor">
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
        </Layer>
      )}

      {attendance && (
        <Layer name="the attendance picker">
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
        </Layer>
      )}

      {searchOpen && (
        <Layer name="search">
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
        </Layer>
      )}

      {eventEditor && (
        <Layer name="the event editor">
          <EventEditor
            entry={eventEditor.entry}
            defaultStartIso={eventEditor.startIso}
            defaultWork={eventEditor.work}
            onSave={saveEvents}
            onDelete={deleteEvent}
            onClose={() => setEventEditor(null)}
          />
        </Layer>
      )}

      {trashOpen && (
        <Layer name="Trash">
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
        </Layer>
      )}

      {settingsOpen && (
        <Layer name="Settings">
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
        </Layer>
      )}
      {adminOpen && isOwner && (
        <Layer name="Admin">
          <Admin onClose={() => setAdminOpen(false)} />
        </Layer>
      )}
    </>
  )
}
