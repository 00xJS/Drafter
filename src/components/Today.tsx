import { useCallback, useMemo, useRef, useState } from 'react'
import { readFolded, toggleFold, writeFolded } from '../homefolds'
import { Fold, HomeFolds, useFold } from './HomeFold'
import { Icon } from './Icon'
import {
  MEAL_SLOT_META,
  CalendarEntry,
  CalendarEvent,
  CalendarSource,
  Garment,
  Habit,
  JournalEntry,
  Meal,
  MealSlot,
  Outfit,
  PLACE_CATEGORY_META,
  Person,
  Place,
  Project,
  Recipe,
  Review as ReviewRecord,
  Routine,
  SNOOZE_OPTIONS,
  Snooze,
  SnoozeTarget,
  Task,
  TaskStatus,
  Wear,
} from '../types'
import { mealLabel, platesOn, tonightDinner } from '../kitchen'
import { JournalCard } from './JournalCard'
import { newerStamp } from '../itemops'
import { snoozedIds } from '../snooze'
import { NEVER_NUDGES, SEEN_META, peopleToNudge, personStats, plannedGift, seenTasks, upcomingOccasions } from '../people'
import { placeCadenceStatus } from '../places'
import { defaultReviewAnchor, doneByWeek, isVisit, weekRange, shiftRange } from '../review'
import { DAY_MS, compareTasks, dayOffset, dueTone, inInbox, startOfDay } from '../taskutils'
import { eventStartDate } from '../calendarstate'
import { workDaysOf } from '../calgrid'
import { haptic } from '../native'
import { lockAxis } from '../pull'
import { useDayKey } from '../useDayKey'
import { useNow } from '../useNow'
import { clock, dateKey, excerpt, fmtTime, timeAgo } from '../utils'
import { bucketByDue, focusTasks } from '../../shared/today.mjs'
import type { MealIdea } from '../../shared/weekplan.mjs'
import { DueBadge, PriorityMark, StatTile } from './bits'
import { HabitsCard } from './HabitsCard'
import { RoutinesCard } from './RoutinesCard'
import { BriefingCard, briefingFacts } from './BriefingCard'
import type { BriefingCta } from './BriefingCard'
import { MealIdeasCard } from './MealIdeasCard'
// from focus.ts and dayclose.ts, not the sheets: a static import of either
// sheet would pull its chunk into the first load
import { blocksOn } from '../focus'
import type { PlanStep } from './PlanDaySheet'
import { dayClosed } from '../dayclose'
// the card and its thumbnails only: the rest of the wardrobe is Home → Wardrobe's own chunk
import { canDress } from '../wardrobe'
import { WardrobeCard, type CardLog } from './wardrobe/WardrobeCard'
import type { WardrobeOpen } from './planner/useNavigation'
import type { SyncAlarm } from '../syncalarm'

// One ongoing home project: Today shows no project cards, no "stalled" line
// and no project chips — a bar that never fills and a chip on every row would
// say nothing. Projects live on a calendar day and in search.

interface Props {
  tasks: Task[]
  people: Person[]
  /** Only places with a cadence can appear; the rest are never nudged. */
  places: Place[]
  reviews: ReviewRecord[]
  onPlanWith(p: Person): void
  onWentTo(p: Place): void
  onPlanAt(p: Place): void
  onPlanOccasion(p: Person, kind: 'birthday' | 'anniversary', at: Date): void
  onSaw(p: Person): void
  onSaveReview(r: ReviewRecord): void
  projects: Project[]
  events: CalendarEvent[]
  sourceMap: Map<string, CalendarSource>
  onPlan(ev: CalendarEvent): void
  onOpen(t: Task): void
  onStatus(id: string, s: TaskStatus): void
  onDefer(id: string, day: Date): void
  onDeferAll(ids: string[], day: Date): void
  onNew(preset?: Partial<Task>): void
  meals: Meal[]
  recipes: Recipe[]
  onOpenKitchen(): void
  onOpenReview(): void
  onCookRecipe(r: Recipe): void
  journal: JournalEntry[]
  onSaveJournal(e: JournalEntry): void
  onDeleteJournal(id: string): void
  onOpenJournal(): void
  habits: Habit[]
  onSaveHabit(h: Habit): void
  onDeleteHabit(id: string): void
  /** The signed-in person's display name, for the greeting. */
  name?: string
  /** A household member's display name: the briefing tile that says whose work day it is. */
  nameOf?(id: string | undefined): string | null
  routines: Routine[]
  onSaveRoutine(r: Routine): void
  onDeleteRoutine(id: string): void
  // ---- Phase 3 (B4). Optional until the planner shell passes them: without
  // them Today reads as it did, with no focus card, strip action or ideas.
  /** The signed-in user's id: whose focus is whose. Null or absent in local mode, where any focus is yours. */
  myId?: string | null
  /** Our own calendar entries: a focus task's time block is the entry whose taskId names it. */
  entries?: CalendarEntry[]
  /** Open Plan my day, at a step (the focus card's Edit asks for 'focus'); no step lets the sheet choose. */
  onPlanDay?(step?: PlanStep): void
  /** Open Shut down (the strip's tile from 17:00, and "Day closed" to reopen it). */
  onShutDown?(): void
  /** Open Plan next week — offered on Sundays. */
  onPlanWeek?(): void
  /** Defer from the focus card: the same move as onDefer, and the task also leaves today's focus. */
  onDeferFromFocus?(id: string, day: Date): void
  /** Plan one of today's meal ideas; the ideas card only shows when this is given. */
  onPlanMeal?(dayKey: string, slot: MealSlot, idea: MealIdea): void
  // ---- the wardrobe. Optional: without all five Today reads as it did.
  /** Your clothes, saved outfits and looks; the card shows once the wardrobe can dress you. */
  garments?: Garment[]
  outfits?: Outfit[]
  wears?: Wear[]
  /** What the card logs — a look from its one tap, or an edit of today's (a plan worn, a note) — for the shell to save with Undo. */
  onLogWear?(w: Wear, opts?: CardLog): void
  /** Pick…, Change and Forgot yesterday: Home → Wardrobe, on a day. */
  onOpenWardrobe?(o?: WardrobeOpen): void
  // ---- the site owner's sync alarm. Optional: without it Today reads as it did.
  /** The hourly sync check found the server refusing writes (syncalarm.ts): a banner at the top. */
  syncAlarm?: SyncAlarm | null
  /** Admin → Data, where the check's own card is. */
  onOpenSyncCheck?(): void
  /** Hides the banner on this device while this run of failures goes on, for twelve hours. */
  onDismissSyncAlarm?(): void
  /** The backlog lives on Tasks — Home is only the day. */
  onOpenTasks?(): void
  /**
   * The notes. They live on Tasks as a segment and were easy to miss there —
   * "it seems like it is buried on the tasks page & could be overlooked" — so
   * Home names them beside the other pages it opens (v3.28). The segment on
   * Tasks stays: this is a second door, not a move.
   */
  onOpenNotes?(): void
  // ---- putting a nudge off (v3.24). Optional: without both, nothing shows an ×.
  /**
   * Your own snoozes. A person, a place or one of the next fortnight's events
   * can be put off rather than answered — and never forever: each one carries
   * the day it comes back.
   */
  snoozes?: Snooze[]
  /** Put one off for `days`; the shell writes the row and offers Undo. */
  onSnooze?(target: SnoozeTarget, targetId: string, days: number, label: string): void
  /**
   * Open "Who, and how often" on its People side. Offered under the people
   * nobody has logged yet: one sheet sets a rhythm for everyone at once.
   */
  onSetUpRhythms?(): void
}

