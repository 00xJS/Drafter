import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Account, CalendarEntry, CalendarSource, ChatTurn, Garment, GroceryList, Habit, Item, JournalEntry, Meal, Message, Note, Outfit, Person, Place, Project, Recipe, Review, Routine, Snooze, Task, TaskStatus, Template, Wear } from './types'
import { haptic, onAppPause } from './native'
import { syncNow } from './sync'
import { clearLocalData, idbGet, idbSet, readRecordCache, writeRecordChanges } from './idb'
import { browserKV, type SyncFailure } from './syncstate'
import { getSupabase } from './supabase'
import { PERSONAL_KINDS } from '../shared/kinds.mts'
import { listDrawer } from './kindlists'
import { watchRealtime } from './realtime'
import {
  createSyncEngine,
  recordLabel,
  watchLifecycle,
  type EngineConflict,
  type ImportSummary,
  type RetiredSpawn,
  type StatusChange,
  type SyncEngine,
  type SyncInfo,
} from './syncengine'

// The React adapter over the sync engine (src/syncengine.ts). The engine owns
// the records, the dirty set, the cursor, persistence and the rounds; this
// file subscribes to it, draws the lists every view renders from the engine's
// per-kind arrays (src/kindlists.ts), and wires the page's lifecycle and the
// live channel (src/realtime.ts) to it.

export type { EngineConflict, ImportSummary, RetiredSpawn, StatusChange, SyncInfo }
export { conflictMessage, retiredMessage, stampStatus } from './syncengine'
export { sortNotes } from './kindlists'

/** A row the server refused, as Settings lists it. */
export interface FailedSync extends SyncFailure {
  kind?: Item['kind']
  label: string
}

export interface Store {
  /**
   * The signed-in account, or null in local mode. A record whose id has to be
   * this member's alone — a meal, a week's grocery list — is built with it, so
   * two people in one household never write the same row.
   */
  myId: string | null
  /** Live tasks (tombstoned ones filtered out) — what every view renders. */
  tasks: Task[]
  /** Live projects. */
  projects: Project[]
  /** Subscribed external calendars. */
  calendars: CalendarSource[]
  /** People you track visits with. */
  people: Person[]
  /** Places you track outings at. */
  places: Place[]
  recipes: Recipe[]
  meals: Meal[]
  /** Calendar entries you wrote yourself (start AND end), oldest first. */
  events: CalendarEntry[]
  groceries: GroceryList[]
  /** Your journal entries (personal, newest day first). */
  journal: JournalEntry[]
  reviews: Review[]
  /** Your habits (personal), in card order. */
  habits: Habit[]
  /** Your routines (personal), in card order. */
  routines: Routine[]
  /**
   * Note records (shared with the household, like tasks): pinned first, then the
   * most recently edited. Project pads (Project.notesHtml) are not in here.
   */
  notes: Note[]
  templates: Template[]
  /** Your clothes (personal), retired pieces included — their history still counts — by name. */
  garments: Garment[]
  /** Your clothes in Trash, for the composer alone: a day whose look still holds one shows it there, badged, and a log keeps its slot. */
  garmentsInTrash: Garment[]
  /** Your saved outfits (personal), oldest first. */
  outfits: Outfit[]
  /** What you wore (personal): newest day first, a day's latest look first. */
  wears: Wear[]
  snoozes: Snooze[]
  messages: Message[]
  chat: ChatTurn[]
  accounts: Account[]
  /** Everything including tombstones — for sync only. */
  allItems: Item[]
  /**
   * Everything I may see: allItems minus other household members' personal
   * records (PERSONAL_KINDS: journal, review, calendar, habit, routine and the
   * wardrobe). Meals are the household's, like the grocery list. Trash, JSON
   * export and counts use this so a peer's deleted diary never shows up in my bin.
   */
  visibleItems: Item[]
  /** False until the local cache has been read (avoids empty-state flashes). */
  loaded: boolean
  syncInfo: SyncInfo
  /** Rows the server refused: still dirty, retried with backoff, counted as unsynced. */
  failures: FailedSync[]
  upsert(item: Item): void
  remove(id: string): void
  restore(ids: string[]): void
  /**
   * Hard-delete: a content-free tombstone replaces the record here at once and
   * is pushed like any change, retried until the server takes it. Resolves true
   * when the server already has it, false while it is still queued.
   */
  purge(ids: string[]): Promise<boolean>
  /** Returns what changed so the caller can offer Undo. */
  setStatus(id: string, status: TaskStatus): StatusChange | null
  importItems(incoming: unknown[]): ImportSummary
  syncNowManual(): Promise<boolean>
  /** Forget the delta cursor so the next sync is a full exchange. */
  fullResync(): Promise<boolean>
  /** Drop peer-owned rows after leaving a household (keeps unowned + mine). */
  retainMine(myId: string | null): void
  /** Push a refused row now instead of waiting out its backoff. */
  retrySync(id: string): Promise<boolean>
  /** Drop this device's version of a refused row; the server's copy comes back. */
  discardLocal(id: string): void
  /** Called, each round that has any, with the records whose local edit lost a field to another device's. */
  onConflict(listener: (conflicts: EngineConflict[]) => void): () => void
  /** Put this device's values back for those conflicts, as a new and newer edit. */
  keepMine(conflicts: EngineConflict[]): void
  /** Called when a round put in the Trash a repeat's extra next occurrence that held something the one kept does not. */
  onRetired(listener: (retired: RetiredSpawn[]) => void): () => void
  /** Records whose latest edit the server has not confirmed yet, and its last confirmed copy of each it had. */
  unconfirmed(): { ids: ReadonlySet<string>; shadows: Item[] }
}

