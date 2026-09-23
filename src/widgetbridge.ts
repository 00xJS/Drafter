import { Capacitor, registerPlugin } from '@capacitor/core'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { buildCapturedTask, quickCaptureFields } from './capture'
import { dueSections } from './components/Today'
import { blocksOn } from './focus'
import { addGroceryItem, buildGroceryList, groceryId, mealLabel, mealsForWeek, tonightDinner } from './kitchen'
import { genericRemindersEnabled, isNative, onAppPause, onAppResume } from './native'
import { weekRange } from './review'
import type { Store } from './store'
import { getSupabase } from './supabase'
import { hasDueTime, isOpen } from './taskutils'
import { MEAL_SLOT_META, type CalendarEntry, type GroceryList, type Item, type Meal, type Person, type Recipe, type Task } from './types'
import { clock, dateKey, excerpt, uid } from './utils'
import { newerStamp } from '../shared/domain.mts'
import { focusTasks } from '../shared/today.mts'

// The iPhone's Home Screen and Lock Screen widget, and Siri's "Add to Drafter".
//
// The widget cannot run this app: it draws a small JSON snapshot the web view
// leaves in the App Group (WidgetBridgePlugin.swift writes it, DrafterWidgets
// reads it). Everything in the snapshot is decided here, by the rules Today
// uses, so the widget never disagrees with the page. It carries the signed-in
// member's own day only: tasks, time blocks and meals, never the journal or
// anything else personal, and only counts when Settings → Reminders → Hide
// details on the lock screen is on.
//
// Siri's intents cannot run it either, and have no network. They queue what
// was said in the App Group; the app drains the queue at launch, on every
// resume, and at once when Siri adds something while it is open, and saves
// each one with the app's own builders.

export const WIDGET_SNAPSHOT_VERSION = 1
/** The lines the medium widget has room for. */
export const WIDGET_ITEMS = 3
/** A snapshot older than this asks for Drafter to be opened rather than show a day that may have moved on. */
export const WIDGET_STALE_MS = 12 * 60 * 60 * 1000
/** How long the store has to be still before the snapshot is rewritten. */
export const WIDGET_DEBOUNCE_MS = 2000

/** One line on the widget: a task in the day's focus, or due that day. */
export interface WidgetItem {
  title: string
  /** Its time block ("9am–10:30am"), else the time it is due that day ("3pm"); absent with neither. */
  time?: string
  /** Chosen for the day's focus (Plan my day), not only due. */
  focus: boolean
}

/** A day as the widget draws it. */
export interface WidgetDay {
  /** YYYY-MM-DD on this device's calendar, which the widget shares. */
  day: string
  /** What is left: the open tasks in the day's focus, and the rest of the open ones due that day. */
  count: number
  /** Open tasks due before the day: Today's Overdue. */
  overdue: number
  /** The first WIDGET_ITEMS of `count`, focus first. None while details are hidden. */
  items: WidgetItem[]
  /** How many of `count` are not in `items`. */
  more: number
  /** The day's dinner by Kitchen's rule; absent with none planned, and while details are hidden. */
  dinner?: { title: string; when: string; out: boolean }
}

/** What the web view hands the widget (ios/App/DrafterWidgets/WidgetSnapshot.swift decodes it). */
export interface WidgetSnapshot {
  v: typeof WIDGET_SNAPSHOT_VERSION
  generatedAt: string
  /** From here on the widget says "Open Drafter to refresh". */
  staleAt: string
  /** Counts only, no titles: the lock-screen privacy switch. */
  generic: boolean
  /** Today, then tomorrow, so the widget turns over at midnight on its own. None after a sign-out. */
  days: WidgetDay[]
}

/** What the snapshot is built from: the lists Today is handed. */
export interface WidgetSources {
  tasks: Task[]
  /** Calendar entries you wrote (Store.events): a task's time block is the entry whose taskId names it. */
  entries: CalendarEntry[]
  meals: Meal[]
  recipes: Recipe[]
  /** Whose focus is whose; null in local mode, where any focus is yours. */
  myId: string | null
}

/** What Today's rows call a task with no title. */
const titleOf = (t: Task): string => t.title || excerpt(t.description, 60) || 'Untitled'

