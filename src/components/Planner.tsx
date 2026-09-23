import { Suspense, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useItems } from '../store'
import { getSupabase } from '../supabase'
import { clearLocalData } from '../idb'
import { retireDue, trackMediaInUse, watchPendingMedia, type MediaInUse } from '../media'
import { projectById } from '../taskutils'
import { useHousehold } from '../household'
import { ErrorBoundary } from './ErrorBoundary'
import { PullToRefresh } from './PullToRefresh'
import { useSignOut } from './SignOutGuard'
import { forgetRetiredKeys } from '../retiredkeys'
import { garmentMediaIds } from '../../shared/media.mjs'
import { usePlannerCtx } from './planner/ctx'
import { CalendarScreen } from './planner/CalendarScreen'
import { AdminScreen } from './planner/AdminScreen'
import { ChatScreen } from './planner/ChatScreen'
import { HomeScreen } from './planner/HomeScreen'
import { InsightsScreen } from './planner/InsightsScreen'
import { KeepScreen } from './planner/KeepScreen'
import { SettingsScreen } from './planner/SettingsScreen'
import { useWarmChunks } from './planner/lazy'
import { Overlays } from './planner/Overlays'
import { VIEW_LABELS } from './planner/routes'
import { TasksScreen } from './planner/TasksScreen'
import { Toast } from './planner/Toast'
import { TopBar } from './planner/TopBar'
import { useCalendarSync } from './planner/useCalendarSync'
import { useDeepLinks } from './planner/useDeepLinks'
import { useFocusActions } from './planner/useFocusActions'
import { useLifeActions } from './planner/useLifeActions'
import { useNativeShell } from './planner/useNativeShell'
import { useListFilters } from './planner/useListFilters'
import { useNavigation } from './planner/useNavigation'
import { useOverlays } from './planner/useOverlays'
import { useOwner } from './planner/useOwner'
import { useSyncAlarm } from './planner/useSyncAlarm'
import { useCookTaskSync } from './planner/useCookTaskSync'
import { useTaskActions } from './planner/useTaskActions'
import { useToast } from './planner/useToast'

