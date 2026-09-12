import type { PlannerCtx } from './ctx'
import { People, Places } from './lazy'

/** People, with Places as its second segment. */
export function PeopleScreen({ p }: { p: PlannerCtx }) {
  const { store, showToast, peopleTab, setPeopleTab, placeOpenId, setPlaceOpenId, openJournal } = p
  const { openTask, newTask, logOuting, logVisit, planAt, planWith } = p
  return (
    <>
      <div className="people-tab-seg">
        <span className="segmented">
          <button
            type="button"
            className={peopleTab === 'people' ? 'seg on' : 'seg'}
            onClick={() => setPeopleTab('people')}
          >
            People
          </button>
          <button
            type="button"
            className={peopleTab === 'places' ? 'seg on' : 'seg'}
            onClick={() => setPeopleTab('places')}
          >
            Places
          </button>
        </span>
      </div>
      {peopleTab === 'places' ? (
        <Places
          places={store.places}
          people={store.people}
          tasks={store.tasks}
          meals={store.meals}
          onSave={p => store.upsert(p)}
          onDelete={id => {
            store.remove(id)
            showToast('Removed', () => store.restore([id]))
          }}
          onLogOuting={(place, at, note, peopleIds) =>
            logOuting({
              at,
              title: note || `Went to ${place.name}`,
              placeId: place.id,
              peopleIds,
            })
          }
          onPlan={planAt}
          onOpenTask={openTask}
          openId={placeOpenId}
          onOpenConsumed={() => setPlaceOpenId(null)}
          onNewTask={preset => newTask(preset)}
        />
      ) : (
        <People
          people={store.people}
          places={store.places}
          tasks={store.tasks}
          journal={store.journal}
          onOpenJournal={date => openJournal(date)}
          onSave={p => store.upsert(p)}
          onDelete={id => {
            store.remove(id)
            showToast('Removed', () => store.restore([id]))
          }}
          onSavePlace={p => store.upsert(p)}
          onLogVisit={logVisit}
          onPlan={planWith}
          onOpenTask={openTask}
        />
      )}
    </>
  )
}
