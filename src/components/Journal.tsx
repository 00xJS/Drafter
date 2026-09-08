import { RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { JournalEntry, MOODS, MOOD_META, Mood, Person } from '../types'
import { newerStamp } from '../itemops'
import {
  MoodSeries,
  dayLabel,
  entriesOn,
  entryOn,
  idSet,
  journalDays,
  localDayKey,
  moodAverage,
  moodSeries,
  newEntry,
  peopleOf,
  recentEntries,
  relativeDayLabel,
  samePeople,
  shiftDayKey,
  streak,
} from '../journal'
import { excerpt } from '../utils'
import { ConfirmButton } from './ConfirmButton'
import { StatTile } from './bits'

/** How long after the last keystroke an entry is written. Blur and unmount write at once. */
const SAVE_DELAY = 700

/** What the editor holds for a day; compared field by field to decide whether a remote edit may be adopted. */
interface Draft {
  body: string
  mood?: Mood
  peopleIds: string[]
}

const draftOf = (entry?: JournalEntry): Draft => ({ body: entry?.body ?? '', mood: entry?.mood, peopleIds: entry?.peopleIds ?? [] })
const sameDraft = (a: Draft, b: Draft) => a.body === b.body && a.mood === b.mood && samePeople(a.peopleIds, b.peopleIds)

/** Small round faces for the people an entry names (Today does the same for occasions). */
export function JournalPeople({ entry, people }: { entry: Pick<JournalEntry, 'peopleIds'>; people: Person[] }) {
  const who = peopleOf(entry, people)
  if (who.length === 0) return null
  return (
    <span className="journal-avatars" aria-label={`With ${who.map(p => p.name).join(', ')}`}>
      {who.map(p => (
        <span key={p.id} className="person-avatar small" style={{ background: p.color }} title={p.name}>
          {p.emoji ?? p.name.slice(0, 1).toUpperCase()}
        </span>
      ))}
    </span>
  )
}

interface EditorProps {
  /** The day's current entry, if any. */
  entry?: JournalEntry
  /** YYYY-MM-DD the editor writes into. */
  date: string
  /** Everyone who can be tagged as "who this day was about". */
  people: Person[]
  onSave(e: JournalEntry): void
  /** Clearing every word (and the mood, and the people) removes the entry instead of saving a blank one. */
  onDelete?(id: string): void
  autoFocus?: boolean
  placeholder?: string
  rows?: number
  /** Show a "Delete entry" control (full journal page only). */
  showDelete?: boolean
  /** Start with the whole people list showing (journal page); Today's card keeps it behind "+ Who". */
  peopleOpen?: boolean
}

/**
 * A textarea, five faces and a row of people that autosave into one day's
 * entry. Typing never creates more than one record: the entry made here is
 * remembered until the store echoes it back, and an edit arriving from
 * another device is adopted only while nothing is being typed.
 */
export function JournalEditor({ entry, date, people, onSave, onDelete, autoFocus, placeholder, rows = 3, showDelete, peopleOpen }: EditorProps) {
  const [body, setBody] = useState(entry?.body ?? '')
  const [mood, setMood] = useState<Mood | undefined>(entry?.mood)
  const [peopleIds, setPeopleIds] = useState<string[]>(entry?.peopleIds ?? [])
  const [showPeople, setShowPeople] = useState(!!peopleOpen)
  const latest = useRef<Draft>({ body, mood, peopleIds })
  latest.current = { body, mood, peopleIds }
  const created = useRef<JournalEntry | null>(null)
  const seen = useRef<Draft>(draftOf(entry))
  const timer = useRef<number | undefined>(undefined)
  const [savedAt, setSavedAt] = useState<string | undefined>(entry?.updatedAt)

  /** The id this editor just removed; a stale commit for it must not remove it twice. */
  const deletedId = useRef<string | null>(null)

  useEffect(() => {
    const cur = latest.current
    const prev = seen.current
    const remote = draftOf(entry)
    const dirty = !sameDraft(cur, prev)
    if (!dirty || !entry) {
      setBody(remote.body)
      setMood(remote.mood)
      setPeopleIds(remote.peopleIds)
    } else {
      // Typing while a change lands from elsewhere (another device, a Shortcut,
      // an agent): keep what was typed here, take every field that was not
      // touched here, and carry an appended line along instead of overwriting it.
      if (cur.mood === prev.mood && remote.mood !== prev.mood) setMood(remote.mood)
      if (samePeople(cur.peopleIds, prev.peopleIds) && !samePeople(remote.peopleIds, prev.peopleIds)) setPeopleIds(remote.peopleIds)
      if (cur.body === prev.body) {
        setBody(remote.body)
      } else if (remote.body !== prev.body) {
        const known = prev.body.replace(/\s+$/, '')
        const added = remote.body.startsWith(known) ? remote.body.slice(known.length) : ''
        if (added.trim() && !cur.body.includes(added.trim())) {
          // appendEntry writes a bare line when the day was blank; keep the two texts on separate lines
          const base = cur.body.replace(/\s+$/, '')
          setBody(base + (base && !/^\s*\n/.test(added) ? '\n' : '') + added)
          window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => commitRef.current(), SAVE_DELAY)
        }
      }
    }
    seen.current = remote
    if (entry) {
      created.current = null
      // any live entry reaching here (a new id, or the deleted one restored) may be edited again
      deletedId.current = null
      setSavedAt(entry.updatedAt)
    }
  }, [entry, date])

  const commit = () => {
    window.clearTimeout(timer.current)
    const { body, mood, peopleIds } = latest.current
    const ids = idSet(peopleIds) // never store an empty array
    const blank = !body.trim() && mood === undefined && !ids
    const cur = entry ?? created.current ?? undefined
    if (cur && cur.id === deletedId.current) return
    if (!cur) {
      if (blank) return
      const next = newEntry(date, body, mood, ids)
      created.current = next
      seen.current = { body, mood, peopleIds }
      setSavedAt(next.updatedAt)
      onSave(next)
      return
    }
    if (cur.body === body && cur.mood === mood && samePeople(cur.peopleIds, ids)) return
    if (blank && onDelete) {
      created.current = null
      deletedId.current = cur.id
      seen.current = { body: '', mood: undefined, peopleIds: [] }
      onDelete(cur.id)
      return
    }
    const next: JournalEntry = { ...cur, body, mood, peopleIds: ids, updatedAt: newerStamp(cur.updatedAt) }
    if (!entry) created.current = next
    seen.current = { body, mood, peopleIds }
    setSavedAt(next.updatedAt)
    onSave(next)
  }
  const commitRef = useRef(commit)
  commitRef.current = commit
  useEffect(() => () => commitRef.current(), [])

  const schedule = () => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => commitRef.current(), SAVE_DELAY)
  }

  const togglePerson = (id: string) => {
    setPeopleIds(cur => (cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]))
    // state updates after this tick; write on the next one (same as the mood chips)
    window.setTimeout(() => commitRef.current(), 0)
  }
  const selected = peopleOf({ peopleIds }, people)
  const peopleShown = showPeople ? people : selected

  return (
    <div className="journal-editor">
      <div className="mood-row" role="radiogroup" aria-label="How was the day">
        {MOODS.map(m => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mood === m}
            className={mood === m ? 'mood-chip on' : 'mood-chip'}
            title={MOOD_META[m].label}
            onClick={() => {
              setMood(cur => (cur === m ? undefined : m))
              // state updates after this tick; write on the next one
              window.setTimeout(() => commitRef.current(), 0)
            }}
          >
            {MOOD_META[m].emoji}
          </button>
        ))}
        {mood && <small className="muted">{MOOD_META[mood].label}</small>}
      </div>
      <textarea
        rows={rows}
        value={body}
        placeholder={placeholder ?? 'What happened, what you noticed, what you want to remember…'}
        autoFocus={autoFocus}
        onChange={e => {
          setBody(e.target.value)
          schedule()
        }}
        onBlur={() => commitRef.current()}
      />
      {people.length > 0 && (
        <div className="journal-people" aria-label="Who was this day about">
          {showPeople && <small className="muted">Who was this day about?</small>}
          <div className="platform-toggles">
            {peopleShown.map(p => (
              <button
                key={p.id}
                type="button"
                className={peopleIds.includes(p.id) ? 'toggle on' : 'toggle'}
                aria-pressed={peopleIds.includes(p.id)}
                onClick={() => togglePerson(p.id)}
              >
                {p.emoji ? `${p.emoji} ` : ''}
                {p.name}
              </button>
            ))}
            <button type="button" className="btn subtle" onClick={() => setShowPeople(v => !v)} aria-expanded={showPeople}>
              {showPeople ? 'Hide' : '+ Who'}
            </button>
          </div>
        </div>
      )}
      <div className="journal-editor-foot">
        {showDelete && (entry ?? created.current) && onDelete && (
          <ConfirmButton
            className="btn subtle danger"
            confirmLabel="Click again to delete"
            onConfirm={() => {
              window.clearTimeout(timer.current)
              const id = (entry ?? created.current)!.id
              created.current = null
              deletedId.current = id
              seen.current = { body: '', mood: undefined, peopleIds: [] }
              setBody('')
              setMood(undefined)
              setPeopleIds([])
              onDelete(id)
            }}
          >
            Delete entry
          </ConfirmButton>
        )}
        <small className="muted">{savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : 'Saves as you type'}</small>
      </div>
    </div>
  )
}

