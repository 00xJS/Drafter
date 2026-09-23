import { memberName } from '../../household'
import { newerStamp } from '../../itemops'
import { localDayKey } from '../../journal'
import { Today } from '../Today'
import type { PlannerCtx } from './ctx'

/** A Home + New task is due this evening, so it lands on the day, not the Inbox. */
function todayEveningIso(): string {
  const d = new Date()
  d.setHours(18, 0, 0, 0)
  return d.toISOString()
}

/**
 * Home IS the day — one screen, no segments.
 *
 * It held four pages at v3.28: the day, the week, the journal and the chat.
 * The Week and the Journal archive are Insights' now, the Wardrobe is Keep's
 * and the Chat is a sheet off the top bar, reachable from every tab rather
 * than from this one. What stays is the day and its chips, and the chips still
 * link to all of them — linking is not owning.
 */
export function HomeScreen({ p }: { p: PlannerCtx }) {
  // the lists from the store; the callbacks on its actions, so they stay the
  // same through every edit and sync round and Today is not drawn again for them
  const { store, upsert, remove, restore, household, allEvents, sourceMap, showToast, goTasksTab } = p
  const { setView, setKitchenRecipe, openJournal, openReview, openKitchen, openWardrobe } = p
  const { openTask, newTask, changeStatus, defer, deferAll } = p
  const { planWith, wentTo, planAt, planOccasion, sawThem, planForEvent, snooze } = p
  const { openSheet, deferFromFocus, planMealIdea } = p
  const { syncAlarm, dismissSyncAlarm, setAdminOpen, calendarSignIn, dismissCalendarSignIn, openSettings } = p
  return (
    <Today
          tasks={store.tasks}
          people={store.people}
          places={store.places}
          reviews={store.reviews}
          onPlanWith={planWith}
          onWentTo={wentTo}
          onPlanAt={planAt}
          onPlanOccasion={planOccasion}
          onSaw={sawThem}
          onSaveReview={r => upsert(r)}
          projects={store.projects}
          events={allEvents}
          sourceMap={sourceMap}
          onPlan={planForEvent}
          onOpen={openTask}
          onStatus={changeStatus}
          onDefer={defer}
          onDeferAll={deferAll}
          onNew={preset => newTask(preset ?? { dueAt: todayEveningIso() })}
          onOpenTasks={() => setView('tasks')}
          meals={store.meals}
          recipes={store.recipes}
          onOpenKitchen={() => openKitchen()}
          onOpenReview={openReview}
          onCookRecipe={r => {
            setKitchenRecipe(r)
            openKitchen()
          }}
          journal={store.journal}
          onSaveJournal={e => upsert(e)}
          onDeleteJournal={id => {
            remove(id)
            showToast('Journal entry removed', () => restore([id]))
          }}
          onOpenJournal={() => openJournal(localDayKey())}
          name={household.info?.me.displayName ?? undefined}
          // whose work day is whose on the briefing strip (v3.24)
          nameOf={id => memberName(household.info, id)}
          habits={store.habits}
          onSaveHabit={h => upsert(h)}
          onDeleteHabit={id => {
            remove(id)
            showToast('Habit removed', () => restore([id]))
          }}
          routines={store.routines}
          onSaveRoutine={r => upsert(r)}
          onDeleteRoutine={id => {
            remove(id)
            showToast('Routine removed', () => restore([id]))
          }}
          // the daily routines: whose focus is whose, each focus task's time
          // block, the strip's Plan my day / Shut down, Sunday's Plan next
          // week, and the focus card's and the meal ideas' own moves
          myId={household.myId}
          entries={store.events}
          onPlanDay={step => openSheet({ kind: 'day', step })}
          onShutDown={() => openSheet({ kind: 'shutdown' })}
          onPlanWeek={() => openSheet({ kind: 'week' })}
          onDeferFromFocus={deferFromFocus}
          onPlanMeal={planMealIdea}
          // what you are wearing: one tap logs a look, or says a plan was worn,
          // with Undo; Pick… and Change open the wardrobe on the day
          garments={store.garments}
          outfits={store.outfits}
          wears={store.wears}
          onLogWear={(w, { before, msg = 'Logged for today' } = {}) => {
            upsert(w)
            // Undo takes a new look away, or writes back the look an edit was made on, stamped newer again
            if (msg !== null) showToast(msg, () => (before ? upsert({ ...before, updatedAt: newerStamp(w.updatedAt) }) : remove(w.id)))
          }}
          onOpenWardrobe={openWardrobe}
          // the owner's sync alarm: the hourly check found the server refusing
          // writes. The banner opens Admin on Data, where the check's card is
          syncAlarm={syncAlarm}
          onDismissSyncAlarm={dismissSyncAlarm}
          onOpenSyncCheck={() => setAdminOpen(true, 'data')}
          // a calendar mirror whose sign-in died: once a streak, and the way to Settings → Calendars
          calendarSignIn={calendarSignIn}
          onDismissCalendarSignIn={dismissCalendarSignIn}
          onOpenCalendarSettings={() => openSettings('calendars')}
          // putting a nudge off: a person, a place or one of the next
          // fortnight's events, for a while and never forever (v3.24)
          snoozes={store.snoozes}
          onSnooze={snooze}
          // under the people nobody has logged yet: Who, and how often, on its People side
          onSetUpRhythms={() => openSheet({ kind: 'rhythms', side: 'people' })}
          // the notes are a Tasks segment; Home is a second way in, not a move
          onOpenNotes={() => {
            goTasksTab('notes')
            setView('tasks')
          }}
          // the notification hub (v3.32): the bell counts, the sheet lists
          notices={store.notices}
          onOpenNotices={() => openSheet({ kind: 'notices' })}
    />
  )
}
