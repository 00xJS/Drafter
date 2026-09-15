import { SEEN_META } from '../../people'

/** A year table's trend: more lately, drifting, or steady (recentTrend). Every table and total line reads it the same way. */
export function TrendBadge({ trend }: { trend: number }) {
  return trend > 0 ? (
    <span className="badge" style={{ background: 'var(--tone-sky-bg)', color: 'var(--tone-sky)' }}>
      ↑ more lately
    </span>
  ) : trend < 0 ? (
    <span className="badge" style={{ background: SEEN_META.due.bg, color: SEEN_META.due.color }}>
      ↓ drifting
    </span>
  ) : (
    <small className="muted">steady</small>
  )
}
