import { countOf } from '../../people'
import { MONTHS } from '../../stats'
import { TrendBadge } from './TrendBadge'

/**
 * A year by month on the shared chart styles: a bar for each month, this
 * month's (`current`, -1 for another year) drawn hot, and under them the
 * year's `total` in words with its trend (TrendBadge). `label` names the chart
 * for a screen reader ("Days logged: Jan 0, Feb 3, …") and `noun` a bar's
 * tooltip ("Mar: 3 days").
 */
export function MonthBars({
  months,
  current,
  label,
  noun = 'day',
  total,
  trend,
  prefix = 'stats',
}: {
  /** Twelve counts, January first (monthBuckets). */
  months: readonly number[]
  current: number
  label: string
  noun?: string
  total: string
  trend: number
  /** The class prefix its styles are keyed by: the kit's own, or 'wardrobe' for the wardrobe's, which draw alike. */
  prefix?: string
}) {
  const [w, h, base] = [360, 112, 94]
  const most = Math.max(1, ...months)
  const slot = w / 12
  return (
    <>
      <div className={`chart-plot ${prefix}-month-bars`}>
        <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${label}: ${months.map((n, i) => `${MONTHS[i]} ${n}`).join(', ')}`}>
          <line className="axis-base" x1={0} x2={w} y1={base} y2={base} />
          {months.map((n, i) => {
            const tall = (n / most) * (base - 8)
            return (
              <g key={i}>
                {n > 0 && (
                  <rect className={i === current ? 'bar hot' : 'bar'} x={i * slot + slot * 0.2} y={base - tall} width={slot * 0.6} height={tall} rx={2}>
                    <title>{`${MONTHS[i]}: ${countOf(n, noun)}`}</title>
                  </rect>
                )}
                <text className="tick-label" x={i * slot + slot / 2} y={h - 4} textAnchor="middle">
                  {MONTHS[i]}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
      <p className={`${prefix}-month-total`}>
        {total} <TrendBadge trend={trend} />
      </p>
    </>
  )
}
