import { CSSProperties, Fragment, RefObject, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { scrollBehavior } from '../utils'
import { JournalEntry, MOODS, MOOD_META, Mood, Person } from '../types'
import { useDayKey } from '../useDayKey'
import {
  MoodSeries,
  SEARCH_PAGE,
  WEEKDAY_MOOD_MIN,
  WeekdayMood,
  dayLabel,
  entriesOn,
  entryOn,
  journalDays,
  journalWeek,
  lowestMoodWeekday,
  moodAverage,
  moodByWeekday,
  moodIndexAt,
  moodSeries,
  moodWeeksFor,
  peopleNameMap,
  recentEntries,
  relativeDayLabel,
  searchJournal,
  shiftDayKey,
  streak,
  weekdayLabel,
  weekdayName,
} from '../journal'
import { weekStartKey } from '../../shared/weeks.mts'
import { useMediaQuery } from '../useMediaQuery'
import { StatTile } from './bits'
import { JournalEditor, JournalPeople } from './JournalCard'

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
export function useWidth<T extends HTMLElement>(initial: number): [RefObject<T | null>, number] {
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

/** A column's mood as --mood: .mood-col steps its strength with it, from the theme's floor at 1 up to full at 5. */
const moodStyle = (m: Mood) => ({ '--mood': m }) as CSSProperties

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
              <path className="mood-col" d={column(i, d.mood)} style={moodStyle(d.mood)} />
            ) : (
              <line className="mood-tick" x1={px(xc(i))} x2={px(xc(i))} y1={px(base - 2)} y2={base} />
            )}
          </g>
        ))}
        {/* the average line runs on a casing of the card's colour, so where it
            crosses a column its ground is still the card */}
        {markers.length > 1 && <polyline className="mood-avg-casing" points={markers.map(p => `${p.x},${p.y}`).join(' ')} />}
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

// Whether the stats are open, as this device last left them. Out here: the
// React Compiler leaves a component with a choice inside a try as written.
function storedStatsOpen(): boolean {
  try {
    return localStorage.getItem(STATS_KEY) === '1'
  } catch {
    return false
  }
}

