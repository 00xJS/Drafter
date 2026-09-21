import { memberName } from '../../household'
import { Icon } from '../Icon'
import { inTrash } from '../../itemops'
import type { PlannerCtx } from './ctx'
import { Board, Finance, NotesView, TasksTable } from './lazy'
import { TASKS_TABS } from './routes'

/** Tasks: the list, the board, Finance and the project notes, four segments of one tab. */
export function TasksScreen({ p }: { p: PlannerCtx }) {
  const { store, household, projectMap, inHousehold } = p
  const { tasksTab, setTasksTab, notesProjectId, setNotesProjectId, setTrashOpen, noteOpenId, setNoteOpenId } = p
  const { openTask, newTask, deleteTask, changeStatus, showToast } = p
  // counted here rather than in the list: the Trash button lives on the
  // segment row now. `inTrash` is the Trash's own rule, imported rather than
  // repeated, so the badge and the list always say the same number.
  const trashCount = store.visibleItems.filter(inTrash).length

  // a map lookup so an id whose project was deleted degrades to the index
  const notesProject = notesProjectId ? projectMap.get(notesProjectId) : undefined

  return (
    <>
      {/* one workspace, four lenses on the same project data — the list, the
          board, the money (bills, paydays and accounts) and the project notes */}
      <p className="field-hint tasks-home-note">The day is on Home. This is every task — the list, the board, the money and the notes.</p>
      <div className="people-tab-seg with-trash">
        <span className="segmented" role="tablist" aria-label="Tasks view">
          {TASKS_TABS.map(t => (
            <button key={t.key} type="button" role="tab" aria-selected={tasksTab === t.key} className={tasksTab === t.key ? 'seg on' : 'seg'} onClick={() => setTasksTab(t.key)}>
              {t.label}
            </button>
          ))}
        </span>
        {/* The Trash, up here where it can be seen (v3.28). It used to sit at
            the end of the list's toolbar and, at 375pt, inside an "Import /
            Export ▾" menu — so the control you reach for when you delete
            something by mistake was the one you could not find. Import and
            export went to Settings → Data in the same move. */}
        <button
          type="button"
          className="btn tasks-trash"
          onClick={() => setTrashOpen(true)}
          aria-label={trashCount > 0 ? `Trash, ${trashCount} item${trashCount === 1 ? '' : 's'}` : 'Trash'}
          title="Trash"
        >
          <Icon name="trash" size={18} />
          {trashCount > 0 && <span className="board-count">{trashCount}</span>}
        </button>
      </div>
      {tasksTab === 'list' && (
        <TasksTable
          tasks={store.tasks}
          onOpen={openTask}
          onNew={newTask}
          onDelete={deleteTask}
          inHousehold={inHousehold}
          myId={household.myId}
          nameOf={id => memberName(household.info, id)}
        />
      )}
      {tasksTab === 'board' && (
        <Board
          tasks={store.tasks}
          members={household.info?.members ?? []}
          inHousehold={inHousehold}
          onOpen={openTask}
          onStatus={changeStatus}
          onNew={s => newTask({ status: s })}
        />
      )}
      {tasksTab === 'bills' && (
        <Finance
          tasks={store.tasks}
          accounts={store.accounts}
          // a payday says whose it is, and an account can too
          members={household.info?.members ?? []}
          onOpen={openTask}
          onNew={bill =>
            newTask(
              // a payday defaults to a fortnight, which is what most are; a bill
              // to a month, as it always has
              { bill: { kind: bill.kind }, recurrence: { freq: bill.kind === 'income' ? 'biweekly' : 'monthly' }, title: bill.kind === 'income' ? 'Payday' : '' },
              { capture: false },
            )
          }
          // the one completion path with a real undo: it restores the bill and
          // removes next month's occurrence, so an accidental tap costs nothing
          onMarkPaid={t => changeStatus(t.id, 'done')}
          onSaveAccount={a => store.upsert(a)}
          onRemoveAccount={id => {
            store.remove(id)
            showToast('Account removed', () => store.restore([id]))
          }}
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
          onCreateTask={(title, projectId) => newTask({ title, projectId, status: 'todo' })}
          // notes of their own beside the project pads: the list, a page each,
          // and a delete that goes to Trash with the same Undo tasks have
          notes={store.notes}
          allNotes={store.notes}
          myId={household.myId}
          inHousehold={inHousehold}
          nameOf={id => memberName(household.info, id)}
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
