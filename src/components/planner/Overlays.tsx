import { Suspense, useMemo, useState, type ReactNode } from 'react'
import { mediaIdsOf } from '../../../shared/media.mts'
import { proposeWeek, targetWeek } from '../../../shared/weekplan.mts'
import { newerStamp, trashedLine } from '../../itemops'
import { COOK_TASK_PREFIX, mealForCookHandOver, saveCookToRecipe } from '../../kitchen'
import { OPEN_STATUSES, type Task } from '../../types'
import { deleteMedia } from '../../media'
import { localDayKey, shiftDayKey } from '../../journal'
import { useDayKey } from '../../useDayKey'
import { readWeekPlanDismissed } from '../../weekplanstore'
import { ErrorBoundary } from '../ErrorBoundary'
import type { PlannerCtx } from './ctx'
import { askDocOpener } from './askRouting'
import { AskSheet, AttendancePicker, EventEditor, ImHereSheet, NoticesSheet, PlanDaySheet, ProjectEditor, RhythmSheet, Search, ShutdownSheet, TaskEditor, Trash, WeekPlanSheet } from './lazy'
import { hubOpener } from './hubRouting'
import type { RhythmChange } from '../RhythmSheet'

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
      entries={store.events}
      myId={household.myId}
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

/**
 * What saving a brand-new task says. One logged as done already ("✓ Log a
 * finished task") is not on the list's Open filter, so its toast offers Show,
 * which brings its row up (`logged`).
 */
export function addedLine(t: Pick<Task, 'title' | 'status'>): { msg: string; logged: boolean } {
  const name = `“${t.title || 'Untitled'}”`
  return t.status === 'done' ? { msg: `Logged ${name} as done`, logged: true } : { msg: `Added ${name}`, logged: false }
}

/** The toast after Who, and how often: whose rhythm was saved, by name for one. */
export function rhythmsSaved(changes: readonly RhythmChange[]): string {
  if (changes.length === 1) return `Rhythm saved for ${changes[0].after.name}`
  const people = changes.filter(c => c.after.kind === 'person').length
  const places = changes.length - people
  const parts = [people && `${people} ${people === 1 ? 'person' : 'people'}`, places && `${places} ${places === 1 ? 'place' : 'places'}`].filter(Boolean)
  return `Rhythms saved for ${parts.join(' and ')}`
}

/**
 * What the task editor may offer as blockers of `editing`: the open tasks — to
 * do, doing or blocked — other than itself, from its own project when it has
 * one, and the ones it already waits on, whatever became of them, so every
 * blocker it shows keeps its name. Done and wishlist tasks were offered too,
 * the whole history of the household in one list, and a done one picked from
 * it was a blocker that had never been there.
 */
export function blockerCandidates(tasks: readonly Task[], editing: Task | undefined): Task[] {
  const listed = new Set(editing?.blockedBy ?? [])
  return tasks.filter(
    t => t.id !== editing?.id && (listed.has(t.id) || (OPEN_STATUSES.includes(t.status) && (!editing?.projectId || t.projectId === editing.projectId))),
  )
}

