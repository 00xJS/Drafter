import { useState } from 'react'
import { NO_PERSON_FILTER, personMatcher, type PersonFilter } from '../../people'
import { NO_PLACE_FILTER, placeMatcher, type PlaceFilter } from '../../places'
import type { Store } from '../../store'

/**
 * The People and Places lists' find boxes and chips, held for the whole shell
 * rather than inside the People tab.
 *
 * They started on PeopleScreen so that a segment's List and its Stats counted
 * the same rows. The Stats lens now draws those same two views in its own tab,
 * and a second pair of filters there would have made the same figure read two
 * ways on one device — which is the one thing a figure must never do. So the
 * pair moved up: People → List, People → Stats and Stats → People all read
 * these, and a chip pressed on any of them is pressed on all three.
 *
 * For this visit only: nothing is saved, and they clear with the page, as the
 * lists' own always did.
 */
export function useListFilters({ store, personOpenId, placeOpenId }: { store: Store; personOpenId: string | null; placeOpenId: string | null }) {
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
  return { peopleFilter, setPeopleFilter, placeFilter, setPlaceFilter }
}