/**
 * The site owner's sync alarm: the hourly check found the server refusing
 * writes. The check tells the owner through the digest's push or email; with
 * both off this is how it reaches them, in the check's own words, with the
 * way to Admin → Data and a way to put it aside.
 */
export function SyncAlarmBanner({ alarm, onOpen, onDismiss }: { alarm: SyncAlarm; onOpen?(): void; onDismiss?(): void }) {
  return (
    <section className="sync-alarm" role="status" aria-label="Sync check">
      <p>
        <strong>{alarm.title ?? 'Some edits are not reaching the server.'}</strong> {alarm.sentence}
      </p>
      {onOpen && (
        <button type="button" className="btn" onClick={onOpen}>
          Open Admin → Data
        </button>
      )}
      {onDismiss && (
        <button type="button" className="btn subtle" onClick={onDismiss} aria-label="Dismiss the sync alarm" title="Dismiss">
          ✕
        </button>
      )}
    </section>
  )
}

const STALE_DAYS = 14
const NO_ENTRIES: CalendarEntry[] = []
const NO_SNOOZES: Snooze[] = []

/**
 * How long "hide this event" has to last: until the day it is for has gone by,
 * and no longer. Rounded up to a whole day so the row is gone for the rest of
 * today, and at least one day so a × on something already ending never reads
 * as a no-op.
 */
export function daysUntilGone(ev: CalendarEvent, now = new Date()): number {
  const start = eventStartDate(ev).getTime()
  const end = ev.allDay ? start + DAY_MS : Date.parse(ev.end)
  const ms = (Number.isFinite(end) ? end : start + DAY_MS) - now.getTime()
  return Math.max(1, Math.ceil(ms / DAY_MS))
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 }

/**
 * What to offer on a clear day: open wishlist items, most wanted first (by
 * priority, then most recently touched), a handful so it reads as a nudge and
 * not as another list.
 */
export function freeTimeWishlist(tasks: Task[], limit = 5): Task[] {
  return tasks
    .filter(t => t.status === 'wishlist' && !t.deletedAt)
    .sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
}

/**
 * The × on a nudge: put this one off, for a while (v3.24).
 *
 * Today's people, places and Coming up used to offer two answers — "done" and
 * leaving it there to ask again tomorrow. Some weeks the honest answer is
 * neither. So: an ×, and a small menu of how long. There is deliberately no
 * "never" on it; each option carries the day the nudge comes back, so nothing
 * is quietly dropped and nobody is forgotten by a mis-tap.
 */
function SnoozeButton({ label, onPick }: { label: string; onPick(days: number): void }) {
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <button type="button" className="btn subtle nudge-x" aria-label={`Put ${label} off for a while`} title={`Not now — put ${label} off`} onClick={() => setOpen(true)}>
        ×
      </button>
    )
  }
  return (
    <span className="nudge-snooze" role="group" aria-label={`Put ${label} off for`}>
      {SNOOZE_OPTIONS.map(o => (
        <button
          key={o.days}
          type="button"
          className="btn subtle nudge-snooze-opt"
          title={`Ask again in ${o.label}`}
          onClick={() => {
            setOpen(false)
            onPick(o.days)
          }}
        >
          {o.short}
        </button>
      ))}
      <button type="button" className="btn subtle nudge-x" aria-label="Keep asking" title="Keep asking" onClick={() => setOpen(false)}>
        ↩
      </button>
    </span>
  )
}

interface Section {
  key: string
  title: string
  sub?: string
  tasks: Task[]
  tone?: 'warn'
}

/**
 * Today's focus has a card of its own, so every section leaves those tasks
 * out and says how many went: each section comes back with only its other
 * rows and an `inFocus` count, and a section left with no rows is dropped.
 * The count tiles are worked out before this and still include them.
 */
export function leaveOutFocus<T extends { tasks: Task[] }>(sections: T[], focusIds: ReadonlySet<string>): (T & { inFocus: number })[] {
  return sections.flatMap(sec => {
    const rows = sec.tasks.filter(t => !focusIds.has(t.id))
    return rows.length > 0 ? [{ ...sec, tasks: rows, inFocus: sec.tasks.length - rows.length }] : []
  })
}

/** This device's calendar day for a due date, or null for one that is not a date. */
const localDayKey = (iso: string): string | null => (Number.isFinite(Date.parse(iso)) ? dateKey(iso) : null)

/**
 * The dated sections, split by the rule the morning digest and an assistant's
 * get_overview use (bucketByDue), read on this device's calendar: Home never
 * calls a task overdue that the digest says is due today. "Already past" is
 * the timed ones among today's, and "This week" the next seven days of what
 * bucketByDue calls due soon, which has no end of its own.
 */
export function dueSections(tasks: Task[], now: Date = new Date()) {
  const { open, overdue, dueToday, dueSoon } = bucketByDue(tasks, { today: dateKey(now), dayKey: localDayKey })
  const today = dueToday.sort(compareTasks)
  return {
    open,
    overdue: overdue.sort(compareTasks),
    today,
    late: today.filter(t => dueTone(t, now) === 'late'),
    week: dueSoon.filter(t => dayOffset(t.dueAt!, now) <= 7).sort(compareTasks),
  }
}

/** From 17:00 the strip offers Shut down once a focus is set, and from 20:00 whether or not. */
export const SHUTDOWN_HOUR = 17
export const LATE_HOUR = 20

/**
 * The strip's one action: "Plan my day" in the morning (and in the early
 * evening while nothing is in focus), "Shut down" in the evening, and "Day
 * closed" once this device has shut the day down.
 */
export function briefingCtaLabel({ hour, hasFocus, closed }: { hour: number; hasFocus: boolean; closed: boolean }): BriefingCta['label'] {
  if (closed) return 'Day closed'
  if (hour >= LATE_HOUR || (hour >= SHUTDOWN_HOUR && hasFocus)) return 'Shut down'
  return 'Plan my day'
}

function addDays(from: Date, n: number): Date {
  const d = startOfDay(from)
  d.setDate(d.getDate() + n)
  return d
}

function nextWeekday(from: Date, weekday: number): Date {
  const d = startOfDay(from)
  const delta = (weekday - d.getDay() + 7) % 7 || 7
  d.setDate(d.getDate() + delta)
  return d
}