let shared: SyncEngine | null = null

/** One engine per page: the dirty set and cursor it keeps belong to the device, not to a component. */
function engine(): SyncEngine {
  shared ??= createSyncEngine({
    // local mode (no Supabase env) has nothing to sync, so nothing is ever "unsynced"
    rpc: getSupabase() ? syncNow : null,
    storage: {
      // one row per record; the single value is only read, once, to move it over
      readAll: readRecordCache,
      writeChanges: writeRecordChanges,
      readSnapshot: () => idbGet('posts', 'all'),
      writeSnapshot: record => idbSet('posts', 'all', record),
      clearAll: clearLocalData,
      kv: browserKV,
    },
  })
  return shared
}

const NO_FAILURES: FailedSync[] = []

/**
 * A round now, if this page has started the engine; never starts one. A
 * sign-out's Try uploading now sends the edits the wipe would take with the
 * photos, the pieces that point at them among them.
 */
export function syncIfStarted(): Promise<boolean> {
  return shared ? shared.sync() : Promise.resolve(false)
}

export function useItems(myId: string | null = null): Store {
  const e = engine()
  const snap = useSyncExternalStore(e.subscribe, e.getState)
  const items = snap.items

  // boot: read the IndexedDB cache (wiping one another account left), then a first sync
  useEffect(() => {
    void e.boot(myId)
  }, [e, myId])

  // the periodic sync, the foreground/background triggers and the shell's pause
  useEffect(() => {
    const stopPeriodic = e.start()
    const stopLifecycle = watchLifecycle(e, { document, window, onPause: onAppPause })
    return () => {
      stopLifecycle()
      stopPeriodic()
    }
  }, [e])

  // supabase re-emits SIGNED_IN on every tab focus; the engine decides what it means
  useEffect(() => {
    const sb = getSupabase()
    if (!sb) return
    const { data: sub } = sb.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN') e.signedIn(session?.user.id ?? null)
    })
    return () => sub.subscription.unsubscribe()
  }, [e])

  // Live updates: a change another device makes arrives within seconds, as a
  // nudge to run the ordinary round (src/realtime.ts). Signed in with a backend
  // only; a new account is a new channel, and signing out closes it.
  useEffect(() => {
    const sb = getSupabase()
    if (!sb || !myId) return
    const channel = watchRealtime({ client: sb, engine: e })
    // back on the page, or back online: a channel that dropped meanwhile comes back
    const onReturn = () => {
      if (document.visibilityState === 'visible') channel.resume()
    }
    document.addEventListener('visibilitychange', onReturn)
    window.addEventListener('online', onReturn)
    const { data: sub } = sb.auth.onAuthStateChange(event => {
      // after the callback, not inside it: auth-js holds its lock while it runs,
      // and a subscribe asks it for the session
      if (event === 'SIGNED_OUT') setTimeout(() => channel.pause(), 0)
      else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') setTimeout(() => channel.resume(), 0)
    })
    return () => {
      sub.subscription.unsubscribe()
      document.removeEventListener('visibilitychange', onReturn)
      window.removeEventListener('online', onReturn)
      channel.stop()
    }
  }, [e, myId])

  // The lists, drawn from the engine's per-kind arrays: a list is drawn again
  // only when its own kind changed (src/kindlists.ts), so editing a task keeps
  // every other list — and whatever a view memoized on it — as it was.
  const [draw] = useState(listDrawer)
  const lists = draw(snap.byKind, myId).lists

  // Everything I may see: a peer's personal kinds are never shown, even when a
  // cache from before the policy still holds them.
  const visibleItems = useMemo(() => items.filter(i => !PERSONAL_KINDS.has(i.kind) || !i.ownerId || !myId || i.ownerId === myId), [items, myId])
  const failures = useMemo(() => {
    if (snap.failures.length === 0) return NO_FAILURES
    const byId = new Map(items.map(i => [i.id, i]))
    return snap.failures.map(f => {
      const row = byId.get(f.id)
      return { ...f, kind: row?.kind, label: recordLabel(row) }
    })
  }, [snap.failures, items])

  const setStatus = useCallback(
    (id: string, status: TaskStatus) => {
      const change = e.setStatus(id, status)
      if (change && status === 'done' && change.prev.status !== 'done') void haptic('success')
      return change
    },
    [e],
  )

  // one object for as long as nothing in it changed
  return useMemo<Store>(
    () => ({
      myId,
      ...lists,
      allItems: items,
      visibleItems,
      loaded: snap.loaded,
      syncInfo: snap.syncInfo,
      failures,
      upsert: e.upsert,
      remove: e.remove,
      restore: e.restore,
      purge: e.purge,
      setStatus,
      importItems: e.importItems,
      syncNowManual: e.sync,
      fullResync: e.fullResync,
      retainMine: e.retainMine,
      retrySync: e.retry,
      discardLocal: e.discard,
      onConflict: e.onConflict,
      keepMine: e.keepMine,
      onRetired: e.onRetired,
      unconfirmed: e.unconfirmed,
    }),
    [e, myId, lists, items, visibleItems, snap.loaded, snap.syncInfo, failures, setStatus],
  )
}
