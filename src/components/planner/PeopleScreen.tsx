import type { PlannerCtx } from './ctx'
import { People, PeopleStats, Places, PlacesStats } from './lazy'
import { ListStatsSwitch } from './ListStatsSwitch'

/** Who, and how often, from the List · Stats row: one word, so the row still fits a 375pt phone. */
function RhythmsButton({ onOpen }: { onOpen(): void }) {
  return (
    <button type="button" className="btn" onClick={onOpen} title="Who, and how often">
      Rhythms
    </button>
  )
}

/**
 * Keep's People and Places halves, each with its own List · Stats.
 *
 * The People · Places switch that used to sit at the top of this file is
 * gone: those are two of Keep's four segments now, drawn by KeepScreen, and a
 * second switch under it saying the same two words would be the tab bar's own
 * job done twice.
 */
export function PeopleScreen({ p }: { p: PlannerCtx }) {
  const { store, household, showToast, keepTab, placeOpenId, setPlaceOpenId, personOpenId, setPersonOpenId, openPlace, openPerson, openJournal } = p
  const { openTask, newTask, logOuting, logVisit, sawThem, planAt, planWith, setEventEditor, innerViews, setInnerView, openCalendarDay, openSheet } = p
  // Each list's find box and chip. They live on the shell (useListFilters), not
  // here, because the Stats lens draws these same two Stats in its own tab: a
  // second pair there would let one figure read two ways on one device. A chip
  // pressed on the List, on this segment's Stats or on the lens's is pressed on
  // all three.
  const { peopleFilter, setPeopleFilter, placeFilter, setPlaceFilter } = p
  // the add one-shots live on the shell with the other one-shots (useNavigation)
  const { addPerson, setAddPerson, addAPerson, addPlace, setAddPlace, addAPlace } = p
  return (
    <>
      {keepTab === 'places' ? (
        <>
          {/* remembered as the segments are: chosen here, and nowhere else */}
          <ListStatsSwitch
            label="Places list or stats"
            value={innerViews.places}
            onChange={v => setInnerView('places', v)}
            action={
              <>
                <RhythmsButton onOpen={() => openSheet({ kind: 'rhythms', side: 'places' })} />
                <button type="button" className="btn primary" onClick={addAPlace}>
                  + Add place
                </button>
              </>
            }
          />
          {innerViews.places === 'stats' ? (
            <PlacesStats
              // the records the list is handed, so each figure agrees with its row
              places={store.places}
              people={store.people}
              tasks={store.tasks}
              meals={store.meals}
              // the list's kind chip and find box: every figure counts only the places they leave
              filter={placeFilter}
              onFilter={setPlaceFilter}
              onOpenPlace={place => openPlace(place.id)}
              onPlan={planAt}
              onOpenPerson={person => openPerson(person.id)}
              onOpenDay={openCalendarDay}
              // whose log these figures count (v3.24)
              myId={household.myId}
            />
          ) : (
            <Places
              places={store.places}
              people={store.people}
              tasks={store.tasks}
              // whose outings the rows count (v3.24)
              myId={household.myId}
              meals={store.meals}
              filter={placeFilter}
              onFilter={setPlaceFilter}
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
              openAdd={addPlace}
              onAddConsumed={() => setAddPlace(false)}
              onNewTask={preset => newTask(preset)}
              onImHere={() => openSheet({ kind: 'imhere' })}
            />
          )}
        </>
      ) : (
        <>
          {/* remembered as the segments are: chosen here, and nowhere else */}
          <ListStatsSwitch
            label="People list or stats"
            value={innerViews.people}
            onChange={v => setInnerView('people', v)}
            action={
              <>
                <RhythmsButton onOpen={() => openSheet({ kind: 'rhythms', side: 'people' })} />
                <button type="button" className="btn primary" onClick={addAPerson}>
                  + Add person
                </button>
              </>
            }
          />
          {innerViews.people === 'stats' ? (
            <PeopleStats
              // what the list reads, and nothing personal: every figure agrees with a row
              people={store.people}
              tasks={store.tasks}
              entries={store.events}
              // the list's group chip and find box: every figure counts only the people they leave
              filter={peopleFilter}
              onFilter={setPeopleFilter}
              // Today's Saw them: a visit logged now, with Undo
              onSaw={sawThem}
              // the podium, the bars and the lists open a person's card on the list
              onOpenPerson={person => openPerson(person.id)}
              onOpenDay={openCalendarDay}
              // whose log these figures count (v3.24)
              myId={household.myId}
            />
          ) : (
            <People
              people={store.people}
              places={store.places}
              tasks={store.tasks}
              entries={store.events}
              // whose log the rows count (v3.24)
              myId={household.myId}
              journal={store.journal}
              filter={peopleFilter}
              onFilter={setPeopleFilter}
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
              openAdd={addPerson}
              onAddConsumed={() => setAddPerson(false)}
            />
          )}
        </>
      )}
    </>
  )
}
