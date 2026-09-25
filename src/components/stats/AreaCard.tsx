import type { ReactNode } from 'react'
import { Sparkline } from './Sparkline'

/**
 * One area's line on Insights' This year page: a headline figure, a shape,
 * and the way through to the figures that area keeps itself.
 *
 * The lens deliberately does not re-count People, Places, Kitchen or the
 * Wardrobe here — each of those counts what its own list's find box and chips
 * leave, and the lens has no list, so a second copy of the number would be a
 * different number. What it shows is the one figure that needs no filter, and
 * a button that opens the real thing.
 */
export function AreaCard({
  name,
  value,
  sub,
  series,
  seriesLabel,
  tone,
  onOpen,
  openLabel = 'See all',
  aside,
}: {
  /** The area, in a word: it is the heading, the tooltip and the accessible name. */
  name: string
  /** The one figure that needs no filter, already in words ("13 dinners"). */
  value: string
  sub?: ReactNode
  /** Twelve months, January first; omitted when the area has nothing to plot. */
  series?: readonly number[]
  seriesLabel?: string
  tone?: string
  onOpen?(): void
  openLabel?: string
  /** A ring or a mark drawn instead of the sparkline. */
  aside?: ReactNode
}) {
  const body = (
    <>
      <span className="area-head">
        <span className="area-title">{name}</span>
        <span className="area-value">{value}</span>
        {sub && <span className="area-sub">{sub}</span>}
      </span>
      <span className="area-aside">{aside ?? (series && series.length > 1 ? <Sparkline series={series} label={seriesLabel ?? name} tone={tone} /> : null)}</span>
    </>
  )
  if (!onOpen) return <div className="area-card">{body}</div>
  // the button's own words are the area, its figure and its line, which is what
  // a screen reader should hear; `name` is only what the tooltip and the
  // accessible name add to them ("See all — Kitchen")
  return (
    <button type="button" className="area-card area-open" onClick={onOpen} title={`${openLabel} — ${name}`} aria-label={`${name}: ${value}. ${openLabel}`}>
      {body}
      <span className="area-go" aria-hidden>
        ›
      </span>
    </button>
  )
}
