import { useMemo } from 'react'
import { PROJECT_STATUS_META, Project, Task, projectProgress } from '../types'
import { DAY_MS, startOfDay } from '../taskutils'
import { fmtDate } from '../utils'
import { ProgressBar } from './bits'

interface Props {
  projects: Project[]
  tasks: Task[]
  onOpenProject(p: Project): void
  onNewProject(): void
  onOpenTask(t: Task): void
}

const PX_PER_DAY = 4

interface Row {
  project: Project
  start: Date
  end: Date
  /** Dates were inferred (no explicit start/target) — drawn dashed. */
  inferred: boolean
  progress: ReturnType<typeof projectProgress>
  dueTasks: Task[]
}

export function Roadmap({ projects, tasks, onOpenProject, onNewProject, onOpenTask }: Props) {
  const model = useMemo(() => {
    const today = startOfDay()
    const visible = projects.filter(p => p.status !== 'archived')
    const rows: Row[] = visible.map(project => {
      const mine = tasks.filter(t => t.projectId === project.id)
      const dueTasks = mine.filter(t => t.dueAt && t.status !== 'canceled').sort((a, b) => a.dueAt!.localeCompare(b.dueAt!))
      const msDates = (project.milestones ?? []).filter(m => m.dueAt).map(m => new Date(m.dueAt!).getTime())
      const taskDates = dueTasks.map(t => new Date(t.dueAt!).getTime())
      const explicitStart = project.startAt ? new Date(project.startAt) : null
      const explicitEnd = project.targetAt ? new Date(project.targetAt) : null
      const latest = Math.max(...msDates, ...taskDates, -Infinity)
      const start = explicitStart ?? new Date(Math.min(new Date(project.createdAt).getTime(), today.getTime()))
      const end =
        explicitEnd ??
        new Date(Math.max(Number.isFinite(latest) ? latest : 0, start.getTime() + 30 * DAY_MS, today.getTime() + 14 * DAY_MS))
      return { project, start: startOfDay(start), end: startOfDay(end), inferred: !explicitStart && !explicitEnd, progress: projectProgress(mine), dueTasks }
    })
    const minStart = rows.length ? Math.min(...rows.map(r => r.start.getTime()), today.getTime()) : today.getTime()
    const maxEnd = rows.length ? Math.max(...rows.map(r => r.end.getTime()), today.getTime() + 90 * DAY_MS) : today.getTime() + 180 * DAY_MS
    // pad to whole months so the header lines up
    const from = new Date(new Date(minStart).getFullYear(), new Date(minStart).getMonth() - 1, 1)
    const to = new Date(new Date(maxEnd).getFullYear(), new Date(maxEnd).getMonth() + 2, 1)
    const months: { label: string; left: number; width: number }[] = []
    for (let m = new Date(from); m < to; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
      const next = new Date(m.getFullYear(), m.getMonth() + 1, 1)
      months.push({
        label: m.toLocaleDateString(undefined, { month: 'short', year: m.getMonth() === 0 || m.getTime() === from.getTime() ? '2-digit' : undefined }),
        left: ((m.getTime() - from.getTime()) / DAY_MS) * PX_PER_DAY,
        width: ((next.getTime() - m.getTime()) / DAY_MS) * PX_PER_DAY,
      })
    }
    const x = (d: Date | number) => ((typeof d === 'number' ? d : d.getTime()) - from.getTime()) / DAY_MS * PX_PER_DAY
    const width = x(to)
    rows.sort((a, b) => a.start.getTime() - b.start.getTime())
    return { rows, months, x, width, today, todayX: x(today) }
  }, [projects, tasks])

  if (projects.length === 0) {
    return (
      <div className="empty-hero">
        <h2>No projects yet</h2>
        <p>
          A project is anything with an end in mind — the kitchen refresh, a side app, the garden plan. Give it a target
          date and its milestones and tasks line up here.
        </p>
        <p>
          <button className="btn primary" onClick={onNewProject}>
            + New project
          </button>
        </p>
      </div>
    )
  }

  return (
    <div className="roadmap">
      <div className="toolbar">
        <h2 className="view-title">Roadmap</h2>
        <span className="cal-hint">Bars are project spans · ◆ milestones · dots are due tasks · click anything to open it</span>
        <span className="spacer" />
        <button className="btn" onClick={onNewProject}>
          + New project
        </button>
      </div>
      <div className="rm-scroll">
        <div className="rm-canvas" style={{ width: model.width + 260 }}>
          <div className="rm-header">
            <div className="rm-label rm-label-head">Project</div>
            <div className="rm-track" style={{ width: model.width }}>
              {model.months.map(m => (
                <span key={m.label + m.left} className="rm-month" style={{ left: m.left, width: m.width }}>
                  {m.label}
                </span>
              ))}
            </div>
          </div>
          {model.rows.map(row => {
            const left = model.x(row.start)
            const w = Math.max(model.x(row.end) - left, 8)
            const meta = PROJECT_STATUS_META[row.project.status]
            return (
              <div key={row.project.id} className="rm-row">
                <button className="rm-label" onClick={() => onOpenProject(row.project)}>
                  <span className="pdot" style={{ background: row.project.color }} />
                  <span className="rm-name">
                    {row.project.emoji && `${row.project.emoji} `}
                    {row.project.name}
                  </span>
                  <span className="badge" style={{ background: meta.bg, color: meta.color }}>
                    {meta.label}
                  </span>
                  <span className="rm-progress">
                    <ProgressBar pct={row.progress.pct} color={row.project.color} />
                    <small>
                      {row.progress.done}/{row.progress.total}
                    </small>
                  </span>
                </button>
                <div className="rm-track" style={{ width: model.width }}>
                  {model.months.map(m => (
                    <span key={m.left} className="rm-gridline" style={{ left: m.left }} />
                  ))}
                  <span className="rm-today" style={{ left: model.todayX }} />
                  <button
                    className={row.inferred ? 'rm-bar inferred' : 'rm-bar'}
                    style={{ left, width: w, background: row.project.color }}
                    onClick={() => onOpenProject(row.project)}
                    title={`${fmtDate(row.start.toISOString())} → ${fmtDate(row.end.toISOString())}${row.inferred ? ' (inferred — set start/target dates)' : ''}`}
                  >
                    <span className="rm-bar-fill" style={{ width: `${row.progress.pct}%` }} />
                  </button>
                  {(row.project.milestones ?? [])
                    .filter(m => m.dueAt)
                    .map(m => (
                      <button
                        key={m.id}
                        className={m.done ? 'rm-ms done' : 'rm-ms'}
                        style={{ left: model.x(new Date(m.dueAt!)), borderColor: row.project.color }}
                        title={`◆ ${m.name} · ${fmtDate(m.dueAt)}`}
                        onClick={() => onOpenProject(row.project)}
                      >
                        <span className="rm-ms-name">{m.name}</span>
                      </button>
                    ))}
                  {row.dueTasks.map(t => (
                    <button
                      key={t.id}
                      className={`rm-task ${t.status}`}
                      style={{ left: model.x(new Date(t.dueAt!)), background: t.status === 'done' ? undefined : row.project.color }}
                      title={`${t.title || 'Untitled'} · ${fmtDate(t.dueAt)}`}
                      onClick={() => onOpenTask(t)}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
