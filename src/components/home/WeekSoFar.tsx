import { useMemo } from 'react'
import { insightFigures, periodSpan, pickHighlights, type Highlight, type InsightInput } from '../../../shared/insights.mts'
import { localDayKey } from '../../../shared/journal.mts'
import { useDayClock } from '../../useDayClock'
import { dateKey } from '../../utils'
import { DeltaBadge } from '../stats/DeltaBadge'
import { HighlightVisual } from '../insights/HighlightVisual'

/** The day an instant falls on, on this device's calendar: the Highlights' own reading. */
const localDayOf = (iso: string): string => localDayKey(new Date(iso))

/** What the week is counted from: the lists Insights → Stats reads, as Home holds them. */
export type WeekSoFarProps = Omit<InsightInput, 'now' | 'today' | 'dayKeyOf'> & {
  /** More than one member: the highlight counts the household's work, as the Highlights do. */
  household: boolean
  /** Insights → Stats, on the week. */
  onOpen(): void
}

/**
 * The week's first Insights highlight — "12 tasks done this week, ↑4 on last
 * week" — with its small picture, for Home. Picked by Insights' own rules
 * (shared/insights.mts: the same figures, the same scoping and the same
 * order as Insights → Stats on Week, which a tap opens), never a copy of
 * them. A week with nothing to say draws nothing.
 *
 * A chunk of its own (planner/lazy.ts): the rules it counts by are the
 * Stats lens's, and the launch never parses them.
 */
export function WeekSoFar(p: WeekSoFarProps) {
  // the lens's one clock for the day (useDayClock): read as it mounts and again at midnight
  const now = useDayClock()
  const today = dateKey(now)
  const { tasks, events, people, places, meals, recipes, journal, habits, garments, wears, myId, household } = p
  const top = useMemo<Highlight | null>(() => {
    const input: InsightInput = { tasks, events, people, places, meals, recipes, journal, habits, garments, wears, myId, now, today, dayKeyOf: localDayOf }
    return pickHighlights(insightFigures(input, periodSpan('week', today, today)), { household })[0] ?? null
  }, [tasks, events, people, places, meals, recipes, journal, habits, garments, wears, myId, now, today, household])
  if (!top) return null
  return (
    <button type="button" className={`chart-card home-so-far ink-${top.area}`} onClick={p.onOpen} aria-label={`This week so far: ${top.line}. Open Insights`}>
      <span className="home-so-far-body">
        <span className="home-so-far-head">This week so far</span>
        <span className="home-so-far-title">{top.title}</span>
        {(top.delta || top.detail) && (
          <span className="home-so-far-more">
            {top.delta && <DeltaBadge by={top.delta.by} text={top.delta.text} than={top.delta.than} />}
            {top.detail && <span>{top.detail}</span>}
          </span>
        )}
      </span>
      {top.visual && (
        <span className="home-so-far-visual" aria-hidden="true">
          <HighlightVisual visual={top.visual} label={top.line} />
        </span>
      )}
    </button>
  )
}
