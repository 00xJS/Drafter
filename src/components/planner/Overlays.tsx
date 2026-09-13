import { Suspense, useState, type ReactNode } from 'react'
import { proposeWeek, targetWeek } from '../../../shared/weekplan.mjs'
import type { AskDoc } from '../../ask'
import { newerStamp } from '../../itemops'
import { localDayKey, shiftDayKey } from '../../journal'
import { readWeekPlanDismissed } from '../../weekplanstore'
import { ErrorBoundary } from '../ErrorBoundary'
import type { PlannerCtx } from './ctx'
import { Admin, AskSheet, AttendancePicker, EventEditor, PlanDaySheet, ProjectEditor, Search, Settings, ShutdownSheet, TaskEditor, Trash, WeekPlanSheet } from './lazy'

/** The zone "today" and every day in the planning sheets are read in. */
const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

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

/**
 * Plan next week, worked out once as the sheet opens, so the rows it ticks
 * never shift under it when a sync lands. Rows said no to for that week before
 * stay out, and a busy evening is read from every calendar.
 */
function WeekPlanLayer({ p }: { p: PlannerCtx }) {
  const { store, household, allEvents, closeSheet, applyWeekPlan, createPlaceInline, createRecipeInline } = p
  const [plan] = useState(() => {
    const todayKey = localDayKey()
    const week = targetWeek(todayKey)
    return proposeWeek(store.visibleItems, {
      todayKey,
      tz: deviceZone(),
      userId: household.myId,
      dismissed: week ? readWeekPlanDismissed(week.weekKey) : [],
      now: new Date(),
      events: allEvents,
    })
  })
  if (!plan) return null
  return (
    <WeekPlanSheet
      plan={plan}
      recipes={store.recipes}
      places={store.places}
      people={store.people}
      meals={store.meals}
      tasks={store.tasks}
      onCreatePlace={createPlaceInline}
      onCreateRecipe={createRecipeInline}
      onApply={a => {
        closeSheet()
        applyWeekPlan(plan, a)
      }}
      onClose={closeSheet}
    />
  )
}

