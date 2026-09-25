import type { ReactNode } from 'react'
import { stripDayWords, type StripDay, type Tonight, type UpNext } from '../../homeweek'
import { fmtTime, spokenDay } from '../../utils'
import { Icon } from '../Icon'

/** A day's letter: S M T W T F S, as the Kitchen's week strip says them. */
const letterOf = (key: string): string => new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { weekday: 'narrow' })

/**
 * The week on Home, Sunday first as the Kitchen's strip has it: each day's
 * date with a dot under it for each kind of thing on it — tasks due, meals
 * planned, events — in its area's colour, and today filled. A day opens on
 * the Calendar, its day sheet up.
 */
export function HomeWeekStrip({ days, todayKey, onOpenDay }: { days: readonly StripDay[]; todayKey: string; onOpenDay?(key: string): void }) {
  return (
    <nav className="home-week" aria-label="This week">
      {days.map(d => {
        const today = d.key === todayKey
        const body = (
          <>
            <span className="home-week-dow" aria-hidden="true">
              {letterOf(d.key)}
            </span>
            <span className="home-week-num" aria-hidden="true">
              {Number(d.key.slice(8, 10))}
            </span>
            <span className="home-week-dots" aria-hidden="true">
              {d.tasks > 0 && <i className="ink-tasks" />}
              {d.meals > 0 && <i className="ink-kitchen" />}
              {d.events > 0 && <i className="home-dot-event" />}
            </span>
          </>
        )
        const label = `${today ? 'Today, ' : ''}${spokenDay(d.key)}: ${stripDayWords(d)}`
        const cls = 'home-week-day' + (today ? ' today' : '') + (d.key < todayKey ? ' past' : '')
        return onOpenDay ? (
          <button key={d.key} type="button" className={cls} aria-label={label} aria-current={today ? 'date' : undefined} onClick={() => onOpenDay(d.key)}>
            {body}
          </button>
        ) : (
          <span key={d.key} className={cls} role="img" aria-label={label}>
            {body}
          </span>
        )
      })}
    </nav>
  )
}

/** One of the two tiles under Today's focus: what it is about, the thing, and a line on it; the whole tile a button. */
function Tile({ label, mark, value, sub, onOpen, className = '' }: { label: string; mark: ReactNode; value: string; sub: string; onOpen?(): void; className?: string }) {
  const body = (
    <>
      <span className="home-tile-label">
        <span className="home-tile-mark" aria-hidden="true">
          {mark}
        </span>
        {label}
      </span>
      <span className="home-tile-value">{value}</span>
      <span className="home-tile-sub">{sub}</span>
    </>
  )
  return onOpen ? (
    <button type="button" className={`home-tile ${className}`} onClick={onOpen}>
      {body}
    </button>
  ) : (
    <div className={`home-tile ${className}`}>{body}</div>
  )
}

/**
 * Dinner and Up next, side by side under Today's focus. Dinner is tonight's
 * plan — what it is, and who it is for and who cooks ("Both of you · Maria
 * cooks") — or Plan dinner, and opens the Kitchen's This week on today. Up
 * next is the next timed thing today, or tomorrow's first, with its time, and
 * opens it; with nothing timed it opens the Calendar on today.
 */
export function HomeTiles({
  tonight,
  who,
  next,
  onOpenDinner,
  onOpenNext,
}: {
  tonight: Tonight | null
  /** mealWho's words for tonight's plan: who it is for, who cooks. '' when there is nothing to say. */
  who: string
  next: UpNext | null
  onOpenDinner?(): void
  onOpenNext?(): void
}) {
  const nextSub = next ? `${next.tomorrow ? 'Tomorrow · ' : ''}${fmtTime(next.at)}` : 'Nothing timed today or tomorrow'
  return (
    <div className="home-tiles">
      <Tile
        className="home-tile-dinner"
        label="Dinner"
        mark={tonight?.mark ?? '🍽️'}
        value={tonight ? tonight.label : 'Plan dinner'}
        sub={tonight ? who || 'Tonight' : 'Nothing planned yet'}
        onOpen={onOpenDinner}
      />
      <Tile
        className="home-tile-next"
        label="Up next"
        mark={<Icon name={next?.kind === 'task' ? 'checkbox' : 'calendar'} size={14} />}
        value={next ? next.title : 'All clear'}
        sub={nextSub}
        onOpen={onOpenNext}
      />
    </div>
  )
}
