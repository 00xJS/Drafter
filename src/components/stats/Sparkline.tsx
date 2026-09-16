/**
 * A shape, not a chart: a series small enough to sit inside a tile or a summary
 * row, saying which way a number has been going without asking for an axis. No
 * ticks, no grid, no tooltip — where those are wanted the chart is a MonthBars
 * or a RankedBars in a card of its own.
 *
 * The area under the line is the same ink at a low alpha, which is what makes
 * a five-pixel-tall line legible; `aria-label` carries the series in words, so
 * a screen reader gets the trend rather than a decorative image.
 */
export function Sparkline({ series, label, height = 30, tone = 'var(--viz-series-1)' }: { series: readonly number[]; label: string; height?: number; tone?: string }) {
  const w = 120
  const pad = 2
  if (series.length < 2) return null
  const most = Math.max(1, ...series)
  const step = (w - pad * 2) / (series.length - 1)
  const y = (n: number) => height - pad - (n / most) * (height - pad * 2)
  const points = series.map((n, i) => `${(pad + i * step).toFixed(1)},${y(n).toFixed(1)}`)
  return (
    <svg className="sparkline" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <polygon className="spark-area" points={`${pad},${height} ${points.join(' ')} ${w - pad},${height}`} fill={tone} />
      <polyline className="spark-line" points={points.join(' ')} fill="none" stroke={tone} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