/** Whatever sits over the screen: the task, project and event editors, the attendance picker, the planning sheets, search, trash, settings and Admin. */
export function Overlays({ p }: { p: PlannerCtx }) {
  const { store, household, projectMap, paletteCommands, inHousehold, showToast, filteredTasks, allEvents } = p
  const { setView, goTasksTab, goPeopleTab, setNotesProjectId, openPlace, openJournal, openNote, setKitchenRecipe } = p
  const { editor, setEditor, projectEditor, setProjectEditor, attendance, setAttendance, eventEditor, setEventEditor, sheet, openSheet, closeSheet } = p
  const { searchOpen, setSearchOpen, trashOpen, setTrashOpen, settingsOpen, setSettingsOpen, settingsNonce, adminOpen, setAdminOpen, isOwner } = p
  const { openTask, newTask, openProject, sawThem, logAttendance, captureTask, deleteTask, deleteProject, closeLinkedIssue, pushToProjectBoard } = p
  const { calendars, googlePush, microsoftSync, mirrorEvent, mirrorsOn, saveEvents, deleteEvent } = p
  const { applyDayPlan, applyShutdown } = p
  const today = localDayKey()

  // A source or a citation tapped in Ask Drafter: the sheet gives way to the
  // record, opened where it lives. A subscribed calendar's event has no editor,
  // so it opens the Calendar.
  const openAskDoc = (doc: AskDoc) => {
    closeSheet()
    if (doc.kind === 'task' || doc.kind === 'bill') {
      const t = store.tasks.find(x => x.id === doc.id)
      if (t) openTask(t)
    } else if (doc.kind === 'project') {
      const found = store.projects.find(x => x.id === doc.id)
      if (found) openProject(found)
    } else if (doc.kind === 'place') openPlace(doc.id)
    else if (doc.kind === 'journal') openJournal(doc.date)
    else if (doc.kind === 'person') {
      goPeopleTab('people')
      setView('people')
    } else if (doc.kind === 'recipe') {
      const r = store.recipes.find(x => x.id === doc.id)
      if (r) setKitchenRecipe(r)
      setView('kitchen')
    } else if (doc.kind === 'meal') setView('kitchen')
    else if (doc.kind === 'event') {
      const e = doc.feed ? undefined : store.events.find(x => x.id === doc.id)
      if (e) setEventEditor({ entry: e, startIso: e.start })
      else setView('calendar')
    }
  }

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
            onSavePerson={p => store.upsert(p)}
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
            tasks={store.tasks.filter(t => t.projectId === projectEditor.project.id)}
            getLatest={id => store.projects.find(x => x.id === id)}
            onSave={p => {
              // the editor only ever opens on the existing project, from its
              // Timeline bar, a milestone in a calendar day or search; saving
              // closes it and leaves the person where they were
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
              // a template or a drafted plan just added a batch of dated tasks
              // to the project: the Board shows them together, and the toast
              // says how many
              goTasksTab('board')
              setView('tasks')
              showToast(`Added ${ts.length} task${ts.length === 1 ? '' : 's'} to “${p.name}”`)
            }}
            onSaveTemplate={t => {
              store.upsert(t)
              showToast(`Template “${t.name}” saved — pick it in the project editor to add its tasks`)
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
            onSavePerson={p => store.upsert(p)}
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
            notes={store.notes}
            onOpenNote={n => openNote(n.id)}
            onAsk={question => openSheet({ kind: 'ask', question })}
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

      {/* The daily routines. Each sheet writes nothing itself: Done hands the
          whole plan to useFocusActions, which applies it with one toast and one
          Undo. Routine ticks and the journal line save as they always do. */}
      {sheet?.kind === 'day' && (
        <Layer name="Plan my day">
          <PlanDaySheet
            tasks={filteredTasks}
            projects={store.projects}
            reviews={store.reviews}
            events={allEvents}
            entries={store.events}
            today={today}
            now={new Date()}
            myId={household.myId}
            initialStep={sheet.step}
            mirroring={mirrorsOn}
            meals={store.meals}
            recipes={store.recipes}
            places={store.places}
            onApply={r => {
              closeSheet()
              applyDayPlan(r)
            }}
            onClose={closeSheet}
          />
        </Layer>
      )}

      {sheet?.kind === 'shutdown' && (
        <Layer name="Shut down">
          <ShutdownSheet
            tasks={filteredTasks}
            projects={store.projects}
            reviews={store.reviews}
            routines={store.routines}
            journal={store.journal}
            people={store.people}
            today={today}
            tomorrow={shiftDayKey(today, 1)}
            myId={household.myId}
            onSaveRoutine={r => store.upsert(r)}
            onSaveJournal={e => store.upsert(e)}
            onDeleteJournal={id => {
              store.remove(id)
              showToast('Journal entry removed', () => store.restore([id]))
            }}
            onApply={r => {
              closeSheet()
              applyShutdown(r)
            }}
            onClose={closeSheet}
          />
        </Layer>
      )}

      {/* Plan next week writes nothing itself either: its ticked rows go to
          useFocusActions as one AcceptedPlan, applied with one toast and Undo */}
      {sheet?.kind === 'week' && (
        <Layer name="Plan next week">
          <WeekPlanLayer p={p} />
        </Layer>
      )}

      {sheet?.kind === 'ask' && (
        <Layer name="Ask Drafter">
          <AskSheet
            key={sheet.question ?? ''}
            initialQuestion={sheet.question}
            // your own events are items already: ask.ts skips a feed's copy of one (localId)
            sources={{ tasks: store.tasks, projects: store.projects, people: store.people, places: store.places, recipes: store.recipes, meals: store.meals, entries: store.events, feedEvents: allEvents, journal: store.journal }}
            tz={deviceZone()}
            onOpen={openAskDoc}
            onClose={closeSheet}
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