/**
 * How far left the row slides to park the two defer buttons in full view, until
 * the tray has been measured. Two `.swipe-action`s at their 84px `min-width` —
 * the whole tray at `--type-scale` 1. Their labels are `0.75rem`, so above
 * about scale 1.2 "Tomorrow" and "Next week" no longer fit in 84px and the tray
 * is wider than this; the row measures it and latches on the real width instead
 * (the tray has no width cap, and the opaque `.swipe-face` above it would hide
 * — and swallow the taps on — whatever the slide failed to uncover).
 */
export const DEFER_TRAY = -168
/** Past this much of a left drag, letting go parks the tray open instead of snapping back. */
export const DEFER_LATCH = -56
/** A right drag this long completes the task on release. */
export const DONE_PULL = 88
/**
 * How far back over a threshold the finger has to come before the row counts as
 * having left that band. Without it a thumb resting on the line buzzes on every
 * touchmove event.
 */
const BAND_HYSTERESIS = 10
/** Which release the row is currently promising: nothing, complete, or park the tray. */
export type DragBand = 'none' | 'done' | 'latch'

/**
 * Which of the three swipe outcomes letting go right now would pick, given where
 * the row was a moment ago. Entering a band is what buzzes, so leaving one costs
 * `BAND_HYSTERESIS` more travel than entering it did — a thumb parked on the
 * threshold must not rattle.
 */
export function bandOf(dx: number, prev: DragBand, canDefer: boolean): DragBand {
  // holding the band you are already in is the only thing hysteresis does; a
  // flick that has left it is re-read from scratch, so crossing straight to the
  // other band still buzzes on the move that got there
  if (prev === 'done' && dx >= DONE_PULL - BAND_HYSTERESIS) return 'done'
  if (prev === 'latch' && canDefer && dx <= DEFER_LATCH + BAND_HYSTERESIS) return 'latch'
  if (dx >= DONE_PULL) return 'done'
  if (canDefer && dx <= DEFER_LATCH) return 'latch'
  return 'none'
}

/**
 * A task line that can be swiped. The defer buttons live in a tray that the row
 * face slides off to reveal: the face is opaque and sits above them, so at rest
 * the row is an ordinary row and nothing can print through it. The tray is also
 * only mounted once the row has actually moved, so it is never in the way of a
 * screen reader or a stray tap.
 */
function TaskRow({
  task,
  reason,
  onOpen,
  onStatus,
  onDefer,
}: {
  task: Task
  reason?: string
  onOpen(t: Task): void
  onStatus(id: string, s: TaskStatus): void
  onDefer?(id: string, day: Date): void
}) {
  const done = task.status === 'done'
  const canDefer = !!onDefer && !done
  const drag = useRef<{ x: number; y: number; base: number; axis: '?' | 'x' | 'y'; band: DragBand } | null>(null)
  const swiped = useRef(false)
  const [dx, setDx] = useState(0)
  const [trayW, setTrayW] = useState(-DEFER_TRAY)
  const [dragging, setDragging] = useState(false)
  const trayOpen = dx <= DEFER_LATCH
  /** Where a latch parks the face: the tray's real width, once it has one. */
  const latch = -trayW

  // The tray's buttons carry text that grows with --type-scale and it has no
  // width cap, so its width is a measurement, not a constant. A ref callback
  // rather than an effect: it runs once, when the tray attaches, before the
  // browser paints — an effect would re-read offsetWidth (and force layout) on
  // every touchmove of the app's most-used gesture.
  const measureTray = useCallback((el: HTMLDivElement | null) => {
    const w = el?.offsetWidth
    if (!w) return
    setTrayW(prev => (prev === w ? prev : w))
    // the ⋯ handle latches from rest, where the tray was not in the DOM to be
    // measured — correct that park now. A face still following a finger is left
    // alone; the release reads the width this just stored.
    if (drag.current?.axis !== 'x') setDx(d => (d <= DEFER_LATCH ? -w : d))
  }, [])

  const close = () => {
    setDx(0)
    setDragging(false)
  }
  const deferTo = (days: number) => {
    close()
    onDefer?.(task.id, addDays(new Date(), days))
  }

  return (
    <li className={`trow swipe-row${done ? ' done' : ''}${trayOpen ? ' tray-open' : ''}`}>
      {canDefer && dx < -4 && (
        <div className="swipe-tray" ref={measureTray}>
          <button type="button" className="swipe-action" onClick={() => deferTo(1)}>
            Tomorrow
          </button>
          <button type="button" className="swipe-action next" onClick={() => deferTo(7)}>
            Next week
          </button>
        </div>
      )}
      <div
        className="swipe-face"
        style={dx ? { transform: `translateX(${dx}px)`, ...(dragging ? { transition: 'none' } : null) } : undefined}
        onClick={() => {
          // a swipe ends in a click on iOS — never let it open the editor
          if (swiped.current) {
            swiped.current = false
            return
          }
          if (dx !== 0) close()
          else onOpen(task)
        }}
        onTouchStart={e => {
          drag.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, base: dx, axis: '?', band: bandOf(dx, 'none', canDefer) }
        }}
        onTouchMove={e => {
          const d = drag.current
          if (!d) return
          const ddx = e.touches[0].clientX - d.x
          const ddy = e.touches[0].clientY - d.y
          if (d.axis === '?') {
            // the same dead zone and tie-break as the pull-down, so a diagonal
            // start is claimed by exactly one of them
            const axis = lockAxis(ddx, ddy)
            if (!axis) return
            d.axis = axis
            if (axis === 'x') setDragging(true)
          }
          if (d.axis !== 'x') return
          swiped.current = true
          const next = Math.max(Math.min(d.base + ddx, DONE_PULL + 32), canDefer ? latch - 32 : 0)
          setDx(next)
          // one tap on entering a band, so the thumb knows what letting go will do
          const band = bandOf(next, d.band, canDefer)
          if (band !== d.band) {
            d.band = band
            if (band !== 'none') void haptic('light')
          }
        }}
        onTouchEnd={() => {
          const axis = drag.current?.axis
          // release on the band that was last signalled, not on a fresh read of
          // dx: inside the hysteresis window those disagree, and the buzz has
          // already promised the thumb an outcome. `canDefer` is re-checked all
          // the same — a sync landing mid-gesture can complete the task, and a
          // row with no tray must never park itself over an empty gutter.
          const band = drag.current?.band ?? 'none'
          drag.current = null
          setDragging(false)
          if (axis !== 'x') return
          if (band === 'done') {
            setDx(0)
            onStatus(task.id, done ? 'todo' : 'done')
          } else if (band === 'latch' && canDefer) setDx(latch)
          else setDx(0)
        }}
      >
        <input
          type="checkbox"
          className="tcheck"
          checked={done}
          aria-label={done ? 'Reopen' : 'Mark done'}
          onClick={e => e.stopPropagation()}
          onChange={() => onStatus(task.id, done ? 'todo' : 'done')}
        />
        <div className="dash-main">
          <button type="button" className="row-open">
            <span className="dash-title">
              <PriorityMark priority={task.priority} /> {task.title || excerpt(task.description, 60) || 'Untitled'}
            </span>
          </button>
          <span className="dash-meta">
            {reason && <span className="why">{reason}</span>}
            {task.status === 'blocked' && <span className="badge badge-blocked">Blocked</span>}
            {task.status === 'doing' && <span className="badge badge-doing">Doing</span>}
          </span>
        </div>
        <DueBadge task={task} />
        {canDefer && (
          <button
            type="button"
            className="swipe-handle"
            aria-label={trayOpen ? 'Hide defer options' : 'Defer this task'}
            aria-expanded={trayOpen}
            title="Defer"
            onClick={e => {
              e.stopPropagation()
              setDx(trayOpen ? 0 : latch)
            }}
          >
            ⋯
          </button>
        )}
      </div>
    </li>
  )
}