/** Today's card: write today, glance at yesterday, see the streak. */
export function JournalCard({
  entries,
  people,
  onSave,
  onDelete,
  onOpenAll,
}: {
  entries: JournalEntry[]
  people: Person[]
  onSave(e: JournalEntry): void
  onDelete?(id: string): void
  onOpenAll(): void
}) {
  const today = localDayKey()
  const entry = entryOn(entries, today)
  const yesterday = entryOn(entries, shiftDayKey(today, -1))
  const run = streak(entries, today)
  const sub = entry
    ? run > 1
      ? `${run} days in a row`
      : 'Written today'
    : run > 0
      ? `How did today go? ${run} day${run === 1 ? '' : 's'} in a row so far`
      : 'How did today go? A line is enough.'
  return (
    <section className="chart-card journal-card">
      <header className="chart-head">
        <div>
          <h3>Journal</h3>
          <p className="chart-sub">{sub}</p>
        </div>
        <button className="btn subtle" onClick={onOpenAll}>
          All entries
        </button>
      </header>
      <JournalEditor entry={entry} date={today} people={people} onSave={onSave} onDelete={onDelete} rows={2} placeholder="A line about today…" />
      {yesterday && (yesterday.body.trim() || yesterday.mood) && (
        <p className="journal-yesterday" onClick={onOpenAll} title="Open the journal">
          <span className="muted">Yesterday </span>
          {yesterday.mood ? `${MOOD_META[yesterday.mood].emoji} ` : ''}
          {excerpt(yesterday.body, 140) || MOOD_META[yesterday.mood!].label}
        </p>
      )}
    </section>
  )
}

