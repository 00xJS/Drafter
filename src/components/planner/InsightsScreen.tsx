import { newerStamp } from '../../itemops'
import type { PlannerCtx } from './ctx'
import { JournalView, Review } from './lazy'
import { INSIGHTS_TABS, STATS_PAGE_TITLES } from './routes'
import { PushedScreen } from './PushedScreen'
import { StatsScreen } from './StatsScreen'
import { Segmented } from '../stats/Segmented'

/**
 * Insights: the one tab you never add anything to.
 *
 * Three segments. **Stats** is the lens — every figure the app keeps: the
 * Highlights first, and each area's figures a page pushed over them, with
 * ‹ Back, as Settings and the chat are pushed over a tab (PushedScreen). The
 * tab stays the one you are on: an area's page is Insights', not a screen of
 * its own. **Journal** is the archive of what you wrote. **Review** is the
 * week you just had.
 *
 * The archive sits BESIDE the lens rather than inside it, and that is not
 * tidiness: the lens's own Journal segment says "Counts and moods only —
 * nothing you wrote is shown here", which is a line the journal being personal
 * draws. Figures about the journal and the journal itself are two different
 * things to look at, and only one of them is safe to put on a chart.
 *
 * Both moved here from Home in v3.29, where they were pages hanging off the
 * day. Writing today's line is still Home's — that is capture, and it belongs
 * on the day; reading back what you wrote is this tab's.
 */
export function InsightsScreen({ p }: { p: PlannerCtx }) {
  const { store, upsert, remove, restore, household, showToast, insightsTab, setInsightsTab, statsTab, closeStatsPage } = p
  const { journalOpenDate, setJournalOpenDate, openTask, newTask, changeStatus, openSheet, openWardrobe } = p
  // an area's figures, or the year, pushed over the Highlights: the page and ‹ Back, and no segments
  if (insightsTab === 'stats' && statsTab !== 'highlights') {
    return (
      <PushedScreen title={STATS_PAGE_TITLES[statsTab]} onBack={closeStatsPage}>
        <StatsScreen p={p} />
      </PushedScreen>
    )
  }
  return (
    <>
      <div className="people-tab-seg insights-seg">
        <Segmented items={INSIGHTS_TABS} value={insightsTab} onChange={t => setInsightsTab(t)} label="Insights view" />
      </div>
      {insightsTab === 'stats' && <StatsScreen p={p} />}
      {insightsTab === 'journal' && (
        <JournalView
          entries={store.journal}
          people={store.people}
          onSave={(e: Parameters<typeof upsert>[0]) => upsert(e)}
          onDelete={(id: string) => {
            remove(id)
            showToast('Journal entry removed', () => restore([id]))
          }}
          openDate={journalOpenDate}
          onOpenDateConsumed={() => setJournalOpenDate(null)}
        />
      )}
      {insightsTab === 'review' && (
        <Review
          tasks={store.tasks}
          projects={store.projects}
          people={store.people}
          reviews={store.reviews}
          journal={store.journal}
          places={store.places}
          habits={store.habits}
          entries={store.events}
          // whose week this is: who you saw and where you went are yours (v3.24)
          myId={household.myId}
          onSaveReview={r => upsert(r)}
          onOpen={openTask}
          onStatus={changeStatus}
          onReschedule={(ids, dueAt) => {
            for (const id of ids) {
              const t = store.tasks.find(x => x.id === id)
              if (t) upsert({ ...t, dueAt, status: t.status === 'wishlist' ? 'todo' : t.status, updatedAt: newerStamp(t.updatedAt) })
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
    </>
  )
}
