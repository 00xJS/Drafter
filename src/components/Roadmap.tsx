import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CalendarEvent, CalendarSource, PROJECT_STATUS_META, Project, Task, projectProgress } from '../types'
import { DAY_MS, startOfDay } from '../taskutils'
import { eventStartDate } from '../calendars'
import { getSupabase } from '../supabase'
import { fmtDate } from '../utils'
import { ProgressBar } from './bits'

interface Props {
  projects: Project[]
  tasks: Task[]
  events: CalendarEvent[]
  sourceMap: Map<string, CalendarSource>
  onOpenProject(p: Project): void
  onNewProject(): void
  onOpenTask(t: Task): void
}

/** A young history stretches to fill the width; an old one packs down to this and scrolls. */
const MIN_PX_PER_DAY = 4
const MAX_PX_PER_DAY = 48
/** The project label column beside the track. */
const LABEL_W = 260

interface Row {
  project: Project
  start: Date
  end: Date
  /** Dates were inferred (no explicit start/target) — drawn dashed. */
  inferred: boolean
  progress: ReturnType<typeof projectProgress>
  dueTasks: Task[]
}

/**
 * The span the Timeline draws: from the first day of the service to the end of
 * today. The first day is when this account was created; in local mode, or
 * before the session is known, it is the earliest project or task. Nothing past
 * today is drawn — what is coming lives on the calendar's Month and Week.
 */
export function timelineRange(accountCreatedAt: string | null, projects: Project[], tasks: Task[], today: Date): { from: Date; to: Date } {
  const account = accountCreatedAt ? Date.parse(accountCreatedAt) : NaN
  let first = Number.isFinite(account) ? account : Infinity
  if (!Number.isFinite(first)) {
    for (const r of [...projects, ...tasks]) {
      const t = Date.parse(r.createdAt)
      if (Number.isFinite(t) && t < first) first = t
    }
  }
  const from = startOfDay(new Date(Math.min(Number.isFinite(first) ? first : today.getTime(), today.getTime())))
  // the end of today, so today's own marks are not cut off at the edge
  const to = new Date(startOfDay(today).getTime() + DAY_MS)
  return { from, to }
}

/** Pixels per day that fit `days` into `available` pixels, within the min and max. */
export function pxPerDay(available: number, days: number): number {
  if (!(available > 0) || !(days > 0)) return MIN_PX_PER_DAY
  return Math.min(MAX_PX_PER_DAY, Math.max(MIN_PX_PER_DAY, available / days))
}

