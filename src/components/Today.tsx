import { useCallback, useMemo, useRef, useState } from 'react'
import {
  MEAL_SLOT_META,
  CalendarEntry,
  CalendarEvent,
  CalendarSource,
  Habit,
  JournalEntry,
  Meal,
  MealSlot,
  PLACE_CATEGORY_META,
  Person,
  Place,
  Project,
  Recipe,
  Review as ReviewRecord,
  Routine,
  Task,
  TaskStatus,
} from '../types'
import { tonightDinner } from '../kitchen'
import { JournalCard } from './Journal'
import { newerStamp } from '../itemops'
import { SEEN_META, compareStats, personStats, plannedGift, upcomingOccasions } from '../people'
import { placeCadenceStatus } from '../places'
import { NextUp, defaultReviewAnchor, doneByWeek, isVisit, nextUp, weekRange, shiftRange } from '../review'
import { DAY_MS, compareTasks, dayOffset, dueTone, isOpen, startOfDay } from '../taskutils'
import { eventStartDate } from '../calendars'
import { haptic } from '../native'
import { lockAxis } from '../pull'
import { clock, dateKey, excerpt, fmtTime, timeAgo } from '../utils'
import { focusTasks } from '../../shared/today.mjs'
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

// One ongoing home project: Today shows no project cards, no "stalled" line
// and no project chips — a bar that never fills and a chip on every row would
// say nothing. Projects live on the Timeline and in search.

interface Props {
  tasks: Task[]
  /** Unfiltered tasks — visits are counted across every project. */
  allTasks: Task[]
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
}

