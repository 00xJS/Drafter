import type { HighlightVisual as Visual } from '../../../shared/insights.mts'
import { Ring } from '../stats/Ring'
import { Sparkline } from '../stats/Sparkline'

/**
 * A highlight's small picture, drawn with the Stats kit in its area's colour
 * (the .ink-* class on the card around it): a sparkline, a ring, or the
 * Kitchen's three ways as one bar. Insights' Highlights draw it on each card,
 * and Home's "This week so far" on the week's first.
 */
export function HighlightVisual({ visual: v, label }: { visual: Visual; label: string }) {
  if (v.kind === 'spark') return <Sparkline series={v.series} label={label} />
  if (v.kind === 'ring') return <Ring value={v.value} of={Math.max(1, v.of)} size={48} label={v.label} />
  return <SplitBar parts={v.parts} />
}

/** The Kitchen's three ways in a period as one bar, its parts as long as each count, and the counts under it. */
export function SplitBar({ parts }: { parts: Extract<Visual, { kind: 'split' }>['parts'] }) {
  const shown = parts.filter(p => p.value > 0)
  return (
    <span className="split-figure">
      <span className="split-bar">
        {shown.map(p => (
          <span key={p.key} className={`split-${p.key}`} style={{ flexGrow: p.value }} title={`${p.label}: ${p.value}`} />
        ))}
      </span>
      {/* The figures, printed under it in each part's colour. They were only
          in each part's title, which a phone never shows, and the card is a
          button: a tap on it opens the area, so it cannot be tapped to read. */}
      <span className="split-key">
        {shown.map(p => (
          <span key={p.key} className="split-key-part">
            <i className={`split-${p.key}`} />
            {p.value}
          </span>
        ))}
      </span>
    </span>
  )
}