function timeOf(t: Task, day: string, blocks: Map<string, CalendarEntry>): string | undefined {
  const block = blocks.get(t.id)
  if (block) return `${clock(block.start)}–${clock(block.end)}`
  if (t.dueAt && hasDueTime(t.dueAt) && dateKey(t.dueAt) === day) return clock(t.dueAt)
  return undefined
}

/** One day, as Today would show it at `at`: its focus card, its Today and Overdue sections, and the briefing's dinner. */
function widgetDay(src: WidgetSources, at: Date, generic: boolean): WidgetDay {
  const day = dateKey(at)
  const focus = focusTasks(src.tasks, day, src.myId).filter(isOpen)
  const inFocus = new Set(focus.map(t => t.id))
  const { overdue, today } = dueSections(src.tasks, at)
  const left = [...focus, ...today.filter(t => !inFocus.has(t.id))]
  const blocks = blocksOn(src.entries, day)
  const items: WidgetItem[] = generic
    ? []
    : left.slice(0, WIDGET_ITEMS).map(t => {
        const time = timeOf(t, day, blocks)
        return { title: titleOf(t), ...(time ? { time } : {}), focus: inFocus.has(t.id) }
      })
  const plate = generic ? null : tonightDinner(src.meals, src.recipes, at)
  return {
    day,
    count: left.length,
    overdue: overdue.length,
    items,
    more: left.length - items.length,
    ...(plate
      ? { dinner: { title: mealLabel(plate.meal), when: plate.meal.slot === 'dinner' ? 'Tonight' : MEAL_SLOT_META[plate.meal.slot].label, out: !!plate.meal.out } }
      : {}),
  }
}

/**
 * The widget's snapshot at `now`: today and tomorrow, each by Today's own
 * rules — focusTasks for the focus, dueSections for Today and Overdue,
 * tonightDinner for the dinner. Tomorrow is today's list read from its
 * midnight, so what is still open tonight counts as overdue there, as it will.
 */
export function buildWidgetSnapshot(src: WidgetSources, { now, generic }: { now: Date; generic: boolean }): WidgetSnapshot {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return {
    v: WIDGET_SNAPSHOT_VERSION,
    generatedAt: now.toISOString(),
    staleAt: new Date(now.getTime() + WIDGET_STALE_MS).toISOString(),
    generic,
    days: [widgetDay(src, now, generic), widgetDay(src, tomorrow, generic)],
  }
}

/** Nothing to show: after a sign-out the widget asks for Drafter to be opened. */
export function emptyWidgetSnapshot(now: Date): WidgetSnapshot {
  const at = now.toISOString()
  return { v: WIDGET_SNAPSHOT_VERSION, generatedAt: at, staleAt: at, generic: false, days: [] }
}

// ---- Siri's captures ---------------------------------------------------------

/** One thing Siri was asked to add (CaptureQueue.swift writes these). */
export interface SiriCapture {
  id: string
  kind: 'task' | 'grocery'
  text: string
  /** When it was said, as an ISO instant. */
  at: string
}

/** The captures that came over the bridge, leaving out anything this build cannot read. */
export function parseCaptures(raw: unknown): SiriCapture[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return []
    const { id, kind, text, at } = entry as Record<string, unknown>
    if ((kind !== 'task' && kind !== 'grocery') || typeof text !== 'string' || !text.trim()) return []
    return [{ id: typeof id === 'string' ? id : '', kind, text: text.trim(), at: typeof at === 'string' ? at : '' }]
  })
}

