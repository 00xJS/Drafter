import { useState } from 'react'
import { NO_PERSON_FILTER, personMatcher, type PersonFilter } from '../../people'
import { NO_PLACE_FILTER, placeMatcher, type PlaceFilter } from '../../places'
import type { PlannerCtx } from './ctx'
import { People, PeopleStats, Places, PlacesStats } from './lazy'
import { ListStatsSwitch } from './ListStatsSwitch'

/** People, with Places as its second segment; each segment has its own List · Stats. */
export function PeopleScreen({ p }: { p: PlannerCtx }) {
  const { store, showToast, peopleTab, setPeopleTab, placeOpenId, setPlaceOpenId, personOpenId, setPersonOpenId, openPlace, openPerson, openJournal } = p
  const { openTask, newTask, logOuting, logVisit, sawThem, planAt, planWith, setEventEditor, innerViews, setInnerView, openCalendarDay, inHousehold, mineOnly } = p
  // Each list's find box and chip, held here rather than in the list, so its
  // Stats counts only the rows they leave and List → Stats → List keeps them.
  // For this visit only: nothing is saved, and leaving the tab clears them,
  // as it cleared the list's own.
  const [peopleFilter, setPeopleFilter] = useState<PersonFilter>(NO_PERSON_FILTER)
  const [placeFilter, setPlaceFilter] = useState<PlaceFilter>(NO_PLACE_FILTER)
  // A card or a row asked for (from search, Ask, a reminder, a link or a row
  // on Stats) is never hidden by them. One they would hide clears them as it
  // arrives, before the list draws, so it opens with the first paint whichever
  // half was showing. One they leave keeps them, as every row Stats draws is,
  // so Stats → a row → List still holds what was typed and pressed.
  const [asked, setAsked] = useState({ person: personOpenId, place: placeOpenId })
  if (asked.person !== personOpenId || asked.place !== placeOpenId) {
    setAsked({ person: personOpenId, place: placeOpenId })
    // one not in the store yet clears them too, so nothing hides it when it lands
    const person = store.people.find(x => x.id === personOpenId)
    if (personOpenId && !(person && personMatcher(peopleFilter)(person))) setPeopleFilter(NO_PERSON_FILTER)
    const place = store.places.find(x => x.id === placeOpenId)
    if (placeOpenId && !(place && placeMatcher(store.places, placeFilter)(place))) setPlaceFilter(NO_PLACE_FILTER)
  }
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
      {peopleTab === 'places' ? (
        <>
          {/* remembered as the segments are: chosen here, and nowhere else */}
          <ListStatsSwitch label="Places list or stats" value={innerViews.places} onChange={v => setInnerView('places', v)} />
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
              // with Mine on in a household the Calendar a day opens shows only your tasks, while these count everyone's outings
              mineOnCalendar={inHousehold && mineOnly}
            />
          ) : (
            <Places
              places={store.places}
              people={store.people}
              tasks={store.tasks}
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
              onNewTask={preset => newTask(preset)}
            />
          )}
        </>
      ) : (
        <>
          {/* remembered as the segments are: chosen here, and nowhere else */}
          <ListStatsSwitch label="People list or stats" value={innerViews.people} onChange={v => setInnerView('people', v)} />
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
              // with Mine on in a household the Calendar a day opens shows only your tasks, while these count everyone's visits
              mineOnCalendar={inHousehold && mineOnly}
            />
          ) : (
            <People
              people={store.people}
              places={store.places}
              tasks={store.tasks}
              entries={store.events}
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
            />
          )}
        </>
      )}
    </>
  )
}
