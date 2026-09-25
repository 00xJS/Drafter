import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { CalendarEntry, Garment, Habit, JournalEntry, MOOD_META, PLACE_CATEGORY_META, Person, Place, Project, Review as ReviewRecord, Task, TaskStatus, Wear } from '../types'
import { Period, ReviewData, buildReview, defaultReviewAnchor, rangeFor, shiftRange } from '../review'
import { formatMoney } from '../bills'
import { countOf, seenLabel } from '../people'
import { entriesInRange, journalLines, localDayKey, moodAverage, peopleNameMap, relativeDayLabel } from '../journal'
import { habitsConsistency, type HabitConsistency } from '../habits'
import { habitLines } from '../../shared/review.mts'
import { JournalPeople } from './JournalCard'
import { summarizeReview } from '../ai'
import { newerStamp } from '../itemops'
import { dateKey, excerpt, fmtDate, uid } from '../utils'
import { liveById, outfitLabel, wearIndex, wornBetween } from '../wardrobe'
import { DueBadge, StatTile } from './bits'
import { ReviewDays } from './ReviewDays'
import { useNow } from '../useNow'
import { noonOf } from '../useDayKey'
import type { WardrobeOpen } from './planner/useNavigation'
import { Collage, GarmentPhoto } from './wardrobe/GarmentPhoto'

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
  /** Your own calendar entries: one that has happened with people on it counts under People. */
  entries?: CalendarEntry[]
  /**
   * Whose week this is. Who you saw and where you went are each member's own
   * (v3.24): a fortnight in which the other member saw their mother twice used
   * to read here as though you had, which is how the separation was noticed.
   */
  myId?: string | null
  onSaveReview(r: ReviewRecord): void
  onOpen(t: Task): void
  onStatus(id: string, s: TaskStatus): void
  /** Move a set of tasks to a day, each keeping its time, with one Undo (the planner's deferAll). */
  onDeferAll(ids: string[], day: Date): void
  /** Move a set of tasks to one status, with one Undo. */
  onStatusAll(ids: string[], s: TaskStatus): void
  onNew(preset?: Partial<Task>): void
  /** Open the "Plan next week" sheet. Without it there is no button. */
  onPlanWeek?(): void
  /** Your clothes and what you wore (personal): the period's looks and its most worn piece. */
  garments?: Garment[]
  wears?: Wear[]
  /** Home → Wardrobe: a look on its day, the most worn piece on its sheet. Without it there is no wardrobe card. */
  onOpenWardrobe?(o: WardrobeOpen): void
}

/** "Plan next week" is the toolbar's main action from Friday to Sunday, when the week ahead is what there is to plan. */
export function planWeekIsPrimary(d: Date): boolean {
  const day = d.getDay()
  return day === 5 || day === 6 || day === 0
}

/** The Monday after `from` (a Monday's is the next one). Only its day is read: each task keeps its own time. */
export function nextMonday(from: Date): Date {
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + ((8 - from.getDay()) % 7 || 7), 12)
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
              aria-label={`Mark “${t.title || 'Untitled'}” done`}
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

/** Whether the summary card is open, per device. Open unless it was shut. */
const SUMMARY_KEY = 'drafter:review-summary'

// Read and kept out here: the React Compiler leaves a component with a choice
// inside a try as written.
function storedSummaryOpen(): boolean {
  try {
    return localStorage.getItem(SUMMARY_KEY) !== '0'
  } catch {
    return true
  }
}

function storeSummaryOpen(open: boolean): void {
  try {
    localStorage.setItem(SUMMARY_KEY, open ? '1' : '0')
  } catch {
    /* ignore */
  }
}