/**
 * Today's focus, directly under the briefing strip: up to three tasks you
 * chose this morning (or last night), open ones first, each swipeable like any
 * Today row and showing its time block when it has one. A defer from here also
 * takes the task out of today's focus. Nothing in focus, no card.
 */
export function FocusCard({
  tasks,
  blocks,
  onOpen,
  onStatus,
  onDefer,
  onEdit,
}: {
  /** Today's focus as focusTasks lists it: open first, then done. */
  tasks: Task[]
  /** Each task's time block today, by task id. */
  blocks: Map<string, CalendarEntry>
  onOpen(t: Task): void
  onStatus(id: string, s: TaskStatus): void
  onDefer(id: string, day: Date): void
  /** Opens Plan my day at the focus step. */
  onEdit?(): void
}) {
  const fold = useFold('focus', 'Today’s focus')
  if (tasks.length === 0) return null
  const done = tasks.filter(t => t.status === 'done').length
  const allDone = done === tasks.length
  const sub = allDone ? (tasks.length === 3 ? 'All three done' : 'All done') : `${done} of ${tasks.length} done`
  return (
    <section id="today-focus" className={'chart-card focus-card' + (allDone ? ' all-done' : '') + fold.className}>
      <header className="chart-head">
        <div>
          <h3>Today’s focus</h3>
          <p className="chart-sub">{sub}</p>
        </div>
        {onEdit && (
          <button type="button" className="btn subtle" onClick={onEdit}>
            Edit
          </button>
        )}
        {fold.control}
      </header>
      <ul className="dash-list tlist">
        {tasks.map(t => {
          const block = blocks.get(t.id)
          return (
            <TaskRow
              key={t.id}
              task={t}
              reason={block ? `${clock(block.start)}–${clock(block.end)}` : undefined}
              onOpen={onOpen}
              onStatus={onStatus}
              onDefer={onDefer}
            />
          )
        })}
      </ul>
    </section>
  )
}

const EVENT_HORIZON_DAYS = 14

function eventWhen(ev: CalendarEvent): string {
  const start = eventStartDate(ev)
  const off = dayOffset(start.toISOString())
  const day = off === 0 ? 'Today' : off === 1 ? 'Tomorrow' : start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  return ev.allDay ? day : `${day} ${fmtTime(ev.start)}`
}

function plannedLabel(dueAt?: string): string {
  if (!dueAt) return 'Planned'
  const off = dayOffset(dueAt)
  if (off === 0) return 'Planned · Today'
  if (off === 1) return 'Planned · Tomorrow'
  return `Planned · ${new Date(dueAt).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`
}

/**
 * The fold on a section of Home: shut it to its heading, and remember which.
 * It sits at the end of the section's own header row, after whatever action
 * that header already had — two controls at the right, not one on top of
 * another (v3.29).
 */
