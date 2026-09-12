import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { CalendarEntry, CalendarSource, GroceryList, Habit, Item, JournalEntry, Meal, Person, Place, Project, Recipe, Review, Routine, Task, TaskStatus, Template } from './types'
import { haptic } from './native'
import { syncNow } from './sync'
import { clearLocalData, idbGet, idbSet } from './idb'
import { browserKV } from './syncstate'
import { getSupabase } from './supabase'
import {
  createSyncEngine,
  watchLifecycle,
  type ImportSummary,
  type StatusChange,
  type SyncEngine,
  type SyncInfo,
} from './syncengine'

// The React adapter over the sync engine (src/syncengine.ts). The engine owns
// the records, the dirty set, the cursor, persistence and the rounds; this
// file subscribes to it, derives the per-kind lists every view renders, and
// wires the page's lifecycle to it.

export type { ImportSummary, StatusChange, SyncInfo }
export { stampStatus } from './syncengine'

/** Kinds that belong to one account even inside a household. */
const PERSONAL_KINDS = new Set(['journal', 'review', 'calendar', 'habit', 'routine'])

export interface Store {
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
  templates: Template[]
  /** Everything including tombstones — for sync only. */
  allItems: Item[]
  /**
   * Everything I may see: allItems minus other household members' personal
   * records (journal, review, calendar). Trash, JSON export and counts use this
   * so a peer's deleted diary never shows up in my bin.
   */
  visibleItems: Item[]
  /** False until the local cache has been read (avoids empty-state flashes). */
  loaded: boolean
  syncInfo: SyncInfo
  upsert(item: Item): void
  remove(id: string): void
  restore(ids: string[]): void
  /** Hard-delete: gone from this device and from the database, no undo. */
  purge(ids: string[]): Promise<void>
  /** Returns what changed so the caller can offer Undo. */
  setStatus(id: string, status: TaskStatus): StatusChange | null
  importItems(incoming: unknown[]): ImportSummary
  syncNowManual(): Promise<boolean>
  /** Forget the delta cursor so the next sync is a full exchange. */
  fullResync(): Promise<boolean>
  /** Drop peer-owned rows after leaving a household (keeps unowned + mine). */
  retainMine(myId: string | null): void
}

let shared: SyncEngine | null = null

/** One engine per page: the dirty set and cursor it keeps belong to the device, not to a component. */
function engine(): SyncEngine {
  shared ??= createSyncEngine({
    rpc: syncNow,
    storage: {
      readSnapshot: () => idbGet('posts', 'all'),
      writeSnapshot: record => idbSet('posts', 'all', record),
      clearAll: clearLocalData,
      kv: browserKV,
    },
  })
  return shared
}

export function useItems(myId: string | null = null): Store {
  const e = engine()
  const snap = useSyncExternalStore(e.subscribe, e.getState)
  const items = snap.items

  // boot: read the IndexedDB cache (wiping one another account left), then a first sync
  useEffect(() => {
    void e.boot(myId)
  }, [e, myId])

  // periodic sync + sync when the app returns to the foreground
  useEffect(() => {
    const stopPeriodic = e.start()
    const stopLifecycle = watchLifecycle(e, { document, window })
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

  // Calendar subscriptions and reviews are personal: only mine (or unowned,
  // pre-household rows) show. Declared BEFORE every memo that calls it — a
  // const used above its declaration throws once the list is non-empty, which
  // took down the whole app the first time a review was saved.
  const isMine = (i: Item) => !i.ownerId || !myId || i.ownerId === myId

  const tasks = useMemo(() => items.filter((i): i is Task => i.kind === 'task' && !i.deletedAt), [items])
  const projects = useMemo(
    () =>
      items
        .filter((i): i is Project => i.kind === 'project' && !i.deletedAt)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [items],
  )
  const people = useMemo(
    () =>
      items
        .filter((i): i is Person => i.kind === 'person' && !i.deletedAt)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [items],
  )
  const places = useMemo(
    () =>
      items
        .filter((i): i is Place => i.kind === 'place' && !i.deletedAt)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [items],
  )
  const recipes = useMemo(
    () =>
      items
        .filter((i): i is Recipe => i.kind === 'recipe' && !i.deletedAt)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [items],
  )
  const meals = useMemo(
    () => items.filter((i): i is Meal => i.kind === 'meal' && !i.deletedAt).sort((a, b) => a.date.localeCompare(b.date)),
    [items],
  )
  const groceries = useMemo(
    () => items.filter((i): i is GroceryList => i.kind === 'grocery' && !i.deletedAt),
    [items],
  )
  // Entries you wrote yourself. Household-visible like tasks: a block of time
  // on a family calendar is meant to be seen, unlike a `calendar` subscription.
  const events = useMemo(
    () => items.filter((i): i is CalendarEntry => i.kind === 'event' && !i.deletedAt).sort((a, b) => a.start.localeCompare(b.start)),
    [items],
  )
  const visibleItems = useMemo(
    () => items.filter(i => !PERSONAL_KINDS.has(i.kind) || isMine(i)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, myId],
  )
  // Journal entries are personal, like reviews: only mine (or unowned, local-mode rows).
  const journal = useMemo(
    () =>
      items
        .filter((i): i is JournalEntry => i.kind === 'journal' && !i.deletedAt && isMine(i))
        .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, myId],
  )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reviews = useMemo(() => items.filter((i): i is Review => i.kind === 'review' && !i.deletedAt && isMine(i)), [items, myId])
  const habits = useMemo(
    () =>
      items
        .filter((i): i is Habit => i.kind === 'habit' && !i.deletedAt && !i.archivedAt && isMine(i))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt.localeCompare(b.createdAt)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, myId],
  )
  const routines = useMemo(
    () =>
      items
        .filter((i): i is Routine => i.kind === 'routine' && !i.deletedAt && !i.archivedAt && isMine(i))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt.localeCompare(b.createdAt)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, myId],
  )
  const templates = useMemo(
    () => items.filter((i): i is Template => i.kind === 'template' && !i.deletedAt).sort((a, b) => a.name.localeCompare(b.name)),
    [items],
  )
  const calendars = useMemo(
    () =>
      items
        .filter((i): i is CalendarSource => i.kind === 'calendar' && !i.deletedAt && isMine(i))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, myId],
  )

  return {
    tasks,
    projects,
    calendars,
    people,
    places,
    recipes,
    meals,
    events,
    groceries,
    journal,
    reviews,
    habits,
    routines,
    templates,
    allItems: items,
    visibleItems,
    loaded: snap.loaded,
    syncInfo: snap.syncInfo,
    upsert: e.upsert,
    remove: e.remove,
    restore: e.restore,
    purge: e.purge,
    setStatus: (id, status) => {
      const change = e.setStatus(id, status)
      if (change && status === 'done' && change.prev.status !== 'done') void haptic('success')
      return change
    },
    importItems: e.importItems,
    syncNowManual: e.sync,
    fullResync: e.fullResync,
    retainMine: e.retainMine,
  }
}
