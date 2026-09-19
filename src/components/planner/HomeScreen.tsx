import { newerStamp } from '../../itemops'
import { localDayKey } from '../../journal'
import { JournalView } from '../Journal'
import { Today } from '../Today'
import type { PlannerCtx } from './ctx'
import { Review, Wardrobe } from './lazy'

/** Home is the day. Week, Journal and Wardrobe open from its cards (and from
 *  a link or the palette) as a page with a way back — not as peer tabs that
 *  split the same 18 hours four ways. */
export function HomeScreen({ p }: { p: PlannerCtx }) {
  const { store, household, allEvents, sourceMap, showToast } = p
  const { homeTab, setHomeTab, journalOpenDate, setJournalOpenDate, setView, setKitchenRecipe, openJournal, wardrobeOpen, setWardrobeOpen, openWardrobe } = p
  const { openTask, newTask, changeStatus, defer, deferAll } = p
  const { planWith, wentTo, planAt, planOccasion, sawThem, planForEvent } = p
  const { openSheet, deferFromFocus, planMealIdea } = p
  const { syncAlarm, dismissSyncAlarm, setAdminOpen } = p
  return (
    <>
      {homeTab !== 'today' && (
        <button type="button" className="btn subtle notes-back" onClick={() => setHomeTab('today')}>
          Today
        </button>
      )}
      {homeTab === 'today' && (
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
          onSaveReview={r => store.upsert(r)}
          projects={store.projects}
          events={allEvents}
          sourceMap={sourceMap}
          onPlan={planForEvent}
          onOpen={openTask}
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
            store.upsert(w)
            // Undo takes a new look away, or writes back the look an edit was made on, stamped newer again
            if (msg !== null) showToast(msg, () => (before ? store.upsert({ ...before, updatedAt: newerStamp(w.updatedAt) }) : store.remove(w.id)))
          }}
          onOpenWardrobe={openWardrobe}
          // the owner's sync alarm: the hourly check found the server refusing
          // writes. The banner opens Admin on Data, where the check's card is
          syncAlarm={syncAlarm}
          onDismissSyncAlarm={dismissSyncAlarm}
          onOpenSyncCheck={() => setAdminOpen(true, 'data')}
        />
      )}
      {homeTab === 'week' && (
        <Review
          tasks={store.tasks}
          projects={store.projects}
          people={store.people}
          reviews={store.reviews}
          journal={store.journal}
          places={store.places}
          habits={store.habits}
          entries={store.events}
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
          onNew={preset => newTask(preset)}
          onPlanWeek={() => openSheet({ kind: 'week' })}
          // what you wore that week: a look opens the composer on its day, the
          // most worn piece its sheet
          garments={store.garments}
          wears={store.wears}
          onOpenWardrobe={openWardrobe}
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
      {homeTab === 'wardrobe' && (
        <Wardrobe
          garments={store.garments}
          inTrash={store.garmentsInTrash}
          outfits={store.outfits}
          wears={store.wears}
          myId={household.myId}
          // your work days on the calendar: Outfit dresses them for work
          entries={store.events}
          onSave={item => store.upsert(item)}
          onRemove={id => store.remove(id)}
          onRestore={ids => store.restore(ids)}
          showToast={showToast}
          open={wardrobeOpen}
          onOpenConsumed={() => setWardrobeOpen(null)}
        />
      )}
    </>
  )
}
