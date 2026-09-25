import { useMemo } from 'react'
import {
  INSIGHT_PERIODS,
  insightFigures,
  nextSpan,
  parsePeriodKey,
  periodName,
  periodNote,
  periodPhrase,
  periodSpan,
  pickHighlights,
  previousSpan,
  type Highlight,
  type HighlightVisual,
  type InsightInput,
  type InsightPeriod,
} from '../../../shared/insights.mts'
import { STATS_AREAS, type StatsTab } from '../planner/routes'
import { AreaCard, DeltaBadge, Ring, Segmented, Sparkline } from '../stats'

const AREA_LABELS = new Map<string, string>(STATS_AREAS.map(a => [a.key, a.label]))

/** What counts whose, in a household: said once, under the period, in words and no badge (scopeRecords, shared/insights.mts). */
const HOUSEHOLD_SCOPE = 'Tasks, money and meals count the household; people, places, your journal, habits and clothes are yours.'

export interface HighlightsProps {
  /** What the figures are counted from (scopeRecords decides whose; see shared/insights.mts). */
  input: InsightInput
  /** More than one member: the line saying what counts whose is drawn. Alone, everything counted is yours. */
  household: boolean
  period: InsightPeriod
  onPeriod(p: InsightPeriod): void
  /** Which week, month or year, by its key; null for the one we are in. */
  at: string | null
  onAt(key: string | null): void
  /** An area's figures, or the year's, pushed over the page. */
  onOpen(page: Exclude<StatsTab, 'highlights'>): void
}

/**
 * Insights → Stats' first page: a few plain lines about the week, the month or
 * the year, most interesting first, each opening the figures of its area.
 *
 * The lines are picked by rules (shared/insights.mts), never by a model, from
 * figures the rest of the app counts the same way — the monthly recap sends
 * the same lines, from the same module. Nothing is drawn for a figure of
 * nothing: a quiet week says it is quiet. Under them, a chip for every area
 * and the year, so every figure the app keeps is one tap away.
 */
export function Highlights({ input, household, period, onPeriod, at, onAt, onOpen }: HighlightsProps) {
  const { today } = input
  const asked = parsePeriodKey(at)
  const anchor = asked && asked.period === period ? asked.anchor : today
  const span = useMemo(() => periodSpan(period, anchor, today), [period, anchor, today])
  const cards = useMemo(() => pickHighlights(insightFigures(input, span)), [input, span])
  const before = previousSpan(span, today)
  const after = nextSpan(span, today)
  return (
    <div className="insights-feed">
      <div className="highlights-head">
        <Segmented items={INSIGHT_PERIODS} value={period} onChange={onPeriod} label="Period" role="group" className="period-seg" />
        <div className="highlights-when">
          <button type="button" className="btn subtle icon-btn when-step" aria-label={`Previous ${period}`} onClick={() => onAt(before.key)}>
            ‹
          </button>
          <div className="when-words">
            <h2 className="when-name">{periodName(span, today)}</h2>
            <p className="stats-note">{periodNote(span, today)}</p>
          </div>
          <button type="button" className="btn subtle icon-btn when-step" aria-label={`Next ${period}`} disabled={!after} onClick={() => onAt(after && !after.current ? after.key : null)}>
            ›
          </button>
        </div>
        {household && <p className="field-hint insights-scope">{HOUSEHOLD_SCOPE}</p>}
      </div>

      {/* every figure the app keeps, an area a tap: the Highlights are a few of them, never all */}
      <nav className="area-chips" aria-label="Every figure, by area">
        {STATS_AREAS.map(a => (
          <button key={a.key} type="button" className={`btn area-chip ink-${a.key}`} onClick={() => onOpen(a.key)}>
            <span className="area-dot" aria-hidden="true" />
            {a.label}
          </button>
        ))}
      </nav>

      {cards.length > 0 ? (
        <ol className="highlight-list" aria-label={`Highlights, ${periodName(span, today).toLowerCase()}`}>
          {cards.map(c => (
            <li key={c.id}>
              <HighlightCard card={c} onOpen={() => onOpen(c.area)} />
            </li>
          ))}
        </ol>
      ) : (
        <div className="chart-card highlights-empty">
          <p className="empty">{span.current ? `Nothing to tell about ${periodPhrase(span, today)} yet.` : `Nothing was logged ${periodPhrase(span, today)}.`}</p>
          <p className="stats-note">Finish a task, see someone, eat in or out, write a line or log an outfit, and it shows here. Every figure is under the areas above.</p>
        </div>
      )}

      <div className="ink-year">
        <AreaCard name="This year" value="A year of days" sub="Streaks, each area’s year, and the days you got things done" onOpen={() => onOpen('year')} openLabel="Open" />
      </div>
    </div>
  )
}

/** One highlight: its area, its line, its change and what leads it, a small picture, and the way to its area's figures. */
function HighlightCard({ card: c, onOpen }: { card: Highlight; onOpen(): void }) {
  const area = AREA_LABELS.get(c.area) ?? c.area
  return (
    <button type="button" className={`highlight ink-${c.area}`} onClick={onOpen} aria-label={`${c.line}. Open ${area}`}>
      <span className="highlight-body">
        <span className="highlight-area">
          <span className="area-dot" aria-hidden="true" />
          {area}
        </span>
        <span className="highlight-title">{c.title}</span>
        {(c.delta || c.detail) && (
          <span className="highlight-more">
            {c.delta && <DeltaBadge by={c.delta.by} text={c.delta.text} than={c.delta.than} />}
            {c.detail && <span className="highlight-detail">{c.detail}</span>}
          </span>
        )}
      </span>
      {c.visual && (
        <span className="highlight-visual" aria-hidden="true">
          <Visual visual={c.visual} label={c.line} />
        </span>
      )}
      <span className="area-go" aria-hidden="true">
        ›
      </span>
    </button>
  )
}

/** A card's small picture, drawn with the Stats kit in its area's colour. */
function Visual({ visual: v, label }: { visual: HighlightVisual; label: string }) {
  if (v.kind === 'spark') return <Sparkline series={v.series} label={label} />
  if (v.kind === 'ring') return <Ring value={v.value} of={Math.max(1, v.of)} size={48} label={v.label} />
  const shown = v.parts.filter(p => p.value > 0)
  return (
    <span className="split-bar">
      {shown.map(p => (
        <span key={p.key} className={`split-${p.key}`} style={{ flexGrow: p.value }} title={`${p.label}: ${p.value}`} />
      ))}
    </span>
  )
}
