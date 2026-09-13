import { DragEvent, useCallback, useEffect, useId, useMemo, useState } from 'react'
import { CalendarEvent, CalendarSource, MEAL_SLOTS, Meal, Person, Place, PlaceCategory, Project, Recipe, STATUS_META, Task, WORK_MODE_META, WorkMode, BILL_KIND_META } from '../types'
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
} from '../calgrid'
import { mealsByDay } from '../kitchen'
import { plannedGift } from '../people'
import { MealSlotRow } from './MealSlotRow'
import { formatMoney } from '../bills'
import { Modal } from './Modal'

export type CalendarView = 'month' | 'week'

interface Props {
  /** Which grid to draw; the Timeline is a separate component. */
  view: CalendarView
  tasks: Task[]
  /**
   * Every task, before Mine / Everyone narrowed `tasks`. Read by the day
   * sheet's gift rule and nothing else: a gift someone else in the household
   * is buying still covers the occasion. Defaults to `tasks`.
   */
  allTasks?: Task[]
  projects: Project[]
  projectMap: Map<string, Project>
  people: Person[]
  meals: Meal[]
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
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// four before "+n more" — with two-line titles and cells that grow to fit, a
// normal day shows everything it has and only a packed one folds
const MAX_PILLS = 4
const OCCASION_GLYPH = { birthday: '🎂', anniversary: '💞' }
/** Cooked at home. */
const MEAL_COLOR = '#f97316'
/** Bought — a different colour so a run of takeaways stands out in the month grid. */
const MEAL_OUT_COLOR = '#38bdf8'
const mealGlyph = (m: Meal) => (m.out ? '🥡' : '🍽️')
/** Entries you wrote, distinct from any subscribed feed's colour. */
const LOCAL_EVENT_COLOR = '#a78bfa'

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
/** Default time for a task created from a day: 9am, same as the rest of the app. */
const morningOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0, 0).toISOString()
const fullDate = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
const isPast = (ev: CalendarEvent) => new Date(ev.allDay ? ev.start + 'T00:00' : ev.start).getTime() < Date.now()

