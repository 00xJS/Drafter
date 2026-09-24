import { shiftDayKey } from '../../journal'
import { shortDay } from '../../kitchen'
import type { Wear } from '../../types'
import { Icon } from '../Icon'
import { dayLetter, dayMark, dayNumber, weekOf, weekRange, type DayMark } from './board'

interface Props {
  /** The day being dressed: the strip is its week, and it is the day chosen. */
  day: string
  todayKey: string
  /** The last day a look can be planned for: none after it can be chosen. */
  lastDay: string
  /** Every look, worn or planned: each day's mark. */
  wears: readonly Wear[]
  /** "Today · Mon 14 Sep": the date field's name. */
  dayName: string
  onDay(day: string): void
}

const MARK_WORDS: Record<Exclude<DayMark, null>, string> = { logged: 'a look worn', planned: 'a look planned' }

/**
 * The week being dressed, Sunday to Saturday, under a period bar: ‹ and › a
 * week either way, and the week between them, with the date field over it for
 * any day at all. Each day has its letter and its date, a dot once a look was
 * worn and a ring while it holds a plan; today is marked, the day being
 * dressed is chosen, and a day past the last one a plan can be made for
 * cannot be.
 */
export function WeekStrip({ day, todayKey, lastDay, wears, dayName, onDay }: Props) {
  const days = weekOf(day)
  const later = shiftDayKey(day, 7)
  return (
    <div className="wardrobe-week">
      <div className="period-bar wardrobe-week-head">
        <button type="button" className="btn wardrobe-step" aria-label="The week before" onClick={() => onDay(shiftDayKey(day, -7))}>
          ‹
        </button>
        <span className="period-label wardrobe-day-pick">
          <span aria-hidden="true">{weekRange(days, todayKey)}</span>
          <Icon name="chevron" size={14} />
          <input
            type="date"
            max={lastDay}
            value={day}
            aria-label={`Day: ${dayName}`}
            onChange={e => {
              const v = e.target.value
              // a year ahead at most: a plan, not a diary
              if (/^\d{4}-\d{2}-\d{2}$/.test(v) && v <= lastDay) onDay(v)
            }}
            onClick={e => {
              try {
                e.currentTarget.showPicker()
              } catch {
                /* the browser opens its own, or has none to show */
              }
            }}
          />
        </span>
        <button type="button" className="btn wardrobe-step" aria-label="The week after" disabled={days[6] >= lastDay} onClick={() => onDay(later <= lastDay ? later : lastDay)}>
          ›
        </button>
      </div>
      <div className="wardrobe-week-days" role="group" aria-label="Days of the week">
        {days.map(d => {
          const mark = dayMark(wears, d)
          const classes = ['week-strip-day', 'wardrobe-week-day', d === todayKey ? 'today' : '', d === day ? 'picked' : ''].filter(Boolean).join(' ')
          return (
            <button
              key={d}
              type="button"
              className={classes}
              aria-pressed={d === day}
              aria-current={d === todayKey ? 'date' : undefined}
              aria-label={`${shortDay(d, todayKey)}${d === todayKey ? ', today' : ''}${mark ? `: ${MARK_WORDS[mark]}` : ''}`}
              disabled={d > lastDay}
              onClick={() => onDay(d)}
            >
              <span className="wardrobe-week-letter" aria-hidden="true">
                {dayLetter(d)}
              </span>
              <span className="wardrobe-week-num" aria-hidden="true">
                {dayNumber(d)}
              </span>
              <span className={mark ? `wardrobe-week-mark ${mark}` : 'wardrobe-week-mark'} aria-hidden="true" />
            </button>
          )
        })}
      </div>
    </div>
  )
}