export function Today({
  tasks,
  people,
  places,
  reviews,
  onPlanWith,
  onWentTo,
  onPlanAt,
  onPlanOccasion,
  onSaw,
  onSaveReview,
  projects,
  events,
  sourceMap,
  onPlan,
  onOpen,
  onStatus,
  onDefer,
  onDeferAll,
  onNew,
  meals,
  recipes,
  onOpenKitchen,
  onOpenReview,
  onCookRecipe,
  journal,
  onSaveJournal,
  onDeleteJournal,
  onOpenJournal,
  habits,
  onSaveHabit,
  onDeleteHabit,
  name,
  nameOf,
  routines,
  onSaveRoutine,
  onDeleteRoutine,
  myId = null,
  entries = NO_ENTRIES,
  onPlanDay,
  onShutDown,
  onPlanWeek,
  onDeferFromFocus,
  onPlanMeal,
  garments,
  outfits,
  wears,
  onLogWear,
  onOpenWardrobe,
  syncAlarm,
  onOpenSyncCheck,
  onDismissSyncAlarm,
  onOpenTasks,
  snoozes = NO_SNOOZES,
  onSnooze,
  onOpenNotes,
  onSetUpRhythms,
}: Props) {
  /**
   * Today's day key, and the reason this page re-renders at midnight.
   *
   * Everything below used to read `dateKey(new Date())` where it stood, which
   * is right at the instant it runs and wrong for as long as the page stays
   * mounted afterwards. On the phone that is the normal case: iOS suspends and
   * resumes the WKWebView rather than killing it, so Home left open overnight
   * kept yesterday — and the cards that take a day key WRITE with it. A look
   * logged from the wardrobe card, a habit ticked, a routine step: each landed
   * on the day before.
   */
  const todayKey = useDayKey()
  // what is still coming up moves on as the hours pass, not only when the list changes
  const now = useNow()
  const weekly = useMemo(() => doneByWeek(tasks), [tasks])
  const thisWeek = useMemo(() => weekRange(new Date()), [])
  const isSunday = new Date().getDay() === 0
  /**
   * Where the journal card sits: with the other once-a-day cards in the
   * evening, below the task sections in the morning. Frozen at mount — the
   * editor debounces its writes, and re-deciding this at 17:00 would remount it
   * (losing the caret, and the keystrokes since the last save) mid-sentence.
   */
  /** Which sections are folded away, per device (src/homefolds.ts). */
  const [folded, setFolded] = useState(readFolded)
  const onFold = (id: string) =>
    setFolded(f => {
      const next = toggleFold(f, id)
      writeFolded(next)
      return next
    })
  /** A section's class, with the fold on it when it is shut. */
  const card = (id: string, cls = 'chart-card') => (folded.includes(id) ? `${cls} folded` : cls)

  const [evening] = useState(() => new Date().getHours() >= 17)
  /**
   * Where the wardrobe card sits: straight under the focus card in the
   * morning, while you are dressing, and above the habits after that. Frozen
   * at mount like `evening`, so it never jumps under a thumb at noon.
   */
  const [morning] = useState(() => new Date().getHours() < 12)
  const wardrobeCard =
    garments && outfits && wears && onLogWear && onOpenWardrobe ? (
      <WardrobeCard
        garments={garments}
        outfits={outfits}
        wears={wears}
        dayKey={todayKey}
        // a work day of your own on the calendar puts the looks for work first
        workDay={workDaysOf(entries, myId).has(todayKey)}
        onLog={onLogWear}
        onOpen={onOpenWardrobe}
      />
    ) : null
  // NOT frozen: Today stays mounted across a night on the phone, and a routines
  // card still filtering by last night's hour would hide the morning list. The
  // card itself holds the hour still while an edit is open.
  const hour = new Date().getHours()
  // Top 3 is written during last week's review as "for next week"
  const weekReview = useMemo(() => {
    const prev = shiftRange(thisWeek, -1)
    return reviews.find(r => r.period === 'week' && r.key === prev.key) ?? reviews.find(r => r.period === 'week' && r.key === thisWeek.key)
  }, [reviews, thisWeek])
  const sundayDraft = useMemo(() => {
    const anchor = defaultReviewAnchor(new Date())
    const range = weekRange(anchor)
    return reviews.find(r => r.period === 'week' && r.key === range.key && r.summary?.trim())
  }, [reviews])
  const top3 = useMemo(() => (weekReview?.top ?? []).map(t => t.trim()).filter(Boolean).slice(0, 3), [weekReview])
  const topDone = useMemo(() => weekReview?.topDone ?? [], [weekReview])
  // today's focus has its own card: the lists below leave it out and say so
  const focus = useMemo(() => focusTasks(tasks, todayKey, myId), [tasks, todayKey, myId])
  const focusIds = useMemo(() => new Set(focus.map(t => t.id)), [focus])
  const blocks = useMemo(() => blocksOn(entries, todayKey), [entries, todayKey])
  const occasions = useMemo(() => upcomingOccasions(people, 21), [people])
  // What you have put off, by what it was put off (v3.24). Read once here so
  // three lists can ask it; a row whose day has come back is simply absent.
  const putOff = useMemo(
    () => ({
      people: snoozedIds(snoozes, 'person'),
      places: snoozedIds(snoozes, 'place'),
      events: snoozedIds(snoozes, 'event'),
    }),
    [snoozes],
  )
  const { peopleNudges, neverLogged } = useMemo(() => {
    // your own events that have happened count as seeing the people on them, as on People.
    // myId is what makes this YOUR log: the address book is the household's,
    // but the other member seeing their mother is not you having called her (v3.24).
    const seen = seenTasks(tasks, entries, new Date(), myId)
    const stats = people.map(p => personStats(p, seen))
    // peopleToNudge, not a filter here: the rule about who Today asks after —
    // the drifting, then two nobody has logged, taking turns by day — lives
    // with the rest of the people rules. What is put off is handed to it, so
    // the next in turn takes the place of one put off.
    return {
      peopleNudges: peopleToNudge(stats, { todayKey, putOff: putOff.people }),
      neverLogged: stats.filter(s => s.status === 'never').length,
    }
  }, [people, tasks, entries, myId, putOff, todayKey])
  // Cadence places only: a place without a rhythm has status 'none' and never lands here.
  // A meal eaten out there counts as going, as it does on Places.
  const placeNudges = useMemo(() => {
    const now = new Date()
    const out: { place: Place; status: 'due' | 'overdue'; reason: string; daysSince: number }[] = []
    for (const place of places) {
      if (putOff.places.has(place.id)) continue
      const s = placeCadenceStatus(place, tasks, now, meals, myId)
      if (s.status === 'due' || s.status === 'overdue') out.push({ place, status: s.status, reason: s.reason, daysSince: s.daysSince ?? 0 })
    }
    return out
      .sort((a, b) => (a.status === b.status ? b.daysSince - a.daysSince : a.status === 'overdue' ? -1 : 1))
      .slice(0, 4)
  }, [places, tasks, meals, myId, putOff])
  const dinner = useMemo(() => tonightDinner(meals, recipes), [meals, recipes])
  const plates = useMemo(() => platesOn(meals, recipes), [meals, recipes])
  const upcomingEvents = useMemo(() => {
    const horizon = now + EVENT_HORIZON_DAYS * DAY_MS
    return events
      .filter(ev => {
        // A work day is a property of the day, not something coming up: the
        // calendar has always drawn it as a badge rather than an item, and
        // the briefing strip already says whose day is what. Listing them
        // here filled Coming up with the other member's shifts (v3.24).
        if (ev.work) return false
        // and of what is left, an × puts one away until it has gone by
        if (putOff.events.has(ev.id)) return false
        const start = eventStartDate(ev).getTime()
        const end = ev.allDay ? start + DAY_MS : new Date(ev.end).getTime()
        return end > now && start < horizon
      })
      .slice(0, 10)
  }, [events, putOff, now])

  const s = useMemo(() => {
    const now = new Date()
    const nowMs = now.getTime()
    const { open, overdue, today, late, week } = dueSections(tasks, now)
    const doing = open.filter(t => t.status === 'doing' && !t.dueAt).sort(compareTasks)
    const blocked = open.filter(t => t.status === 'blocked').sort(compareTasks)
    const stale = open
      .filter(t => !t.dueAt && t.status === 'todo' && nowMs - new Date(t.updatedAt).getTime() > STALE_DAYS * DAY_MS)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    // every stale to-do also passes inInbox; it moves on from the Inbox to Going stale rather than being listed twice
    const staleIds = new Set(stale.map(t => t.id))
    const inbox = open.filter(t => inInbox(t) && !staleIds.has(t.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const doneRecentAll = tasks
      .filter(t => t.status === 'done' && t.completedAt && nowMs - new Date(t.completedAt).getTime() < 7 * DAY_MS)
      .sort((a, b) => b.completedAt!.localeCompare(a.completedAt!))
    const doneRecent = doneRecentAll.filter(t => !isVisit(t))
    const visitsRecent = doneRecentAll.filter(isVisit)
    return { open, overdue, today, late, week, doing, blocked, stale, inbox, doneRecent, visitsRecent }
  }, [tasks])

  const toggleTop = (index: number) => {
    if (!weekReview) return
    const next = [...(weekReview.topDone ?? [false, false, false])]
    while (next.length < 3) next.push(false)
    next[index] = !next[index]
    onSaveReview({ ...weekReview, topDone: next, updatedAt: newerStamp(weekReview.updatedAt) })
  }

  // A clear day — no events, nothing due, nothing overdue — is the moment to
  // surface the wishlist: the things you said you would do if there were time.
  const clearDay = !briefingFacts(events, habits, new Date()).events && s.overdue.length === 0 && s.today.length === 0
  const freeTime = clearDay ? freeTimeWishlist(tasks) : []

  // the owner's sync alarm tops the page, the empty one too
  const alarm = syncAlarm ? <SyncAlarmBanner alarm={syncAlarm} onOpen={onOpenSyncCheck} onDismiss={onDismissSyncAlarm} /> : null

  // a wardrobe that can dress you has its card to show, tasks or not
  const dressable = !!(wardrobeCard && garments && canDress(garments))
  if (tasks.length === 0 && projects.length === 0 && !dinner && !sundayDraft && !dressable) {
    return (
      <>
        {alarm}
        <div className="empty-hero">
          <h2>Welcome to your planner</h2>
          <p>
            Add tasks with due dates and this page becomes your daily driver: what's overdue, what's due today, and what
            the week looks like.
          </p>
          <p>
            <button className="btn primary" onClick={() => onNew()}>
              + New task
            </button>
          </p>
        </div>
      </>
    )
  }

  const everySection: Section[] = [
    { key: 'overdue', title: 'Overdue', sub: 'Past due and still open', tasks: s.overdue, tone: 'warn' as const },
    {
      key: 'today',
      title: 'Today',
      sub: s.late.length ? `${s.late.length} already past` : 'Due before midnight',
      tasks: s.today,
    },
    { key: 'inbox', title: 'Inbox', sub: 'Captured, not yet triaged — give each a date', tasks: s.inbox },
  ]
  const sections = leaveOutFocus(everySection, focusIds)

  // A tile only offers the jump when the section it counts is actually on the
  // page; otherwise it is the same button, announced as unavailable. `null`
  // rather than `undefined` on purpose — see StatTile: these three tiles gain
  // and lose their target as the day is worked through, and a tile that changed
  // element type under a focused thumb or caret would drop focus to <body>.
  const shown = new Set(sections.map(sec => sec.key))
  // a section whose every row is in today's focus is not drawn: its tile jumps to the focus card instead
  const inFocusOnly = new Set(everySection.filter(sec => sec.tasks.length > 0 && sec.tasks.every(t => focusIds.has(t.id))).map(sec => sec.key))
  const jump = (key: string) =>
    shown.has(key)
      ? () => document.getElementById(`today-${key}`)?.scrollIntoView({ block: 'start' })
      : inFocusOnly.has(key)
        ? () => document.getElementById('today-focus')?.scrollIntoView({ block: 'start' })
        : null

  // the strip's one action; "Day closed" is this device's own note (ShutdownSheet)
  const ctaLabel = briefingCtaLabel({ hour, hasFocus: focus.length > 0, closed: dayClosed(todayKey) })
  const cta: BriefingCta | undefined =
    ctaLabel === 'Plan my day' ? (onPlanDay ? { label: ctaLabel, onClick: () => onPlanDay() } : undefined) : onShutDown ? { label: ctaLabel, onClick: onShutDown } : undefined
  const focusTitles = new Set(focus.map(t => (t.title || '').trim().toLowerCase()).filter(Boolean))

  const journalCard = (
    <JournalCard entries={journal} people={people} onSave={onSaveJournal} onDelete={onDeleteJournal} onOpenAll={onOpenJournal} />
  )

  const endOfNextWeek = (() => {
    const d = nextWeekday(new Date(), 0)
    d.setDate(d.getDate() + 7)
    d.setHours(17, 0, 0, 0)
    return d.toISOString()
  })()

  return (
    <HomeFolds value={{ folded, onFold }}>
    <div className="insights today">
      <header className="today-head">
        <div>
          <h2>Today</h2>
          <p className="chart-sub">
            {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
        </div>
        {/* Review rides on the title line: it is the one of these that is about
            a span of days rather than a thing you keep, so it belongs with the
            date rather than in the row of places below (v3.29). */}
        {onOpenReview && (
          <button type="button" className="btn today-review" onClick={onOpenReview}>
            Review
          </button>
        )}
      </header>

      {/* The places Home opens, as cards rather than as a row of small buttons.
          They are three of the app's rooms and a card is what a room looks
          like; a 44pt pill among four others read as a toolbar. Chat left this
          row for the top bar in v3.29, where its badge is visible from every
          tab — which is what left exactly three to share the width. */}
      <div className="today-cards">
        {onOpenJournal && (
          <button type="button" className="today-card" onClick={onOpenJournal}>
            <Icon name="journal" size={24} />
            <span>Journal</span>
          </button>
        )}
        {onOpenNotes && (
          <button type="button" className="today-card" onClick={onOpenNotes}>
            <Icon name="notes" size={24} />
            <span>Notes</span>
          </button>
        )}
        {onOpenWardrobe && (
          <button
            type="button"
            className="today-card"
            onClick={() => onOpenWardrobe(garments && canDress(garments) ? { tab: 'outfit', date: todayKey } : { tab: 'clothes', add: true })}
          >
            <Icon name="wardrobe" size={24} />
            <span>Wardrobe</span>
          </button>
        )}
      </div>
      {alarm}
      {/* the day at a glance sits above the counters: what the day IS before what it owes */}
      <BriefingCard events={events} habits={habits} dinner={dinner} now={new Date()} name={name} cta={cta} myId={myId} nameOf={nameOf} />
      <FocusCard
        tasks={focus}
        blocks={blocks}
        onOpen={onOpen}
        onStatus={onStatus}
        onDefer={onDeferFromFocus ?? onDefer}
        onEdit={onPlanDay ? () => onPlanDay('focus') : undefined}
      />
      {morning && wardrobeCard}
      {freeTime.length > 0 && (
        <section className={card('wishlist', 'chart-card wishlist-nudge')}>
          <header className="chart-head">
            <div>
              <h3>Nothing due today — from your wishlist</h3>
              <p className="chart-sub">Things you have been meaning to do, for when there is time</p>
            </div>
          <Fold id="wishlist" name="the wishlist" folded={folded} onFold={onFold} />
          </header>
          <ul className="dash-list tlist">
            {freeTime.map(t => (
              <TaskRow key={t.id} task={t} onOpen={onOpen} onStatus={onStatus} />
            ))}
          </ul>
        </section>
      )}
      {/* Below 640px the two `kpi-extra` tiles leave grid flow entirely and
          "Open" spans the row (the phone `.kpi-extra` rules in src/styles/), so DOM order does not decide
          what the phone shows — it is the desktop row, left as it was. */}
      <div className="kpi-row">
        <StatTile
          label="Overdue"
          value={String(s.overdue.length)}
          sub={s.overdue.length ? 'need a new date or a push' : 'nothing slipped'}
          warn={s.overdue.length > 0}
          onJump={jump('overdue')}
        />
        <StatTile
          label="Due today"
          value={String(s.today.length)}
          sub={s.late.length ? `${s.late.length} already past` : undefined}
          onJump={jump('today')}
        />
        <StatTile label="This week" value={String(s.week.length)} sub="due in the next 7 days" className="kpi-extra" onJump={onOpenTasks ?? undefined} />
        <StatTile label="Open" value={String(s.open.length)} sub="the rest is on Tasks" className="kpi-wide" onJump={onOpenTasks ?? undefined} />
        <div className="stat-tile kpi-extra">
          <div className="stat-label">Done this week</div>
          <div className="stat-value">
            {s.doneRecent.length}
            {s.visitsRecent.length > 0 && <small className="stat-aside"> · {s.visitsRecent.length} visits</small>}
          </div>
          <div className="spark" aria-hidden title="Done per week, last 12 weeks">
            {weekly.map((n, i) => (
              <span key={i} className={i === weekly.length - 1 ? 'spark-bar now' : 'spark-bar'} style={{ height: `${n === 0 ? 8 : 20 + (n / Math.max(...weekly, 1)) * 80}%` }} />
            ))}
          </div>
        </div>
      </div>

      {/* the one bulk gesture worth the space the counters gave back */}
      {s.overdue.length > 0 && (
        <p className="kpi-bulk">
          <button type="button" className="btn" onClick={() => onDeferAll(s.overdue.map(t => t.id), addDays(new Date(), 1))}>
            Push {s.overdue.length} overdue → tomorrow
          </button>
        </p>
      )}

      {plates.length > 0 && (
        <section className="chart-card kitchen-tonight">
          <header className="chart-head">
            <div>
              <h3>
                {plates.length === 1 && plates[0].meal.slot === 'dinner'
                  ? 'Tonight’s dinner'
                  : plates.length === 1
                    ? `Today’s ${MEAL_SLOT_META[plates[0].meal.slot].label.toLowerCase()}`
                    : 'Today’s meals'}
              </h3>
              <p className="chart-sub">On the day — the week is planned in Kitchen</p>
            </div>
            <button className="btn subtle" onClick={onOpenKitchen}>
              This week
            </button>
          </header>
          {plates.map(plate => (
            <div key={plate.meal.id} className="today-plate">
              <p className="kitchen-tonight-title">
                {plate.meal.out ? '🥡' : plate.recipe?.emoji || '🍽️'}{' '}
                {plates.length > 1 ? `${MEAL_SLOT_META[plate.meal.slot].label} · ` : ''}
                {mealLabel(plate.meal)}
              </p>
              {plate.recipe && (
                <p className="chart-sub kitchen-tonight-ings">
                  {plate.recipe.ingredients
                    .slice(0, 6)
                    .map(i => i.name)
                    .join(' · ')}
                  {plate.recipe.ingredients.length > 6 ? '…' : ''}
                </p>
              )}
              {plate.recipe && (
                <div className="ai-row" style={{ padding: '0 4px 12px' }}>
                  <button className="btn primary" onClick={() => onCookRecipe(plate.recipe!)}>
                    Cook
                  </button>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      {onPlanMeal && <MealIdeasCard dayKey={todayKey} now={new Date()} meals={meals} recipes={recipes} places={places} tasks={tasks} onPlan={onPlanMeal} />}

      {sundayDraft?.summary && (
        <section className={card('weekreview', 'chart-card week-review-ready')}>
          <header className="chart-head">
            <div>
              <h3>{isSunday ? 'Your week is ready' : 'Last week’s review'}</h3>
              <p className="chart-sub">{isSunday ? 'Written this morning from what actually happened' : 'Written from what actually happened'}</p>
            </div>
            <div className="event-actions">
              {isSunday && onPlanWeek && (
                <button type="button" className="btn" onClick={onPlanWeek}>
                  Plan next week
                </button>
              )}
              <button className="btn primary" onClick={onOpenReview}>
                Open review
              </button>
            </div>
          <Fold id="weekreview" name="the week" folded={folded} onFold={onFold} />
            </header>
          <p className="week-review-excerpt">{excerpt(sundayDraft.summary, 280)}</p>
        </section>
      )}

      {evening && journalCard}

      {!morning && wardrobeCard}

      <HabitsCard habits={habits} today={todayKey} onSave={onSaveHabit} onDelete={onDeleteHabit} />

      <RoutinesCard routines={routines} today={todayKey} hour={hour} onSave={onSaveRoutine} onDelete={onDeleteRoutine} />

      {top3.length > 0 && (
        <section className={card('weektop3', 'chart-card week-top3')}>
          <header className="chart-head">
            <div>
              <h3>This week's 3</h3>
              <p className="chart-sub">From last Sunday's review</p>
            </div>
            {isSunday && onPlanWeek && !sundayDraft?.summary && (
              <button type="button" className="btn subtle" onClick={onPlanWeek}>
                Plan next week
              </button>
            )}
          <Fold id="weektop3" name="this week's 3" folded={folded} onFold={onFold} />
          </header>
          <ul className="dash-list">
            {top3.map((line, i) => (
              <li key={i} className={topDone[i] ? 'trow done' : 'trow'}>
                <input type="checkbox" className="tcheck" checked={!!topDone[i]} aria-label="Mark done" onChange={() => toggleTop(i)} />
                <div className="dash-main">
                  <span className="dash-title">{line}</span>
                  {/* the line stays; its task is also on the focus card above */}
                  {focusTitles.has(line.trim().toLowerCase()) && <span className="badge focus-badge">Today’s focus</span>}
                </div>
                <button className="btn subtle" onClick={() => onNew({ title: line, dueAt: endOfNextWeek, status: 'todo' })}>
                  → task
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {sections.length === 0 ? (
        <div className="chart-card">
          <p className="empty">
            Nothing due and nothing stuck.{' '}
            <button type="button" className="btn subtle" onClick={() => onNew()}>
              + New task
            </button>{' '}
            or enjoy the quiet.
          </p>
        </div>
      ) : (
        <div className="today-grid">
          {sections.map(sec => (
            <section key={sec.key} id={`today-${sec.key}`} className={card(sec.key, sec.tone === 'warn' ? 'chart-card warn-card' : 'chart-card')}>
              <header className="chart-head">
                <div>
                  <h3>
                    {sec.title} <span className="board-count">{sec.tasks.length}</span>
                  </h3>
                  {sec.sub && <p className="chart-sub">{sec.sub}</p>}
                </div>
                {sec.key === 'overdue' && sec.tasks.length > 0 && (
                  <button className="btn" onClick={() => onDeferAll(sec.tasks.map(t => t.id), addDays(new Date(), 1))}>
                    Push all to tomorrow
                  </button>
                )}
              <Fold id={sec.key} name={sec.title} folded={folded} onFold={onFold} />
                </header>
              <ul className="dash-list tlist">
                {sec.tasks.slice(0, 12).map(t => (
                  <TaskRow key={t.id} task={t} onOpen={onOpen} onStatus={onStatus} onDefer={onDefer} />
                ))}
              </ul>
              {sec.tasks.length > 12 && <p className="board-more">+ {sec.tasks.length - 12} more in the Tasks tab</p>}
              {sec.inFocus > 0 && <p className="board-more focus-more">+ {sec.inFocus} in today’s focus</p>}
            </section>
          ))}
        </div>
      )}

      {!evening && journalCard}

      {occasions.length > 0 && (
        <section className={card('occasions', 'chart-card occasions')}>
          <header className="chart-head">
            <div>
              <h3>Occasions</h3>
              <p className="chart-sub">Birthdays and anniversaries in the next 3 weeks</p>
            </div>
          <Fold id="occasions" name="Occasions" folded={folded} onFold={onFold} />
          </header>
          <ul className="dash-list event-list">
            {occasions.map(o => {
              const gift = plannedGift(o.person.id, o.kind, o.at, tasks)
              return (
                <li key={`${o.person.id}-${o.kind}`} className="event-row">
                  <span className="person-avatar small" style={{ background: o.person.color }}>
                    {o.kind === 'birthday' ? '🎂' : '💍'}
                  </span>
                  <div className="dash-main">
                    <span className="dash-title">
                      {o.person.name}'s {o.kind}
                      {o.years ? <small className="muted"> · turns {o.years}</small> : null}
                    </span>
                    <span className="dash-reason">
                      {o.daysUntil === 0 ? 'Today!' : o.daysUntil === 1 ? 'Tomorrow' : `In ${o.daysUntil} days`} ·{' '}
                      {o.at.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                  <div className="event-actions">
                    <button className="btn subtle" onClick={() => onSaw(o.person)}>
                      {o.kind === 'birthday' ? 'Called/Saw' : 'Saw them'}
                    </button>
                    {gift ? (
                      <button className="btn" onClick={() => onOpen(gift)}>
                        Gift planned
                      </button>
                    ) : (
                      <button className="btn" onClick={() => onPlanOccasion(o.person, o.kind, o.at)}>
                        Plan a gift
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {(peopleNudges.length > 0 || placeNudges.length > 0) && (
        <section className={card('people', 'chart-card people-nudges')}>
          <header className="chart-head">
            <div>
              <h3>People</h3>
              <p className="chart-sub">Who's due a call, who you've not logged yet — and where you've meant to go back to</p>
            </div>
          <Fold id="people" name="People" folded={folded} onFold={onFold} />
          </header>
          <ul className="dash-list event-list">
            {peopleNudges.map(s => (
              <li key={s.person.id} className="event-row">
                <span className="person-avatar small" style={{ background: s.person.color }}>
                  {s.person.emoji ?? s.person.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="dash-main">
                  <span className="dash-title">
                    {s.person.name}{' '}
                    <span className="badge" style={{ background: SEEN_META[s.status].bg, color: SEEN_META[s.status].color }}>
                      {SEEN_META[s.status].label}
                    </span>
                  </span>
                  <span className="dash-reason">{s.reason}</span>
                </div>
                <div className="event-actions">
                  {/* a full button, like Plan something beside it: it was the one
                      control on Today drawn with no outline at all */}
                  <button className="btn" onClick={() => onSaw(s.person)}>
                    Saw them
                  </button>
                  {s.planned ? (
                      <button className="btn" onClick={() => onOpen(s.planned!)}>
                        {plannedLabel(s.planned.dueAt)}
                      </button>
                    ) : (
                      <button className="btn" onClick={() => onPlanWith(s.person)}>
                        Plan something
                      </button>
                    )}
                  {onSnooze && <SnoozeButton label={s.person.name} onPick={days => onSnooze('person', s.person.id, days, s.person.name)} />}
                </div>
              </li>
            ))}
            {placeNudges.map(s => (
              <li key={s.place.id} className="event-row">
                <span className="person-avatar small" style={{ background: s.place.color }}>
                  {s.place.emoji ?? PLACE_CATEGORY_META[s.place.category].emoji}
                </span>
                <div className="dash-main">
                  <span className="dash-title">
                    {s.place.name}{' '}
                    <span className="badge" style={{ background: SEEN_META[s.status].bg, color: SEEN_META[s.status].color }}>
                      Been a while
                    </span>
                  </span>
                  <span className="dash-reason">{s.reason}</span>
                </div>
                <div className="event-actions">
                  <button className="btn" onClick={() => onWentTo(s.place)}>
                    Went there
                  </button>
                  <button className="btn" onClick={() => onPlanAt(s.place)}>
                    Plan a trip
                  </button>
                  {onSnooze && <SnoozeButton label={s.place.name} onPick={days => onSnooze('place', s.place.id, days, s.place.name)} />}
                </div>
              </li>
            ))}
          </ul>
          {/* under the cold start's two: the one sheet that gives everyone a rhythm, or No reminders, at once */}
          {onSetUpRhythms && peopleNudges.some(s => s.status === 'never') && (
            <p className="nudge-foot">
              <span className="muted">
                {neverLogged === 1 ? 'One person has' : `${neverLogged} people have`} no visit logged yet
                {/* NEVER_NUDGES a day take their turn, so the rest are only waiting */}
                {neverLogged > NEVER_NUDGES ? `; ${NEVER_NUDGES} a day come up here.` : '.'}
              </span>
              <button type="button" className="btn" onClick={onSetUpRhythms}>
                Set up rhythms
              </button>
            </p>
          )}
        </section>
      )}

      {upcomingEvents.length > 0 && (
        <section className={card('comingup', 'chart-card coming-up')}>
          <header className="chart-head">
            <div>
              <h3>Coming up</h3>
              <p className="chart-sub">From your calendars, next {EVENT_HORIZON_DAYS} days — plan ahead with one tap</p>
            </div>
          <Fold id="comingup" name="Coming up" folded={folded} onFold={onFold} />
          </header>
          <ul className="dash-list event-list">
            {upcomingEvents.map(ev => (
              <li key={ev.id} className="event-row">
                <span className="pdot" style={{ background: sourceMap.get(ev.sourceId)?.color ?? 'var(--dot-fallback)' }} />
                <div className="dash-main">
                  <span className="dash-title">{ev.title}</span>
                  <span className="dash-reason">
                    {eventWhen(ev)}
                    {ev.location ? ` · ${ev.location}` : ''}
                  </span>
                </div>
                <div className="event-actions">
                  <button className="btn" onClick={() => onPlan(ev)}>
                    Plan
                  </button>
                  {/* most of these are work days and need no planning: × puts
                      the row away until the day it is for has gone by */}
                  {onSnooze && (
                    <button
                      type="button"
                      className="btn subtle nudge-x"
                      aria-label={`Hide ${ev.title} from Coming up`}
                      title="Not something to plan — hide it"
                      onClick={() => onSnooze('event', ev.id, daysUntilGone(ev), ev.title)}
                    >
                      ×
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {s.doneRecent.length > 0 && (
        <section className={card('done', 'chart-card')}>
          <header className="chart-head">
            <div>
              <h3>Recently done</h3>
              <p className="chart-sub">Completed in the last 7 days</p>
            </div>
          <Fold id="done" name="Recently done" folded={folded} onFold={onFold} />
          </header>
          <ul className="dash-list tlist">
            {s.doneRecent.slice(0, 8).map(t => (
              <li key={t.id} className="trow done" onClick={() => onOpen(t)}>
                <input type="checkbox" className="tcheck" checked readOnly aria-label="Done" onClick={e => e.stopPropagation()} onChange={() => onStatus(t.id, 'todo')} />
                <div className="dash-main">
                  <button type="button" className="row-open">
                    <span className="dash-title">{t.title || excerpt(t.description, 60) || 'Untitled'}</span>
                  </button>
                </div>
                <span className="dash-reason">{timeAgo(t.completedAt!)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
    </HomeFolds>
  )
}
