import { useEffect, useRef } from 'react'
import { MONTHS } from '../../stats'
import { dateKey } from '../../utils'
import { AREA_INK } from './ink'

/**
 * A year of days as one small grid — a column per week, a row per weekday,
 * oldest week on the left and today at the right edge.
 *
 * It is here because a month calendar is the wrong shape for a habit: twelve of
 * them is twelve screens of mostly empty boxes, and the thing you actually want
 * to see — the runs and the gaps — only appears when a year fits in one glance.
 * The month calendars the areas already draw stay where they are: they carry a
 * photo or a dish per day, which this deliberately cannot.
 *
 * Nothing here is a tap target: a cell is about 12px and a finger is 44, so the
 * grid reads and the lists underneath it act. Each cell still carries its day
 * and its count as a title, and the whole grid is one labelled image.
 */
export interface HeatDay {
  key: string
  /** 0 is an empty day; anything above is drawn at its share of the busiest. */
  count: number
}

/** The days of the `weeks` whole weeks ending on the week `end` falls in, oldest first, Sunday-aligned. */
export function heatDays(end: Date, weeks: number): string[] {
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - end.getDay() - (weeks - 1) * 7)
  return Array.from({ length: weeks * 7 }, (_, i) => dateKey(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)))
}

/** `end` is the caller's clock (useDayKey, useNow): a default read here would be the day the grid first drew, kept by the React Compiler for as long as it stays up. */
export function HeatGrid({ counts, end, weeks = 53, label, noun = 'day', tone }: { counts: ReadonlyMap<string, number>; end: Date; weeks?: number; label: string; noun?: string; tone?: string }) {
  const days = heatDays(end, weeks)
  const today = dateKey(end)
  const most = Math.max(1, ...days.map(d => counts.get(d) ?? 0))
  // one label per month, at the first column that month reaches
  const ticks: { at: number; text: string }[] = []
  for (let col = 0; col < weeks; col++) {
    const month = Number(days[col * 7].slice(5, 7)) - 1
    if (ticks.length === 0 || ticks[ticks.length - 1].text !== MONTHS[month]) ticks.push({ at: col, text: MONTHS[month] })
  }
  const filled = days.filter(d => (counts.get(d) ?? 0) > 0).length
  // A year is wider than a phone, and the end of it is the part you came for,
  // so the grid opens on this week rather than on last September. Set rather
  // than animated: this is where the view starts, not somewhere it moved to.
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [weeks])
  return (
    <div className="heat-wrap">
      <div className="heat-scroll" ref={scroller}>
        <div className="heat-months" style={{ gridTemplateColumns: `repeat(${weeks}, 1fr)` }} aria-hidden>
          {ticks.map(t => (
            <span key={t.text + t.at} className="heat-month" style={{ gridColumnStart: t.at + 1 }}>
              {t.text}
            </span>
          ))}
        </div>
        <div className="heat-grid" style={{ gridTemplateColumns: `repeat(${weeks}, 1fr)` }} role="img" aria-label={`${label}: ${filled} of ${days.length} days`}>
          {days.map(day => {
            const n = counts.get(day) ?? 0
            const after = day > today
            return (
              <span
                key={day}
                className={after ? 'heat-cell ahead' : day === today ? 'heat-cell today' : 'heat-cell'}
                title={after ? day : `${day}: ${n} ${noun}${n === 1 ? '' : 's'}`}
                style={n > 0 && !after ? { background: tone ?? AREA_INK, opacity: 0.25 + 0.75 * (n / most) } : undefined}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}