/** What ✨ Write my summary sends: the period's lists as lines, and last period's Top 3 with what was kept of it. */
function summaryInput(o: {
  period: Period
  label: string
  data: ReviewData
  habitStats: HabitConsistency
  reflections: string
  prevSaved?: ReviewRecord
  wrote: JournalEntry[]
  people: Person[]
}): Parameters<typeof summarizeReview>[0] {
  const { data, habitStats, prevSaved } = o
  const lastTop = prevSaved?.top?.filter(Boolean) ?? []
  return {
    period: o.period,
    label: o.label,
    done: data.done.map(t => t.title),
    slipped: data.slipped.map(t => t.title),
    upcoming: data.upcoming.map(t => `${t.title} · due ${fmtDate(t.dueAt)}`),
    people: data.people.map(p => `${p.person.name} ×${p.visits.length}`),
    places: data.places.map(p => `${p.place.name} ×${p.visits.length}`),
    // one compact line — kept, missed and each streak — so the model can weigh
    // it without a tally per day; Sunday's draft sends the same line (shared/review.mts)
    habits: habitLines(habitStats),
    reflections: o.reflections,
    lastTop,
    kept: lastTop.map((_, i) => !!prevSaved?.topDone?.[i]),
    journal: journalLines(o.wrote, 14, peopleNameMap(o.people)),
  }
}

/** Words in a summary, for the line that stands in for it while it is hidden. */
export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0
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