/** What a capture is saved against. */
export interface CaptureContext {
  myId: string | null
  tasks: Task[]
  people: Person[]
  groceries: GroceryList[]
  meals: Meal[]
  recipes: Recipe[]
  now: Date
  newId(): string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The records Siri's captures become.
 *
 * A task is built exactly as the palette's Capture (Shift+Enter) builds one —
 * buildCapturedTask over quickCaptureFields — read as of the moment it was
 * said, so "tomorrow" is the day after Siri heard it; an undated one lands in
 * the Inbox. It takes the capture's own id, so a capture seen twice is saved
 * once. A grocery item goes on this week's list exactly as Kitchen's add box
 * puts it there: my list for the week, or a new one built from the week's
 * meals, through addGroceryItem, so a name already on it is not added twice.
 */
export function captureRecords(captures: readonly SiriCapture[], ctx: CaptureContext): Item[] {
  const out: Item[] = []
  const known = new Set(ctx.tasks.map(t => t.id))
  const lookup = { people: ctx.people }
  const week = weekRange(ctx.now)
  let list: GroceryList | null = null
  for (const c of captures) {
    if (c.kind === 'task') {
      const said = Date.parse(c.at)
      const when = Number.isFinite(said) ? new Date(said) : ctx.now
      const id = UUID.test(c.id) ? c.id.toLowerCase() : ctx.newId()
      if (known.has(id)) continue
      known.add(id)
      out.push(buildCapturedTask(quickCaptureFields(c.text, when), lookup, { id, now: when }))
      continue
    }
    const base: GroceryList =
      list ??
      ctx.groceries.filter(g => g.weekKey === week.key && !g.deletedAt).find(g => !ctx.myId || !g.ownerId || g.ownerId === ctx.myId) ??
      buildGroceryList(week.key, mealsForWeek(ctx.meals, week.start), ctx.recipes, null, undefined, ctx.myId)
    const next: GroceryList = { ...base, id: base.id ?? groceryId(week.key, ctx.myId), weekKey: week.key, items: addGroceryItem(base.items, { name: c.text }, ctx.newId).items }
    list = { ...next, updatedAt: newerStamp(next.updatedAt) }
  }
  if (list) out.push(list)
  return out
}

// ---- the bridge ---------------------------------------------------------------

/** What WidgetBridgePlugin.swift sends when Siri queued something while the app was open. */
export const CAPTURES_QUEUED = 'capturesQueued'

/** WidgetBridgePlugin.swift, compiled into the app and registered by DrafterBridgeViewController. */
export interface WidgetBridgePlugin {
  setSnapshot(options: { json: string }): Promise<void>
  drainCaptures(): Promise<{ captures?: unknown }>
  /** Siri queued something while the app was open, so there will be no resume to drain on. */
  addListener(eventName: typeof CAPTURES_QUEUED, listener: () => void): Promise<{ remove(): Promise<void> }>
}

let widgetPlugin: WidgetBridgePlugin | null | undefined

/** The plugin, or null on the web and in an app built before it existed. Looked up on first use. */
export function widgetBridgePlugin(): WidgetBridgePlugin | null {
  if (widgetPlugin === undefined) {
    widgetPlugin = isNative() && Capacitor.isPluginAvailable('WidgetBridge') ? registerPlugin<WidgetBridgePlugin>('WidgetBridge') : null
  }
  return widgetPlugin
}

/** The parts of the store the widget reads and Siri's captures are saved through. */
export type WidgetStore = Pick<Store, 'loaded' | 'myId' | 'tasks' | 'events' | 'meals' | 'recipes' | 'people' | 'groceries' | 'upsert'>

export interface WidgetBridge {
  /** Something the widget shows may have changed: write once the store has been still for WIDGET_DEBOUNCE_MS. */
  changed(): void
  /** The app is going: write now, whatever the debounce was waiting for. */
  flush(): Promise<boolean>
  /** Save what Siri queued. Resolves with how many records were written; the captures stay queued until the local copy is in. */
  drain(): Promise<number>
  /** Drain as soon as Siri adds something while the app is open. Resolves with a disposer. */
  watchCaptures(): Promise<() => void>
  /** The account signed out: the widget stops showing its day. */
  signedOut(): Promise<boolean>
  dispose(): void
}

export function createWidgetBridge(deps: {
  plugin: WidgetBridgePlugin
  store(): WidgetStore
  /** Settings → Reminders → Hide details on the lock screen. */
  generic(): boolean
  now?(): Date
  newId?(): string
}): WidgetBridge {
  const now = deps.now ?? (() => new Date())
  const newId = deps.newId ?? uid
  let timer: ReturnType<typeof setTimeout> | null = null
  /** What was last written, stamps aside: the same day again is not written again, except on the way out. */
  let written: string | null = null
  let draining: Promise<number> = Promise.resolve(0)

  const cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  const write = async (force: boolean): Promise<boolean> => {
    const s = deps.store()
    if (!s.loaded) return false
    const snapshot = buildWidgetSnapshot({ tasks: s.tasks, entries: s.events, meals: s.meals, recipes: s.recipes, myId: s.myId }, { now: now(), generic: deps.generic() })
    const content = JSON.stringify([snapshot.generic, snapshot.days])
    if (!force && content === written) return false
    try {
      await deps.plugin.setSnapshot({ json: JSON.stringify(snapshot) })
      written = content
      return true
    } catch {
      return false
    }
  }

  const drainOnce = async (): Promise<number> => {
    if (!deps.store().loaded) return 0
    let raw: unknown
    try {
      raw = (await deps.plugin.drainCaptures()).captures
    } catch {
      return 0
    }
    const captures = parseCaptures(raw)
    if (captures.length === 0) return 0
    // read again: the store may have moved on while the bridge answered
    const s = deps.store()
    const records = captureRecords(captures, { myId: s.myId, tasks: s.tasks, people: s.people, groceries: s.groceries, meals: s.meals, recipes: s.recipes, now: now(), newId })
    for (const r of records) s.upsert(r)
    return records.length
  }

  const drain = (): Promise<number> => {
    // one at a time: a second batch must see the grocery list the first one wrote
    const run = draining.then(() => drainOnce().catch(() => 0))
    draining = run
    return run
  }

  return {
    changed() {
      cancel()
      timer = setTimeout(() => {
        timer = null
        void write(false)
      }, WIDGET_DEBOUNCE_MS)
    },
    flush() {
      cancel()
      return write(true)
    },
    drain,
    async watchCaptures() {
      try {
        const handle = await deps.plugin.addListener(CAPTURES_QUEUED, () => void drain())
        return () => void handle.remove()
      } catch {
        return () => {}
      }
    },
    async signedOut() {
      cancel()
      written = null
      try {
        await deps.plugin.setSnapshot({ json: JSON.stringify(emptyWidgetSnapshot(now())) })
        return true
      } catch {
        return false
      }
    },
    dispose: cancel,
  }
}

/**
 * The widget and Siri, wired to the planner's store and the shell's
 * lifecycle: the snapshot follows the store (debounced) and is written again
 * as the app goes to the background, Siri's captures are saved at launch, on
 * every resume and whenever Siri adds one while the app is open, and a
 * sign-out blanks the widget. Does nothing on the web.
 */
export function useWidgetBridge(store: Store): void {
  const latest = useRef(store)
  useLayoutEffect(() => {
    latest.current = store
  })
  // made once; it reads the store through the ref above, from native callbacks and effects only
  // eslint-disable-next-line react-hooks/refs -- the ref is captured here, not read: nothing calls the bridge while rendering
  const [bridge] = useState(() => {
    const plugin = widgetBridgePlugin()
    return plugin ? createWidgetBridge({ plugin, store: () => latest.current, generic: genericRemindersEnabled }) : null
  })

  // what the widget shows: the lists Today is handed
  useEffect(() => {
    if (bridge && store.loaded) bridge.changed()
  }, [bridge, store.loaded, store.tasks, store.events, store.meals, store.recipes, store.myId])

  // launch: what Siri was asked while the app was shut, once the local copy is in
  useEffect(() => {
    if (bridge && store.loaded) void bridge.drain()
  }, [bridge, store.loaded])

  useEffect(() => {
    if (!bridge) return
    let live = true
    const stops: (() => void)[] = []
    const hold = (pending: Promise<() => void>) => void pending.then(stop => (live ? stops.push(stop) : stop()))
    hold(onAppPause(() => void bridge.flush()))
    hold(onAppResume(() => void bridge.drain()))
    hold(bridge.watchCaptures())
    // a sign-out wipes this device and reloads; the widget must not keep the account's day
    const auth = getSupabase()?.auth.onAuthStateChange(event => {
      if (event === 'SIGNED_OUT') void bridge.signedOut()
    })
    return () => {
      live = false
      for (const stop of stops) stop()
      auth?.data.subscription.unsubscribe()
      bridge.dispose()
    }
  }, [bridge])
}
