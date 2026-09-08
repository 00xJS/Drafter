import { useMemo, useRef, useState } from 'react'
import { CalendarEvent, CalendarSource, Person, Project, Review as ReviewRecord, Task, TaskStatus, projectProgress } from '../types'
import { newerStamp } from '../itemops'
import { SEEN_META, compareStats, personStats, plannedGift, upcomingOccasions } from '../people'
import { NextUp, doneByWeek, isVisit, nextUp, stalledProjects, weekRange, shiftRange } from '../review'
import { DAY_MS, compareTasks, dayOffset, dueTone, isOpen, startOfDay } from '../taskutils'
import { eventStartDate } from '../calendars'
import { excerpt, fmtTime, timeAgo } from '../utils'
import { DueBadge, PriorityMark, ProgressBar, ProjectChip, StatTile } from './bits'

interface Props {
  tasks: Task[]
  /** Unfiltered tasks — visits are counted across every project. */
  allTasks: Task[]
  people: Person[]
  reviews: ReviewRecord[]
  onPlanWith(p: Person): void
  onPlanOccasion(p: Person, kind: 'birthday' | 'anniversary', at: Date): void
  onSaw(p: Person): void
  onSaveReview(r: ReviewRecord): void
  projects: Project[]
  projectMap: Map<string, Project>
  events: CalendarEvent[]
  sourceMap: Map<string, CalendarSource>
  onPlan(ev: CalendarEvent): void
  onOpen(t: Task): void
  onOpenProject(p: Project): void
  onStatus(id: string, s: TaskStatus): void
  onDefer(id: string, day: Date): void
  onDeferAll(ids: string[], day: Date): void
  onNew(preset?: Partial<Task>): void
}

const STALE_DAYS = 14