const NO_ENTRIES: CalendarEntry[] = []
const NO_GARMENTS: Garment[] = []
const NO_WEARS: Wear[] = []
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Under a look in the Week review's strip: its weekday, with the date too in a month's. */
function lookDay(key: string, withDate: boolean): string {
  const [y, m, d] = key.split('-').map(Number)
  const weekday = WEEKDAY_SHORT[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return withDate ? `${weekday} ${d}` : weekday
}

export function Review({
  tasks,
  projects,
  people,
  reviews,
  journal,
  places,
  habits,
  entries = NO_ENTRIES,
  myId,
  onSaveReview,
  onOpen,
  onStatus,
  onDeferAll,
  onStatusAll,
  onNew,
  onPlanWeek,
  garments = NO_GARMENTS,
  wears = NO_WEARS,
  onOpenWardrobe,
}: Props) {
  const [period, setPeriod] = useState<Period>('week')
  const [anchor, setAnchor] = useState(() => defaultReviewAnchor(new Date()))
  const now = useNow()
  // today from the same clock: a day read as the page draws would be kept by
  // the React Compiler for as long as the page stays up
  const todayKey = localDayKey(now)
  const range = useMemo(() => rangeFor(period, anchor), [period, anchor])
  // on the clock, not only on the records: at midnight what was due yesterday
  // becomes overdue here, and the bulk buttons below move exactly that list
  const data: ReviewData = useMemo(() => buildReview(range, tasks, projects, people, new Date(now), places, entries, myId), [range, tasks, projects, people, now, places, entries, myId])
  // what you wore in the period, counted in days as the Stats are: each day's
  // look, and the piece worn on the most of them
  const pieces = useMemo(() => liveById(garments), [garments])
  const worn = useMemo(() => wornBetween(garments, wearIndex(wears, todayKey), dateKey(range.start), dateKey(range.end)), [garments, wears, range, todayKey])
  const wrote = useMemo(() => entriesInRange(journal, range), [journal, range])
  const mood = moodAverage(wrote)
  const habitStats = useMemo(() => habitsConsistency(habits, range.start, range.end, noonOf(todayKey)), [habits, range, todayKey])
  const saved = reviews.find(r => r.period === period && r.key === range.key)
  const prevRange = useMemo(() => shiftRange(range, -1), [range])
  const prevSaved = reviews.find(r => r.period === period && r.key === prevRange.key)
  const [top, setTop] = useState<string[]>(() => reviewDraft(saved).top)
  const [reflections, setReflections] = useState(() => reviewDraft(saved).reflections)
  const [summary, setSummary] = useState(() => reviewDraft(saved).summary)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [summaryOpen, setSummaryOpen] = useState(storedSummaryOpen)
  const toggleSummary = () => {
    const next = !summaryOpen
    setSummaryOpen(next)
    storeSummaryOpen(next)
  }

  // The drafts follow the saved review: to another week or month, and when the
  // record changes from outside — Plan next week, its Undo, a sync. Kept, a
  // stale draft would be saved back over it on the next blur. Never after this
  // page's own save, which would trim what is being typed.
  const ownStamp = useRef<string | null>(null)
  const loaded = useRef({ key: range.key, stamp: saved?.updatedAt })
  // when the period or the saved copy's stamp moves: an effect event, so a
  // new copy of the same record is no reason to look again
  const followSaved = useEffectEvent(() => {
    const next = { key: range.key, stamp: saved?.updatedAt }
    if (reloadDraft(loaded.current, next, ownStamp.current)) {
      const d = reviewDraft(saved)
      setTop(d.top)
      setReflections(d.reflections)
      setSummary(d.summary)
    }
    loaded.current = next
  })
  useEffect(() => followSaved(), [range.key, saved?.updatedAt])

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

  // No `finally`, and the lines put together out of the component
  // (summaryInput): the React Compiler leaves a component with either a
  // finally or a choice inside a try as written. The catch only sets state,
  // so the line after it runs however the ask ended.
  const generate = async () => {
    setBusy(true)
    setError('')
    try {
      const text = await summarizeReview(summaryInput({ period, label: range.label, data, habitStats, reflections, prevSaved, wrote, people }))
      setSummary(text)
      persist({ summary: text })
      // asking for one is asking to read it, so a card shut earlier opens
      if (!summaryOpen) toggleSummary()
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  const isCurrent = range.end.getTime() > now && range.start.getTime() <= now
  const endOfNext = (() => {
    const d = new Date(range.end)
    d.setDate(d.getDate() + (period === 'week' ? 6 : 27))
    d.setHours(17, 0, 0, 0)
    return d.toISOString()
  })()

  return (
    <div className="insights review">
      {/* Three rows, not one of eight children. At 402pt that single row wrapped
          into a shape where ‹ sat above the title and › beside it, the range
          ran off the line, and the two actions landed wherever there was
          space. What you are looking at, then how to move it, then what you
          can do with it (v3.28). */}
      <div className="people-tab-seg review-period">
        <span className="segmented" role="tablist" aria-label="Week or month">
          <button type="button" role="tab" aria-selected={period === 'week'} className={period === 'week' ? 'seg on' : 'seg'} onClick={() => setPeriod('week')}>
            Week
          </button>
          <button type="button" role="tab" aria-selected={period === 'month'} className={period === 'month' ? 'seg on' : 'seg'} onClick={() => setPeriod('month')}>
            Month
          </button>
        </span>
      </div>
      <div className="period-bar review-range">
        <button className="btn" onClick={() => setAnchor(shiftRange(range, -1).start)} aria-label="Previous">
          ‹
        </button>
        <h2 className="period-label">
          {range.label} {isCurrent && <small className="muted">(so far)</small>}
        </h2>
        <button className="btn" onClick={() => setAnchor(shiftRange(range, 1).start)} aria-label="Next">
          ›
        </button>
        {!isCurrent && (
          <button className="btn period-end" onClick={() => setAnchor(new Date())}>
            This {period}
          </button>
        )}
      </div>
      <div className="toolbar review-actions">
        {onPlanWeek && (
          <button className={planWeekIsPrimary(new Date(now)) ? 'btn primary' : 'btn'} onClick={onPlanWeek}>
            Plan next week
          </button>
        )}
        <button className="btn" disabled={busy} onClick={generate}>
          {busy ? 'Writing…' : summary ? '✨ Rewrite summary' : '✨ Write my summary'}
        </button>
      </div>
      {/* under the button that asked, not in the summary card: that sits below
          last week's Top 3 and the figures, a screen or two down on a phone,
          and a summary already written stays readable there */}
      {error && (
        <p className="warn" role="alert">
          {error}
        </p>
      )}

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
                  <input type="checkbox" className="tcheck" checked={!!prevSaved.topDone?.[i]} onChange={() => togglePrevTop(i)} aria-label={`Kept “${line}”`} />
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
        <StatTile label="People seen" value={String(data.people.length)} sub={seenLabel(data.seen.days, data.seen.events)} />
        {wrote.length > 0 && <StatTile label="Journal" value={String(wrote.length)} sub={mood ? `days written · mood ${mood}/5` : 'days written'} />}
      </div>

      {summary && (
        <section className="chart-card review-summary">
          <header className="chart-head">
            <div>
              <h3>Summary</h3>
              <p className="chart-sub">
                {summaryOpen
                  ? "Written by the model from this period's data and your reflections"
                  : `${wordCount(summary)} ${wordCount(summary) === 1 ? 'word' : 'words'}, hidden`}
              </p>
            </div>
            {/* a summary is long, and on a phone it pushes everything the
                period actually holds off the screen */}
            <button type="button" className="btn subtle review-summary-toggle" aria-expanded={summaryOpen} onClick={toggleSummary}>
              {summaryOpen ? 'Hide' : 'Show'}
            </button>
          </header>
          {summaryOpen && <div className="review-summary-text">{summary}</div>}
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
          <ReviewDays counts={data.doneByDay} start={data.range.start} />
          <TaskList tasks={data.done} onOpen={onOpen} />
        </section>

        <section className={data.overdueNow.length > 0 ? 'chart-card warn-card' : 'chart-card'}>
          <header className="chart-head">
            <div>
              <h3>Slipped &amp; overdue</h3>
              <p className="chart-sub">Decide once: push to next week, or let it go</p>
            </div>
            {/* Home's Overdue, no more (review.ts overdueNow): a task due today,
                with no time or a time gone by, is not swept to Monday */}
            {data.overdueNow.length > 0 && (
              <div className="review-bulk">
                <button className="btn" onClick={() => onDeferAll(data.overdueNow.map(t => t.id), nextMonday(new Date()))}>
                  Push all to Monday
                </button>
                <button className="btn subtle" onClick={() => onStatusAll(data.overdueNow.map(t => t.id), 'wishlist')}>
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
                  <span className="seen-count">
                    <strong>{countOf(p.days, 'day')}</strong>
                    {p.visits.length !== p.days && <small>{countOf(p.visits.length, 'event')}</small>}
                  </span>
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

        {onOpenWardrobe && worn.days.length > 0 && (
          <section className="chart-card review-wardrobe">
            <header className="chart-head">
              <div>
                <h3>What you wore</h3>
                <p className="chart-sub">
                  {countOf(worn.days.length, 'day')} logged this {period}
                </p>
              </div>
            </header>
            <ul className="review-looks">
              {worn.days.map(({ day, look, looks }) => (
                <li key={day}>
                  <button
                    type="button"
                    className="review-look"
                    aria-label={`${relativeDayLabel(day, todayKey)}: ${outfitLabel(look.garmentIds, pieces)}${looks > 1 ? `, and ${countOf(looks - 1, 'more look')}` : ''}`}
                    onClick={() => onOpenWardrobe({ date: day })}
                  >
                    <Collage ids={look.garmentIds} byId={pieces} />
                    <span>{lookDay(day, period === 'month')}</span>
                  </button>
                </li>
              ))}
            </ul>
            {worn.top && (
              <button type="button" className="review-most-worn" onClick={() => worn.top && onOpenWardrobe({ tab: 'clothes', garmentId: worn.top.garment.id })}>
                <GarmentPhoto garment={worn.top.garment} className="thumb-28" />
                <span className="review-most-worn-name">
                  <span className="muted">Most worn</span> {worn.top.garment.name}
                </span>
                <strong>{countOf(worn.top.days, 'day')}</strong>
              </button>
            )}
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
                    <span className="dash-reason">{relativeDayLabel(e.date, todayKey)}</span>
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
              <strong>{formatMoney(data.costs.actual)}</strong> spent
              {data.costs.estimate > 0 && <small className="muted"> vs {formatMoney(data.costs.estimate)} estimated</small>}
            </p>
          </section>
        )}
      </div>
    </div>
  )
}
