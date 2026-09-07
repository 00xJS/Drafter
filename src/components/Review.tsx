import { useEffect, useMemo, useState } from 'react'
import { Person, Project, Review as ReviewRecord, Task, TaskStatus } from '../types'
import { Period, ReviewData, buildReview, rangeFor, shiftRange } from '../review'
import { summarizeReview } from '../ai'
import { newerStamp } from '../itemops'
import { fmtDate, uid } from '../utils'
import { DueBadge, ProjectChip, StatTile } from './bits'

interface Props {
  tasks: Task[]
  projects: Project[]
  projectMap: Map<string, Project>
  people: Person[]
  reviews: ReviewRecord[]
  onSaveReview(r: ReviewRecord): void
  onOpen(t: Task): void
  onStatus(id: string, s: TaskStatus): void
  /** Move a set of tasks to a new due date (bulk reschedule). */
  onReschedule(ids: string[], dueAtIso: string): void
  onOpenProject(p: Project): void
}

function nextMonday(from = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + ((8 - from.getDay()) % 7 || 7), 9, 0, 0)
  return d.toISOString()
}

function TaskList({ tasks, projectMap, onOpen, onStatus, max = 12 }: { tasks: Task[]; projectMap: Map<string, Project>; onOpen(t: Task): void; onStatus?(id: string, s: TaskStatus): void; max?: number }) {
  if (tasks.length === 0) return <p className="empty">Nothing here.</p>
  return (
    <ul className="dash-list tlist">
      {tasks.slice(0, max).map(t => (
        <li key={t.id} className={t.status === 'done' ? 'trow done' : 'trow'} onClick={() => onOpen(t)}>
          {onStatus && (
            <input
              type="checkbox"
              className="tcheck"
              checked={t.status === 'done'}
              aria-label="Mark done"
              onClick={e => e.stopPropagation()}
              onChange={() => onStatus(t.id, t.status === 'done' ? 'todo' : 'done')}
            />
          )}
          <div className="dash-main">
            <span className="dash-title">{t.title || 'Untitled'}</span>
            <span className="dash-meta">{t.projectId && projectMap.get(t.projectId) && <ProjectChip project={projectMap.get(t.projectId)!} />}</span>
          </div>
          {t.status === 'done' ? <small className="muted">{fmtDate(t.completedAt)}</small> : <DueBadge task={t} />}
        </li>
      ))}
      {tasks.length > max && <li className="board-more">+ {tasks.length - max} more</li>}
    </ul>
  )
}

