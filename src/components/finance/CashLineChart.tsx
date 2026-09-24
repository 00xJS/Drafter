import { useId } from 'react'
import { formatMoney } from '../../bills'
import { daysBetween, type CashLine } from '../../finance'
import { dayLabel, shortDay } from './labels'

// The cash line: what you can spend, from today, stepping down on each bill
// and set-aside and up on each payday, for 30 days (60 at a tap). A line of
// steps, because money moves on days and holds between them. Below zero it is
// drawn in the danger ink, and the lowest point is marked and named.
//
// The shapes stretch to the card's width (preserveAspectRatio none, strokes
// that keep their width); the dot and the words are HTML laid over them by
// percentage, so neither is squashed with the line.

const W = 300
const H = 100
const TOP = 8
/** Room under the lowest point for its label, when the line's lowest is the bottom of what is drawn. */
const BOTTOM = 24
/** …and the least room there has to be under the dot for the label to fit without it. */
const LABEL = 22

export interface LineGeometry {
  /** The line, and the same line closed along zero: the area it encloses. */
  path: string
  area: string
  /** Where zero is, and whether it is inside what is drawn. */
  zeroY: number
  zeroShown: boolean
  /** The low point, in the chart's units: x of W, y of H. */
  low: { x: number; y: number }
}

/** The line's shapes for a W × H box: pure, so a test can hold the low point where it belongs. */
export function lineGeometry(line: CashLine, days: number): LineGeometry {
  const lo = Math.min(line.low.balance, 0)
  const hi = Math.max(line.high, 0)
  const range = hi - lo || 1
  // zero is the floor of the drawing, so a low point well above it has room
  // under it already, and the space kept for its label would only sit empty
  const lowFrac = (line.low.balance - lo) / range
  const bottom = 4 + (H - TOP - 4) * lowFrac >= LABEL ? 4 : BOTTOM
  const y = (v: number) => TOP + (1 - (v - lo) / range) * (H - TOP - bottom)
  const x = (key: string) => (Math.max(0, Math.min(days, daysBetween(line.from, key))) / days) * W
  const f = (n: number) => Math.round(n * 100) / 100
  let path = `M0 ${f(y(line.start))}`
  for (const d of line.days) path += ` H${f(x(d.day))} V${f(y(d.balance))}`
  path += ` H${W}`
  const zeroY = y(0)
  return {
    path,
    area: `${path} V${f(zeroY)} H0 Z`,
    zeroY: f(zeroY),
    zeroShown: line.low.balance < 0,
    low: { x: f(x(line.low.day)), y: f(y(line.low.balance)) },
  }
}

/** "Spendable cash over the next 30 days: $2,480.00 today, lowest $310.00 on Fri, Oct 3, $1,900.00 on Oct 21." */
export function lineLabel(line: CashLine, days: number): string {
  const end = line.days.length ? line.days[line.days.length - 1].balance : line.start
  const low = line.low.day === line.from ? `never lower than today` : `lowest ${formatMoney(line.low.balance)} on ${dayLabel(line.low.day)}`
  const under = line.short ? `, below zero from ${dayLabel(line.short.day)}` : ''
  return `Spendable cash over the next ${days} days: ${formatMoney(line.start)} today, ${low}${under}, ${formatMoney(end)} on ${shortDay(line.to)}.`
}

export function CashLineChart({ line, days, onToggle }: { line: CashLine; days: number; onToggle(): void }) {
  // a clip path is named in a url(#…), where the colons and marks useId puts
  // in an id are not safe: letters and digits only
  const ids = `fin${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const above = `${ids}-above`
  const below = `${ids}-below`
  const g = lineGeometry(line, days)
  const lowX = (g.low.x / W) * 100
  const lowY = (g.low.y / H) * 100
  // the label reads from the dot, and never off either edge
  const side = lowX < 22 ? 'start' : lowX > 78 ? 'end' : 'middle'
  const under = line.low.balance < 0
  return (
    <button type="button" className="fin-chart" onClick={onToggle} aria-label={`${lineLabel(line, days)} Tap for ${days === 30 ? 60 : 30} days.`}>
      <span className="fin-plot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <defs>
            <clipPath id={above}>
              <rect x="0" y="0" width={W} height={Math.max(0, g.zeroY)} />
            </clipPath>
            <clipPath id={below}>
              <rect x="0" y={g.zeroY} width={W} height={Math.max(0, H - g.zeroY)} />
            </clipPath>
          </defs>
          <path className="fin-area" d={g.area} clipPath={`url(#${above})`} />
          <path className="fin-area under" d={g.area} clipPath={`url(#${below})`} />
          {g.zeroShown && <line className="fin-zero" x1="0" x2={W} y1={g.zeroY} y2={g.zeroY} />}
          <path className="fin-path" d={g.path} clipPath={`url(#${above})`} />
          <path className="fin-path under" d={g.path} clipPath={`url(#${below})`} />
        </svg>
        <span className={under ? 'fin-low-dot under' : 'fin-low-dot'} style={{ left: `${lowX}%`, top: `${lowY}%` }} aria-hidden="true" />
        <span className={`fin-low-label ${side}${under ? ' under' : ''}`} style={{ left: `${lowX}%`, top: `${lowY}%` }} aria-hidden="true">
          Low point {formatMoney(line.low.balance)} · {line.low.day === line.from ? 'today' : shortDay(line.low.day)}
        </span>
      </span>
      <span className="fin-axis" aria-hidden="true">
        <span>Today</span>
        <span>{shortDay(line.to)}</span>
      </span>
    </button>
  )
}
