import { DragEvent, useCallback, useEffect, useEffectEvent, useId, useMemo, useState } from 'react'
import { CalendarEvent, CalendarSource, Garment, MEAL_SLOTS, Meal, Person, Place, PlaceCategory, Project, Recipe, STATUS_META, Task, WORK_MODE_META, Wear, WorkMode } from '../types'
import { clock, dateKey, fmtTime } from '../utils'
import {
  DayItem,
  DaySources,
  dayItems,
  daySummary,
  eventsByDay,
  hasClock,
  marksByDay,
  monthCells,
  occasionsByMonthDay,
  tasksByDay,
  weekDays,
  weekLabel,
  workByDay,
} from '../calgrid'
import { QUICK_PICK_META, cookedIndex, visitIndex, mealLabel, mealsByDay, mealsForSlot, type KitchenMember } from '../kitchen'
import { mealWay, savedPlaces, type MealWay } from '../kitchenstats'
import { plannedGift } from '../people'
import { matchPlace, placeEmoji } from '../places'
import { MealSlotRow, SlotPicker, dinnerPick } from './MealSlotRow'
import { billEmoji, formatMoney } from '../bills'
import { readableInk } from '../contrast'
import { useTheme } from '../theme'
import { useDayKey } from '../useDayKey'
import { useNow } from '../useNow'
import { liveById, lookOn, looksOn, orderPieces, outfitLabel, planFor, wearIndex } from '../wardrobe'
import { Icon } from './Icon'
import { Modal } from './Modal'
import type { WardrobeOpen } from './planner/useNavigation'
import { GarmentPhoto } from './wardrobe/GarmentPhoto'

export type CalendarView = 'month' | 'week' | 'day'

