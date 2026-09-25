import { memberName } from '../../household'
import { recipeStarred } from '../../kitchen'
import type { PlannerCtx } from './ctx'
import { Calendar } from './lazy'

/** Calendar: the month and week grids, or one day in full. */
export function CalendarScreen({ p }: { p: PlannerCtx }) {
  const { store, household, projectMap, allEvents, sourceMap, calMode, setCalMode, calendarOpenDay, setCalendarOpenDay } = p
  const { openTask, newTask, openProject, setEventEditor, setAttendance, reschedule, openWardrobe } = p
  const { saveMeal, clearMeal, createPlaceInline, createRecipeInline, planForEvent, planOccasion } = p
  return (
    <>
      <div className="segmented cal-mode" role="tablist" aria-label="Calendar mode">
        <button type="button" role="tab" aria-selected={calMode === 'month'} className={calMode === 'month' ? 'seg on' : 'seg'} onClick={() => setCalMode('month')}>
          Month
        </button>
        <button type="button" role="tab" aria-selected={calMode === 'week'} className={calMode === 'week' ? 'seg on' : 'seg'} onClick={() => setCalMode('week')}>
          Week
        </button>
        <button type="button" role="tab" aria-selected={calMode === 'day'} className={calMode === 'day' ? 'seg on' : 'seg'} onClick={() => setCalMode('day')}>
          Day
        </button>
      </div>
      <Calendar
        view={calMode}
        tasks={store.tasks}
        // every task, for the day sheet's "Gift planned" alone: a gift someone
        // else in the household is buying still covers the day
        projects={store.projects}
        projectMap={projectMap}
        people={store.people}
        meals={store.meals}
        myId={household.myId}
        nameOf={id => memberName(household.info, id)}
        inHousehold={p.inHousehold}
        // who's cooking a shared dish, in the day sheet's meal picker
        members={p.inHousehold ? (household.info?.members ?? []) : []}
        recipes={store.recipes}
        places={store.places}
        onSaveMeal={saveMeal}
        onClearMeal={clearMeal}
        onCreatePlace={createPlaceInline}
        onCreateRecipe={createRecipeInline}
        onStarRecipe={r => p.upsert(recipeStarred(r, !r.favourite))}
        onNewEvent={(startIso, work) => setEventEditor({ startIso, work })}
        onEditEvent={id => {
          const entry = store.events.find(e => e.id === id)
          if (entry) setEventEditor({ entry, startIso: entry.start })
        }}
        events={allEvents}
        sourceMap={sourceMap}
        onOpen={openTask}
        onNew={d => newTask({ status: 'todo', dueAt: d })}
        onReschedule={reschedule}
        onPlan={planForEvent}
        onAttendance={ev => setAttendance(ev)}
        onOpenProject={openProject}
        onPlanOccasion={planOccasion}
        // what you wore: one small line on a day in the week list and the day
        // sheet, which opens Home → Wardrobe on that day
        garments={store.garments}
        wears={store.wears}
        onOpenWardrobe={openWardrobe}
        // a day the month calendar in People → Stats or Places → Stats opened, its day sheet up
        openDay={calendarOpenDay}
        onOpenDayConsumed={() => setCalendarOpenDay(null)}
      />
    </>
  )
}
