import { useMemo } from 'react'
import { newerStamp } from '../../itemops'
import { liveById, retired, saveOutfit, wearIndex } from '../../wardrobe'
import { outfitLabel } from '../../../shared/wardrobe.mts'
import { useDayKey } from '../../useDayKey'
import type { PlannerCtx } from './ctx'
import type { AreaProps } from '../StatsLens'

/**
 * Insights → Stats: the one place that adds nothing. Every figure the app
 * keeps is in here — the Highlights first, then a page each for tasks, money,
 * people, places, the kitchen, the wardrobe, habits and the journal, and the
 * year. Nothing sends you to another tab to read the rest.
 *
 * The four areas that keep Stats inside themselves are drawn by the lens from
 * THEIR OWN components, so there is one view and one chunk of each wherever it
 * is shown, and one set of numbers. What they need that the lens has no
 * business knowing — the lists' filters, the writes, the ways into a record —
 * is gathered here and handed over as one `areas` prop.
 *
 * Whose figures these are was never in question, so the lens reads
 * store.tasks — the same list Home, the Calendar and Tasks now read.
 *
 * Events are store.events, the ones written here — the same list People's own
 * Stats count seeing someone by. A subscribed calendar's entries are someone
 * else's record of a day and carry nobody from this planner, so they count in
 * neither place.
 */
export function StatsScreen({ p }: { p: PlannerCtx }) {
  const { StatsLens } = p.views
  const { store, upsert, remove, household, inHousehold, statsTab, goStatsTab, setView, goTasksTab, showToast } = p
  const { insightsPeriod, setInsightsPeriod, insightsAt, setInsightsAt } = p
  const { peopleFilter, setPeopleFilter, placeFilter, setPlaceFilter } = p
  const { openPerson, openPlace, openCalendarDay, openKitchen, openKitchenDay, openWardrobe, setKitchenRecipe, sawThem, planAt } = p

  // What the wardrobe's figures are read from. Wardrobe.tsx works these out for
  // itself; here they are the screen's, so the lens stays a view.
  // The day key is a dependency of the index, as it is in Wardrobe.tsx:
  // store.wears keeps its identity when a sync changes nothing, so an index
  // memoized on the list alone would still call yesterday "today" after
  // midnight on a device left open. And it comes from useDayKey, not
  // localDayKey() read as this renders, which the React Compiler keeps from
  // the first render on — the same yesterday by another road.
  const today = useDayKey()
  const byId = useMemo(() => liveById(store.garments), [store.garments])
  const wearIx = useMemo(() => wearIndex(store.wears, today), [store.wears, today])

  const areas: AreaProps = {
    peopleFilter,
    onPeopleFilter: setPeopleFilter,
    placeFilter,
    onPlaceFilter: setPlaceFilter,
    onOpenPerson: person => openPerson(person.id),
    onOpenPlace: place => openPlace(place.id),
    onOpenDay: openCalendarDay,
    onSaw: sawThem,
    onPlanAt: planAt,
    // cook mode lives in the Kitchen, so a recipe opened here goes there — the
    // same landing Today's "tonight's dinner" makes
    onOpenRecipe: recipe => {
      setKitchenRecipe(recipe)
      openKitchen()
    },
    // …and a dinner day lands on This week, framed, exactly as it does when
    // the same calendar is tapped inside the Kitchen's own Stats
    onGoMealDay: openKitchenDay,
    onOpenPiece: id => openWardrobe({ tab: 'clothes', garmentId: id }),
    onGoWearDay: day => openWardrobe({ date: day }),
    // Retiring changes no photo (it only stamps archivedAt), so this needs none
    // of the wardrobe's swap-and-let-go machinery — just the write and its Undo.
    // The Undo is stamped newer than the write it undoes, not newer than the
    // piece it was made on: newerStamp is max(now, prev + 1), so two writes in
    // the same millisecond would tie, and a tie loses the last-write-wins merge
    // — the piece would stay retired with no sign anything went wrong.
    onRetirePiece: g => {
      const gone = retired(g, true)
      upsert(gone)
      showToast(`Retired ${g.name}`, () => upsert({ ...retired(g, false), updatedAt: newerStamp(gone.updatedAt) }))
    },
    // the same rule the composer's Save follows: an outfit already saved is
    // named back rather than saved twice
    onSaveOutfit: pieces => {
      const { outfit, reused } = saveOutfit(store.outfits, pieces)
      if (reused) {
        showToast(`Already saved as “${outfit.name || outfitLabel(outfit.garmentIds, byId)}”`)
        return
      }
      upsert(outfit)
      showToast('Outfit saved', () => remove(outfit.id))
    },
    byId,
    wearIx,
  }

  return (
    <StatsLens
      tab={statsTab}
      onOpen={goStatsTab}
      tasks={store.tasks}
      people={store.people}
      places={store.places}
      events={store.events}
      meals={store.meals}
      recipes={store.recipes}
      groceries={store.groceries}
      journal={store.journal}
      habits={store.habits}
      garments={store.garments}
      outfits={store.outfits}
      wears={store.wears}
      onTasks={() => {
        // the tile that sends you here counts overdue TASKS, so it lands on the
        // list. goTasksTab, not setTasksTab: a jump moves the segment for this
        // visit only, as the palette's own Tasks row does — otherwise you land
        // on Bills or Notes and none of the tasks it counted are in sight.
        goTasksTab('list')
        setView('tasks')
      }}
      areas={areas}
      // whose records the figures count: tasks, money and meals are the
      // household's, who saw whom and where they went is this account's own
      // (v3.24), and in a household the Highlights say so in a line
      myId={household.myId}
      household={inHousehold}
      period={insightsPeriod}
      onPeriod={setInsightsPeriod}
      at={insightsAt}
      onAt={setInsightsAt}
    />
  )
}