/** Whatever sits over the screen: the task, project and event editors, the attendance picker, the planning sheets, search, trash, settings and Admin. */
export function Overlays({ p }: { p: PlannerCtx }) {
  const { store, upsert, remove, restore, purge, household, projectMap, paletteCommands, inHousehold, showToast, allEvents } = p
  const { setView, goTasksTab, setNotesProjectId, openNote, openPlace, openPerson, openJournal, openWardrobe, showTaskInList } = p
  const { editor, setEditor, projectEditor, setProjectEditor, attendance, setAttendance, eventEditor, setEventEditor, sheet, openSheet, closeSheet } = p
  const { searchOpen, setSearchOpen, trashOpen, setTrashOpen } = p
  const { openTask, newTask, openProject, sawThem, logOuting, logAttendance, captureTask, deleteTask, deleteProject, closeLinkedIssue, pushToProjectBoard } = p
  const { mirrorEvent, mirrorsOn, saveEvents, deleteEvent } = p
  const { applyDayPlan, applyShutdown } = p
  // From useDayKey, never localDayKey() as this renders: the React Compiler
  // keeps that from the first render for as long as the planner is up, and
  // Plan my day and Shut down WRITE with it — a focus picked on the phone's
  // third morning landed on the day the app was opened.
  const today = useDayKey()
  // drawn again when a task changes or another is opened, never as the editor is typed in
  const editing = editor?.task
  const candidates = useMemo(() => blockerCandidates(store.tasks, editing), [store.tasks, editing])

  // a citation tapped here closes the sheet first; the same routing serves
  // an answer's sources in Home → Chat (askRouting.ts)
  const openAskDoc = askDocOpener(p, closeSheet)

  /**
   * A cook task handed to someone else in the editor: its meal's cook goes with
   * it (mealForCookHandOver), or the sync that keeps a cook task with its
   * meal's cook would hand it straight back.
   */
  const handOverCook = (t: Task) => {
    const meal = mealForCookHandOver(store.tasks.find(x => x.id === t.id), t, store.meals)
    if (meal) upsert(meal)
  }

  /**
   * A shared meal's cook task can keep what was written on it: the steps and
   * notes go into the meal's recipe (or a new one, for a meal that is not a
   * recipe yet), so they are there the next time it is planned. One Undo puts
   * the recipe, the meal and the task back.
   */
  const cookRecipeFor = (t: Task | undefined) => {
    if (!t?.id.startsWith(COOK_TASK_PREFIX)) return undefined
    const meal = store.meals.find(m => m.id === t.id.slice(COOK_TASK_PREFIX.length) && !m.deletedAt)
    if (!meal || meal.out) return undefined
    const recipe = meal.recipeId ? store.recipes.find(r => r.id === meal.recipeId && !r.deletedAt) : undefined
    return {
      name: recipe?.name ?? null,
      onSave(current: Task) {
        // a hand-over in the same save goes to the meal first, so a recipe linked to it is linked on top of it
        const handed = mealForCookHandOver(store.tasks.find(x => x.id === current.id), current, [meal])
        const base = handed ?? meal
        const saved = saveCookToRecipe(current, base, store.recipes, { now: new Date().toISOString(), newId: () => crypto.randomUUID() })
        if (!saved) {
          if (handed) upsert(handed)
          upsert(current)
          setEditor(null)
          showToast(`Nothing new to add to “${recipe?.name ?? meal.title}” — it already has these steps and notes.`)
          return
        }
        upsert(saved.recipe)
        if (saved.meal) upsert(saved.meal)
        else if (handed) upsert(handed)
        upsert(saved.task)
        setEditor(null)
        showToast(saved.created ? `Saved “${saved.recipe.name}” as a recipe` : `Saved to “${saved.recipe.name}”`, () => {
          if (saved.created) remove(saved.recipe.id)
          else if (recipe) upsert({ ...recipe, updatedAt: newerStamp(saved.recipe.updatedAt) })
          if (saved.meal) upsert({ ...base, updatedAt: newerStamp(saved.meal.updatedAt) })
          upsert({ ...current, updatedAt: newerStamp(saved.task.updatedAt) })
        })
      },
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
            onSavePlace={p => upsert(p)}
            onSavePerson={p => upsert(p)}
            members={inHousehold ? household.info!.members : []}
            myId={household.myId}
            candidates={candidates}
            getLatest={id => store.tasks.find(x => x.id === id)}
            onSave={t => {
              const before = store.tasks.find(x => x.id === t.id)
              const isNew = !before
              handOverCook(t)
              upsert(t)
              setEditor(null)
              if (isNew) {
                const said = addedLine(t)
                showToast(said.msg, () => remove(t.id), said.logged ? { label: 'Show', run: () => showTaskInList(t.id) } : undefined)
              }
              if (t.status === 'done' && before?.status !== 'done') closeLinkedIssue(t)
              if (!before || before.status !== t.status || before.dueAt !== t.dueAt) pushToProjectBoard(t)
            }}
            onDiscard={() => showToast('Nothing to save — that task was empty.')}
            onCommit={t => {
              handOverCook(t)
              upsert(t)
            }}
            onDelete={id => {
              const t = store.tasks.find(x => x.id === id)
              if (t) deleteTask(t)
            }}
            onDuplicate={copy => {
              upsert(copy)
              setEditor({ task: copy })
              showToast(`Duplicated “${copy.title || 'Untitled'}”`, () => {
                remove(copy.id)
                setEditor(cur => (cur?.task?.id === copy.id ? null : cur))
              })
            }}
            onClose={() => setEditor(null)}
            cookRecipe={cookRecipeFor(editor.task)}
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
              // a milestone in a calendar day or search; saving
              // closes it and leaves the person where they were
              upsert(p)
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
              upsert(p)
              for (const t of ts) upsert(t)
              setProjectEditor(null)
              // a template or a drafted plan just added a batch of dated tasks
              // to the project: the Board shows them together, and the toast
              // says how many
              goTasksTab('board')
              setView('tasks')
              showToast(`Added ${ts.length} task${ts.length === 1 ? '' : 's'} to “${p.name}”`)
            }}
            onSaveTemplate={t => {
              upsert(t)
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
            onSavePlace={p => upsert(p)}
            onSavePerson={p => upsert(p)}
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
            // their card opens on the People segment, as a place's row does on Places
            onOpenPerson={person => openPerson(person.id)}
            places={store.places}
            onOpenPlace={p => openPlace(p.id)}
            journal={store.journal}
            onOpenJournal={e => openJournal(e.date)}
            notes={store.notes}
            onOpenNote={n => openNote(n.id)}
            // your clothes and saved outfits: a piece opens its sheet, an
            // outfit today's composer with it in the rows
            garments={store.garments}
            outfits={store.outfits}
            onOpenGarment={g => openWardrobe({ tab: 'clothes', garmentId: g.id })}
            onOpenOutfit={o => openWardrobe({ outfitId: o.id, date: today })}
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
            people={store.people}
            onSavePerson={p => upsert(p)}
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
            tasks={store.tasks}
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
            onNewForToday={() => {
              const d = new Date()
              d.setHours(18, 0, 0, 0)
              newTask({ dueAt: d.toISOString(), focusOn: today, focusBy: household.myId ?? undefined })
            }}
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
            tasks={store.tasks}
            projects={store.projects}
            reviews={store.reviews}
            routines={store.routines}
            journal={store.journal}
            people={store.people}
            today={today}
            tomorrow={shiftDayKey(today, 1)}
            myId={household.myId}
            onSaveRoutine={r => upsert(r)}
            onSaveJournal={e => upsert(e)}
            onDeleteJournal={id => {
              remove(id)
              showToast(trashedLine(null, 'Journal entry'), () => restore([id]))
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

      {sheet?.kind === 'imhere' && (
        <Layer name="I'm here">
          <ImHereSheet
            places={store.places}
            people={store.people}
            onSavePlace={p => upsert(p)}
            onLog={(place, peopleIds, note, here) => {
              closeSheet()
              if (here && place.lat == null && place.lon == null) {
                upsert({ ...place, lat: here.lat, lon: here.lon, updatedAt: newerStamp(place.updatedAt) })
              }
              logOuting({
                at: new Date().toISOString(),
                title: note || `At ${place.name}`,
                placeId: place.id,
                peopleIds,
              })
            }}
            onClose={closeSheet}
          />
        </Layer>
      )}

      {/* Who, and how often: Save hands back the rows that changed, written
          here with one toast and one Undo; Find missing addresses saves each
          pick as it is made */}
      {sheet?.kind === 'rhythms' && (
        <Layer name="Who, and how often">
          <RhythmSheet
            people={store.people}
            places={store.places}
            tasks={store.tasks}
            entries={store.events}
            meals={store.meals}
            // whose visits the suggestions read (v3.24)
            myId={household.myId}
            side={sheet.side}
            onSavePlace={place => upsert(place)}
            onSave={changes => {
              closeSheet()
              for (const c of changes) upsert(c.after)
              showToast(rhythmsSaved(changes), () => {
                for (const c of changes) upsert({ ...c.before, updatedAt: newerStamp(c.after.updatedAt) })
              })
            }}
            onClose={closeSheet}
          />
        </Layer>
      )}

      {/* The hub: a tap marks a notice read — a newer stamp, so the reader's
          other devices take it — and opens what it is about, closing first */}
      {sheet?.kind === 'notices' && (
        <Layer name="Notifications">
          <NoticesSheet
            notices={store.notices}
            tasks={store.tasks}
            people={store.people}
            places={store.places}
            meals={store.meals}
            events={store.events}
            myId={household.myId}
            onRead={n => upsert({ ...n, readAt: new Date().toISOString(), updatedAt: newerStamp(n.updatedAt) })}
            onReadAll={ns => {
              const at = new Date().toISOString()
              for (const n of ns) upsert({ ...n, readAt: at, updatedAt: newerStamp(n.updatedAt) })
            }}
            onOpen={hubOpener(p, closeSheet)}
            onClose={closeSheet}
          />
        </Layer>
      )}

      {sheet?.kind === 'ask' && (
        <Layer name="Ask Drafter">
          <AskSheet
            key={sheet.question ?? ''}
            initialQuestion={sheet.question}
            // your own events are items already: ask.ts skips a feed's copy of
            // one (localId). The wardrobe is yours alone, as the journal is, but
            // nothing you wrote, so it goes whatever the Journal chip says
            sources={{
              tasks: store.tasks,
              projects: store.projects,
              people: store.people,
              places: store.places,
              recipes: store.recipes,
              meals: store.meals,
              entries: store.events,
              feedEvents: allEvents,
              journal: store.journal,
              garments: store.garments,
              outfits: store.outfits,
              wears: store.wears,
              myId: store.myId,
            }}
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
              restore([id])
              // A restored entry goes back out to the mirrors too, or it lives only in
              // Drafter. Pushed as the live, newer record so the providers take it.
              if (row?.kind === 'event') mirrorEvent({ ...row, deletedAt: undefined, updatedAt: newerStamp(row.updatedAt) }, { revive: true })
              showToast('Restored')
            }}
            onPurge={id => {
              // read first: the purge leaves a content-free tombstone in its place
              const row = store.allItems.find(x => x.id === id)
              // queued until the server takes it: offline or refused, it stays unsynced and is retried
              void purge([id]).then(done => {
                showToast(done ? 'Deleted forever' : 'Deleted here — it will be deleted everywhere at the next sync')
                // a piece of clothing's photos, front and back, go with it, from this device and the bucket
                if (row?.kind === 'garment') void deleteMedia(mediaIdsOf(row))
              })
            }}
            onClose={() => setTrashOpen(false)}
          />
        </Layer>
      )}

    </>
  )
}
