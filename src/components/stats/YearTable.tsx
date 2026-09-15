import type { ReactNode } from 'react'
import { heatStyle } from '../../contrast'
import { countOf } from '../../people'
import { MONTHS } from '../../stats'
import { useTheme } from '../../theme'
import { TrendBadge } from './TrendBadge'

/** One row of a year table (monthsAndTrend): its key and name, a count for each month, the year's total and the trend. */
export interface YearRow {
  key: string
  name: string
  months: readonly number[]
  total: number
  trend: number
}

/**
 * A year as a heat table: a row for each thing, a cell for each month tinted
 * in the row's colour at a strength that grows with its count (heatStyle,
 * which keeps its text readable on a deep colour), then the total and the
 * trend. It scrolls inside its own .table-scroll, so the page never scrolls
 * sideways at 375pt. `color` is the row's colour as drawn — markInk for a
 * mark moved to stand out, or the colour as it is. `extra` is a column before
 * the trend (People's events); `empty` stands in for a table with no rows.
 */
export function YearTable<R extends YearRow>({
  rows,
  head,
  noun,
  totalHead,
  color,
  months = MONTHS,
  extra,
  empty,
}: {
  rows: readonly R[]
  /** The first column's head: "Piece", "Person", "Place". */
  head: string
  /** What a cell counts, for its tooltip: "2 days", "1 outing". */
  noun: string
  totalHead: string
  color(row: R): string
  /** The month columns' heads: Jan to Dec, or one letter each where room is short. */
  months?: readonly string[]
  extra?: { head: string; className?: string; cell(row: R): ReactNode }
  empty?: ReactNode
}) {
  const theme = useTheme()
  if (rows.length === 0 && empty !== undefined) return <p className="empty">{empty}</p>
  return (
    <div className="table-scroll">
      <table className="year-table">
        <thead>
          <tr>
            <th>{head}</th>
            {months.map((m, i) => (
              <th key={i} className="num">
                {m}
              </th>
            ))}
            <th className="num">{totalHead}</th>
            {extra && <th className="num">{extra.head}</th>}
            <th>Trend</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const ink = color(r)
            return (
              <tr key={r.key}>
                <td>
                  <span className="pdot" style={{ background: ink }} /> {r.name}
                </td>
                {r.months.map((n, i) => (
                  <td key={i} className="num year-cell" title={n > 0 ? countOf(n, noun) : undefined} style={n > 0 ? heatStyle(ink, n, theme) : undefined}>
                    {n || ''}
                  </td>
                ))}
                <td className="num">
                  <strong>{r.total}</strong>
                </td>
                {extra && <td className={extra.className ? `num ${extra.className}` : 'num'}>{extra.cell(r)}</td>}
                <td>
                  <TrendBadge trend={r.trend} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
