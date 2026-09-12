import type { PlannerCtx } from './ctx'
import { Calendar, Roadmap } from './lazy'

/** Calendar: the month and week grids, or the projects' timeline. */
export function CalendarScreen({ p }: { p: PlannerCtx }) {
  const { store, projectMap, filteredTasks, allEvents, sourceMap, calMode, setCalMode } = p
  const { openTask, newTask, openProject, newProject, setEventEditor, setAttendance, reschedule } = p
  const { saveMeal, clearMeal, createPlaceInline, createRecipeInline, planForEvent, planOccasion } = p
  return (
    <>
      <div className="segmented cal-mode" role="tablist" aria-label="Calendar mode">
        <button className={calMode === 'month' ? 'seg on' : 'seg'} onClick={() => setCalMode('month')}>
          Month
        </button>
        <button className={calMode === 'week' ? 'seg on' : 'seg'} onClick={() => setCalMode('week')}>
          Week
        </button>
        <button className={calMode === 'timeline' ? 'seg on' : 'seg'} onClick={() => setCalMode('timeline')}>
          Timeline
        </button>
      </div>
      {calMode !== 'timeline' ? (
        <Calendar
          view={calMode}
          tasks={filteredTasks}
          projects={store.projects}
          projectMap={projectMap}
          people={store.people}
          meals={store.meals}
          recipes={store.recipes}
          places={store.places}
          onSaveMeal={saveMeal}
          onClearMeal={clearMeal}
          onCreatePlace={createPlaceInline}
          onCreateRecipe={createRecipeInline}
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
        />
      ) : (
        <Roadmap
          projects={store.projects}
          tasks={store.tasks}
          events={allEvents}
          sourceMap={sourceMap}
          onOpenProject={openProject}
          onNewProject={newProject}
          onOpenTask={openTask}
        />
      )}
    </>
  )
}
