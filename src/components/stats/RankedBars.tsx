import { useState, type ReactNode } from 'react'
import type { DayWindow } from '../../stats'
import { useTheme } from '../../theme'
import { ChartCard, WindowSwitch } from './ChartCard'
import { markInk } from './ink'

/** One ranked row: its key, its name, and what it counts. */
export interface Ranked {
  key: string
  name: string
  count: number
}

/**
 * Ranked horizontal bars in a card, with the 30 days · 12 months · All switch
 * at its head. `rank` gives the rows for a window, most first (topN); each bar
 * is as long as its count against the first's, drawn in the row's own `color`
 * as a mark (markInk). A row's label is its `picture` (a thumbnail or an
 * avatar), its name and its `badge`, and a button when `onOpen` is given.
 */
export function RankedBars<R extends Ranked>({
  title,
  sub,
  empty,
  rank,
  initial = 30,
  color,
  picture,
  badge,
  onOpen,
  prefix = 'stats',
}: {
  title: ReactNode
  sub?: ReactNode
  /** What the card says when nothing counts in the window. */
  empty: ReactNode
  rank(window: DayWindow): readonly R[]
  /** The window it opens on. */
  initial?: DayWindow
  color?(row: R): string | undefined
  picture?(row: R): ReactNode
  badge?(row: R): ReactNode
  onOpen?(row: R): void
  /** The class prefix its styles are keyed by: the kit's own, or 'wardrobe' for the wardrobe's, which draw alike. */
  prefix?: string
}) {
  const theme = useTheme()
  const [span, setSpan] = useState<DayWindow>(initial)
  const rows = rank(span)
  const most = Math.max(1, ...rows.map(r => r.count))
  return (
    <ChartCard title={title} sub={sub} aside={<WindowSwitch value={span} onChange={setSpan} />}>
      {rows.length === 0 ? (
        <p className="empty">{empty}</p>
      ) : (
        <div className={`hbars ${prefix}-hbars`}>
          {rows.map(r => {
            const face = (
              <>
                {picture?.(r)}
                <span className={`${prefix}-hbar-name`}>{r.name}</span>
                {badge?.(r)}
              </>
            )
            return (
              <div key={r.key} className="hbar-row">
                {onOpen ? (
                  <button type="button" className={`${prefix}-hbar-label`} onClick={() => onOpen(r)}>
                    {face}
                  </button>
                ) : (
                  <span className={`${prefix}-hbar-label`}>{face}</span>
                )}
                <span className="hbar-track">
                  <span className="hbar-fill" style={{ width: `${Math.max(4, (r.count / most) * 85)}%`, background: markInk(color?.(r), theme) }} />
                  <span className="hbar-value">{r.count}</span>
                </span>
              </div>
            )
          })}
        </div>
      )}
    </ChartCard>
  )
}
