import { Fragment, RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { JournalEntry, MOODS, MOOD_META, Mood, Person } from '../types'
import { newerStamp } from '../itemops'
import {
  MoodSeries,
  SEARCH_PAGE,
  WEEKDAY_MOOD_MIN,
  WeekdayMood,
  dayLabel,
  entriesOn,
  entryOn,
  faceGroup,
  idSet,
  journalDays,
  localDayKey,
  lowestMoodWeekday,
  moodAverage,
  moodByWeekday,
  moodIndexAt,
  moodSeries,
  moodWeeksFor,
  newEntry,
  peopleNameMap,
  peopleOf,
  recentEntries,
  relativeDayLabel,
  samePeople,
  searchJournal,
  shiftDayKey,
  streak,
  weekdayLabel,
  weekdayName,
} from '../journal'
import { excerpt } from '../utils'
import { haptic } from '../native'
import { useMediaQuery } from '../useMediaQuery'
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

/**
 * Small round faces for the people an entry names (Today does the same for
 * occasions). On a phone at most three faces are drawn, then a `+N` chip: the
 * day header they sit in is a single row on a 375pt screen, and a whole
 * household of faces pushes its Edit button off the clipped page. Desktop has
 * the width, so it keeps every face. `role="img"` makes the label authoritative
 * — a bare span is `generic`, a role that may not be named, so the roster would
 * be dropped and the faces read one by one instead.
 */
export function JournalPeople({ entry, people }: { entry: Pick<JournalEntry, 'peopleIds'>; people: Person[] }) {
  const narrow = useMediaQuery('(max-width: 640px)')
  const who = peopleOf(entry, people)
  if (who.length === 0) return null
  const { shown, extra } = faceGroup(who, narrow ? 3 : who.length)
  return (
    <span className="journal-avatars" role="img" aria-label={`With ${who.map(p => p.name).join(', ')}`}>
      {shown.map(p => (
        <span key={p.id} className="person-avatar small" style={{ background: p.color }} title={p.name}>
          {p.emoji ?? p.name.slice(0, 1).toUpperCase()}
        </span>
      ))}
      {extra > 0 && (
        <span className="person-avatar small more" title={who.slice(shown.length).map(p => p.name).join(', ')}>
          +{extra}
        </span>
      )}
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

  /**
   * The box grows with what is in it. `resize: vertical` is the only other
   * affordance and WKWebView draws no handle for it, so without this the phone
   * writes into a fixed two-line slit that scrolls under its own thumb. The CSS
   * max-height caps the growth and turns the overflow back into a scroller.
   *
   * Two details keep the growth from costing anything elsewhere. The
   * measurement clears the inline height rather than setting `auto`, so the box
   * falls back to the height `rows` asked for and no inline height is written
   * at all while the text still fits — that is what leaves the desktop editor
   * exactly as tall as its `rows`. And a box that HAS grown does collapse for
   * the one layout the measurement forces; WebKit clamps the document scroll
   * while the page is briefly shorter and does not put it back, which would
   * ratchet a long entry upward on every keystroke, so the scroll offset is
   * carried across the measurement (a no-op whenever nothing clamped).
   */
  const box = useRef<HTMLTextAreaElement>(null)
  const fit = useCallback(() => {
    const el = box.current
    if (!el) return
    const top = window.scrollY
    el.style.height = ''
    // scrollHeight covers content + padding but not the border; under
    // box-sizing: border-box the height has to carry the border as well
    if (el.scrollHeight > el.clientHeight) el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`
    // `behavior: 'instant'` because the document scrolls smoothly by default
    // (styles.css) — an animated correction on every keystroke would drift the
    // page out from under the caret
    if (window.scrollY !== top) window.scrollTo({ top, behavior: 'instant' })
  }, [])
  useLayoutEffect(fit, [body, fit])
  /** A pinned height is only right for the width it was measured at: rotating the
   *  phone (and the Capacitor keyboard resize) rewraps the text, so measure again. */
  useEffect(() => {
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [fit])

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
              void haptic('light')
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
        ref={box}
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

/**
 * Geometry of the mood chart in CSS pixels (the viewBox follows the card's
 * width, so units are pixels). The right gutter holds the "Great"/"Rough" end
 * labels, which cost 46px — 14% of a 375pt card, spent on two words. Below
 * `gutterAt` the gutter shrinks to `narrowRight` and the scale moves into the
 * caption under the chart instead.
 */
const MOOD_CHART = { h: 150, top: 10, right: 46, narrowRight: 8, gutterAt: 480, bottom: 20, left: 6, minW: 240 }
/** A month label needs about this much clear run before the next one, or the two collide. */
const MONTH_LABEL_W = 26
const px = (n: number) => Math.round(n * 10) / 10

/**
 * The width of an element, tracked as it resizes; starts at `initial` until the
 * element is measured. Exported because the page reads it too: how many weeks
 * the chart covers is a function of the card it lands in, not of a breakpoint.
 * It measures `clientWidth`, which is 0 for anything inside a closed
 * collapsible — attach it to a node that is always in the DOM.
 */
export function useWidth<T extends HTMLElement>(initial: number): [RefObject<T>, number] {
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
 * A run of weeks of moods: one thin column a day on a single 1..5 scale, a
 * weekly-average marker per Sunday-start week joined by a thin line, month
 * labels where the month changes. Inline SVG; every colour is a token or
 * currentColor so both themes read the same. `summary` is the aria-label.
 *
 * Reading a value is hover on a desktop (`<title>` and the lit hit rect) and a
 * scrub on a phone, where hover does not exist: dragging along the chart moves
 * a cursor line and writes the day into the caption under it. The caption is
 * always in the DOM with a floor under it, so the first touch never pushes the
 * chart out from under the thumb.
 */
export function MoodChart({ series, summary }: { series: MoodSeries; summary: string }) {
  const { days, weekly } = series
  const { h, top, bottom, left } = MOOD_CHART
  const [box, w] = useWidth<HTMLDivElement>(600)
  const svg = useRef<SVGSVGElement>(null)
  const [picked, setPicked] = useState<number | null>(null)
  // a narrower range can arrive under a stale index (rotate, or a new entry)
  const sel = picked !== null && picked < days.length ? picked : null
  const gutter = w >= MOOD_CHART.gutterAt
  const right = gutter ? MOOD_CHART.right : MOOD_CHART.narrowRight
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
  // name the starting month too, unless the first change sits so close the
  // labels would touch. The gap is pixels, not slots: five slots is 42px on a
  // desktop and 16px at 375pt, narrower than the "Sep" it has to clear.
  if (days.length > 0 && (months.length === 0 || slot * months[0] >= MONTH_LABEL_W)) months.unshift(0)
  const tip = (d: MoodSeries['days'][number]) =>
    `${dayLabel(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}: ${d.mood ? `${MOOD_META[d.mood].label} (${d.mood}/5)` : 'no mood'}`

  /** clientX -> a day index, through the rendered width rather than the 7px per-day rects */
  const scrub = (clientX: number) => {
    const el = svg.current
    const rect = el?.getBoundingClientRect()
    if (!rect?.width) return
    setPicked(moodIndexAt(((clientX - rect.left) / rect.width) * w, left, slot, days.length))
  }
  const weekAvg = sel === null ? undefined : weekly.find(wk => days[sel].date >= wk.start && days[sel].date <= shiftDayKey(wk.start, 6))?.avg
  const scale = `${MOOD_META[5].label} at the top, ${MOOD_META[1].label} at the bottom`
  // the scale is the axis legend the narrow chart traded its gutter for, so it
  // is its own always-there caption: folding it into the readout meant the
  // first touch replaced it for good and left the chart with no legend at all
  const readout = sel === null ? '' : `${tip(days[sel])}${weekAvg === undefined ? '' : ` · week averaged ${weekAvg}/5`}`

  return (
    <div ref={box} className="mood-chart-plot">
      <svg
        ref={svg}
        className="mood-chart"
        viewBox={`0 0 ${w} ${h}`}
        width={w}
        height={h}
        role="img"
        aria-label={summary}
        onPointerDown={e => {
          // the mouse never scrubs: desktop reads the chart through <title> and
          // the hover rule, and a drag that filled the readout would grow it
          // from nothing and push the day list down for the length of the drag
          // (the caption's min-height floor is @media (pointer: coarse) only)
          if (e.pointerType === 'mouse') return
          // capture so the finger keeps steering the readout past the chart's
          // edges; the browser drops it (and stops sending moves) the moment it
          // decides the gesture is a vertical pan, which touch-action allows
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {
            /* capture is a nicety; the scrub still works without it */
          }
          scrub(e.clientX)
        }}
        onPointerMove={e => {
          if (e.pointerType === 'mouse') return
          // no capture means the touch was handed to a vertical pan: stop steering
          if (e.currentTarget.hasPointerCapture(e.pointerId)) scrub(e.clientX)
        }}
      >
        {MOODS.map(v => (
          <line key={v} className="mood-grid" x1={left} x2={left + plotW} y1={px(y(v))} y2={px(y(v))} />
        ))}
        <line className="mood-base" x1={left} x2={left + plotW} y1={base} y2={base} />
        {gutter && (
          <>
            <text className="mood-end" x={left + plotW + 6} y={px(y(5) + 3.5)}>
              {MOOD_META[5].label}
            </text>
            <text className="mood-end" x={left + plotW + 6} y={px(y(1) + 3.5)}>
              {MOOD_META[1].label}
            </text>
          </>
        )}
        {sel !== null && <line className="mood-cursor" x1={px(xc(sel))} x2={px(xc(sel))} y1={top} y2={base} />}
        {days.map((d, i) => (
          <g key={d.date} className={sel === i ? 'mood-day on' : 'mood-day'}>
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
      {!gutter && <p className="mood-scale">{scale}</p>}
      <p className="mood-readout" aria-live="polite">
        {readout}
      </p>
    </div>
  )
}

/**
 * "Which days are hard": seven bars, one per weekday, Sunday first like the
 * rest of the app's weeks. The lowest average is marked with the accent AND
 * named in the caption — a colour alone would be the only carrier of the one
 * thing this chart exists to say.
 *
 * The block is only rendered above `WEEKDAY_MOOD_MIN` moods (JournalView
 * decides); below it the same card explains why there is nothing to show.
 */
function WeekdayMoods({ days }: { days: WeekdayMood[] }) {
  const low = lowestMoodWeekday(days)
  const lowest = low === null ? undefined : days.find(d => d.weekday === low)
  return (
    <>
      <ul className="weekday-mood">
        {days.map(d => (
          <li key={d.weekday} className={d.weekday === low ? 'weekday-col low' : 'weekday-col'}>
            <span
              className="weekday-track"
              role="img"
              aria-label={`${weekdayName(d.weekday)}: ${d.avg === undefined ? 'no moods yet' : `average ${d.avg} of 5 over ${d.count} ${d.count === 1 ? 'day' : 'days'}`}`}
            >
              {d.avg !== undefined && <span className="weekday-bar" style={{ height: `${Math.round((d.avg / 5) * 100)}%` }} />}
            </span>
            <span className="weekday-value">{d.avg === undefined ? '—' : d.avg}</span>
            {/* the letters repeat (S M T W T F S), so they are decoration: the
                track above carries the day's real name for a screen reader */}
            <span className="weekday-letter" aria-hidden>
              {weekdayLabel(d.weekday)}
            </span>
          </li>
        ))}
      </ul>
      {lowest && (
        <p className="chart-sub weekday-note">
          {weekdayName(lowest.weekday)}s are your lowest, at {lowest.avg}/5.
        </p>
      )}
    </>
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

const STATS_KEY = 'drafter:journal-stats'
/**
 * Where the reader was when they last left the page. JournalView unmounts on
 * every view change, so without this "back to the journal" always means back to
 * the top of it — three weeks of thumbing away from where you were reading.
 */
let lastScrollY = 0
/**
 * How much of the list was on screen when the reader left. Restoring the offset
 * into a freshly-defaulted 60-day document just clamps to its bottom, so the
 * length has to come back with it.
 */
let lastLimit = 60

/** The journal page: today at the top, then every past day, newest first. */
export function JournalView({ entries, people, onSave, onDelete, openDate, onOpenDateConsumed }: ViewProps) {
  const today = localDayKey()
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [limit, setLimit] = useState(() => lastLimit)
  /** Results are their own list with their own paging; it starts fresh on every new query. */
  const [hitLimit, setHitLimit] = useState(SEARCH_PAGE)
  const narrow = useMediaQuery('(max-width: 640px)')
  const [statsOpen, setStatsOpen] = useState(() => {
    try {
      return localStorage.getItem(STATS_KEY) === '1'
    } catch {
      return false
    }
  })
  const toggleStats = () => {
    const next = !statsOpen
    setStatsOpen(next)
    try {
      localStorage.setItem(STATS_KEY, next ? '1' : '0')
    } catch {
      /* ignore */
    }
  }
  // the disclosure is a phone affordance: a desktop page has the room for both
  // and shows them the way it always did
  const showStats = !narrow || statsOpen

  /** True while the mount is restoring the last offset, so no scroll fights it. */
  const restored = useRef(false)

  // a layout effect, not a passive one: React runs a layout cleanup synchronously
  // in the commit that removes this page, before the browser re-lays out the
  // (much shorter) next view and clamps scrollY. A passive cleanup is scheduled
  // after that commit, so the clamping `scroll` event could still reach the
  // listener and overwrite the offset we are trying to keep.
  useLayoutEffect(() => {
    // A past day owns the scroll (the effect below scrolls to it). Today's key
    // does not: every phone route into the journal — the More sheet's row,
    // Today's card, the Review▸Journal segment, the quick action — passes it
    // just to mean "the journal", and honouring that as a target would make the
    // restore unreachable on the one device it was written for. So the restore
    // wins whenever nothing older was asked for, and today's card keeps the
    // scroll only on the first visit of a session.
    let restore = 0
    if ((!openDate || openDate === today) && lastScrollY > 0) {
      restored.current = true
      const y = lastScrollY
      // after paint, so the restored `limit` has rendered its days and the
      // document is tall enough to hold the offset; a document that is short
      // anyway is left at the top rather than pinned to its end
      restore = window.setTimeout(() => {
        // instant: putting the reader back where they were is not a journey
        if (document.documentElement.scrollHeight - window.innerHeight >= y) window.scrollTo({ top: y, behavior: 'instant' })
      }, 0)
    }
    const onScroll = () => {
      lastScrollY = window.scrollY
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      // a mount and unmount inside one task would otherwise scroll whatever
      // view replaced us to the journal's old offset
      clearTimeout(restore)
      window.removeEventListener('scroll', onScroll)
    }
    // mount and unmount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!openDate) {
      // nothing to scroll to, so nothing is deferring to the restore either
      restored.current = false
      return
    }
    // the day must be on screen: drop any search, show enough of the list, then scroll to it
    setQ('')
    setHitLimit(SEARCH_PAGE)
    setEditing(openDate === today ? null : openDate)
    const idx = journalDays(entries).filter(d => d !== today).indexOf(openDate)
    if (idx >= limit) setLimit((lastLimit = idx + 10))
    // …unless the mount above is putting the reader back where they were, which
    // only ever happens for today's key. Cleared straight away: a past day
    // opened later in this same visit is a target again.
    if (!restored.current) window.setTimeout(() => document.getElementById(`journal-day-${openDate}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60)
    restored.current = false
    onOpenDateConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openDate])

  const last30 = useMemo(() => recentEntries(entries, 30, today), [entries, today])
  const avg = moodAverage(last30)
  const run = streak(entries, today)
  const thisMonth = useMemo(() => new Set(entries.filter(e => e.date.slice(0, 7) === today.slice(0, 7)).map(e => e.date)).size, [entries, today])
  const days = useMemo(() => journalDays(entries), [entries])
  // measured on the section, which is in the DOM whether the stats are open or
  // not — the chart's own clientWidth is 0 while it is collapsed away
  const [statsBox, statsW] = useWidth<HTMLDivElement>(600)
  // the chart's plot box is narrower than the section by the card's own padding
  // (16px) and border (1px) on each side — measure the section, decide for the card
  const weeks = moodWeeksFor(statsW - 34)
  const series = useMemo(() => moodSeries(entries, weeks, today), [entries, today, weeks])
  const scored = series.days.filter(d => d.mood !== undefined).length
  const chartAvg = moodAverage(series.days)
  const chartSub =
    chartAvg === undefined
      ? `No moods yet in these ${weeks} weeks`
      : `Average ${chartAvg}/5 across ${scored} ${scored === 1 ? 'entry' : 'entries'} with a mood`
  const chartSummary =
    chartAvg === undefined
      ? `Mood over the last ${weeks} weeks: no moods yet`
      : `Mood over the last ${weeks} weeks: average ${chartAvg} of 5 across ${scored} ${scored === 1 ? 'entry' : 'entries'} with a mood`
  const weekdays = useMemo(() => moodByWeekday(entries, 26, today), [entries, today])
  const weekdayScored = weekdays.reduce((n, d) => n + d.count, 0)

  const query = q.trim()
  const shownDays = useMemo(() => days.filter(d => d !== today), [days, today])
  const peopleById = useMemo(() => peopleNameMap(people), [people])
  // `total` counts every match across every year; `hits` is only what is drawn,
  // so a diary with a decade in it still answers "how often did I write this".
  const results = useMemo(() => searchJournal(entries, query, hitLimit, peopleById), [entries, query, hitLimit, peopleById])
  const spansYears = new Set(results.hits.map(h => h.entry.date.slice(0, 4))).size > 1

  /**
   * Open a day for editing from a search result: the same path `openDate`
   * takes, minus the restore deference (this one is a tap, so it is always the
   * target). Dropping the query is what puts the day list back on screen for
   * the scroll to land in.
   */
  const openDay = (date: string) => {
    setQ('')
    setHitLimit(SEARCH_PAGE)
    setEditing(date === today ? null : date)
    const idx = shownDays.indexOf(date)
    if (idx >= limit) setLimit((lastLimit = idx + 10))
    restored.current = false
    window.setTimeout(() => document.getElementById(`journal-day-${date}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60)
  }

  return (
    <section className="journal">
      <div className="toolbar people-toolbar">
        <div>
          <h2 className="view-title">Journal</h2>
          <p className="chart-sub">One entry a day, in your own words. Sunday's review reads it back.</p>
        </div>
        <span className="spacer" />
        <input
          className="search people-search"
          placeholder="Search entries…"
          value={q}
          onChange={e => {
            setQ(e.target.value)
            setHitLimit(SEARCH_PAGE)
          }}
        />
      </div>

      <section className="chart-card journal-card" id={`journal-day-${today}`}>
        <header className="chart-head">
          <div>
            <h3>{dayLabel(today)}</h3>
            <p className="chart-sub">Today</p>
          </div>
        </header>
        {/* no peopleOpen: the whole household as chips is 100+px between the
            title and the box you came here to type in. "+ Who" is one tap. */}
        <JournalEditor entry={entryOn(entries, today)} date={today} people={people} onSave={onSave} onDelete={onDelete} showDelete />
      </section>

      <div className="journal-stats" ref={statsBox}>
        {narrow && (
          <button type="button" className="btn subtle journal-stats-toggle" aria-expanded={statsOpen} onClick={toggleStats}>
            {statsOpen ? 'Hide stats' : 'Show stats'}
          </button>
        )}
        {showStats && (
          <>
            <div className="kpi-row people-kpis">
              <StatTile label="Streak" value={String(run)} sub={run === 1 ? 'day' : 'days in a row'} />
              <StatTile label="This month" value={String(thisMonth)} sub={thisMonth === 1 ? 'day written' : 'days written'} />
              <StatTile
                label="Mood, 30 days"
                value={avg ? `${avg}/5` : '—'}
                sub={avg ? MOOD_META[Math.round(avg) as Mood].label : 'tap a face on an entry'}
              />
            </div>

            <section className="chart-card mood-chart-card">
              <header className="chart-head">
                <div>
                  <h3>Mood, last {weeks} weeks</h3>
                  <p className="chart-sub">{chartSub}</p>
                </div>
              </header>
              {scored > 0 ? (
                <MoodChart series={series} summary={chartSummary} />
              ) : (
                <p className="empty mood-chart-empty">Tap a face on an entry to start the chart</p>
              )}
            </section>

            <section className="chart-card">
              <header className="chart-head">
                <div>
                  <h3>By weekday</h3>
                  <p className="chart-sub">
                    {weekdayScored >= WEEKDAY_MOOD_MIN ? `Average mood on each day, last 26 weeks` : 'Which days are hard'}
                  </p>
                </div>
              </header>
              {weekdayScored >= WEEKDAY_MOOD_MIN ? (
                <WeekdayMoods days={weekdays} />
              ) : (
                <p className="empty weekday-empty">
                  {`${WEEKDAY_MOOD_MIN} days with a mood and this fills in — ${weekdayScored} so far. An average over three Mondays is noise, not a pattern.`}
                </p>
              )}
            </section>
          </>
        )}
      </div>

      {query ? (
        <div className="journal-results">
          <p className="journal-result-count" aria-live="polite">
            {results.total === 0
              ? `Nothing mentions ${query}`
              : `${results.total} ${results.total === 1 ? 'entry mentions' : 'entries mention'} ${query}`}
          </p>
          <ul className="journal-hits">
            {results.hits.map((hit, i) => {
              const { entry: e, before, match, after } = hit
              const year = e.date.slice(0, 4)
              // a year header only earns its row when there is more than one year to tell apart
              const newYear = spansYears && (i === 0 || results.hits[i - 1].entry.date.slice(0, 4) !== year)
              const empty = !before && !match && !after
              return (
                <Fragment key={e.id}>
                  {newYear && (
                    <li className="journal-year-head">
                      <h3 className="journal-year-title">{year}</h3>
                    </li>
                  )}
                  <li className="journal-hit">
                    <button type="button" className="journal-hit-row" onClick={() => openDay(e.date)}>
                      <span className="journal-hit-head">
                        <strong>{relativeDayLabel(e.date, today)}</strong>
                        <small className="muted">{dayLabel(e.date, { day: 'numeric', month: 'short', year: 'numeric' })}</small>
                        {e.mood && (
                          <span className="journal-mood" title={MOOD_META[e.mood].label}>
                            {MOOD_META[e.mood].emoji}
                          </span>
                        )}
                        <JournalPeople entry={e} people={people} />
                      </span>
                      {/* three plain strings and one <mark>: a journal body is the
                          last text in this app that should reach innerHTML */}
                      <span className="journal-snippet">
                        {empty ? (
                          <span className="muted">{e.mood ? MOOD_META[e.mood].label : 'No words that day'}</span>
                        ) : (
                          <>
                            {before}
                            {match && <mark>{match}</mark>}
                            {after}
                          </>
                        )}
                      </span>
                    </button>
                  </li>
                </Fragment>
              )
            })}
          </ul>
          {results.total > results.hits.length && (
            <p>
              <button className="btn" onClick={() => setHitLimit(n => n + SEARCH_PAGE)}>
                Show older
              </button>
            </p>
          )}
        </div>
      ) : shownDays.length === 0 ? (
        <p className="empty">Past days will collect here. On a phone, a Shortcut can add a line from anywhere: drafter://journal?text=…</p>
      ) : (
        <ul className="journal-days">
          {shownDays.slice(0, limit).map((d, i, list0) => {
            const list = entriesOn(entries, d)
            const first = list[0]
            const isEditing = editing === d
            // the keys are already sorted newest first, so a month starts wherever it differs from the day above
            const newMonth = i === 0 || list0[i - 1].slice(0, 7) !== d.slice(0, 7)
            return (
              <Fragment key={d}>
                {/* the <li> keeps the list's containment (and the sticky rule); the
                    heading inside it is what a reader jumping by month lands on */}
                {newMonth && (
                  <li className="journal-month-head">
                    <h3 className="journal-month-title">{dayLabel(`${d.slice(0, 7)}-01`, { month: 'long', year: 'numeric' })}</h3>
                  </li>
                )}
                <li className="journal-day" id={`journal-day-${d}`}>
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
              </Fragment>
            )
          })}
        </ul>
      )}
      {!query && shownDays.length > limit && (
        <p>
          <button className="btn" onClick={() => setLimit(l => (lastLimit = l + 60))}>
            Show older
          </button>
        </p>
      )}
    </section>
  )
}