interface Section {
  key: string
  title: string
  sub?: string
  tasks: Task[]
  tone?: 'warn'
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

function TaskRow({
  task,
  project,
  reason,
  onOpen,
  onStatus,
  onDefer,
}: {
  task: Task
  project?: Project
  reason?: string
  onOpen(t: Task): void
  onStatus(id: string, s: TaskStatus): void
  onDefer?(id: string, day: Date): void
}) {
  const done = task.status === 'done'
  const touch = useRef<{ x: number; y: number } | null>(null)
  const [dx, setDx] = useState(0)
  return (
    <li
      className={done ? 'trow done' : 'trow'}
      style={dx ? { transform: `translateX(${dx}px)`, transition: 'none' } : undefined}
      onClick={() => onOpen(task)}
      onTouchStart={e => {
        touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      }}
      onTouchMove={e => {
        if (!touch.current || done || !onDefer) {
          if (!touch.current) return
          const ddx = e.touches[0].clientX - touch.current.x
          const ddy = e.touches[0].clientY - touch.current.y
          if (Math.abs(ddx) > Math.abs(ddy) && ddx > 0) setDx(Math.min(ddx, 120))
          return
        }
        const ddx = e.touches[0].clientX - touch.current.x
        const ddy = e.touches[0].clientY - touch.current.y
        if (Math.abs(ddx) <= Math.abs(ddy)) return
        if (ddx > 0) setDx(Math.min(ddx, 120))
        else setDx(Math.max(ddx, -160))
      }}
      onTouchEnd={() => {
        if (dx > 80) onStatus(task.id, done ? 'todo' : 'done')
        else if (dx < -130 && onDefer && !done) onDefer(task.id, addDays(new Date(), 7))
        else if (dx < -80 && onDefer && !done) onDefer(task.id, addDays(new Date(), 1))
        setDx(0)
        touch.current = null
      }}
    >
      {!done && onDefer && (
        <div className="trow-defer" aria-hidden>
          <button
            type="button"
            className="trow-defer-btn"
            onClick={e => {
              e.stopPropagation()
              onDefer(task.id, addDays(new Date(), 1))
            }}
          >
            Tomorrow
          </button>
          <button
            type="button"
            className="trow-defer-btn next"
            onClick={e => {
              e.stopPropagation()
              onDefer(task.id, addDays(new Date(), 7))
            }}
          >
            Next week
          </button>
        </div>
      )}
      <input
        type="checkbox"
        className="tcheck"
        checked={done}
        aria-label={done ? 'Reopen' : 'Mark done'}
        onClick={e => e.stopPropagation()}
        onChange={() => onStatus(task.id, done ? 'todo' : 'done')}
      />
      <div className="dash-main">
        <span className="dash-title">
          <PriorityMark priority={task.priority} /> {task.title || excerpt(task.description, 60) || 'Untitled'}
        </span>
        <span className="dash-meta">
          {project && <ProjectChip project={project} />}
          {reason && <span className="why">{reason}</span>}
          {task.status === 'blocked' && <span className="badge badge-blocked">Blocked</span>}
          {task.status === 'doing' && <span className="badge badge-doing">Doing</span>}
        </span>
      </div>
      <DueBadge task={task} />
    </li>
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
  reviews,
  onPlanWith,
  onPlanOccasion,
  onSaw,
  onSaveReview,
  projects,
  projectMap,
  events,
  sourceMap,
  onPlan,
  onOpen,
  onOpenProject,
  onStatus,
  onDefer,
  onDeferAll,
  onNew,
}: Props) {
  const weekly = useMemo(() => doneByWeek(allTasks), [allTasks])
  const thisWeek = useMemo(() => weekRange(new Date()), [])
  // Top 3 is written during last week's review as "for next week"
  const weekReview = useMemo(() => {
    const prev = shiftRange(thisWeek, -1)
    return reviews.find(r => r.period === 'week' && r.key === prev.key) ?? reviews.find(r => r.period === 'week' && r.key === thisWeek.key)
  }, [reviews, thisWeek])
  const top3 = useMemo(() => (weekReview?.top ?? []).map(t => t.trim()).filter(Boolean).slice(0, 3), [weekReview])
  const topDone = useMemo(() => weekReview?.topDone ?? [], [weekReview])
  const upNext: NextUp[] = useMemo(
    () => nextUp(tasks, projects, 6, new Date(), top3.filter((_, i) => !topDone[i])),
    [tasks, projects, top3, topDone],
  )
  const occasions = useMemo(() => upcomingOccasions(people, 21), [people])
  const stalled = useMemo(() => stalledProjects(projects, allTasks), [projects, allTasks])
  const peopleNudges = useMemo(
    () =>
      people
        .map(p => personStats(p, allTasks))
        .filter(s => s.status === 'overdue' || s.status === 'due')
        .sort(compareStats)
        .slice(0, 6),
    [people, allTasks],
  )
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
    const activeProjects = projects
      .filter(p => p.status === 'active')
      .map(p => ({ project: p, progress: projectProgress(tasks.filter(t => t.projectId === p.id)) }))
    return { open, overdue, today, late, week, doing, blocked, stale, inbox, doneRecent, visitsRecent, activeProjects }
  }, [tasks, projects])

  const toggleTop = (index: number) => {
    if (!weekReview) return
    const next = [...(weekReview.topDone ?? [false, false, false])]
    while (next.length < 3) next.push(false)
    next[index] = !next[index]
    onSaveReview({ ...weekReview, topDone: next, updatedAt: newerStamp(weekReview.updatedAt) })
  }

  if (tasks.length === 0 && projects.length === 0) {
    return (
      <div className="empty-hero">
        <h2>Welcome to your planner</h2>
        <p>
          Create a project from the <strong>+ Project</strong> chip, then add tasks with due dates. This page becomes
          your daily driver: what's overdue, what's due today, and what the week looks like.
        </p>
        <p>
          <button className="btn primary" onClick={() => onNew()}>
            + New task
          </button>
        </p>
      </div>
    )
  }

  const sections: Section[] = [
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
    { key: 'inbox', title: 'Inbox', sub: 'Undated captures — give each a project or a date', tasks: s.inbox },
    { key: 'stale', title: 'Going stale', sub: `To-dos untouched for ${STALE_DAYS}+ days with no date`, tasks: s.stale },
  ].filter(sec => sec.tasks.length > 0)

  const endOfNextWeek = (() => {
    const d = nextWeekday(new Date(), 0)
    d.setDate(d.getDate() + 7)
    d.setHours(17, 0, 0, 0)
    return d.toISOString()
  })()

  return (
    <div className="insights today">
      <div className="kpi-row">
        <StatTile label="Overdue" value={String(s.overdue.length)} sub={s.overdue.length ? 'need a new date or a push' : 'nothing slipped'} warn={s.overdue.length > 0} />
        <StatTile label="Due today" value={String(s.today.length)} sub={s.late.length ? `${s.late.length} already past` : undefined} />
        <StatTile label="This week" value={String(s.week.length)} sub="due in the next 7 days" />
        <StatTile label="Open" value={String(s.open.length)} sub="to do, doing or blocked" />
        <div className="stat-tile">
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

      {top3.length > 0 && (
        <section className="chart-card week-top3">
          <header className="chart-head">
            <div>
              <h3>This week's 3</h3>
              <p className="chart-sub">From last Sunday's review</p>
            </div>
          </header>
          <ul className="dash-list">
            {top3.map((line, i) => (
              <li key={i} className={topDone[i] ? 'trow done' : 'trow'}>
                <input type="checkbox" className="tcheck" checked={!!topDone[i]} aria-label="Mark done" onChange={() => toggleTop(i)} />
                <div className="dash-main">
                  <span className="dash-title">{line}</span>
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
                project={task.projectId ? projectMap.get(task.projectId) : undefined}
                onOpen={onOpen}
                onStatus={onStatus}
                onDefer={onDefer}
              />
            ))}
          </ul>
        </section>
      )}

      {stalled.length > 0 && (
        <p className="stalled-line">
          <span className="badge badge-blocked">Stalled</span>
          {stalled.map(p => (
            <button key={p.id} className="pchip static stalled-chip" onClick={() => onOpenProject(p)} title="No activity in 14 days — still worth doing?">
              <span className="pdot" style={{ background: p.color }} />
              {p.emoji ? `${p.emoji} ` : ''}
              {p.name}
            </button>
          ))}
          <small className="muted">nothing moved in 14 days — pick one up or pause it</small>
        </p>
      )}

      {s.activeProjects.length > 0 && (
        <div className="project-cards">
          {s.activeProjects.map(({ project, progress }) => (
            <button key={project.id} className="project-card" onClick={() => onOpenProject(project)}>
              <span className="project-card-head">
                <span className="pdot" style={{ background: project.color }} />
                <span className="project-card-name">
                  {project.emoji && <span>{project.emoji} </span>}
                  {project.name}
                </span>
                <span className="project-card-pct">{progress.pct}%</span>
              </span>
              <ProgressBar pct={progress.pct} color={project.color} />
              <span className="project-card-sub">
                {progress.done}/{progress.total} done
                {project.targetAt && ` · target ${new Date(project.targetAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}
              </span>
            </button>
          ))}
        </div>
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
            <section key={sec.key} className={sec.tone === 'warn' ? 'chart-card warn-card' : 'chart-card'}>
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
                  <TaskRow key={t.id} task={t} project={t.projectId ? projectMap.get(t.projectId) : undefined} onOpen={onOpen} onStatus={onStatus} onDefer={onDefer} />
                ))}
              </ul>
              {sec.tasks.length > 12 && <p className="board-more">+ {sec.tasks.length - 12} more in the Tasks tab</p>}
            </section>
          ))}
        </div>
      )}

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

      {peopleNudges.length > 0 && (
        <section className="chart-card people-nudges">
          <header className="chart-head">
            <div>
              <h3>People</h3>
              <p className="chart-sub">Who's due a call or a plan — and who you're seeing a lot</p>
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
                  <span className="dash-title">{t.title || excerpt(t.description, 60) || 'Untitled'}</span>
                  <span className="dash-meta">{t.projectId && projectMap.get(t.projectId) && <ProjectChip project={projectMap.get(t.projectId)!} />}</span>
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
