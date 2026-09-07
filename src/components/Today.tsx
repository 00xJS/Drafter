import { useMemo } from 'react'
import { Project, Task, TaskStatus, projectProgress } from '../types'
import { DAY_MS, compareTasks, dayOffset, isOpen } from '../taskutils'
import { excerpt, timeAgo } from '../utils'
import { DueBadge, PriorityMark, ProgressBar, ProjectChip, StatTile } from './bits'

interface Props {
  tasks: Task[]
  projects: Project[]
  projectMap: Map<string, Project>
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
  return (
    <li className={done ? 'trow done' : 'trow'} onClick={() => onOpen(task)}>
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

export function Today({ tasks, projects, projectMap, onOpen, onOpenProject, onStatus, onNew }: Props) {
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
    const stale = open
      .filter(t => !t.dueAt && t.status === 'todo' && nowMs - new Date(t.updatedAt).getTime() > STALE_DAYS * DAY_MS)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    const doneRecent = tasks
      .filter(t => t.status === 'done' && t.completedAt && nowMs - new Date(t.completedAt).getTime() < 7 * DAY_MS)
      .sort((a, b) => b.completedAt!.localeCompare(a.completedAt!))
    const activeProjects = projects
      .filter(p => p.status === 'active')
      .map(p => ({ project: p, progress: projectProgress(tasks.filter(t => t.projectId === p.id)) }))
    return { open, overdue, today, week, doing, blocked, stale, doneRecent, activeProjects }
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
    { key: 'stale', title: 'Going stale', sub: `To-dos untouched for ${STALE_DAYS}+ days with no date`, tasks: s.stale },
  ].filter(sec => sec.tasks.length > 0)

  return (
    <div className="insights today">
      <div className="kpi-row">
        <StatTile label="Overdue" value={String(s.overdue.length)} sub={s.overdue.length ? 'need a new date or a push' : 'nothing slipped'} warn={s.overdue.length > 0} />
        <StatTile label="Due today" value={String(s.today.length)} />
        <StatTile label="This week" value={String(s.week.length)} sub="due in the next 7 days" />
        <StatTile label="Open" value={String(s.open.length)} sub="to do, doing or blocked" />
        <StatTile label="Done this week" value={String(s.doneRecent.length)} sub="keep the streak" />
      </div>

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
