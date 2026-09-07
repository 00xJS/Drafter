import { useMemo, useRef, useState } from 'react'
import { CalendarEvent, CalendarSource, Person, Project, Task, TaskStatus, projectProgress } from '../types'
import { SEEN_META, compareStats, personStats, upcomingOccasions } from '../people'
import { doneByWeek, stalledProjects } from '../review'
import { DAY_MS, compareTasks, dayOffset, isOpen } from '../taskutils'
import { eventStartDate } from '../calendars'
import { excerpt, fmtTime, timeAgo } from '../utils'
import { DueBadge, PriorityMark, ProgressBar, ProjectChip, StatTile } from './bits'

interface Props {
  tasks: Task[]
  /** Unfiltered tasks — visits are counted across every project. */
  allTasks: Task[]
  people: Person[]
  onPlanWith(p: Person): void
  onPlanOccasion(p: Person, kind: 'birthday' | 'anniversary', at: Date): void
  projects: Project[]
  projectMap: Map<string, Project>
  events: CalendarEvent[]
  sourceMap: Map<string, CalendarSource>
  onPlan(ev: CalendarEvent): void
  onOpen(t: Task): void
  onOpenProject(p: Project): void
  onStatus(id: string, s: TaskStatus): void
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

function TaskRow({
  task,
  project,
  onOpen,
  onStatus,
}: {
  task: Task
  project?: Project
  onOpen(t: Task): void
  onStatus(id: string, s: TaskStatus): void
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
        if (!touch.current) return
        const ddx = e.touches[0].clientX - touch.current.x
        const ddy = e.touches[0].clientY - touch.current.y
        if (Math.abs(ddx) > Math.abs(ddy) && ddx > 0) setDx(Math.min(ddx, 120))
      }}
      onTouchEnd={() => {
        // swipe right to complete (or reopen)
        if (dx > 80) onStatus(task.id, done ? 'todo' : 'done')
        setDx(0)
        touch.current = null
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
        <span className="dash-title">
          <PriorityMark priority={task.priority} /> {task.title || excerpt(task.description, 60) || 'Untitled'}
        </span>
        <span className="dash-meta">
          {project && <ProjectChip project={project} />}
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

export function Today({ tasks, allTasks, people, onPlanWith, onPlanOccasion, projects, projectMap, events, sourceMap, onPlan, onOpen, onOpenProject, onStatus, onNew }: Props) {
  const weekly = useMemo(() => doneByWeek(allTasks), [allTasks])
  const occasions = useMemo(() => upcomingOccasions(people, 21), [people])
  const stalled = useMemo(() => stalledProjects(projects, allTasks), [projects, allTasks])
  const peopleNudges = useMemo(
    () =>
      people
        .map(p => personStats(p, allTasks))
        .filter(s => s.status === 'overdue' || s.status === 'due' || s.status === 'often')
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
    const week = withDue
      .filter(t => {
        const off = dayOffset(t.dueAt!, now)
        return off > 0 && off <= 7
      })
      .sort(compareTasks)
    const doing = open.filter(t => t.status === 'doing' && !t.dueAt).sort(compareTasks)
    const blocked = open.filter(t => t.status === 'blocked').sort(compareTasks)
    const inbox = open
      .filter(t => !t.projectId && !t.dueAt && t.status === 'todo' && nowMs - new Date(t.createdAt).getTime() < 7 * DAY_MS)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const stale = open
      .filter(t => !t.dueAt && t.status === 'todo' && nowMs - new Date(t.updatedAt).getTime() > STALE_DAYS * DAY_MS)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    const doneRecent = tasks
      .filter(t => t.status === 'done' && t.completedAt && nowMs - new Date(t.completedAt).getTime() < 7 * DAY_MS)
      .sort((a, b) => b.completedAt!.localeCompare(a.completedAt!))
    const activeProjects = projects
      .filter(p => p.status === 'active')
      .map(p => ({ project: p, progress: projectProgress(tasks.filter(t => t.projectId === p.id)) }))
    return { open, overdue, today, week, doing, blocked, stale, inbox, doneRecent, activeProjects }
  }, [tasks, projects])

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
    { key: 'today', title: 'Today', sub: 'Due before midnight', tasks: s.today },
    { key: 'week', title: 'This week', sub: 'Due in the next 7 days', tasks: s.week },
    { key: 'doing', title: 'In progress, no date', sub: 'Started but not scheduled', tasks: s.doing },
    { key: 'blocked', title: 'Blocked', sub: 'Waiting on something — worth a nudge?', tasks: s.blocked },
    { key: 'inbox', title: 'Inbox', sub: 'Captured this week — give each a project or a date', tasks: s.inbox },
    { key: 'stale', title: 'Going stale', sub: `To-dos untouched for ${STALE_DAYS}+ days with no date`, tasks: s.stale },
  ].filter(sec => sec.tasks.length > 0)

  return (
    <div className="insights today">
      <div className="kpi-row">
        <StatTile label="Overdue" value={String(s.overdue.length)} sub={s.overdue.length ? 'need a new date or a push' : 'nothing slipped'} warn={s.overdue.length > 0} />
        <StatTile label="Due today" value={String(s.today.length)} />
        <StatTile label="This week" value={String(s.week.length)} sub="due in the next 7 days" />
        <StatTile label="Open" value={String(s.open.length)} sub="to do, doing or blocked" />
        <div className="stat-tile">
          <div className="stat-label">Done this week</div>
          <div className="stat-value">{s.doneRecent.length}</div>
          <div className="spark" aria-hidden title="Done per week, last 12 weeks">
            {weekly.map((n, i) => (
              <span key={i} className={i === weekly.length - 1 ? 'spark-bar now' : 'spark-bar'} style={{ height: `${n === 0 ? 8 : 20 + (n / Math.max(...weekly, 1)) * 80}%` }} />
            ))}
          </div>
        </div>
      </div>

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

      {occasions.length > 0 && (
        <section className="chart-card occasions">
          <header className="chart-head">
            <div>
              <h3>Occasions</h3>
              <p className="chart-sub">Birthdays and anniversaries in the next 3 weeks</p>
            </div>
          </header>
          <ul className="dash-list event-list">
            {occasions.map(o => (
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
                <button className="btn" onClick={() => onPlanOccasion(o.person, o.kind, o.at)}>
                  Plan a gift
                </button>
              </li>
            ))}
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
                {s.status !== 'often' && (
                  <button className="btn" onClick={() => onPlanWith(s.person)}>
                    Plan something
                  </button>
                )}
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

      {sections.length === 0 ? (
        <div className="chart-card">
          <p className="empty">Nothing due and nothing stuck. Pull something from the Wishlist or enjoy the quiet.</p>
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
              </header>
              <ul className="dash-list tlist">
                {sec.tasks.slice(0, 12).map(t => (
                  <TaskRow key={t.id} task={t} project={t.projectId ? projectMap.get(t.projectId) : undefined} onOpen={onOpen} onStatus={onStatus} />
                ))}
              </ul>
              {sec.tasks.length > 12 && <p className="board-more">+ {sec.tasks.length - 12} more in the Tasks tab</p>}
            </section>
          ))}
        </div>
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
