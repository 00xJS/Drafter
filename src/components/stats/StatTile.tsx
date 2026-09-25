import type { ReactNode } from 'react'
import { countOf } from '../../people'

/**
 * A counter. Pass `onJump` and it becomes a real button that takes you to
 * whatever it is counting. Omit the prop entirely and it is an inert div,
 * because a tile that never scrolls anywhere must not look or feel pressable —
 * that is every tile on Review and in the journal's stats.
 *
 * `null` is the third state, and the reason the prop is nullable: Today's KPI
 * tiles gain and lose their target as tasks are completed, deferred or synced
 * in, and swapping the ELEMENT under a focused tile drops a keyboard user to
 * the top of the document mid-task. So those stay one button whose target may
 * be missing, dressed and announced as unavailable while it is.
 */
export function StatTile({
  label,
  value,
  sub,
  warn,
  className,
  onJump,
  trend,
}: {
  label: string
  value: string
  sub?: string
  warn?: boolean
  className?: string
  onJump?: (() => void) | null
  /** Its change on the period before (a DeltaBadge), under the figure. */
  trend?: ReactNode
}) {
  const body = (
    <>
      <div className="stat-label">{label}</div>
      <div className={warn ? 'stat-value stat-warn' : 'stat-value'}>{value}</div>
      {trend && <div className="stat-trend">{trend}</div>}
      {sub && <div className="stat-sub">{sub}</div>}
    </>
  )
  const cls = `stat-tile${className ? ` ${className}` : ''}`
  if (onJump === undefined) return <div className={cls}>{body}</div>
  return (
    <button
      type="button"
      className={`${cls} stat-jump`}
      onClick={onJump ?? undefined}
      // not `disabled`: disabling a focused button is itself what moves focus
      // to <body>, which is the thing this is here to avoid
      aria-disabled={onJump ? undefined : true}
      title={onJump ? `Go to ${label}` : undefined}
    >
      {body}
    </button>
  )
}

/** The streak tiles' lines: the run's while today counts, while today waits, and with no run; and the best's. */
export interface StreakWords {
  today: string
  waiting: string
  none: string
  best: string
}

/** The wardrobe's words, in days logged: what the tiles say unless told otherwise. */
const LOGGED: StreakWords = {
  today: 'logged in a row, today too',
  waiting: 'log today to keep it going',
  none: 'log a day to start one',
  best: 'logged in a row',
}

/**
 * Streak and Best streak, as two tiles for a kpi-row: the run reaching today
 * and the longest there has been (dayStreaks), in days or another `noun`.
 * Today waits rather than breaks a run, so until `today` counts, the run's
 * line asks for it.
 */
export function StreakTiles({ current, best, today, noun = 'day', words }: { current: number; best: number; today: boolean; noun?: string; words?: Partial<StreakWords> }) {
  const w = { ...LOGGED, ...words }
  return (
    <>
      <StatTile label="Streak" value={countOf(current, noun)} sub={today ? w.today : current > 0 ? w.waiting : w.none} />
      <StatTile label="Best streak" value={countOf(best, noun)} sub={w.best} />
    </>
  )
}