function storeStatsOpen(open: boolean): void {
  try {
    localStorage.setItem(STATS_KEY, open ? '1' : '0')
  } catch {
    /* ignore */
  }
}

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
  const today = useDayKey()
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [limit, setLimit] = useState(() => lastLimit)
  /**
   * Past days with nothing written that the reader has opened anyway. The list
   * below is built from days that have an entry, so without these there is no
   * row to put the editor in — which is why a day you skipped could not be
   * written up later. Not persisted: one that gets words joins the list on its
   * own, and one that does not is a tap away again.
   */
  const [blankDays, setBlankDays] = useState<string[]>([])
  /** Results are their own list with their own paging; it starts fresh on every new query. */
  const [hitLimit, setHitLimit] = useState(SEARCH_PAGE)
  const narrow = useMediaQuery('(max-width: 640px)')
  const [statsOpen, setStatsOpen] = useState(storedStatsOpen)
  const toggleStats = () => {
    const next = !statsOpen
    setStatsOpen(next)
    storeStatsOpen(next)
  }
  // the disclosure is a phone affordance: a desktop page has the room for both
  // and shows them the way it always did
  const showStats = !narrow || statsOpen

  /** True while the mount is restoring the last offset, so no scroll fights it. */
  const restored = useRef(false)
  /** Whether the way in names a past day, which owns the scroll: read once, as the page mounts. */
  const askedForPastDay = useEffectEvent(() => !!openDate && openDate !== today)

  // a layout effect, not a passive one: React runs a layout cleanup synchronously
  // in the commit that removes this page, before the browser re-lays out the
  // (much shorter) next view and clamps scrollY. A passive cleanup is scheduled
  // after that commit, so the clamping `scroll` event could still reach the
  // listener and overwrite the offset we are trying to keep.
  useLayoutEffect(() => {
    // A past day owns the scroll (the effect below scrolls to it). Today's key
    // does not: every phone route into the journal — Home's Journal segment,
    // Today's card, the palette's Journal, the quick action — passes it
    // just to mean "the journal", and honouring that as a target would make the
    // restore unreachable on the one device it was written for. So the restore
    // wins whenever nothing older was asked for, and today's card keeps the
    // scroll only on the first visit of a session.
    let restore = 0
    if (!askedForPastDay() && lastScrollY > 0) {
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
  }, [])

  // once per day asked for: the parent's setter an effect event, not a reason to run
  const openDateUsed = useEffectEvent(() => onOpenDateConsumed?.())
  useEffect(() => {
    if (!openDate) {
      // nothing to scroll to, so nothing is deferring to the restore either
      restored.current = false
      return
    }
    // the day is on screen by now (showDay, as it was asked for): scroll to it…
    // …unless the mount above is putting the reader back where they were, which
    // only ever happens for today's key. Cleared straight away: a past day
    // opened later in this same visit is a target again.
    if (!restored.current) window.setTimeout(() => document.getElementById(`journal-day-${openDate}`)?.scrollIntoView({ block: 'start', behavior: scrollBehavior() }), 60)
    restored.current = false
    openDateUsed()
  }, [openDate])
  // the list's length outlives the page, so a return lands on a day already drawn
  useEffect(() => {
    lastLimit = limit
  }, [limit])

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
  /**
   * Which week the strip shows. Today's, until you step off it — and then it
   * stays where you left it for the visit, the way the calendar's cursor does.
   * Before this, once Sunday came round the only way back to last Tuesday was
   * the search box or the date field.
   */
  const [weekAnchor, setWeekAnchor] = useState<string>(today)
  const week = useMemo(() => journalWeek(entries, weekAnchor), [entries, weekAnchor])
  const thisWeek = useMemo(() => weekStartKey(weekAnchor) === weekStartKey(today), [weekAnchor, today])
  const weekLabel = useMemo(() => {
    const days = week.map(d => d.date)
    const first = days[0]
    const last = days[days.length - 1]
    if (!first || !last) return ''
    const sameMonth = first.slice(0, 7) === last.slice(0, 7)
    return `${dayLabel(first, { day: 'numeric', ...(sameMonth ? {} : { month: 'short' }) })} – ${dayLabel(last, { day: 'numeric', month: 'short' })}`
  }, [week])
  const stepWeek = (delta: number) => setWeekAnchor(a => shiftDayKey(a, delta * 7))
  // a blank day that has since been written is already in `days`, so the set drops it
  const shownDays = useMemo(
    () => [...new Set([...days, ...blankDays])].filter(d => d !== today).sort((a, b) => b.localeCompare(a)),
    [days, blankDays, today],
  )
  const peopleById = useMemo(() => peopleNameMap(people), [people])
  // `total` counts every match across every year; `hits` is only what is drawn,
  // so a diary with a decade in it still answers "how often did I write this".
  const results = useMemo(() => searchJournal(entries, query, hitLimit, peopleById), [entries, query, hitLimit, peopleById])
  const spansYears = new Set(results.hits.map(h => h.entry.date.slice(0, 4))).size > 1

  /** Is anything written on that day? A day with words is opened to read, not to edit. */
  const hasWords = (date: string) => !!entryOn(entries, date)

  /**
   * The rows `date` will land among, giving it one when nothing is written
   * there yet. Today is its own card at the top and never a row.
   */
  const rowsWith = (date: string): string[] => {
    if (date === today || shownDays.includes(date)) return shownDays
    setBlankDays(ds => (ds.includes(date) ? ds : [...ds, date]))
    return [...shownDays, date].sort((a, b) => b.localeCompare(a))
  }

  /**
   * Open a day for editing — from a search result, the week strip or the date
   * picker: the same path `openDate` takes, minus the restore deference (this
   * one is a tap, so it is always the target). Dropping the query is what puts
   * the day list back on screen for the scroll to land in.
   */
  const openDay = (date: string) => {
    showDay(date)
    restored.current = false
    window.setTimeout(() => document.getElementById(`journal-day-${date}`)?.scrollIntoView({ block: 'start', behavior: scrollBehavior() }), 60)
  }

  /**
   * Put a day on screen: drop any search and show enough of the list. A day
   * with words opens to be READ (v3.24): the archive row shows the whole entry
   * as text, while the editor is a 50vh textarea with a scroller inside it,
   * which is where "I was not able to see the entire journal" came from. A
   * blank day still opens its editor, because writing it up is the only reason
   * to land on one. A link can name a day with nothing written on it
   * (drafter://journal?date=…), which needs a row like any other.
   */
  function showDay(date: string) {
    setQ('')
    setHitLimit(SEARCH_PAGE)
    setEditing(date === today || hasWords(date) ? null : date)
    const idx = rowsWith(date).indexOf(date)
    if (idx >= limit) setLimit(idx + 10)
  }

  // a day asked for from outside (Today, a link) opens as it arrives, as a tap on it would
  const asked = openDate ?? null
  const [shownFor, setShownFor] = useState<string | null>(null)
  if (asked !== shownFor) {
    setShownFor(asked)
    if (asked) showDay(asked)
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

      {/* A week, every day of it. The archive below lists only days that have
          an entry, so the day you meant to write up and didn't had no row to
          tap; these seven always do. ‹ › step whole weeks, as the calendar's
          do: once Sunday came round, last Tuesday was only reachable through
          the search box (v3.24). */}
      <section className="journal-week" aria-label={thisWeek ? 'This week' : `Week of ${weekLabel}`}>
        <div className="journal-week-nav period-bar">
          <button type="button" className="btn" onClick={() => stepWeek(-1)} aria-label="Previous week">
            ‹
          </button>
          <span className="journal-week-label period-label" aria-live="polite">
            {thisWeek ? 'This week' : weekLabel}
          </span>
          <button type="button" className="btn" onClick={() => stepWeek(1)} disabled={thisWeek} aria-label="Next week">
            ›
          </button>
          {!thisWeek && (
            <button type="button" className="btn period-end" onClick={() => setWeekAnchor(today)}>
              This week
            </button>
          )}
        </div>
        <ul className="journal-week-days">
          {week.map(d => (
            <li key={d.date}>
              <button
                type="button"
                className={`journal-week-day${d.date === today ? ' today' : ''}${d.written ? ' written' : ''}`}
                disabled={d.ahead}
                aria-current={d.date === today ? 'date' : undefined}
                aria-label={`${dayLabel(d.date)}: ${d.ahead ? 'still to come' : d.written ? (d.mood ? MOOD_META[d.mood].label : 'written') : 'nothing written'}`}
                onClick={() => openDay(d.date)}
              >
                <span className="journal-week-name" aria-hidden>
                  {dayLabel(d.date, { weekday: 'narrow' })}
                </span>
                <span className="journal-week-num" aria-hidden>
                  {dayLabel(d.date, { day: 'numeric' })}
                </span>
                <span className="journal-week-mark" aria-hidden>
                  {d.mood ? MOOD_META[d.mood].emoji : d.written ? '·' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
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
                    {first?.mood && (
                      <span className="journal-mood" title={MOOD_META[first.mood].label}>
                        {MOOD_META[first.mood].emoji}
                      </span>
                    )}
                    {first && <JournalPeople entry={first} people={people} />}
                    <span className="spacer" />
                    <button className="btn subtle" onClick={() => setEditing(isEditing ? null : d)}>
                      {isEditing ? 'Done' : first ? 'Edit' : 'Write'}
                    </button>
                  </header>
                  {isEditing ? (
                    <JournalEditor entry={first} date={d} people={people} onSave={onSave} onDelete={onDelete} autoFocus showDelete peopleOpen />
                  ) : list.length ? (
                    list.map(e => (
                      <p key={e.id} className="journal-body">
                        {e.body || (e.mood ? MOOD_META[e.mood].label : '')}
                      </p>
                    ))
                  ) : (
                    // a day opened from the week strip and then left alone
                    <p className="journal-body muted">Nothing written.</p>
                  )}
                </li>
              </Fragment>
            )
          })}
        </ul>
      )}
      {!query && shownDays.length > limit && (
        <p>
          <button className="btn" onClick={() => setLimit(l => l + 60)}>
            Show older
          </button>
        </p>
      )}
    </section>
  )
}