export function Calendar({
  view,
  tasks,
  allTasks,
  projects,
  projectMap,
  people,
  meals,
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
  onNewEvent,
  onEditEvent,
  onReschedule,
  onPlan,
  onAttendance,
  onOpenProject,
  onPlanOccasion,
}: Props) {
  // one anchor day drives both grids: its month, or the week around it
  const [cursor, setCursor] = useState(() => dayStart(new Date()))
  const [sheetDay, setSheetDay] = useState<Date | null>(null)
  // The + used to mean "new task" silently, so there was no route to a meal
  // from the calendar at all. It now asks which.
  const [addFor, setAddFor] = useState<string | null>(null)

  const sources: DaySources = useMemo(
    () => ({ tasks: tasksByDay(tasks), events: eventsByDay(events.filter(e => !e.work)), marks: marksByDay(projects), occasions: occasionsByMonthDay(people), meals: mealsByDay(meals) }),
    [tasks, events, projects, people, meals],
  )
  // A work day is drawn as a badge on the day, not as an item competing with
  // the day's events and meals: "am I home on Thursday" is a property of the day.
  const workByDay = useMemo(() => eventsByDay(events.filter(e => e.work)), [events])
  const workOn = (d: Date) => (workByDay.get(dateKey(d)) ?? [])[0]
  const workBadge = (d: Date) => {
    const w = workOn(d)
    if (!w?.work) return null
    const meta = WORK_MODE_META[w.work]
    const hours = w.allDay ? '' : `${clock(w.start)}–${clock(w.end)}`
    return (
      <span
        className={'cal-work-badge ' + w.work}
        title={`${meta.label}${hours ? ' · ' + hours : ''}`}
        aria-label={`${meta.label}${hours ? ', ' + hours : ''}`}
      >
        {meta.emoji} {meta.short}
        {hours ? ` ${hours}` : ''}
      </span>
    )
  }

  const cells = useMemo(() => monthCells(new Date(cursor.getFullYear(), cursor.getMonth(), 1)), [cursor])
  const week = useMemo(() => weekDays(cursor), [cursor])

  const closeSheet = useCallback(() => setSheetDay(null), [])
  const sheetTitleId = useId()

  const todayKey = dateKey(new Date())
  const label = view === 'week' ? weekLabel(cursor) : cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const shift = (delta: number) =>
    setCursor(c => (view === 'week' ? addDays(c, delta * 7) : new Date(c.getFullYear(), c.getMonth() + delta, 1)))

  const eventColor = (ev: CalendarEvent) => (ev.localId ? LOCAL_EVENT_COLOR : (sourceMap.get(ev.sourceId)?.color ?? '#94a3b8'))
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
      return [when, ev.location, source?.name].filter(Boolean).join(' · ')
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
    if (item.kind === 'meal') return item.meal.title
    // A bill reads as what it is and what it costs. The amount is shown here only:
    // the mirrors and the feed send the title the owner typed, so a figure never
    // reaches Google or Outlook unless it was written into the title itself.
    if (item.task.bill) {
      const amount = formatMoney(item.task.estimateCost)
      return `${BILL_KIND_META[item.task.bill.kind].emoji} ${item.task.title || 'Untitled bill'}${amount ? ' ' + amount : ''}`
    }
    return item.task.title || item.task.description.slice(0, 60) || 'Untitled'
  }

  const itemColor = (item: DayItem): string => {
    if (item.kind === 'occasion') return item.occasion.person.color
    if (item.kind === 'event') return eventColor(item.event)
    if (item.kind === 'mark') return item.mark.project.color
    if (item.kind === 'meal') return item.meal.out ? MEAL_OUT_COLOR : MEAL_COLOR
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
          style={{ background: project ? project.color + '22' : STATUS_META[t.status].bg, color: project ? project.color : STATUS_META[t.status].color }}
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
        style={{ borderColor: color, color }}
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

  return (
    <div className="calendar">
      <div className="cal-toolbar">
        <button className="btn" onClick={() => shift(-1)} aria-label={view === 'week' ? 'Previous week' : 'Previous month'}>
          ‹
        </button>
        <h2>{label}</h2>
        <button className="btn" onClick={() => shift(1)} aria-label={view === 'week' ? 'Next week' : 'Next month'}>
          ›
        </button>
        <button className="btn subtle" onClick={() => setCursor(dayStart(new Date()))}>
          Today
        </button>
        <span className="cal-hint">
          {view === 'week' ? 'Tap a day header for everything on it · drag a task to move its due date' : 'Tap a day to expand it · drag a pill to move its due date'}
        </span>
      </div>

      {view === 'week' ? (
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
                            setSheetDay(d)
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
                  {shown.map(item => monthPill(item, d))}
                  {hidden > 0 && <div className="cal-more">+{hidden} more</div>}
                </div>
              )
            })}
          </div>
        </>
      )}

      {sheetDay && (
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
            </div>
            <button className="btn subtle cal-sheet-nav" onClick={() => setSheetDay(addDays(sheetDay, 1))} aria-label="Next day">
              ›
            </button>
            <button className="btn subtle cal-sheet-close" onClick={closeSheet} aria-label="Close">
              ✕
            </button>
          </header>

          <div className="cal-sheet-body">
            {sheetItems.length === 0 && <p className="empty">Nothing on this day yet.</p>}
            <ul className="cal-rows">
              {sheetItems.map(item => {
                if (item.kind === 'occasion') {
                  const { person, kind } = item.occasion
                  // Today's rule, not a copy of it: an open gift task near
                  // this day means the gift is in hand, so open that one
                  // rather than offering to plan a second — whoever in the
                  // household is buying it, so with Mine on too
                  const gift = plannedGift(person.id, kind, sheetDay, allTasks ?? tasks)
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
                            closeSheet()
                            onOpen(gift)
                          }}
                        >
                          Gift planned
                        </button>
                      ) : (
                        <button
                          className="btn cal-row-action"
                          onClick={() => {
                            const at = sheetDay
                            closeSheet()
                            onPlanOccasion(person, kind, at)
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
                          closeSheet()
                          // ours to change; a feed row is read-only, so it
                          // keeps offering to plan around it instead
                          if (ev.localId) onEditEvent(ev.localId)
                          else if (isPast(ev)) onAttendance(ev)
                          else onPlan(ev)
                        }}
                      >
                        {ev.localId ? 'Edit' : isPast(ev) ? 'Who was there?' : 'Plan for this'}
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
                          closeSheet()
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
                if (item.kind === 'meal') {
                  return (
                    <li key={item.id} className="cal-row">
                      <span className="cal-item-dot" style={{ background: item.meal.out ? MEAL_OUT_COLOR : MEAL_COLOR }} />
                      <div className="cal-row-main">
                        <span className="cal-row-title">
                          {mealGlyph(item.meal)} {item.meal.title}
                        </span>
                        <span className="cal-row-meta">{itemMeta(item)}</span>
                      </div>
                    </li>
                  )
                }
                const t = item.task
                const project = taskProject(t)
                return (
                  <li key={item.id} className="cal-row">
                    <button
                      className="cal-row-tap"
                      onClick={() => {
                        closeSheet()
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
            {MEAL_SLOTS.map(slot => (
              <MealSlotRow
                onCreateRecipe={onCreateRecipe}
                key={slot}
                date={dateKey(sheetDay)}
                slot={slot}
                meal={meals.find(m => m.date === dateKey(sheetDay) && m.slot === slot && !m.deletedAt)}
                recipes={recipes}
                places={places}
                onSave={onSaveMeal}
                onClear={onClearMeal}
                onCreatePlace={onCreatePlace}
              />
            ))}
          </section>

          <footer className="cal-sheet-foot">
            <button className="btn primary cal-sheet-new" onClick={() => newTaskOn(sheetDay)}>
              + New task this day
            </button>
            <button
              className="btn cal-sheet-new"
              onClick={() => {
                const d = sheetDay
                setSheetDay(null)
                onNewEvent(morningOf(d))
              }}
            >
              🕘 New event
            </button>
          </footer>
        </Modal>
      )}
    </div>
  )
}