interface Props {
  /** Which calendar to draw: the month, the week list, or one day in full. */
  view: CalendarView
  tasks: Task[]
  projects: Project[]
  projectMap: Map<string, Project>
  people: Person[]
  meals: Meal[]
  /** Whose slot we edit; a peer's dinner for the same night is named beside it. */
  myId?: string | null
  nameOf?(id: string | undefined): string | null
  inHousehold?: boolean
  /** The household, for who's cooking a shared dish in the meal picker. */
  members?: readonly KitchenMember[]
  /** For the day sheet's meal pickers: what you can cook, and where you can eat. */
  recipes: Recipe[]
  places: Place[]
  events: CalendarEvent[]
  sourceMap: Map<string, CalendarSource>
  onOpen(t: Task): void
  onNew(dueAtIso: string): void
  /** Plan or clear a meal from the day sheet. Rebuilds the grocery list (Planner owns it). */
  onSaveMeal(m: Meal): void
  onClearMeal(id: string): void
  /** Save a new place from the meal picker and hand it back. */
  onCreatePlace(name: string, category: PlaceCategory): Place
  /** Save a new recipe (name only) from the meal picker and hand it back. */
  onCreateRecipe(name: string): Recipe
  /** ★ a recipe, or not, from the meal picker's Cook list. */
  onStarRecipe?(recipe: Recipe): void
  /** Open the event editor for a new entry starting at this instant; `work` opens it as a work day. */
  onNewEvent(startIso: string, work?: WorkMode): void
  /** Open the event editor on one of our own entries. */
  onEditEvent(id: string): void
  onReschedule(id: string, day: Date): void
  /** Create a prep task for an external event. */
  onPlan(ev: CalendarEvent): void
  /** Log who was at a past event. */
  onAttendance(ev: CalendarEvent): void
  onOpenProject(p: Project): void
  onPlanOccasion(person: Person, kind: 'birthday' | 'anniversary', at: Date): void
  /**
   * Your clothes and what you wore (personal): a day with a look shows it as
   * one small line in the week list and the day sheet. Not in a month cell,
   * which at 375pt is a seventh of the width and has no room for it.
   */
  garments?: Garment[]
  wears?: Wear[]
  /** Home → Wardrobe on a day. Without it no look is shown. */
  onOpenWardrobe?(o: WardrobeOpen): void
  /** A day (YYYY-MM-DD) to open on arrival, its day sheet up — the month calendar in People → Stats or Places → Stats; consumed once. */
  openDay?: string | null
  onOpenDayConsumed?(): void
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// four before "+n more" — with two-line titles and cells that grow to fit, a
// normal day shows everything it has and only a packed one folds
const MAX_PILLS = 4
const OCCASION_GLYPH = { birthday: '🎂', anniversary: '💞' }
// The calendar's own colours are theme tokens (src/styles/01-base.css), each
// tuned to read in light and dark; a feed's or a project's colour is the user's.
/**
 * A meal in the colour of the way it is had (mealWay, the Kitchen's own rule),
 * a plan in the way it is planned: cooked at home in the accent, as ink; eaten
 * out at a saved place in blue, and bought, with no place named or at one
 * since deleted, in rose, the two Kitchen → Stats keys those ways by, so a run
 * of takeaways stands out in the month grid.
 */
const MEAL_COLORS: Record<MealWay, string> = { cooked: 'var(--accent-ink)', out: 'var(--cal-meal-out)', bought: 'var(--cal-meal-bought)' }
/** Leftovers' own mark, 🍲, as the Kitchen's cards show it; otherwise out or in. */
const mealGlyph = (m: Meal) => (m.quick ? QUICK_PICK_META[m.quick].emoji : m.out ? '🥡' : '🍽️')
/** Entries you wrote, distinct from any subscribed feed's colour. */
const LOCAL_EVENT_COLOR = 'var(--cal-event-local)'
/** An event whose calendar has gone. */
const FALLBACK_EVENT_COLOR = 'var(--dot-fallback)'

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
/** A YYYY-MM-DD key as that local day, or null for none or one that is not a day. */
const dayOfKey = (key: string | null | undefined): Date | null => {
  const m = key ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(key) : null
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
/** Default time for a task created from a day: 9am, same as the rest of the app. */
const morningOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0, 0).toISOString()
const fullDate = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
/** An event that has started by `now` (ms): the row offers Who was there? rather than a plan. */
const isPast = (ev: CalendarEvent, now: number) => new Date(ev.allDay ? ev.start + 'T00:00' : ev.start).getTime() < now

/**
 * Whether a task can be dragged to another day here. The hint under the
 * toolbar says it can — and in the app on an iPhone there is no drag to make,
 * so the hint promised one that never came. An iPad's shell drags (its web
 * view says it is a Mac, or an iPad), and so does every browser.
 */
export function dragsHere(): boolean {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return true
  return !(document.documentElement.classList.contains('native') && /\b(iPhone|iPod)\b/.test(navigator.userAgent))
}

/** The line under the toolbar: what a tap does, and a drag where there is one. */
export function calendarHint(view: CalendarView, drags: boolean): string {
  if (view === 'day') return 'This day’s tasks, events and meals'
  if (view === 'week') return drags ? 'Tap a day header for everything on it · drag a task to move its due date' : 'Tap a day header for everything on it'
  return drags ? 'Tap a day to expand it · drag a pill to move its due date' : 'Tap a day to expand it'
}

export function Calendar({
  view,
  tasks,
  projects,
  projectMap,
  people,
  meals,
  myId,
  nameOf,
  inHousehold,
  members,
  recipes,
  places,
  events,
  sourceMap,
  onOpen,
  onNew,
  onSaveMeal,
  onClearMeal,
  onCreatePlace,
  onCreateRecipe,
  onStarRecipe,
  onNewEvent,
  onEditEvent,
  onReschedule,
  onPlan,
  onAttendance,
  onOpenProject,
  onPlanOccasion,
  garments,
  wears,
  onOpenWardrobe,
  openDay,
  onOpenDayConsumed,
}: Props) {
  // one anchor day drives both grids: its month, or the week around it. A day
  // asked for opens with the first paint when the Calendar mounts for it, and
  // as it arrives when the Calendar is already on screen.
  const [cursor, setCursor] = useState(() => dayOfKey(openDay) ?? dayStart(new Date()))
  const [sheetDay, setSheetDay] = useState<Date | null>(() => (view === 'day' ? null : dayOfKey(openDay)))
  const [asked, setAsked] = useState({ openDay, view })
  if (asked.openDay !== openDay || asked.view !== view) {
    setAsked({ openDay, view })
    const day = asked.openDay !== openDay ? dayOfKey(openDay) : null
    if (day) {
      setCursor(day)
      if (view !== 'day') setSheetDay(day)
    }
    // the day view draws the day itself, so no sheet stays open over it
    if (asked.view !== view && view === 'day') setSheetDay(null)
  }
  // …and says so, so the next ask for the same day opens it again: once per
  // day asked for, the parent's setter an effect event, not a reason to run
  const openDayUsed = useEffectEvent(() => onOpenDayConsumed?.())
  useEffect(() => {
    if (openDay) openDayUsed()
  }, [openDay])
  // The + used to mean "new task" silently, so there was no route to a meal
  // from the calendar at all. It now asks which.
  const [addFor, setAddFor] = useState<string | null>(null)
  /** The day whose dinner the + menu's Meal is choosing, straight in the meal picker. */
  const [dinnerFor, setDinnerFor] = useState<string | null>(null)
  // a pill written in a feed's or a project's colour moves only as far as it takes to read in this theme
  const theme = useTheme()

  const sources: DaySources = useMemo(
    () => ({ tasks: tasksByDay(tasks), events: eventsByDay(events.filter(e => !e.work)), marks: marksByDay(projects), occasions: occasionsByMonthDay(people), meals: mealsByDay(meals) }),
    [tasks, events, projects, people, meals],
  )
  // Today, and the minute, from the app's clock hooks: read as the calendar
  // draws, the React Compiler would keep the first answer while it stays up —
  // the today ring on yesterday, a started event still offering a plan.
  const todayKey = useDayKey()
  const minute = useNow()
  // the day sheet's meal pickers say when each recipe was last cooked, as the Kitchen's do
  const cooked = useMemo(() => cookedIndex(recipes, meals, todayKey), [recipes, meals, todayKey])
  const visited = useMemo(() => visitIndex(places, tasks, meals), [places, tasks, meals])
  /** The saved place an event's location names (matchPlace), looked up once per location. */
  const placeAt = useMemo(() => {
    const known = new Map<string, Place | undefined>()
    for (const e of events) if (e.location && !known.has(e.location)) known.set(e.location, matchPlace(e.location, places))
    return (location: string) => (known.has(location) ? known.get(location) : matchPlace(location, places))
  }, [events, places])
  // A work day is drawn as a badge on the day, not as an item competing with
  // the day's events and meals: "am I home on Thursday" is a property of the day.
  // (workByDay in calgrid.ts: the wardrobe reads a work day from the same map)
  const workDays = useMemo(() => workByDay(events), [events])
  /** Is this work day this account's? An entry with no owner has not synced yet, so it is. */
  const isMine = (w: CalendarEvent) => !w.ownerId || !myId || w.ownerId === myId
  /** YOUR work day. Set work day, Edit and the wardrobe all act on this one alone. */
  const workOn = (d: Date) => (workDays.get(dateKey(d)) ?? []).find(isMine)
  /**
   * The other members' work days on that day. Two people in a household keep
   * different hours, and until v3.24 the calendar drew whichever it found
   * first as though it were yours: "currently my work hours are hers". Theirs
   * are still worth seeing — that is half of what a shared calendar is for —
   * so they are drawn beside yours with the name on them.
   */
  const theirWorkOn = (d: Date) => (workDays.get(dateKey(d)) ?? []).filter(w => !isMine(w))
  /** One badge. `whose` names the member when the day is not yours. */
  const oneWorkBadge = (w: CalendarEvent, whose?: string | null) => {
    if (!w.work) return null
    const meta = WORK_MODE_META[w.work]
    const hours = w.allDay ? '' : `${clock(w.start)}–${clock(w.end)}`
    // "Maria's working from home", not "Working from home" under her name
    const words = whose ? `${whose}: ${meta.label.toLowerCase()}` : meta.label
    return (
      <span
        key={w.id}
        className={'cal-work-badge ' + w.work + (whose ? ' theirs' : '')}
        title={`${words}${hours ? ' · ' + hours : ''}`}
        aria-label={`${words}${hours ? ', ' + hours : ''}`}
      >
        {meta.emoji}
        {/* wrapped so a month cell can keep the glyph and drop the words: at
            51pt a day there is no room for "🏢 Office 08:30–16:30", and the
            words were being hard-clipped mid-letter ("Off|", "Hor") */}
        <span className="cal-work-words">
          {' '}
          {whose ? `${whose} · ` : ''}
          {meta.short}
          {hours ? ` ${hours}` : ''}
        </span>
      </span>
    )
  }
  const workBadge = (d: Date) => {
    const w = workOn(d)
    return w ? oneWorkBadge(w) : null
  }
  /** Their work days, named. Nothing at all when you are the only account here. */
  const theirWorkBadges = (d: Date) => {
    const theirs = theirWorkOn(d)
    if (theirs.length === 0) return null
    return <>{theirs.map(w => oneWorkBadge(w, nameOf?.(w.ownerId) ?? 'Household'))}</>
  }

  const cells = useMemo(() => monthCells(new Date(cursor.getFullYear(), cursor.getMonth(), 1)), [cursor])
  const week = useMemo(() => weekDays(cursor), [cursor])

  const closeSheet = useCallback(() => setSheetDay(null), [])
  const sheetTitleId = useId()

  const label =
    view === 'day' ? fullDate(cursor) : view === 'week' ? weekLabel(cursor) : cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const shiftBy = view === 'day' ? 'day' : view === 'week' ? 'week' : 'month'

  // What you wore: one small line on a day in the week list and the day sheet.
  // Like a work day it is a property of the day, not an item among its events,
  // and it stays out of the month grid, whose cells have no room for it at 375pt.
  // A day whose looks are all plans shows its plan instead, "Planned: …", as
  // Today's card does (planFor). A plan counts in no figure, so it is read from
  // the looks themselves, never from the index every figure reads.
  const pieces = useMemo(() => liveById(garments ?? []), [garments])
  const worn = useMemo(() => wearIndex(wears ?? [], todayKey), [wears, todayKey])
  const lookLine = (d: Date) => {
    if (!garments || !onOpenWardrobe) return null
    const k = dateKey(d)
    const on = lookOn(worn, k)
    const plan = on ? undefined : planFor(wears ?? [], k)
    const look = on?.look ?? plan
    if (!look) return null
    const looks = on ? on.looks : looksOn(wears ?? [], k).filter(w => w.garmentIds.length > 0).length
    const what = outfitLabel(look.garmentIds, pieces)
    const dayLooks = looksOn(wears ?? [], k).filter(w => w.garmentIds.length > 0)
    const thumbs =
      looks > 1
        ? dayLooks
            .slice(-3)
            .map(w => ({ wear: w.id, id: orderPieces(w.garmentIds, pieces)[0] }))
            .filter((t): t is { wear: string; id: string } => !!t.id)
        : orderPieces(look.garmentIds, pieces)
            .slice(0, 3)
            .map(id => ({ wear: look.id, id }))
    const verb = plan ? 'Planned:' : k === todayKey ? 'Wearing' : 'Wore'
    const more = looks > 1 ? `, and ${looks - 1} more look${looks > 2 ? 's' : ''}` : ''
    return (
      <button
        type="button"
        className={plan ? 'cal-look planned' : 'cal-look'}
        aria-label={`${verb} ${what}${more}${plan ? '; ' : ': '}open the wardrobe on ${fullDate(d)}`}
        onClick={() => {
          setSheetDay(null)
          onOpenWardrobe({ date: k })
        }}
      >
        <span className="cal-look-thumbs" aria-hidden="true">
          {thumbs.length > 0 ? thumbs.map(t => <GarmentPhoto key={t.wear} garment={pieces.get(t.id)!} />) : <Icon name="wardrobe" size={14} />}
        </span>
        <span className="cal-look-label">
          <span className="muted">{verb}</span> {what}
        </span>
        {looks > 1 && <span className="cal-look-more">{looks} looks</span>}
      </button>
    )
  }
  const shift = (delta: number) =>
    setCursor(c => (view === 'day' ? addDays(c, delta) : view === 'week' ? addDays(c, delta * 7) : new Date(c.getFullYear(), c.getMonth() + delta, 1)))

  const eventColor = (ev: CalendarEvent) => (ev.localId ? LOCAL_EVENT_COLOR : (sourceMap.get(ev.sourceId)?.color ?? FALLBACK_EVENT_COLOR))
  const taskProject = (t: Task) => (t.projectId ? projectMap.get(t.projectId) : undefined)

  /** One line of context under an item's title, shared by the week list and the day sheet. */
  const itemMeta = (item: DayItem): string => {
    if (item.kind === 'occasion') {
      const kind = item.occasion.kind === 'birthday' ? 'Birthday' : 'Anniversary'
      return item.occasion.years ? `${kind} · ${item.occasion.years} years` : kind
    }
    if (item.kind === 'event') {
      const ev = item.event
      const when = ev.allDay ? 'All day' : `${fmtTime(ev.start)} – ${fmtTime(ev.end)}`
      const source = sourceMap.get(ev.sourceId)
      // somewhere you know wears its emoji, the one its row on Places shows
      const place = ev.location ? placeAt(ev.location) : undefined
      const where = place ? `${placeEmoji(place)} ${ev.location}` : ev.location
      return [when, where, source?.name].filter(Boolean).join(' · ')
    }
    if (item.kind === 'mark') {
      const what = item.mark.kind === 'target' ? 'Target date' : 'Milestone'
      return [item.mark.project.name, what, item.mark.done ? 'Done' : ''].filter(Boolean).join(' · ')
    }
    if (item.kind === 'meal') {
      const slot = item.meal.slot[0].toUpperCase() + item.meal.slot.slice(1)
      // the whole point of the merge: "Dinner · Out" answers the glance
      return item.meal.out ? `${slot} · Out` : slot
    }
    // no project name: there is one ongoing project, so it would repeat on every task
    const when = item.at && hasClock(item.at) ? fmtTime(item.at) : 'No time set'
    return `${when} · ${STATUS_META[item.task.status].label}`
  }

  const itemTitle = (item: DayItem): string => {
    if (item.kind === 'occasion') return `${item.occasion.person.name}’s ${item.occasion.kind}`
    if (item.kind === 'event') return item.event.title
    if (item.kind === 'mark') return item.mark.kind === 'target' ? `${item.mark.project.name} target` : item.mark.milestone?.name || 'Milestone'
    // "Chicken curry with rice and naan": the sides are part of the meal
    if (item.kind === 'meal') return mealLabel(item.meal)
    // A bill reads as what it is and what it costs. The amount is shown here only:
    // the mirrors and the feed send the title the owner typed, so a figure never
    // reaches Google or Outlook unless it was written into the title itself.
    if (item.task.bill) {
      const amount = formatMoney(item.task.estimateCost)
      return `${billEmoji(item.task.bill)} ${item.task.title || 'Untitled bill'}${amount ? ' ' + amount : ''}`
    }
    return item.task.title || item.task.description.slice(0, 60) || 'Untitled'
  }

  // a meal's way by the Kitchen's own rule (mealWay): a place in the Trash leaves a meal out there bought
  const saved = useMemo(() => savedPlaces(places), [places])
  const mealColor = (m: Meal) => MEAL_COLORS[mealWay(m, saved)]

  const itemColor = (item: DayItem): string => {
    if (item.kind === 'occasion') return item.occasion.person.color
    if (item.kind === 'event') return eventColor(item.event)
    if (item.kind === 'mark') return item.mark.project.color
    if (item.kind === 'meal') return mealColor(item.meal)
    return taskProject(item.task)?.color ?? STATUS_META[item.task.status].color
  }

  const dropOn = (day: Date) => (e: DragEvent) => {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/plain')
    if (id) onReschedule(id, day)
  }

  const newTaskOn = (day: Date) => {
    setSheetDay(null)
    onNew(morningOf(day))
  }

  /** A pill inside a month cell: compact, one line, the same shape for every kind. */
  const monthPill = (item: DayItem, day: Date) => {
    if (item.kind === 'task') {
      const t = item.task
      const project = taskProject(t)
      const time = item.at && hasClock(item.at) ? fmtTime(item.at) : ''
      return (
        <button
          key={item.id}
          className={t.status === 'done' ? 'cal-pill done' : 'cal-pill'}
          // the tint is the project's own colour; its text moves only as far as it takes to read on it
          style={{ background: project ? project.color + '22' : STATUS_META[t.status].bg, color: project ? readableInk(project.color, theme, { tint: true }) : STATUS_META[t.status].color }}
          draggable={t.status !== 'done'}
          onDragStart={e => {
            e.dataTransfer.setData('text/plain', t.id)
            e.dataTransfer.effectAllowed = 'move'
          }}
          onClick={e => {
            e.stopPropagation()
            onOpen(t)
          }}
          title={`${time ? time + ' · ' : ''}${itemTitle(item)}`}
        >
          {time && <span className="cal-pill-time">{time}</span>}
          <span className="cal-pill-title">{itemTitle(item)}</span>
        </button>
      )
    }
    const color = itemColor(item)
    const glyph = item.kind === 'occasion' ? OCCASION_GLYPH[item.occasion.kind] : item.kind === 'mark' ? '◆' : item.kind === 'meal' ? mealGlyph(item.meal) : ''
    const time = item.kind === 'event' && !item.event.allDay ? fmtTime(item.event.start) : ''
    return (
      <button
        key={item.id}
        className={'cal-pill ' + item.kind}
        // the outline keeps the colour as it is; the text is the same colour made readable here
        style={{ borderColor: color, color: readableInk(color, theme) }}
        title={`${itemTitle(item)} · ${itemMeta(item)}`}
        // everything that is not a task expands the day rather than editing in place
        onClick={e => {
          e.stopPropagation()
          setSheetDay(day)
        }}
      >
        {glyph && <span className="cal-pill-time">{glyph}</span>}
        {time && <span className="cal-pill-time">{time}</span>}
        <span className="cal-pill-title">{itemTitle(item)}</span>
      </button>
    )
  }

  /** A row in the week list: tasks open their editor, everything else expands the day. */
  const weekRow = (item: DayItem, day: Date) => (
    <li key={item.id}>
      <button
        className="cal-item"
        draggable={item.kind === 'task' && item.task.status !== 'done'}
        onDragStart={
          item.kind === 'task'
            ? e => {
                e.dataTransfer.setData('text/plain', item.task.id)
                e.dataTransfer.effectAllowed = 'move'
              }
            : undefined
        }
        onClick={() => (item.kind === 'task' ? onOpen(item.task) : setSheetDay(day))}
      >
        <span className="cal-item-dot" style={{ background: itemColor(item) }} />
        <span className="cal-item-main">
          <span className={item.kind === 'task' && item.task.status === 'done' ? 'cal-item-title done' : 'cal-item-title'}>{itemTitle(item)}</span>
          <span className="cal-item-meta">{itemMeta(item)}</span>
        </span>
      </button>
    </li>
  )

  useEffect(() => {
    if (!addFor) return
    const close = () => setAddFor(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    // capture: a click anywhere else dismisses, including on another day's +
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [addFor])

  const sheetItems = sheetDay ? dayItems(sheetDay, sources) : []
  const dayFace = (day: Date, leave: () => void) => {
    // a day's meals are its Eating rows below, where they are chosen and
    // changed: listed up here as well, each one was on the sheet twice
    const all = dayItems(day, sources)
    const items = all.filter(item => item.kind !== 'meal')
    return (
      <>
        {/* The day's rows and its Eating scroll as one, under a header and
            above a footer that hold still. The rows alone used to scroll, with
            Eating (a dinner's sides make it most of a phone screen) stacked
            under them outside the scroller: the rows got a 12pt strip, and
            the footer's New task and New event went below the screen. */}
        <div className="cal-sheet-scroll">
          <div className="cal-sheet-body">
            {lookLine(day)}
            {all.length === 0 && <p className="empty">Nothing on this day yet.</p>}
            <ul className="cal-rows">
              {items.map(item => {
                if (item.kind === 'occasion') {
                  const { person, kind } = item.occasion
                  const gift = plannedGift(person.id, kind, day, tasks)
                  return (
                    <li key={item.id} className="cal-row">
                      <span className="cal-item-dot" style={{ background: person.color }} />
                      <div className="cal-row-main">
                        <span className="cal-row-title">
                          {OCCASION_GLYPH[kind]} {itemTitle(item)}
                        </span>
                        <span className="cal-row-meta">{itemMeta(item)}</span>
                      </div>
                      {gift ? (
                        <button
                          className="btn cal-row-action"
                          onClick={() => {
                            leave()
                            onOpen(gift)
                          }}
                        >
                          Gift planned
                        </button>
                      ) : (
                        <button
                          className="btn cal-row-action"
                          onClick={() => {
                            leave()
                            onPlanOccasion(person, kind, day)
                          }}
                        >
                          Plan a gift
                        </button>
                      )}
                    </li>
                  )
                }
                if (item.kind === 'event') {
                  const ev = item.event
                  return (
                    <li key={item.id} className="cal-row">
                      <span className="cal-item-dot" style={{ background: eventColor(ev) }} />
                      <div className="cal-row-main">
                        <span className="cal-row-title">{ev.title}</span>
                        <span className="cal-row-meta">{itemMeta(item)}</span>
                      </div>
                      <button
                        className="btn cal-row-action"
                        onClick={() => {
                          leave()
                          if (ev.localId) onEditEvent(ev.localId)
                          else if (isPast(ev, Date.now())) onAttendance(ev)
                          else onPlan(ev)
                        }}
                      >
                        {ev.localId ? 'Edit' : isPast(ev, minute) ? 'Who was there?' : 'Plan for this'}
                      </button>
                    </li>
                  )
                }
                if (item.kind === 'mark') {
                  const { project } = item.mark
                  return (
                    <li key={item.id} className="cal-row">
                      <button
                        className="cal-row-tap"
                        onClick={() => {
                          leave()
                          onOpenProject(project)
                        }}
                      >
                        <span className="cal-item-dot" style={{ background: project.color }} />
                        <span className="cal-row-main">
                          <span className="cal-row-title">◆ {itemTitle(item)}</span>
                          <span className="cal-row-meta">{itemMeta(item)}</span>
                        </span>
                      </button>
                    </li>
                  )
                }
                if (item.kind !== 'task') return null
                const t = item.task
                const project = taskProject(t)
                return (
                  <li key={item.id} className="cal-row">
                    <button
                      className="cal-row-tap"
                      onClick={() => {
                        leave()
                        onOpen(t)
                      }}
                    >
                      <span className="cal-item-dot" style={{ background: project?.color ?? STATUS_META[t.status].color }} />
                      <span className="cal-row-main">
                        <span className="cal-row-title">{itemTitle(item)}</span>
                        <span className="cal-row-meta">
                          <span className="badge" style={{ background: STATUS_META[t.status].bg, color: STATUS_META[t.status].color }}>
                            {STATUS_META[t.status].label}
                          </span>
                          {item.at && hasClock(item.at) && <strong className="day-time">{fmtTime(item.at)}</strong>}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
          <section className="cal-sheet-eating" aria-label="Meals">
            <h3 className="cal-sheet-eating-head">Eating</h3>
            {MEAL_SLOTS.map(slot => {
              const { mine, theirs } = mealsForSlot(meals, dateKey(day), slot, myId)
              return (
                <MealSlotRow
                  onCreateRecipe={onCreateRecipe}
                  key={slot}
                  date={dateKey(day)}
                  slot={slot}
                  meal={mine}
                  theirs={theirs}
                  nameOf={nameOf}
                  inHousehold={inHousehold}
                  myId={myId}
                  members={members}
                  recipes={recipes}
                  meals={meals}
                  cooked={cooked}
                  visited={visited}
                  places={places}
                  onSave={onSaveMeal}
                  onClear={onClearMeal}
                  onCreatePlace={onCreatePlace}
                  onStar={onStarRecipe}
                />
              )
            })}
          </section>
        </div>
        <footer className="cal-sheet-foot">
          <button className="btn primary cal-sheet-new" onClick={() => newTaskOn(day)}>
            + New task this day
          </button>
          <button
            className="btn cal-sheet-new"
            onClick={() => {
              leave()
              onNewEvent(morningOf(day))
            }}
          >
            🕘 New event
          </button>
        </footer>
      </>
    )
  }

  return (
    <div className="calendar">
      <div className="cal-toolbar period-bar">
        <button className="btn" onClick={() => shift(-1)} aria-label={`Previous ${shiftBy}`}>
          ‹
        </button>
        <h2>{label}</h2>
        <button className="btn" onClick={() => shift(1)} aria-label={`Next ${shiftBy}`}>
          ›
        </button>
        <button className="btn period-end" onClick={() => setCursor(dayStart(new Date()))}>
          Today
        </button>
        <span className="cal-hint">{calendarHint(view, dragsHere())}</span>
      </div>

      {view === 'day' ? (
        <div className="cal-day">
          <div className="cal-day-work">
            {(() => {
              const w = workOn(cursor)
              return w?.localId ? (
                <button className="cal-work-edit" onClick={() => onEditEvent(w.localId!)}>
                  {workBadge(cursor)} <span className="cal-work-edit-label">Edit</span>
                </button>
              ) : (
                <button className="cal-work-set" onClick={() => onNewEvent(morningOf(cursor), 'home')}>
                  🏠 Set work day
                </button>
              )
            })()}
            {theirWorkBadges(cursor)}
          </div>
          {dayFace(cursor, () => {})}
        </div>
      ) : view === 'week' ? (
        <div className="cal-week">
          {week.map(d => {
            const k = dateKey(d)
            const items = dayItems(d, sources)
            return (
              <section key={k} className={'cal-weekday' + (k === todayKey ? ' today' : '')} onDragOver={e => e.preventDefault()} onDrop={dropOn(d)}>
                <div className="cal-weekday-head">
                  <button className="cal-weekday-open" onClick={() => setSheetDay(d)} aria-label={`Expand ${fullDate(d)}`}>
                    <span className="cal-weekday-name">{d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
                    <span className="cal-weekday-num">{d.getDate()}</span>
                    <span className="cal-weekday-count">{daySummary(items)}</span>
                    {workBadge(d)}
                    {theirWorkBadges(d)}
                  </button>
                  <div className="cal-add-wrap" onPointerDown={e => e.stopPropagation()}>
                    <button
                      className="btn subtle cal-weekday-add"
                      onClick={() => setAddFor(addFor === k ? null : k)}
                      aria-label={`Add to ${fullDate(d)}`}
                      aria-expanded={addFor === k}
                      aria-haspopup="menu"
                      title="Add"
                    >
                      +
                    </button>
                    {addFor === k && (
                      <div className="cal-add-menu" role="menu">
                        <button
                          role="menuitem"
                          onClick={() => {
                            setAddFor(null)
                            newTaskOn(d)
                          }}
                        >
                          ✓ Task
                        </button>
                        <button
                          role="menuitem"
                          onClick={() => {
                            setAddFor(null)
                            setDinnerFor(k)
                          }}
                        >
                          🍽️ Meal
                        </button>
                        <button
                          role="menuitem"
                          onClick={() => {
                            setAddFor(null)
                            onNewEvent(morningOf(d))
                          }}
                        >
                          🕘 Event
                        </button>
                        <button
                          role="menuitem"
                          onClick={() => {
                            setAddFor(null)
                            onNewEvent(morningOf(d), 'home')
                          }}
                        >
                          🏠 Work day
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                {lookLine(d)}
                {items.length > 0 && <ul className="cal-daylist">{items.map(item => weekRow(item, d))}</ul>}
              </section>
            )
          })}
        </div>
      ) : (
        <>
          <div className="cal-grid cal-head-row">
            {WEEKDAYS.map(d => (
              <div key={d} className="cal-head">
                {d}
              </div>
            ))}
          </div>
          <div className="cal-grid cal-body">
            {cells.map(d => {
              const k = dateKey(d)
              const inMonth = d.getMonth() === cursor.getMonth()
              const items = dayItems(d, sources)
              // cells have a fixed height: when a day overflows, trade the last
              // pill for the "+N more" line — the day sheet holds the full list
              const shown = items.length > MAX_PILLS ? items.slice(0, MAX_PILLS - 1) : items
              const hidden = items.length - shown.length
              return (
                <div
                  key={k}
                  className={'cal-cell' + (inMonth ? '' : ' out') + (k === todayKey ? ' today' : '')}
                  role="button"
                  tabIndex={0}
                  aria-label={`${fullDate(d)} — ${daySummary(items)}`}
                  onClick={() => setSheetDay(d)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setSheetDay(d)
                    }
                  }}
                  onDragOver={e => e.preventDefault()}
                  onDrop={dropOn(d)}
                >
                  <div className="cal-daynum">{d.getDate()}</div>
                  {workBadge(d)}
                  {theirWorkBadges(d)}
                  {shown.map(item => monthPill(item, d))}
                  {hidden > 0 && <div className="cal-more">+{hidden} more</div>}
                </div>
              )
            })}
          </div>
        </>
      )}

      {view !== 'day' && sheetDay && (
        <Modal onClose={closeSheet} className="cal-sheet" backdropClassName="cal-sheet-backdrop" labelledBy={sheetTitleId}>
          <header className="cal-sheet-head">
            <button className="btn subtle cal-sheet-nav" onClick={() => setSheetDay(addDays(sheetDay, -1))} aria-label="Previous day">
              ‹
            </button>
            <div className="cal-sheet-title">
              <h2 id={sheetTitleId}>{fullDate(sheetDay)}</h2>
              <span className="cal-sheet-sub">{daySummary(sheetItems)}</span>
              {(() => {
                const w = workOn(sheetDay)
                return w?.localId ? (
                  <button
                    className="cal-work-edit"
                    onClick={() => {
                      const id = w.localId!
                      closeSheet()
                      onEditEvent(id)
                    }}
                  >
                    {workBadge(sheetDay)} <span className="cal-work-edit-label">Edit</span>
                  </button>
                ) : (
                  <button
                    className="cal-work-set"
                    onClick={() => {
                      const d = sheetDay
                      setSheetDay(null)
                      onNewEvent(morningOf(d), 'home')
                    }}
                  >
                    🏠 Set work day
                  </button>
                )
              })()}
              {theirWorkBadges(sheetDay)}
            </div>
            <button className="btn subtle cal-sheet-nav" onClick={() => setSheetDay(addDays(sheetDay, 1))} aria-label="Next day">
              ›
            </button>
            <button className="btn subtle cal-sheet-close" onClick={closeSheet} aria-label="Close">
              ✕
            </button>
          </header>
          {dayFace(sheetDay, closeSheet)}
        </Modal>
      )}
      {dinnerFor && (
        <SlotPicker
          date={dinnerFor}
          slot="dinner"
          {...dinnerPick(meals, dinnerFor, myId)}
          myId={myId}
          inHousehold={inHousehold}
          members={members}
          recipes={recipes}
          places={places}
          meals={meals}
          cooked={cooked}
          visited={visited}
          onSave={onSaveMeal}
          onClear={onClearMeal}
          onCreatePlace={onCreatePlace}
          onCreateRecipe={onCreateRecipe}
          onStar={onStarRecipe}
          onClose={() => setDinnerFor(null)}
        />
      )}
    </div>
  )
}
