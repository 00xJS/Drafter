import { useEffect, useMemo, useRef, useState } from 'react'
import { Habit, JournalEntry, MOOD_META, PLACE_CATEGORY_META, Person, Place, Project, Review as ReviewRecord, Task, TaskStatus } from '../types'
import { Period, ReviewData, buildReview, defaultReviewAnchor, rangeFor, shiftRange } from '../review'
import { entriesInRange, journalLines, moodAverage, peopleNameMap, relativeDayLabel } from '../journal'
import { habitsConsistency } from '../habits'
import { JournalPeople } from './Journal'
import { summarizeReview } from '../ai'
import { newerStamp } from '../itemops'
import { excerpt, fmtDate, uid } from '../utils'
import { DueBadge, StatTile } from './bits'

interface Props {
  tasks: Task[]
  projects: Project[]
  people: Person[]
  reviews: ReviewRecord[]
  /** Your journal (personal); the period's entries feed the summary. */
  journal: JournalEntry[]
  places: Place[]
  /** Your habits (personal); done/due over the period feeds the block and the summary. */
  habits: Habit[]
  onSaveReview(r: ReviewRecord): void
  onOpen(t: Task): void
  onStatus(id: string, s: TaskStatus): void
  /** Move a set of tasks to a new due date (bulk reschedule). */
  onReschedule(ids: string[], dueAtIso: string): void
  onNew(preset?: Partial<Task>): void
  /** Open the "Plan next week" sheet. Without it there is no button. */
  onPlanWeek?(): void
}

/** "Plan next week" is the toolbar's main action from Friday to Sunday, when the week ahead is what there is to plan. */
export function planWeekIsPrimary(d: Date): boolean {
  const day = d.getDay()
  return day === 5 || day === 6 || day === 0
}

function nextMonday(from = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + ((8 - from.getDay()) % 7 || 7), 9, 0, 0)
  return d.toISOString()
}

// one ongoing home project: a project chip on every row would say nothing
function TaskList({ tasks, onOpen, onStatus, max = 12 }: { tasks: Task[]; onOpen(t: Task): void; onStatus?(id: string, s: TaskStatus): void; max?: number }) {
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
            <button type="button" className="row-open">
              <span className="dash-title">{t.title || 'Untitled'}</span>
            </button>
          </div>
          {t.status === 'done' ? <small className="muted">{fmtDate(t.completedAt)}</small> : <DueBadge task={t} />}
        </li>
      ))}
      {tasks.length > max && <li className="board-more">+ {tasks.length - max} more</li>}
    </ul>
  )
}

/** The Top 3, reflections and summary drafts a saved review loads into: three Top 3 lines, always. */
export function reviewDraft(saved: ReviewRecord | undefined): { top: string[]; reflections: string; summary: string } {
  return {
    top: saved?.top?.length ? [...saved.top, '', '', ''].slice(0, 3) : ['', '', ''],
    reflections: saved?.reflections ?? '',
    summary: saved?.summary ?? '',
  }
}

/**
 * Whether the drafts reload: another week or month, or the saved review
 * changed by anything but this page's own save, whose stamp is `ownStamp`.
 */
export function reloadDraft(prev: { key: string; stamp?: string }, next: { key: string; stamp?: string }, ownStamp: string | null): boolean {
  if (prev.key !== next.key) return true
  return next.stamp !== prev.stamp && next.stamp !== ownStamp
}