export function Review({ tasks, projects, projectMap, people, reviews, onSaveReview, onOpen, onStatus, onReschedule, onOpenProject }: Props) {
  const [period, setPeriod] = useState<Period>('week')
  const [anchor, setAnchor] = useState(() => new Date())
  const range = useMemo(() => rangeFor(period, anchor), [period, anchor])
  const data: ReviewData = useMemo(() => buildReview(range, tasks, projects, people), [range, tasks, projects, people])
  const saved = reviews.find(r => r.period === period && r.key === range.key)
  const [top, setTop] = useState<string[]>(saved?.top ?? ['', '', ''])
  const [reflections, setReflections] = useState(saved?.reflections ?? '')
  const [summary, setSummary] = useState(saved?.summary ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setTop(saved?.top?.length ? [...saved.top, '', '', ''].slice(0, 3) : ['', '', ''])
    setReflections(saved?.reflections ?? '')
    setSummary(saved?.summary ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.key])

  const persist = (patch: Partial<ReviewRecord>) => {
    const now = new Date().toISOString()
    const base: ReviewRecord = saved ?? { kind: 'review', id: uid(), period, key: range.key, top: [], createdAt: now, updatedAt: now }
    onSaveReview({ ...base, top: top.map(t => t.trim()).filter(Boolean), reflections: reflections.trim() || undefined, summary: summary || undefined, ...patch, updatedAt: saved ? newerStamp(saved.updatedAt) : now })
  }

  const generate = async () => {
    setBusy(true)
    setError('')
    try {
      const text = await summarizeReview({
        period,
        label: range.label,
        done: data.done.map(t => `${t.title}${t.projectId && projectMap.get(t.projectId) ? ` (${projectMap.get(t.projectId)!.name})` : ''}`),
        slipped: data.slipped.map(t => t.title),
        upcoming: data.upcoming.map(t => `${t.title} · due ${fmtDate(t.dueAt)}`),
        people: data.people.map(p => `${p.person.name} ×${p.visits.length}`),
        projects: data.projects.map(p => `${p.project.name}: ${p.done} done, ${p.open} open`),
        stalled: data.stalled.map(p => p.name),
        reflections,
      })
      setSummary(text)
      persist({ summary: text })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const isCurrent = range.end.getTime() > Date.now() && range.start.getTime() <= Date.now()

  return (
    <div className="insights review">
      <div className="toolbar">
        <span className="segmented">
          <button className={period === 'week' ? 'seg on' : 'seg'} onClick={() => setPeriod('week')}>
            Week
          </button>
          <button className={period === 'month' ? 'seg on' : 'seg'} onClick={() => setPeriod('month')}>
            Month
          </button>
        </span>
        <button className="btn" onClick={() => setAnchor(shiftRange(range, -1).start)} aria-label="Previous">
          ‹
        </button>
        <h2 className="view-title">
          {range.label} {isCurrent && <small className="muted">(so far)</small>}
        </h2>
        <button className="btn" onClick={() => setAnchor(shiftRange(range, 1).start)} aria-label="Next">
          ›
        </button>
        <button className="btn subtle" onClick={() => setAnchor(new Date())}>
          This {period}
        </button>
        <span className="spacer" />
        <button className="btn" disabled={busy} onClick={generate}>
          {busy ? 'Writing…' : summary ? '✨ Rewrite summary' : '✨ Write my summary'}
        </button>
      </div>

      <div className="kpi-row">
        <StatTile label="Done" value={String(data.done.length)} sub={`${data.created.length} created`} />
        <StatTile label="Slipped" value={String(data.slipped.length)} sub="due in this period, still open" warn={data.slipped.length > 0} />
        <StatTile label={`Next ${period}`} value={String(data.upcoming.length)} sub="already on the calendar" />
        <StatTile label="People seen" value={String(data.people.length)} sub={`${data.people.reduce((s, p) => s + p.visits.length, 0)} visits`} />
        <StatTile label="Stalled projects" value={String(data.stalled.length)} sub="no activity this period" warn={data.stalled.length > 0} />
      </div>

      {(summary || error) && (
        <section className="chart-card review-summary">
          <header className="chart-head">
            <div>
              <h3>Summary</h3>
              <p className="chart-sub">Written by the model from this period's data and your reflections</p>
            </div>
          </header>
          {error ? <p className="warn">{error}</p> : <div className="review-summary-text">{summary}</div>}
        </section>
      )}

      <div className="today-grid">
        <section className="chart-card">
          <header className="chart-head">
            <div>
              <h3>Done ✓</h3>
              <p className="chart-sub">Everything you finished</p>
            </div>
          </header>
          <div className="review-days" aria-hidden>
            {data.doneByDay.map((n, i) => (
              <span key={i} className="review-day" style={{ height: `${n === 0 ? 6 : 20 + (n / Math.max(...data.doneByDay, 1)) * 80}%` }} title={`${n} done`} />
            ))}
          </div>
          <TaskList tasks={data.done} projectMap={projectMap} onOpen={onOpen} />
        </section>

        <section className={data.overdueNow.length > 0 ? 'chart-card warn-card' : 'chart-card'}>
          <header className="chart-head">
            <div>
              <h3>Slipped &amp; overdue</h3>
              <p className="chart-sub">Decide once: push to next week, or let it go</p>
            </div>
            {data.overdueNow.length > 0 && (
              <div className="review-bulk">
                <button className="btn" onClick={() => onReschedule(data.overdueNow.map(t => t.id), nextMonday())}>
                  Push all to Monday
                </button>
                <button className="btn subtle" onClick={() => data.overdueNow.forEach(t => onStatus(t.id, 'wishlist'))}>
                  Back to Wishlist
                </button>
              </div>
            )}
          </header>
          <TaskList tasks={isCurrent ? data.overdueNow : data.slipped} projectMap={projectMap} onOpen={onOpen} onStatus={onStatus} />
        </section>

        <section className="chart-card">
          <header className="chart-head">
            <div>
              <h3>Top 3 for next {period}</h3>
              <p className="chart-sub">What would make it a good {period}?</p>
            </div>
          </header>
          <div className="review-top">
            {top.map((v, i) => (
              <input
                key={i}
                value={v}
                placeholder={`#${i + 1}`}
                onChange={e => setTop(cur => cur.map((x, j) => (j === i ? e.target.value : x)))}
                onBlur={() => persist({})}
              />
            ))}
          </div>
          <label className="field">
            <span>Reflections</span>
            <textarea rows={3} value={reflections} onChange={e => setReflections(e.target.value)} onBlur={() => persist({})} placeholder="What worked, what didn't, what to change…" />
          </label>
          <TaskList tasks={data.upcoming} projectMap={projectMap} onOpen={onOpen} max={6} />
        </section>

        <section className="chart-card">
          <header className="chart-head">
            <div>
              <h3>Projects</h3>
              <p className="chart-sub">Movement by project</p>
            </div>
          </header>
          {data.projects.length === 0 && data.stalled.length === 0 ? (
            <p className="empty">No project activity.</p>
          ) : (
            <ul className="dash-list">
              {data.projects.map(r => (
                <li key={r.project.id} onClick={() => onOpenProject(r.project)}>
                  <div className="dash-main">
                    <span className="dash-title">
                      <ProjectChip project={r.project} />
                    </span>
                  </div>
                  <small className="muted">
                    {r.done} done · {r.open} open
                  </small>
                </li>
              ))}
              {data.stalled.map(p => (
                <li key={p.id} onClick={() => onOpenProject(p)}>
                  <div className="dash-main">
                    <span className="dash-title">
                      <ProjectChip project={p} />
                    </span>
                    <span className="dash-reason">Nothing moved — still worth doing?</span>
                  </div>
                  <span className="badge badge-blocked">stalled</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="chart-card">
          <header className="chart-head">
            <div>
              <h3>People</h3>
              <p className="chart-sub">Who you saw this {period}</p>
            </div>
          </header>
          {data.people.length === 0 ? (
            <p className="empty">No visits logged.</p>
          ) : (
            <ul className="dash-list">
              {data.people.map(p => (
                <li key={p.person.id}>
                  <span className="person-avatar small" style={{ background: p.person.color }}>
                    {p.person.emoji ?? p.person.name.slice(0, 1)}
                  </span>
                  <div className="dash-main">
                    <span className="dash-title">{p.person.name}</span>
                    <span className="dash-reason">{p.visits.map(v => v.title).join(' · ')}</span>
                  </div>
                  <strong>×{p.visits.length}</strong>
                </li>
              ))}
            </ul>
          )}
        </section>

        {(data.costs.estimate > 0 || data.costs.actual > 0) && (
          <section className="chart-card">
            <header className="chart-head">
              <div>
                <h3>Spend</h3>
                <p className="chart-sub">On tasks completed this {period}</p>
              </div>
            </header>
            <p className="review-costs">
              <strong>{data.costs.actual.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong> spent
              {data.costs.estimate > 0 && <small className="muted"> vs {data.costs.estimate.toLocaleString(undefined, { maximumFractionDigits: 0 })} estimated</small>}
            </p>
          </section>
        )}
      </div>
    </div>
  )
}