export function Roadmap({ projects, tasks, events, sourceMap, onOpenProject, onNewProject, onOpenTask }: Props) {
  // the account's own creation day is the first day of the service
  const [accountSince, setAccountSince] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const sb = getSupabase()
    if (sb)
      void sb.auth.getSession().then(({ data }) => {
        if (alive) setAccountSince(data.session?.user?.created_at ?? null)
      })
    return () => {
      alive = false
    }
  }, [])

  const empty = projects.length === 0
  const scrollRef = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState(0)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => setAvail(el.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [empty])

  const model = useMemo(() => {
    const today = startOfDay()
    const { from, to } = timelineRange(accountSince, projects, tasks, today)
    const ppd = pxPerDay(avail - LABEL_W, (to.getTime() - from.getTime()) / DAY_MS)
    const x = (d: Date | number) => (((typeof d === 'number' ? d : d.getTime()) - from.getTime()) / DAY_MS) * ppd
    const inRange = (ms: number) => ms >= from.getTime() && ms <= to.getTime()
    const rows: Row[] = []
    for (const project of projects.filter(p => p.status !== 'archived')) {
      const mine = tasks.filter(t => t.projectId === project.id)
      const dated = mine.filter(t => t.dueAt && t.status !== 'canceled').sort((a, b) => a.dueAt!.localeCompare(b.dueAt!))
      const msDates = (project.milestones ?? []).filter(m => m.dueAt).map(m => new Date(m.dueAt!).getTime())
      const taskDates = dated.map(t => new Date(t.dueAt!).getTime())
      const explicitStart = project.startAt ? new Date(project.startAt) : null
      const explicitEnd = project.targetAt ? new Date(project.targetAt) : null
      const latest = Math.max(...msDates, ...taskDates, -Infinity)
      const start = explicitStart ?? new Date(Math.min(new Date(project.createdAt).getTime(), today.getTime()))
      const end =
        explicitEnd ??
        new Date(Math.max(Number.isFinite(latest) ? latest : 0, start.getTime() + 30 * DAY_MS, today.getTime() + 14 * DAY_MS))
      // drawn only between the first day and today
      if (start.getTime() > to.getTime() || end.getTime() < from.getTime()) continue
      rows.push({
        project,
        start: startOfDay(new Date(Math.max(start.getTime(), from.getTime()))),
        end: new Date(Math.min(startOfDay(end).getTime(), to.getTime())),
        inferred: !explicitStart && !explicitEnd,
        progress: projectProgress(mine),
        dueTasks: dated.filter(t => inRange(new Date(t.dueAt!).getTime())),
      })
    }
    const months: { label: string; left: number; width: number }[] = []
    for (let m = new Date(from.getFullYear(), from.getMonth(), 1); m < to; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
      const next = new Date(m.getFullYear(), m.getMonth() + 1, 1)
      const left = Math.max(m.getTime(), from.getTime())
      const width = x(Math.min(next.getTime(), to.getTime())) - x(left)
      // the first month and every January carry the year in full ("Sep 2026") —
      // a two-digit year read as a date ("Sep 26"); a sliver of a month (the
      // first day can fall on the 29th) keeps its line but not a label
      const withYear = m.getMonth() === 0 || months.length === 0
      const label = m.toLocaleDateString(undefined, withYear ? { month: 'short', year: 'numeric' } : { month: 'short' })
      months.push({ label: width >= (withYear ? 64 : 28) ? label : '', left: x(left), width })
    }
    rows.sort((a, b) => a.start.getTime() - b.start.getTime())
    const markers = events
      .map(ev => ({ ev, at: eventStartDate(ev) }))
      .filter(m => inRange(m.at.getTime()))
      .slice(0, 400)
    return { rows, months, x, inRange, from, width: x(to), todayX: x(today), markers }
  }, [projects, tasks, events, accountSince, avail])

  // open on today — the right-hand end — when the history is wider than the screen
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [model.width])

  if (empty) {
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
        <h2 className="view-title">Timeline</h2>
        <span className="cal-hint">
          Since {fmtDate(model.from.toISOString())} · bars are project spans · ◆ milestones · dots are due tasks · click anything to open it
        </span>
        <span className="spacer" />
        <button className="btn" onClick={onNewProject}>
          + New project
        </button>
      </div>
      <div className="rm-scroll" ref={scrollRef}>
        <div className="rm-canvas" style={{ width: model.width + LABEL_W }}>
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
          {model.markers.length > 0 && (
            <div className="rm-row rm-events">
              <div className="rm-label rm-label-head">Calendar</div>
              <div className="rm-track" style={{ width: model.width }}>
                {model.months.map(m => (
                  <span key={m.left} className="rm-gridline" style={{ left: m.left }} />
                ))}
                <span className="rm-today" style={{ left: model.todayX }} />
                {model.markers.map(({ ev, at }) => (
                  <span
                    key={ev.id}
                    className="rm-event"
                    style={{ left: model.x(at), background: sourceMap.get(ev.sourceId)?.color ?? '#94a3b8' }}
                    title={`${ev.title} · ${fmtDate(at.toISOString())}`}
                  />
                ))}
              </div>
            </div>
          )}
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
                    .filter(m => m.dueAt && model.inRange(new Date(m.dueAt).getTime()))
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
