/**
 * A figure's change on the period before it: "↑7 on last week", "↓$120.00 on
 * August", "same as last week" — TrendBadge's badge, with the size of the
 * change and what it is set against (describeDelta, shared/insights.mts, puts
 * it in words). A fall is drawn in grey rather than in warning's amber: fewer
 * tasks done, or less money paid, is not in itself something gone wrong.
 *
 * `text` is the change in words when it is not a plain count (describeDelta
 * writes money and points); a count is written as it is.
 *
 * A file of its own, not TrendBadge's: that one reaches the first load
 * through bits.tsx, and only the Stats views draw this.
 */
export function DeltaBadge({ by, text, than }: { by: number; text?: string; than: string }) {
  if (by === 0) return <small className="muted delta-line">same as {than.replace(/^on /, '')}</small>
  const said = text ?? (by > 0 ? `↑${by}` : `↓${-by}`)
  return (
    <span className="delta-line">
      <span className="badge delta-badge" style={by > 0 ? { background: 'var(--tone-sky-bg)', color: 'var(--tone-sky)' } : { background: 'var(--tone-grey-bg)', color: 'var(--tone-grey)' }}>
        {said}
      </span>{' '}
      <small className="muted">{than}</small>
    </span>
  )
}
