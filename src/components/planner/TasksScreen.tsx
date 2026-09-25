import { memberName } from '../../household'
import { Icon } from '../Icon'
import { inTrash, newerStamp } from '../../itemops'
import type { Account } from '../../types'
import type { PlannerCtx } from './ctx'
import { Board, Finance, NotesView, TasksTable } from './lazy'
import { TASKS_TABS } from './routes'

/** Tasks: the list, the board, Finance and the project notes, four segments of one tab. */
export function TasksScreen({ p }: { p: PlannerCtx }) {
  const { store, upsert, remove, restore, household, projectMap, inHousehold } = p
  const { tasksTab, setTasksTab, notesProjectId, setNotesProjectId, setTrashOpen, noteOpenId, setNoteOpenId, financeCheckIn, setFinanceCheckIn, financeBill, setFinanceBill, taskShown, setTaskShown } = p
  const { openTask, newTask, deleteTask, changeStatus, applyStatus, showToast } = p
  // a change of an account's with an Undo that puts back the account as it was (or takes a new one away)
  const undoAccount = (before: Account | null, after: Account) => () => (before ? upsert({ ...before, updatedAt: newerStamp(after.updatedAt) }) : remove(after.id))
  // counted here rather than in the list: the Trash button lives on the
  // segment row now. `inTrash` is the Trash's own rule, imported rather than
  // repeated, so the badge and the list always say the same number.
  const trashCount = store.visibleItems.filter(inTrash).length

  // a map lookup so an id whose project was deleted degrades to the index
  const notesProject = notesProjectId ? projectMap.get(notesProjectId) : undefined

  return (
    <>
      {/* one workspace, four lenses on the same project data — the list, the
          board, the money (bills, paydays and accounts) and the project notes.
          Finance opens on what is safe to spend, not on this line about tasks. */}
      {tasksTab !== 'bills' && <p className="field-hint tasks-home-note">The day is on Home. This is every task — the list, the board, the money and the notes.</p>}
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
          reveal={taskShown}
          onRevealed={() => setTaskShown(null)}
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
          myId={household.myId}
          inHousehold={inHousehold}
          onOpen={openTask}
          onNew={preset => newTask(preset, { capture: false })}
          // the one completion path with a real undo: it restores the bill and
          // removes next month's occurrence, so an accidental tap costs nothing
          onMarkPaid={t => changeStatus(t.id, 'done')}
          onAdd={(t, message) => {
            upsert(t)
            showToast(message, () => remove(t.id))
          }}
          onSaveTask={t => upsert(t)}
          onRemoveTask={t => {
            remove(t.id)
            showToast('Weekly check-in off', () => restore([t.id]))
          }}
          // from a bill's or a payday's short sheet: the Trash with its Undo, as
          // any task's delete; and Archive, which is Canceled — counted nowhere,
          // kept — with an Undo that puts back the status it had
          onDeleteTask={deleteTask}
          onArchiveTask={(t, archive) => {
            const change = applyStatus(t.id, archive ? 'canceled' : 'todo')
            if (!change) return
            showToast(`${archive ? 'Archived' : 'Restored'} “${t.title || 'Untitled'}”`, () => {
              upsert({ ...change.prev, updatedAt: newerStamp(change.next.updatedAt) })
              if (change.spawnedId) remove(change.spawnedId)
            })
          }}
          onChangeAccount={(before, after, message) => {
            upsert(after)
            showToast(message, undoAccount(before, after))
          }}
          onRemoveAccount={id => {
            remove(id)
            showToast('Account removed', () => restore([id]))
          }}
          onCheckIn={(changes, done) => {
            for (const c of changes) upsert(c.after)
            // this week's check-in, ticked off by doing it, with the one Undo
            const ticked = done ? applyStatus(done.id, 'done') : null
            // a balance typed in gives the account a new list of them; one added blank has none
            const n = changes.filter(c => c.after.balances.length > 0 && c.after.balances !== c.before?.balances).length
            const said = n ? `Checked in ${n} account${n === 1 ? '' : 's'}` : changes.length === 1 ? 'Account added' : `${changes.length} accounts added`
            showToast(ticked ? `${said} — this week’s check-in is done` : said, () => {
              for (const c of changes) {
                if (c.before) upsert({ ...c.before, updatedAt: newerStamp(c.after.updatedAt) })
                else remove(c.after.id)
              }
              if (ticked) {
                upsert({ ...ticked.prev, updatedAt: newerStamp(ticked.next.updatedAt) })
                if (ticked.spawnedId) remove(ticked.spawnedId)
              }
            })
          }}
          checkIn={financeCheckIn}
          onCheckInOpened={() => setFinanceCheckIn(false)}
          addBill={financeBill}
          onAddBillOpened={() => setFinanceBill(false)}
        />
      )}
      {tasksTab === 'notes' && (
        <NotesView
          projects={store.projects}
          project={notesProject}
          getLatest={id => store.projects.find(x => x.id === id)}
          onSave={p => upsert(p)}
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
          onSaveNote={note => upsert(note)}
          onDeleteNote={id => {
            const note = store.notes.find(x => x.id === id)
            remove(id)
            showToast(`“${note?.title || 'Untitled note'}” moved to Trash`, () => restore([id]))
          }}
          // a note picked in the palette's search opens once, then is forgotten
          openNoteId={noteOpenId ?? undefined}
          onOpenNoteDone={() => setNoteOpenId(null)}
        />
      )}
    </>
  )
}
