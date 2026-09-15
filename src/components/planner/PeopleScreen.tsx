import type { PlannerCtx } from './ctx'
import { People, Places, PlacesStats } from './lazy'
import { PLACES_VIEWS } from './routes'

/** People, with Places as its second segment, and Places' own List · Stats. */
export function PeopleScreen({ p }: { p: PlannerCtx }) {
  const { store, showToast, peopleTab, setPeopleTab, placesView, setPlacesView, placeOpenId, setPlaceOpenId, personOpenId, setPersonOpenId, openPlace, openPerson, openJournal } = p
  const { openTask, newTask, logOuting, logVisit, planAt, planWith, setEventEditor, openCalendarDay } = p
  return (
    <>
      <div className="people-tab-seg">
        <span className="segmented" role="tablist" aria-label="People view">
          <button
            type="button"
            role="tab"
            aria-selected={peopleTab === 'people'}
            className={peopleTab === 'people' ? 'seg on' : 'seg'}
            onClick={() => setPeopleTab('people')}
          >
            People
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={peopleTab === 'places'}
            className={peopleTab === 'places' ? 'seg on' : 'seg'}
            onClick={() => setPeopleTab('places')}
          >
            Places
          </button>
        </span>
      </div>
      {peopleTab === 'places' && (
        // the wardrobe's small switch inside the segment, remembered as the segments are
        <div className="stats-bar">
          <span className="segmented stats-seg" role="tablist" aria-label="Places view">
            {PLACES_VIEWS.map(v => (
              <button key={v.key} type="button" role="tab" aria-selected={placesView === v.key} className={placesView === v.key ? 'seg on' : 'seg'} onClick={() => setPlacesView(v.key)}>
                {v.label}
              </button>
            ))}
          </span>
        </div>
      )}
      {peopleTab === 'places' ? (
        placesView === 'stats' ? (
          <PlacesStats
            // the records the list is handed, so each figure agrees with its row
            places={store.places}
            people={store.people}
            tasks={store.tasks}
            meals={store.meals}
            onOpenPlace={place => openPlace(place.id)}
            onPlan={planAt}
            onOpenPerson={person => openPerson(person.id)}
            onOpenDay={openCalendarDay}
          />
        ) : (
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
        )
      ) : (
        <People
          people={store.people}
          places={store.places}
          tasks={store.tasks}
          entries={store.events}
          journal={store.journal}
          onOpenJournal={date => openJournal(date)}
          onSave={p => store.upsert(p)}
          onDelete={id => {
            store.remove(id)
            showToast('Removed', () => store.restore([id]))
          }}
          onSavePlace={p => store.upsert(p)}
          // Places with that row open, as search opens one; the segment moves
          // for this visit only, like any link to it
          onOpenPlace={place => openPlace(place.id)}
          onLogVisit={logVisit}
          onPlan={planWith}
          onOpenTask={openTask}
          onOpenEntry={e => setEventEditor({ entry: e, startIso: e.start })}
          // a person picked in search (or Ask, or a reminder) arrives with their card open
          openId={personOpenId}
          onOpenConsumed={() => setPersonOpenId(null)}
        />
      )}
    </>
  )
}