const STALE_DAYS = 14
const NO_ENTRIES: CalendarEntry[] = []

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
  if (tasks.length === 0) return null
  const done = tasks.filter(t => t.status === 'done').length
  const allDone = done === tasks.length
  const sub = allDone ? (tasks.length === 3 ? 'All three done' : 'All done') : `${done} of ${tasks.length} done`
  return (
    <section id="today-focus" className={'chart-card focus-card' + (allDone ? ' all-done' : '')}>
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

export function Today({
  tasks,
  allTasks,
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
}: Props) {
  const weekly = useMemo(() => doneByWeek(allTasks), [allTasks])
  const thisWeek = useMemo(() => weekRange(new Date()), [])
  const isSunday = new Date().getDay() === 0
  /**
   * Where the journal card sits: with the other once-a-day cards in the
   * evening, below the task sections in the morning. Frozen at mount — the
   * editor debounces its writes, and re-deciding this at 17:00 would remount it
   * (losing the caret, and the keystrokes since the last save) mid-sentence.
   */
  const [evening] = useState(() => new Date().getHours() >= 17)
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
  const todayKey = dateKey(new Date())
  // today's focus has its own card: the lists below leave it out and say so
  const focus = useMemo(() => focusTasks(tasks, todayKey, myId), [tasks, todayKey, myId])
  const focusIds = useMemo(() => new Set(focus.map(t => t.id)), [focus])
  const blocks = useMemo(() => blocksOn(entries, todayKey), [entries, todayKey])
  const { upNext, upNextInFocus } = useMemo(() => {
    const pinned = top3.filter((_, i) => !topDone[i])
    const all: NextUp[] = nextUp(tasks, projects, 6, new Date(), pinned)
    if (focusIds.size === 0) return { upNext: all, upNextInFocus: 0 }
    return { upNext: nextUp(tasks, projects, 6, new Date(), pinned, focusIds), upNextInFocus: all.filter(n => focusIds.has(n.task.id)).length }
  }, [tasks, projects, top3, topDone, focusIds])
  const occasions = useMemo(() => upcomingOccasions(people, 21), [people])
  const peopleNudges = useMemo(
    () =>
      people
        .map(p => personStats(p, allTasks))
        .filter(s => s.status === 'overdue' || s.status === 'due')
        .sort(compareStats)
        .slice(0, 6),
    [people, allTasks],
  )
  // Cadence places only: a place without a rhythm has status 'none' and never lands here.
  const placeNudges = useMemo(() => {
    const now = new Date()
    const out: { place: Place; status: 'due' | 'overdue'; reason: string; daysSince: number }[] = []
    for (const place of places) {
      const s = placeCadenceStatus(place, allTasks, now)
      if (s.status === 'due' || s.status === 'overdue') out.push({ place, status: s.status, reason: s.reason, daysSince: s.daysSince ?? 0 })
    }
    return out
      .sort((a, b) => (a.status === b.status ? b.daysSince - a.daysSince : a.status === 'overdue' ? -1 : 1))
      .slice(0, 4)
  }, [places, allTasks])
  const dinner = useMemo(() => tonightDinner(meals, recipes), [meals, recipes])
  const upcomingEvents = useMemo(() => {
    const now = Date.now()
    const horizon = now + EVENT_HORIZON_DAYS * DAY_MS
    return events
      .filter(ev => {
        const start = eventStartDate(ev).getTime()
        const end = ev.allDay ? start + DAY_MS : new Date(ev.end).getTime()
        return end > now && start < horizon
      })
      .slice(0, 10)
  }, [events])

  const s = useMemo(() => {
    const now = new Date()
    const nowMs = now.getTime()
    const open = tasks.filter(isOpen)
    const withDue = open.filter(t => t.dueAt)
    const overdue = withDue.filter(t => dayOffset(t.dueAt!, now) < 0).sort(compareTasks)
    const today = withDue.filter(t => dayOffset(t.dueAt!, now) === 0).sort(compareTasks)
    const late = today.filter(t => dueTone(t, now) === 'late')
    const week = withDue
      .filter(t => {
        const off = dayOffset(t.dueAt!, now)
        return off > 0 && off <= 7
      })
      .sort(compareTasks)
    const doing = open.filter(t => t.status === 'doing' && !t.dueAt).sort(compareTasks)
    const blocked = open.filter(t => t.status === 'blocked').sort(compareTasks)
    const inbox = open
      .filter(t => !t.projectId && !t.dueAt && t.status === 'todo')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const stale = open
      .filter(t => !t.dueAt && t.status === 'todo' && nowMs - new Date(t.updatedAt).getTime() > STALE_DAYS * DAY_MS)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
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

  if (tasks.length === 0 && projects.length === 0 && !dinner && !sundayDraft) {
    return (
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
    { key: 'week', title: 'This week', sub: 'Due in the next 7 days', tasks: s.week },
    { key: 'doing', title: 'In progress, no date', sub: 'Started but not scheduled', tasks: s.doing },
    { key: 'blocked', title: 'Blocked', sub: 'Waiting on something — worth a nudge?', tasks: s.blocked },
    { key: 'inbox', title: 'Inbox', sub: 'Captured, not yet triaged — give each a project or a date', tasks: s.inbox },
    { key: 'stale', title: 'Going stale', sub: `To-dos untouched for ${STALE_DAYS}+ days with no date`, tasks: s.stale },
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
    <div className="insights today">
      <header className="today-head">
        <div>
          <h2>Today</h2>
          <p className="chart-sub">
            {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
        </div>
      </header>
      {/* the day at a glance sits above the counters: what the day IS before what it owes */}
      <BriefingCard events={events} habits={habits} dinner={dinner} now={new Date()} name={name} cta={cta} />
      <FocusCard
        tasks={focus}
        blocks={blocks}
        onOpen={onOpen}
        onStatus={onStatus}
        onDefer={onDeferFromFocus ?? onDefer}
        onEdit={onPlanDay ? () => onPlanDay('focus') : undefined}
      />
      {freeTime.length > 0 && (
        <section className="chart-card wishlist-nudge">
          <header className="chart-head">
            <div>
              <h3>Nothing due today — from your wishlist</h3>
              <p className="chart-sub">Things you have been meaning to do, for when there is time</p>
            </div>
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
        <StatTile label="This week" value={String(s.week.length)} sub="due in the next 7 days" className="kpi-extra" onJump={jump('week')} />
        <StatTile label="Open" value={String(s.open.length)} sub="to do, doing or blocked" className="kpi-wide" />
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

      {dinner && (
        <section className="chart-card kitchen-tonight">
          <header className="chart-head">
            <div>
              <h3>{dinner.meal.slot === 'dinner' ? 'Tonight’s dinner' : `Today’s ${MEAL_SLOT_META[dinner.meal.slot].label.toLowerCase()}`}</h3>
              <p className="chart-sub">
                {dinner.meal.out ? 'Eating out — nothing to cook' : dinner.recipe ? `${dinner.recipe.ingredients.length} ingredients` : 'Planned on the Kitchen tab'}
              </p>
            </div>
            <button className="btn subtle" onClick={onOpenKitchen}>
              Kitchen
            </button>
          </header>
          <p className="kitchen-tonight-title">
            {dinner.meal.out ? '🥡' : dinner.recipe?.emoji || '🍽️'} {dinner.meal.title}
          </p>
          {dinner.recipe && (
            <p className="chart-sub kitchen-tonight-ings">
              {dinner.recipe.ingredients
                .slice(0, 6)
                .map(i => i.name)
                .join(' · ')}
              {dinner.recipe.ingredients.length > 6 ? '…' : ''}
            </p>
          )}
          {dinner.recipe && (
            <div className="ai-row" style={{ padding: '0 4px 12px' }}>
              <button className="btn primary" onClick={() => onCookRecipe(dinner.recipe!)}>
                Cook
              </button>
            </div>
          )}
        </section>
      )}

      {onPlanMeal && <MealIdeasCard dayKey={todayKey} now={new Date()} meals={meals} recipes={recipes} places={places} tasks={allTasks} onPlan={onPlanMeal} />}

      {sundayDraft?.summary && (
        <section className="chart-card week-review-ready">
          <header className="chart-head">
            <div>
              <h3>{isSunday ? 'Your week is ready' : 'Last week’s review'}</h3>
              <p className="chart-sub">{isSunday ? 'Written this morning from what actually happened' : 'From Sunday’s digest'}</p>
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
          </header>
          <p className="week-review-excerpt">{excerpt(sundayDraft.summary, 280)}</p>
        </section>
      )}

      {evening && journalCard}

      <HabitsCard habits={habits} today={dateKey(new Date())} onSave={onSaveHabit} onDelete={onDeleteHabit} />

      <RoutinesCard routines={routines} today={dateKey(new Date())} hour={hour} onSave={onSaveRoutine} onDelete={onDeleteRoutine} />

      {top3.length > 0 && (
        <section className="chart-card week-top3">
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

      {upNext.length > 0 && (
        <section className="chart-card next-up">
          <header className="chart-head">
            <div>
              <h3>Next up</h3>
              <p className="chart-sub">Ranked across every open task, dated or not</p>
            </div>
          </header>
          <ul className="dash-list tlist">
            {upNext.map(({ task, reason }) => (
              <TaskRow
                key={task.id}
                task={task}
                reason={reason}
                onOpen={onOpen}
                onStatus={onStatus}
                onDefer={onDefer}
              />
            ))}
          </ul>
          {upNextInFocus > 0 && <p className="board-more focus-more">+ {upNextInFocus} in today’s focus</p>}
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
            <section key={sec.key} id={`today-${sec.key}`} className={sec.tone === 'warn' ? 'chart-card warn-card' : 'chart-card'}>
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
        <section className="chart-card occasions">
          <header className="chart-head">
            <div>
              <h3>Occasions</h3>
              <p className="chart-sub">Birthdays and anniversaries in the next 3 weeks</p>
            </div>
          </header>
          <ul className="dash-list event-list">
            {occasions.map(o => {
              const gift = plannedGift(o.person.id, o.kind, o.at, allTasks)
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
        <section className="chart-card people-nudges">
          <header className="chart-head">
            <div>
              <h3>People</h3>
              <p className="chart-sub">Who's due a call — and where you've meant to go back to</p>
            </div>
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
                  <button className="btn subtle" onClick={() => onSaw(s.person)}>
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
                  <button className="btn subtle" onClick={() => onWentTo(s.place)}>
                    Went there
                  </button>
                  <button className="btn" onClick={() => onPlanAt(s.place)}>
                    Plan a trip
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {upcomingEvents.length > 0 && (
        <section className="chart-card coming-up">
          <header className="chart-head">
            <div>
              <h3>Coming up</h3>
              <p className="chart-sub">From your calendars, next {EVENT_HORIZON_DAYS} days — plan ahead with one tap</p>
            </div>
          </header>
          <ul className="dash-list event-list">
            {upcomingEvents.map(ev => (
              <li key={ev.id} className="event-row">
                <span className="pdot" style={{ background: sourceMap.get(ev.sourceId)?.color ?? '#94a3b8' }} />
                <div className="dash-main">
                  <span className="dash-title">{ev.title}</span>
                  <span className="dash-reason">
                    {eventWhen(ev)}
                    {ev.location ? ` · ${ev.location}` : ''}
                  </span>
                </div>
                <button className="btn" onClick={() => onPlan(ev)}>
                  Plan
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {s.doneRecent.length > 0 && (
        <section className="chart-card">
          <header className="chart-head">
            <div>
              <h3>Recently done</h3>
              <p className="chart-sub">Completed in the last 7 days</p>
            </div>
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
  )
}