/** Geometry of the mood chart in CSS pixels (the viewBox follows the card's width, so units are pixels). The right gutter holds the end labels. */
const MOOD_CHART = { h: 150, top: 10, right: 46, bottom: 20, left: 6, minW: 240 }
const px = (n: number) => Math.round(n * 10) / 10

/** The width of an element, tracked as it resizes; starts at `initial` until the element is measured. */
function useWidth<T extends HTMLElement>(initial: number): [RefObject<T>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(initial)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setWidth(Math.max(MOOD_CHART.minW, Math.round(el.clientWidth) || initial))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [initial])
  return [ref, width]
}

/** Column opacity steps with the mood: 1 = 0.35 up to 5 = 1. */
const moodOpacity = (m: Mood) => 0.35 + ((m - 1) * 0.65) / 4

/**
 * Twelve weeks of moods: one thin column a day on a single 1..5 scale, a
 * weekly-average marker per Sunday-start week joined by a thin line, month
 * labels where the month changes. Inline SVG; every colour is a token or
 * currentColor so both themes read the same. `summary` is the aria-label.
 */
export function MoodChart({ series, summary }: { series: MoodSeries; summary: string }) {
  const { days, weekly } = series
  const { h, top, right, bottom, left } = MOOD_CHART
  const [box, w] = useWidth<HTMLDivElement>(600)
  const plotW = w - left - right
  const plotH = h - top - bottom
  const slot = plotW / Math.max(1, days.length)
  const bar = Math.max(1.5, Math.min(6, slot * 0.6))
  const r = Math.min(2, bar / 2)
  const y = (v: number) => top + ((5 - v) / 5) * plotH
  const base = px(y(0))
  const xc = (i: number) => left + slot * (i + 0.5)
  // a column grows from the baseline and only its data end is rounded
  const column = (i: number, m: Mood) => {
    const x0 = px(xc(i) - bar / 2)
    const x1 = px(x0 + bar)
    const y0 = px(y(m))
    return `M${x0},${base} V${px(y0 + r)} Q${x0},${y0} ${px(x0 + r)},${y0} H${px(x1 - r)} Q${x1},${y0} ${x1},${px(y0 + r)} V${base} Z`
  }
  const markers = weekly.flatMap(wk => {
    if (wk.avg === undefined) return []
    const last = shiftDayKey(wk.start, 6)
    const idx = days.map((d, i) => (d.date >= wk.start && d.date <= last ? i : -1)).filter(i => i >= 0)
    if (idx.length === 0) return []
    return [{ start: wk.start, avg: wk.avg, count: wk.count, x: px(idx.reduce((s, i) => s + xc(i), 0) / idx.length), y: px(y(wk.avg)) }]
  })
  const months = days.flatMap((d, i) => (i > 0 && d.date.slice(0, 7) !== days[i - 1].date.slice(0, 7) ? [i] : []))
  // name the starting month too, unless the first change sits so close the labels would touch
  if (days.length > 0 && (months.length === 0 || months[0] >= 5)) months.unshift(0)
  const tip = (d: MoodSeries['days'][number]) =>
    `${dayLabel(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}: ${d.mood ? `${MOOD_META[d.mood].label} (${d.mood}/5)` : 'no mood'}`

  return (
    <div ref={box} className="mood-chart-plot">
      <svg className="mood-chart" viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={summary}>
        {MOODS.map(v => (
          <line key={v} className="mood-grid" x1={left} x2={left + plotW} y1={px(y(v))} y2={px(y(v))} />
        ))}
        <line className="mood-base" x1={left} x2={left + plotW} y1={base} y2={base} />
        <text className="mood-end" x={left + plotW + 6} y={px(y(5) + 3.5)}>
          {MOOD_META[5].label}
        </text>
        <text className="mood-end" x={left + plotW + 6} y={px(y(1) + 3.5)}>
          {MOOD_META[1].label}
        </text>
        {days.map((d, i) => (
          <g key={d.date} className="mood-day">
            <title>{tip(d)}</title>
            <rect className="mood-hit" x={px(left + slot * i)} y={top} width={px(slot)} height={plotH} />
            {d.mood ? (
              <path className="mood-col" d={column(i, d.mood)} style={{ opacity: moodOpacity(d.mood) }} />
            ) : (
              <line className="mood-tick" x1={px(xc(i))} x2={px(xc(i))} y1={px(base - 2)} y2={base} />
            )}
          </g>
        ))}
        {markers.length > 1 && <polyline className="mood-avg-line" points={markers.map(p => `${p.x},${p.y}`).join(' ')} />}
        {markers.map(p => (
          <circle key={p.start} className="mood-avg" cx={p.x} cy={p.y} r={3.5}>
            <title>{`Week of ${dayLabel(p.start, { day: 'numeric', month: 'short' })}: average ${p.avg}/5 over ${p.count} ${p.count === 1 ? 'day' : 'days'}`}</title>
          </circle>
        ))}
        {months.map(i => (
          <text key={days[i].date} className="mood-month" x={px(left + slot * i)} y={h - 5}>
            {dayLabel(days[i].date, { month: 'short' })}
          </text>
        ))}
      </svg>
    </div>
  )
}