export default function Planner() {
  const household = useHousehold()
  const store = useItems(household.myId)
  // More than one account shares this planner: what decides whether a record
  // says who can see it. Nothing narrows the lists any more — see ctx.ts.
  const inHousehold = !!household.info?.household && (household.info?.members.length ?? 0) > 1

  // the multi-project bar is gone; a filter a device saved before the update
  // must not silently hide tasks, so it is dropped rather than read
  useEffect(() => forgetRetiredKeys(), [])
  // a photo saved offline, or whose upload failed, goes up at launch, when the
  // connection comes back and whenever the app is shown again
  useEffect(() => watchPendingMedia(), [])
  // a photo swapped out of a piece of clothing is deleted only once no piece
  // here, live or in Trash, points at it and the server has the edit that let
  // it go, and no copy the server may still hold points at it: the swaps ask
  // this, and get nothing until the records have loaded
  const mediaInUse = useRef<() => MediaInUse | null>(() => null)
  useLayoutEffect(() => {
    mediaInUse.current = () => {
      if (!store.loaded) return null
      const { ids: unsynced, shadows } = store.unconfirmed()
      return { userId: household.myId, ids: garmentMediaIds(store.allItems), unsynced, onServer: garmentMediaIds(shadows) }
    }
  })
  useEffect(() => trackMediaInUse(() => mediaInUse.current()), [])
  // a round the server answered may be the one that confirmed such an edit
  useEffect(() => void retireDue(), [store.syncInfo.lastAt])
  // "Sign in again" signs out, which wipes this device: a photo still waiting
  // to upload is asked about first, and with the session gone none can upload
  const signIn = useSignOut(async () => {
    await getSupabase()?.auth.signOut()
    await clearLocalData()
    window.location.reload()
  }, store.syncInfo.authError)
  const nav = useNavigation()
  // the People and Places lists' find boxes and chips: on the shell, because
  // their Stats are drawn in two places now (the segment's own, and the Stats
  // lens) and one figure must not read two ways on one device
  const listFilters = useListFilters({ store, personOpenId: nav.personOpenId, placeOpenId: nav.placeOpenId })
  const toaster = useToast({ store })
  const { showToast } = toaster

  const projectMap = useMemo(() => projectById(store.projects), [store.projects])
  const cal = useCalendarSync({ store, household, showToast })
  const overlays = useOverlays()
  const owner = useOwner()
  // the owner's banner on Today when the hourly sync check finds writes refused
  const syncAlarm = useSyncAlarm(owner.isOwner)

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
  useNativeShell({ store, applyLinkRef, myId: household.myId })

  const lifeActions = useLifeActions({ store, showToast, newTask: overlays.newTask, inHousehold })
  // a shared meal's cook task carries its recipe's steps, ingredients and notes, kept in step
  useCookTaskSync(store)
  const taskActions = useTaskActions({
    store,
    showToast,
    setEditor: overlays.setEditor,
    setProjectEditor: overlays.setProjectEditor,
    setNotesProjectId: nav.setNotesProjectId,
  })
  // Plan my day, Shut down, and Today's focus defer and meal ideas: written
  // through the task, calendar and meal paths above, one toast and Undo each
  const focusActions = useFocusActions({ store, household, showToast, ...taskActions, ...cal, ...lifeActions })
  // a moment after launch, fetch the lazy views and editors, so no tab or
  // editor waits on the network later
  useWarmChunks(owner.isOwner)

  // Everything the top bar, the screens and the overlays read, handed down as
  // one prop, with its callbacks the same functions from render to render
  // (see planner/ctx.ts).
  const p = usePlannerCtx({
    store,
    household,
    projectMap,
    inHousehold,
    ...nav,
    ...listFilters,
    ...toaster,
    ...cal,
    ...overlays,
    ...owner,
    ...syncAlarm,
    ...lifeActions,
    ...taskActions,
    ...focusActions,
  })
  // what the shell itself reads: the screen switch, pull to refresh, the toast
  const { view, pushed, manualSync, anyOpen, toast, setToast } = p

  return (
    <div className="app">
      <TopBar p={p} />

      {store.syncInfo.authError && (
        <div className="auth-banner">
          Your session expired — changes are staying on this device only.
          <button className="btn" disabled={signIn.busy} onClick={signIn.start}>
            Sign in again
          </button>
        </div>
      )}
      {signIn.question}

      {/* iOS: drag down from the top of a tab to refresh — the same set the
          foreground resume runs. Off while an editor or sheet owns the screen;
          the day sheet lives inside main and is refused by the touch target. */}
      <PullToRefresh enabled={!anyOpen} onRefresh={manualSync} />

      <main className="content">
        {store.loaded && (
          <ErrorBoundary where={VIEW_LABELS[view]} resetKey={view}>
            {/* a screen whose chunk has not arrived holds its space, blank.
                Moving between tabs is a transition, so a screen already up
                stays up until the next one can replace it. */}
            <Suspense fallback={<div className="view-pending" aria-busy="true" />}>
              {/* A pushed screen — Settings, the chat — takes the same space a
                  tab does, and leaves by its own ‹ Back or by a tap on any
                  tab. It is drawn INSTEAD of the tab rather than over it: a
                  sheet left the page behind it showing above the fold, cut
                  off mid-card, which is what said "this is a glance" about
                  two places you actually sit in. */}
              {pushed === 'settings' ? (
                <SettingsScreen p={p} />
              ) : pushed === 'chat' ? (
                <ChatScreen p={p} />
              ) : pushed === 'admin' ? (
                <AdminScreen p={p} />
              ) : (
                <>
                  {view === 'home' && <HomeScreen p={p} />}
                  {view === 'calendar' && <CalendarScreen p={p} />}
                  {view === 'tasks' && <TasksScreen p={p} />}
                  {view === 'keep' && <KeepScreen p={p} />}
                  {view === 'insights' && <InsightsScreen p={p} />}
                </>
              )}
            </Suspense>
          </ErrorBoundary>
        )}
      </main>

      <Overlays p={p} />

      <Toast toast={toast} setToast={setToast} />
    </div>
  )
}
