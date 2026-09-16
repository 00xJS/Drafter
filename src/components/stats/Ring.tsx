import type { ReactNode } from 'react'

/**
 * "13 of 15", drawn. A ring reads a share at a glance where a number has to be
 * divided in your head, and it holds its shape at any size, so the same
 * component serves a tile and a row.
 *
 * The track is --viz-empty, the kit's word for a mark that counts nothing, and
 * the arc is the chart series — both hold 3:1 on a card in either theme
 * (theme-tokens.test.ts). The figure in the middle is the value, not a
 * percentage, unless the caller writes one: a share of something you did is
 * easier to read as the thing itself.
 */
export function Ring({ value, of, size = 68, label, caption, tone }: { value: number; of: number; size?: number; label: ReactNode; caption?: ReactNode; tone?: string }) {
  const pct = of > 0 ? Math.min(1, Math.max(0, value / of)) : 0
  const r = size / 2 - 6
  const circ = 2 * Math.PI * r
  return (
    <span className="stat-ring" style={{ width: size, '--ring-h': `${size}px` } as React.CSSProperties}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={`${value} of ${of}`}>
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={6} />
        {pct > 0 && (
          <circle
            className="ring-arc"
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={6}
            strokeLinecap="round"
            stroke={tone}
            strokeDasharray={`${circ * pct} ${circ}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <span className="ring-label" aria-hidden>
        {label}
      </span>
      {caption && <span className="ring-caption">{caption}</span>}
    </span>
  )
}