interface ViewProps {
  entries: JournalEntry[]
  people: Person[]
  onSave(e: JournalEntry): void
  onDelete(id: string): void
  /** A day to open for editing (from search); consumed once. */
  openDate?: string | null
  onOpenDateConsumed?(): void
}

/** The journal page: today at the top, then every past day, newest first. */
export function JournalView({ entries, people, onSave, onDelete, openDate, onOpenDateConsumed }: ViewProps) {
  const today = localDayKey()
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [limit, setLimit] = useState(60)

  useEffect(() => {
    if (!openDate) return
    // the day must be on screen: drop any search, show enough of the list, then scroll to it
    setQ('')
    setEditing(openDate === today ? null : openDate)
    const idx = journalDays(entries).filter(d => d !== today).indexOf(openDate)
    if (idx >= limit) setLimit(idx + 10)
    window.setTimeout(() => document.getElementById(`journal-day-${openDate}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60)
    onOpenDateConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openDate])

  const last30 = useMemo(() => recentEntries(entries, 30, today), [entries, today])
  const avg = moodAverage(last30)
  const run = streak(entries, today)
  const thisMonth = useMemo(() => new Set(entries.filter(e => e.date.slice(0, 7) === today.slice(0, 7)).map(e => e.date)).size, [entries, today])
  const days = useMemo(() => journalDays(entries), [entries])
  const series = useMemo(() => moodSeries(entries, 12, today), [entries, today])
  const scored = series.days.filter(d => d.mood !== undefined).length
  const chartAvg = moodAverage(series.days)
  const chartSub =
    chartAvg === undefined ? 'No moods yet in this range' : `Average ${chartAvg}/5 across ${scored} ${scored === 1 ? 'entry' : 'entries'} with a mood`
  const chartSummary =
    chartAvg === undefined
      ? 'Mood over the last 12 weeks: no moods yet'
      : `Mood over the last 12 weeks: average ${chartAvg} of 5 across ${scored} ${scored === 1 ? 'entry' : 'entries'} with a mood`
  const needle = q.trim().toLowerCase()
  const shownDays = useMemo(() => {
    const matches = (e: JournalEntry) =>
      e.body.toLowerCase().includes(needle) || peopleOf(e, people).some(p => p.name.toLowerCase().includes(needle))
    return days.filter(d => d !== today).filter(d => !needle || entriesOn(entries, d).some(matches))
  }, [days, entries, needle, people, today])

  return (
    <section className="journal">
      <div className="toolbar people-toolbar">
        <div>
          <h2 className="view-title">Journal</h2>
          <p className="chart-sub">One entry a day, in your own words. Sunday's review reads it back.</p>
        </div>
        <span className="spacer" />
        <input className="search people-search" placeholder="Search entries…" value={q} onChange={e => setQ(e.target.value)} />
      </div>

      <div className="kpi-row people-kpis">
        <StatTile label="Streak" value={String(run)} sub={run === 1 ? 'day' : 'days in a row'} />
        <StatTile label="This month" value={String(thisMonth)} sub={thisMonth === 1 ? 'day written' : 'days written'} />
        <StatTile label="Mood, 30 days" value={avg ? `${avg}/5` : '—'} sub={avg ? MOOD_META[Math.round(avg) as Mood].label : 'tap a face on an entry'} />
      </div>

      <section className="chart-card mood-chart-card">
        <header className="chart-head">
          <div>
            <h3>Mood, last 12 weeks</h3>
            <p className="chart-sub">{chartSub}</p>
          </div>
        </header>
        {scored > 0 ? <MoodChart series={series} summary={chartSummary} /> : <p className="empty mood-chart-empty">Tap a face on an entry to start the chart</p>}
      </section>

      <section className="chart-card journal-card" id={`journal-day-${today}`}>
        <header className="chart-head">
          <div>
            <h3>{dayLabel(today)}</h3>
            <p className="chart-sub">Today</p>
          </div>
        </header>
        <JournalEditor entry={entryOn(entries, today)} date={today} people={people} onSave={onSave} onDelete={onDelete} showDelete peopleOpen />
      </section>

      {shownDays.length === 0 ? (
        <p className="empty">
          {needle ? 'Nothing matches.' : 'Past days will collect here. On a phone, a Shortcut can add a line from anywhere: drafter://journal?text=…'}
        </p>
      ) : (
        <ul className="journal-days">
          {shownDays.slice(0, limit).map(d => {
            const list = entriesOn(entries, d)
            const first = list[0]
            const isEditing = editing === d
            return (
              <li key={d} className="journal-day" id={`journal-day-${d}`}>
                <header className="journal-day-head">
                  <strong>{relativeDayLabel(d, today)}</strong>
                  <small className="muted">{dayLabel(d, { day: 'numeric', month: 'short', year: 'numeric' })}</small>
                  {first.mood && (
                    <span className="journal-mood" title={MOOD_META[first.mood].label}>
                      {MOOD_META[first.mood].emoji}
                    </span>
                  )}
                  <JournalPeople entry={first} people={people} />
                  <span className="spacer" />
                  <button className="btn subtle" onClick={() => setEditing(isEditing ? null : d)}>
                    {isEditing ? 'Done' : 'Edit'}
                  </button>
                </header>
                {isEditing ? (
                  <JournalEditor entry={first} date={d} people={people} onSave={onSave} onDelete={onDelete} autoFocus showDelete peopleOpen />
                ) : (
                  list.map(e => (
                    <p key={e.id} className="journal-body">
                      {e.body || (e.mood ? MOOD_META[e.mood].label : '')}
                    </p>
                  ))
                )}
              </li>
            )
          })}
        </ul>
      )}
      {shownDays.length > limit && (
        <p>
          <button className="btn" onClick={() => setLimit(l => l + 60)}>
            Show older
          </button>
        </p>
      )}
    </section>
  )
}
