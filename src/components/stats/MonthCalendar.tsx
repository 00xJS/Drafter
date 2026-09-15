import { useState, type ReactNode } from 'react'
import { shortDay } from '../../kitchen'
import { MONTHS, monthGrid, shiftMonth } from '../../stats'
import { ChartCard, Stepper } from './ChartCard'

/** Its weeks run Sunday to Saturday, as the Calendar's do. */
const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

/** A day of the month as MonthCalendar draws it. */
export interface MonthDay {
  /** What the day holds, in words after its date, for a screen reader and a tooltip: "tee + jeans", "nothing logged". */
  what: string
  /** What its cell shows under the date: a collage, an avatar. */
  content?: ReactNode
  /** A class for its cell, such as has-look for a day with something on it. */
  className?: string
}

/**
 * A month as Sunday-to-Saturday weeks in a card, stepped back with ‹ and on
 * with › as far as today's month. Each day is drawn by `day` under its date,
 * today is marked, and a day still to come is dashed and inert. With `onOpen`
 * a day that has come is a button that opens it, to see it or to log one it
 * never had; without, the days are only pictures. `sub` is the line under the
 * title for the month on show (`month` 1–12).
 */
export function MonthCalendar({
  today,
  title,
  sub,
  day,
  onOpen,
  prefix = 'stats',
}: {
  /** Today's day key: the month it opens on, and the last it steps to. */
  today: string
  title: ReactNode
  sub?(year: number, month: number): ReactNode
  day(key: string): MonthDay
  onOpen?(key: string): void
  /** The class prefix its card is keyed by: the kit's own, or 'wardrobe' for the wardrobe's. */
  prefix?: string
}) {
  const thisMonth = today.slice(0, 7)
  const [month, setMonth] = useState(thisMonth)
  const [y, m] = month.split('-').map(Number)
  const name = `${MONTHS[m - 1]} ${y}`
  return (
    <ChartCard
      className={`${prefix}-photo-cal`}
      title={title}
      sub={sub?.(y, m)}
      aside={<Stepper label={name} unit="month" canNext={month < thisMonth} onStep={delta => setMonth(shiftMonth(month, delta))} />}
    >
      <div className="photo-cal-head" aria-hidden="true">
        {WEEKDAY_INITIALS.map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
      <ol className="photo-cal" aria-label={name}>
        {monthGrid(y, m).map((key, i) => {
          if (!key) return <li key={`pad-${i}`} className="photo-cal-pad" aria-hidden="true" />
          const cell = day(key)
          const come = key <= today
          const face = (
            <>
              {cell.content}
              <span className="photo-cal-num">{Number(key.slice(8))}</span>
            </>
          )
          return (
            <li key={key} className={['photo-cal-cell', cell.className ?? '', key === today ? 'today' : '', come ? '' : 'later'].filter(Boolean).join(' ')}>
              {come && onOpen ? (
                <button type="button" className="photo-cal-day" aria-label={`${shortDay(key, today)}: ${cell.what}`} onClick={() => onOpen(key)}>
                  {face}
                </button>
              ) : (
                <span className="photo-cal-day" title={come ? `${shortDay(key, today)}: ${cell.what}` : undefined}>
                  {face}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </ChartCard>
  )
}
