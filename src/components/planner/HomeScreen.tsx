import { newerStamp } from '../../itemops'
import { localDayKey } from '../../journal'
import { JournalView } from '../Journal'
import { Today } from '../Today'
import type { PlannerCtx } from './ctx'
import { Review } from './lazy'
import { HOME_TABS } from './routes'

/** Home: the day, the week's look-back and the journal, three segments of one tab. */
export function HomeScreen({ p }: { p: PlannerCtx }) {
  const { store, household, projectMap, filteredTasks, allEvents, sourceMap, showToast } = p
  const { homeTab, setHomeTab, journalOpenDate, setJournalOpenDate, setView, setKitchenRecipe, openJournal } = p
  const { openTask, newTask, openProject, newProject, changeStatus, defer, deferAll } = p
  const { planWith, wentTo, planAt, planOccasion, sawThem, planForEvent } = p
  const { openSheet, deferFromFocus, planMealIdea } = p
  return (
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
          onPlanWeek={() => openSheet({ kind: 'week' })}
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
  )
}
