import type { PlannerCtx } from './ctx'
import { Bills, Board, NotesView, TasksTable } from './lazy'
import { TASKS_TABS } from './routes'

/** Tasks: the list, the board, the bills and the project notes, four segments of one tab. */
export function TasksScreen({ p }: { p: PlannerCtx }) {
  const { store, household, projectMap, filteredTasks, inHousehold, mineOnly, setMineOnly } = p
  const { tasksTab, setTasksTab, notesProjectId, setNotesProjectId, setTrashOpen, noteOpenId, setNoteOpenId } = p
  const { openTask, newTask, newProject, deleteTask, changeStatus, showToast } = p

  // a map lookup so an id whose project was deleted degrades to the index
  const notesProject = notesProjectId ? projectMap.get(notesProjectId) : undefined

  return (
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
          // notes of their own beside the project pads: the list, a page each,
          // and a delete that goes to Trash with the same Undo tasks have
          notes={store.notes}
          onSaveNote={note => store.upsert(note)}
          onDeleteNote={id => {
            const note = store.notes.find(x => x.id === id)
            store.remove(id)
            showToast(`“${note?.title || 'Untitled note'}” moved to Trash`, () => store.restore([id]))
          }}
          // a note picked in the palette's search opens once, then is forgotten
          openNoteId={noteOpenId ?? undefined}
          onOpenNoteDone={() => setNoteOpenId(null)}
        />
      )}
    </>
  )
}