export function Review({ tasks, projects, people, reviews, journal, places, habits, onSaveReview, onOpen, onStatus, onReschedule, onNew, onPlanWeek }: Props) {
  const [period, setPeriod] = useState<Period>('week')
  const [anchor, setAnchor] = useState(() => defaultReviewAnchor(new Date()))
  const range = useMemo(() => rangeFor(period, anchor), [period, anchor])
  const data: ReviewData = useMemo(() => buildReview(range, tasks, projects, people, new Date(), places), [range, tasks, projects, people, places])
  const wrote = useMemo(() => entriesInRange(journal, range), [journal, range])
  const mood = moodAverage(wrote)
  const habitStats = useMemo(() => habitsConsistency(habits, range.start, range.end, new Date()), [habits, range])
  const saved = reviews.find(r => r.period === period && r.key === range.key)
  const prevRange = useMemo(() => shiftRange(range, -1), [range])
  const prevSaved = reviews.find(r => r.period === period && r.key === prevRange.key)
  const [top, setTop] = useState<string[]>(() => reviewDraft(saved).top)
  const [reflections, setReflections] = useState(() => reviewDraft(saved).reflections)
  const [summary, setSummary] = useState(() => reviewDraft(saved).summary)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // The drafts follow the saved review: to another week or month, and when the
  // record changes from outside — Plan next week, its Undo, a sync. Kept, a
  // stale draft would be saved back over it on the next blur. Never after this
  // page's own save, which would trim what is being typed.
  const ownStamp = useRef<string | null>(null)
  const loaded = useRef({ key: range.key, stamp: saved?.updatedAt })
  useEffect(() => {
    const next = { key: range.key, stamp: saved?.updatedAt }
    if (reloadDraft(loaded.current, next, ownStamp.current)) {
      const d = reviewDraft(saved)
      setTop(d.top)
      setReflections(d.reflections)
      setSummary(d.summary)
    }
    loaded.current = next
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.key, saved?.updatedAt])

  const persist = (patch: Partial<ReviewRecord>) => {
    const now = new Date().toISOString()
    const base: ReviewRecord = saved ?? { kind: 'review', id: uid(), period, key: range.key, top: [], createdAt: now, updatedAt: now }
    const updatedAt = saved ? newerStamp(saved.updatedAt) : now
    ownStamp.current = updatedAt
    onSaveReview({ ...base, top: top.map(t => t.trim()).filter(Boolean), reflections: reflections.trim() || undefined, summary: summary || undefined, ...patch, updatedAt })
  }

  const togglePrevTop = (index: number) => {
    if (!prevSaved) return
    const next = [...(prevSaved.topDone ?? [])]
    while (next.length < (prevSaved.top?.length ?? 0)) next.push(false)
    next[index] = !next[index]
    onSaveReview({ ...prevSaved, topDone: next, updatedAt: newerStamp(prevSaved.updatedAt) })
  }

  const generate = async () => {
    setBusy(true)
    setError('')
    try {
      const lastTop = prevSaved?.top?.filter(Boolean) ?? []
      const text = await summarizeReview({
        period,
        label: range.label,
        done: data.done.map(t => t.title),
        slipped: data.slipped.map(t => t.title),
        upcoming: data.upcoming.map(t => `${t.title} · due ${fmtDate(t.dueAt)}`),
        people: data.people.map(p => `${p.person.name} ×${p.visits.length}`),
        places: data.places.map(p => `${p.place.name} ×${p.visits.length}`),
        // one compact line so the model can weigh it without a tally per day
        habits: habitStats.due > 0 ? [`${habitStats.pct}% consistent (${habitStats.done}/${habitStats.due}): ${habitStats.rows.map(r => `${r.habit.name} ${r.done}/${r.due}`).join(' · ')}`] : [],
        reflections,
        lastTop,
        kept: lastTop.map((_, i) => !!prevSaved?.topDone?.[i]),
        journal: journalLines(wrote, 14, peopleNameMap(people)),
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
  const endOfNext = (() => {
    const d = new Date(range.end)
    d.setDate(d.getDate() + (period === 'week' ? 6 : 27))
    d.setHours(17, 0, 0, 0)
    return d.toISOString()
  })()

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
        {onPlanWeek && (
          <button className={planWeekIsPrimary(new Date()) ? 'btn primary' : 'btn'} onClick={onPlanWeek}>
            Plan next week
          </button>
        )}
        <button className="btn" disabled={busy} onClick={generate}>
          {busy ? 'Writing…' : summary ? '✨ Rewrite summary' : '✨ Write my summary'}
        </button>
      </div>

      {prevSaved && (prevSaved.top?.length || prevSaved.reflections) && (
        <section className="chart-card you-said">
          <header className="chart-head">
            <div>
              <h3>You said</h3>
              <p className="chart-sub">Last {period}'s Top 3 and reflections — tick what you kept</p>
            </div>
          </header>
          {prevSaved.top?.length ? (
            <ul className="dash-list">
              {prevSaved.top.map((line, i) => (
                <li key={i} className={prevSaved.topDone?.[i] ? 'trow done' : 'trow'}>
                  <input type="checkbox" className="tcheck" checked={!!prevSaved.topDone?.[i]} onChange={() => togglePrevTop(i)} aria-label="Kept" />
                  <div className="dash-main">
                    <span className="dash-title">{line}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">No Top 3 written last {period}.</p>
          )}
          {prevSaved.reflections && <p className="you-said-reflections">{prevSaved.reflections}</p>}
        </section>
      )}

      <div className="kpi-row">
        <StatTile label="Done" value={String(data.done.length)} sub={`${data.created.length} created`} />
        <StatTile label="Slipped" value={String(data.slipped.length)} sub="due in this period, still open" warn={data.slipped.length > 0} />
        <StatTile label={`Next ${period}`} value={String(data.upcoming.length)} sub="already on the calendar" />
        <StatTile label="People seen" value={String(data.people.length)} sub={`${data.people.reduce((s, p) => s + p.visits.length, 0)} visits`} />
        {wrote.length > 0 && <StatTile label="Journal" value={String(wrote.length)} sub={mood ? `days written · mood ${mood}/5` : 'days written'} />}
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
          <TaskList tasks={data.done} onOpen={onOpen} />
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
          <TaskList tasks={isCurrent ? data.overdueNow : data.slipped} onOpen={onOpen} onStatus={onStatus} />
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
              <div key={i} className="review-top-row">
                <input
                  value={v}
                  placeholder={`#${i + 1}`}
                  onChange={e => setTop(cur => cur.map((x, j) => (j === i ? e.target.value : x)))}
                  onBlur={() => persist({})}
                />
                {v.trim() && (
                  <button type="button" className="btn subtle" title="Create a task" onClick={() => onNew({ title: v.trim(), dueAt: endOfNext, status: 'todo' })}>
                    → task
                  </button>
                )}
              </div>
            ))}
          </div>
          <label className="field">
            <span>Reflections</span>
            <textarea rows={3} value={reflections} onChange={e => setReflections(e.target.value)} onBlur={() => persist({})} placeholder="What worked, what didn't, what to change…" />
          </label>
          <TaskList tasks={data.upcoming} onOpen={onOpen} max={6} />
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

        {data.places.length > 0 && (
          <section className="chart-card">
            <header className="chart-head">
              <div>
                <h3>Where you went</h3>
                <p className="chart-sub">Outings this {period}</p>
              </div>
            </header>
            <ul className="dash-list">
              {data.places.map(p => (
                <li key={p.place.id}>
                  <span className="person-avatar small" style={{ background: p.place.color }}>
                    {p.place.emoji ?? PLACE_CATEGORY_META[p.place.category].emoji}
                  </span>
                  <div className="dash-main">
                    <span className="dash-title">{p.place.name}</span>
                    <span className="dash-reason">{p.visits.map(v => v.title).join(' · ')}</span>
                  </div>
                  <strong>×{p.visits.length}</strong>
                </li>
              ))}
            </ul>
          </section>
        )}

        {habitStats.due > 0 && (
          <section className="chart-card review-habits">
            <header className="chart-head">
              <div>
                <h3>Habits</h3>
                <p className="chart-sub">
                  {habitStats.pct}% consistent — {habitStats.done} of {habitStats.due} {isCurrent ? 'so far' : `this ${period}`}
                </p>
              </div>
            </header>
            <ul className="dash-list">
              {habitStats.rows.map(r => (
                <li key={r.habit.id}>
                  <span className="journal-mood" aria-hidden>
                    {r.habit.emoji ?? '·'}
                  </span>
                  <div className="dash-main">
                    <span className="dash-title">{r.habit.name}</span>
                  </div>
                  <strong className="habit-streak">
                    {r.done}/{r.due}
                  </strong>
                </li>
              ))}
            </ul>
          </section>
        )}

        {wrote.length > 0 && (
          <section className="chart-card review-journal">
            <header className="chart-head">
              <div>
                <h3>What you wrote</h3>
                <p className="chart-sub">Your journal this {period} — the summary reads it too</p>
              </div>
            </header>
            <ul className="dash-list">
              {wrote.map(e => (
                <li key={e.id}>
                  <span className="journal-mood" aria-hidden>
                    {e.mood ? MOOD_META[e.mood].emoji : '·'}
                  </span>
                  <div className="dash-main">
                    <span className="dash-title">{excerpt(e.body, 220) || (e.mood ? MOOD_META[e.mood].label : '')}</span>
                    <span className="dash-reason">{relativeDayLabel(e.date)}</span>
                  </div>
                  <JournalPeople entry={e} people={people} />
                </li>
              ))}
            </ul>
          </section>
        )}

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
