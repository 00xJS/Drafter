import { readDay, useReadout } from './stats/Readout'
import { dateKey } from '../utils'

/**
 * The Review's Done ✓ strip: a bar a day of the period, as tall as what was
 * finished that day. Its figures were only in each bar's title, which a
 * phone never shows; a tap on a bar says its day and its count under the
 * strip (useReadout), and a screen reader hears the days with any from its label.
 */
export function ReviewDays({ counts, start }: { counts: number[]; start: Date }) {
  const readout = useReadout('Tap a day to read it')
  const most = Math.max(...counts, 1)
  const days = counts.map((n, i) => ({ n, said: `${readDay(dateKey(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)))}: ${n} done` }))
  return (
    <>
      <div className="review-days" role="img" aria-label={`Done by day: ${days.filter(d => d.n > 0).map(d => d.said).join(', ') || 'nothing yet'}`} onClick={readout.onClick}>
        {days.map((d, i) => (
          <span key={i} className="review-day" style={{ height: `${d.n === 0 ? 6 : 20 + (d.n / most) * 80}%` }} title={d.said} data-read={d.said} />
        ))}
      </div>
      {readout.line}
    </>
  )
}
