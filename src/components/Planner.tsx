import { useEffect, useMemo } from 'react'
import { useItems } from '../store'
import { getSupabase } from '../supabase'
import { clearLocalData } from '../idb'
import { projectById } from '../taskutils'
import { useHousehold } from '../household'
import { ErrorBoundary } from './ErrorBoundary'
import { PullToRefresh } from './PullToRefresh'
import { forgetRetiredKeys } from '../retiredkeys'
import { buildPaletteCommands } from './planner/commands'
import type { PlannerCtx } from './planner/ctx'
import { CalendarScreen } from './planner/CalendarScreen'
import { HomeScreen } from './planner/HomeScreen'
import { KitchenScreen } from './planner/KitchenScreen'
import { Overlays } from './planner/Overlays'
import { PeopleScreen } from './planner/PeopleScreen'
import { VIEW_LABELS } from './planner/routes'
import { TasksScreen } from './planner/TasksScreen'
import { Toast } from './planner/Toast'
import { TopBar } from './planner/TopBar'
import { useCalendarSync } from './planner/useCalendarSync'
import { useDeepLinks } from './planner/useDeepLinks'
import { useLifeActions } from './planner/useLifeActions'
import { useMineOnly } from './planner/useMineOnly'
import { useNativeShell } from './planner/useNativeShell'
import { useNavigation } from './planner/useNavigation'
import { useOverlays } from './planner/useOverlays'
import { useOwner } from './planner/useOwner'
import { useTaskActions } from './planner/useTaskActions'
import { useToast } from './planner/useToast'

export default function Planner() {
  const household = useHousehold()
  const store = useItems(household.myId)
  const mine = useMineOnly({ store, household })

  // the multi-project bar is gone; a filter a device saved before the update
  // must not silently hide tasks, so it is dropped rather than read
  useEffect(() => forgetRetiredKeys(), [])
  const nav = useNavigation()
  const toaster = useToast({ store })
  const { showToast } = toaster

  const projectMap = useMemo(() => projectById(store.projects), [store.projects])
  const cal = useCalendarSync({ store, household, showToast })
  const overlays = useOverlays()
  const owner = useOwner()

  const { applyLinkRef } = useDeepLinks({
    store,
    showToast,
    ...nav,
    ...overlays,
    // useTaskActions makes these further down, so its GitHub effects still
    // mount last; a link only ever runs after render, when both exist
    changeStatus: (id, status) => taskActions.changeStatus(id, status),
    defer: (id, day) => taskActions.defer(id, day),
  })
  useNativeShell({ store, applyLinkRef })

  const lifeActions = useLifeActions({ store, showToast, newTask: overlays.newTask })
  const taskActions = useTaskActions({
    store,
    showToast,
    setEditor: overlays.setEditor,
    setProjectEditor: overlays.setProjectEditor,
    setNotesProjectId: nav.setNotesProjectId,
  })

  // Everything the top bar, the screens and the overlays read, rebuilt every
  // render and handed down as one prop (see planner/ctx.ts).
  const p: PlannerCtx = {
    store,
    household,
    projectMap,
    paletteCommands: buildPaletteCommands(nav, overlays),
    ...mine,
    ...nav,
    ...toaster,
    ...cal,
    ...overlays,
    ...owner,
    ...lifeActions,
    ...taskActions,
  }
  // what the shell itself reads: the screen switch, the Mine note, pull to refresh, the toast
  const { view, mineOnly, setMineOnly, inHousehold, manualSync, anyOpen, toast, setToast } = p

  return (
    <div className="app">
      <TopBar p={p} />

      {store.syncInfo.authError && (
        <div className="auth-banner">
          Your session expired — changes are staying on this device only.
          <button
            className="btn"
            onClick={async () => {
              await getSupabase()?.auth.signOut()
              await clearLocalData()
              window.location.reload()
            }}
          >
            Sign in again
          </button>
        </div>
      )}

      {/* iOS: drag down from the top of a tab to refresh — the same set the
          foreground resume runs. Off while an editor or sheet owns the screen;
          the day sheet lives inside main and is refused by the touch target. */}
      <PullToRefresh enabled={!anyOpen} onRefresh={manualSync} />

      <main className="content">
        {store.loaded && (
          <ErrorBoundary where={VIEW_LABELS[view]} resetKey={view}>
            {/* Mine is remembered across launches and the switch lives on Tasks,
                so a Home or Calendar that opens already narrowed says so — and
                offers the way off — rather than quietly hiding the others' tasks */}
            {inHousehold && mineOnly && (view === 'home' || view === 'calendar') && (
              <button type="button" className="mine-note" onClick={() => setMineOnly(false)}>
                Showing only your tasks · Show everyone
              </button>
            )}
            {view === 'home' && <HomeScreen p={p} />}
            {view === 'calendar' && <CalendarScreen p={p} />}
            {view === 'tasks' && <TasksScreen p={p} />}
            {view === 'people' && <PeopleScreen p={p} />}
            {view === 'kitchen' && <KitchenScreen p={p} />}
          </ErrorBoundary>
        )}
      </main>

      <Overlays p={p} />

      <Toast toast={toast} setToast={setToast} />
    </div>
  )
}
