import { ReactNode, useState } from 'react'
import { fmtNum } from '../utils'

export interface Datum {
  label: string
  value: number
}

/** Card wrapper with a table-view twin so every chart is readable without color or hover. */
export function ChartCard({
  title,
  subtitle,
  columns,
  rows,
  children,
}: {
  title: string
  subtitle?: string
  columns: string[]
  rows: (string | number)[][]
  children: ReactNode
}) {
  const [showTable, setShowTable] = useState(false)
  return (
    <section className="chart-card">
      <header className="chart-head">
        <div>
          <h3>{title}</h3>
          {subtitle && <p className="chart-sub">{subtitle}</p>}
        </div>
        <button className="btn subtle" onClick={() => setShowTable(s => !s)}>
          {showTable ? 'Chart' : 'Table'}
        </button>
      </header>
      {showTable ? (
        <div className="chart-table-wrap">
          <table className="chart-table">
            <thead>
              <tr>
                {columns.map(c => (
                  <th key={c} className={c === columns[0] ? '' : 'num'}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {r.map((cell, j) => (
                    <td key={j} className={j > 0 ? 'num' : ''}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
    </section>
  )
}

function niceTicks(max: number, integer = false): number[] {
  const rough = Math.max(max, 1) / 4
  const pow = Math.pow(10, Math.floor(Math.log10(rough)))
  let step = [1, 2, 2.5, 5, 10].map(m => m * pow).find(c => c >= rough) ?? 10 * pow
  if (integer) step = Math.max(1, Math.round(step))
  const top = Math.ceil((Math.max(max, 1) - 1e-9) / step) * step
  const ticks: number[] = []
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v * 1000) / 1000)
  return ticks
}

function topRoundedRect(x: number, yTop: number, w: number, h: number): string {
  const r = Math.min(4, h, w / 2)
  const yBase = yTop + h
  return [
    `M ${x} ${yBase}`,
    `L ${x} ${yTop + r}`,
    `Q ${x} ${yTop} ${x + r} ${yTop}`,
    `L ${x + w - r} ${yTop}`,
    `Q ${x + w} ${yTop} ${x + w} ${yTop + r}`,
    `L ${x + w} ${yBase}`,
    'Z',
  ].join(' ')
}

/** Single-series column chart: thin rounded-top bars, hairline grid, hover tooltip. */
export function ColumnChart({
  data,
  formatValue = fmtNum,
  integerTicks = false,
}: {
  data: Datum[]
  formatValue?: (n: number) => string
  integerTicks?: boolean
}) {
  const [hover, setHover] = useState<number | null>(null)

  const W = 680
  const H = 240
  const pad = { top: 22, right: 8, bottom: 26, left: 44 }
  const plotW = W - pad.left - pad.right
  const plotH = H - pad.top - pad.bottom

  const max = Math.max(1, ...data.map(d => d.value))
  const ticks = niceTicks(max, integerTicks)
  const top = ticks[ticks.length - 1]
  const n = Math.max(1, data.length)
  const band = plotW / n
  const barW = Math.max(6, Math.min(24, band - 6))
  const maxIdx = data.reduce((mi, d, i) => (d.value > data[mi].value ? i : mi), 0)
  const labelStep = Math.max(1, Math.ceil(n / 8))
  const y = (v: number) => pad.top + plotH - (v / top) * plotH

  return (
    <div className="chart-plot">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Column chart">
        {ticks.map(t => (
          <g key={t}>
            <line x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis-base' : 'gridline'} />
            <text x={pad.left - 6} y={y(t) + 3} className="tick-label" textAnchor="end">
              {fmtNum(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = pad.left + i * band + band / 2
          const x = cx - barW / 2
          const h = (d.value / top) * plotH
          return (
            <g key={i}>
              {d.value > 0 && <path d={topRoundedRect(x, y(d.value), barW, h)} className={'bar' + (hover === i ? ' hot' : '')} />}
              {i % labelStep === 0 && (
                <text x={cx} y={H - 8} className="tick-label" textAnchor="middle">
                  {d.label}
                </text>
              )}
              {i === maxIdx && d.value > 0 && (
                <text x={cx} y={y(d.value) - 6} className="direct-label" textAnchor="middle">
                  {formatValue(d.value)}
                </text>
              )}
              <rect
                x={pad.left + i * band}
                y={pad.top}
                width={band}
                height={plotH}
                className="hit"
                tabIndex={0}
                aria-label={`${d.label}: ${formatValue(d.value)}`}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              />
            </g>
          )
        })}
      </svg>
      {hover !== null && data[hover] && (
        <div className="chart-tip" style={{ left: `${((pad.left + hover * band + band / 2) / W) * 100}%` }}>
          <span className="tip-value">{formatValue(data[hover].value)}</span>
          <span className="tip-label">{data[hover].label}</span>
        </div>
      )}
    </div>
  )
}

// Sequential blue ramp (validated palette steps 100→600) for the heatmap.
const HEAT_RAMP = ['#cde2fb', '#9ec5f4', '#5598e7', '#2a78d6', '#184f95']

export interface HeatCell {
  count: number
  avg: number
}

export interface HeatRow {
  label: string
  cells: HeatCell[]
}

/** Day × time-slot heatmap; cell color = sequential ramp on avg value, empty cells recede. */
export function Heatmap({
  rows,
  colLabels,
  formatValue = fmtNum,
}: {
  rows: HeatRow[]
  colLabels: string[]
  formatValue?: (n: number) => string
}) {
  const [tip, setTip] = useState<{ r: number; c: number; x: number; y: number } | null>(null)
  const max = Math.max(1, ...rows.flatMap(r => r.cells.map(c => c.avg)))

  const cellColor = (cell: HeatCell) => {
    if (cell.count === 0) return 'var(--surface-2)'
    const idx = Math.min(HEAT_RAMP.length - 1, Math.floor((cell.avg / max) * HEAT_RAMP.length))
    return HEAT_RAMP[idx]
  }

  return (
    <div className="heatmap-wrap">
      <div className="heatmap" style={{ gridTemplateColumns: `auto repeat(${colLabels.length}, 1fr)` }}>
        <span />
        {colLabels.map(c => (
          <span key={c} className="heat-col-label">
            {c}
          </span>
        ))}
        {rows.map((row, r) => (
          <FragmentRow key={row.label}>
            <span className="heat-row-label">{row.label}</span>
            {row.cells.map((cell, c) => (
              <button
                key={c}
                type="button"
                className="heat-cell"
                style={{ background: cellColor(cell) }}
                aria-label={`${row.label} ${colLabels[c]}: ${cell.count} posts, average ${formatValue(Math.round(cell.avg))} engagement`}
                onMouseEnter={e => {
                  const el = e.currentTarget
                  setTip({ r, c, x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop })
                }}
                onFocus={e => {
                  const el = e.currentTarget
                  setTip({ r, c, x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop })
                }}
                onMouseLeave={() => setTip(null)}
                onBlur={() => setTip(null)}
              />
            ))}
          </FragmentRow>
        ))}
      </div>
      <div className="heat-legend">
        <span>Fewer</span>
        {HEAT_RAMP.map(c => (
          <span key={c} className="heat-swatch" style={{ background: c }} />
        ))}
        <span>More avg engagement</span>
      </div>
      {tip && rows[tip.r] && (
        <div className="chart-tip" style={{ left: tip.x, top: Math.max(0, tip.y - 44), transform: 'translateX(-50%)' }}>
          <span className="tip-value">
            {rows[tip.r].cells[tip.c].count === 0
              ? 'No posts'
              : `avg ${formatValue(Math.round(rows[tip.r].cells[tip.c].avg))} · ${rows[tip.r].cells[tip.c].count} post${rows[tip.r].cells[tip.c].count === 1 ? '' : 's'}`}
          </span>
          <span className="tip-label">
            {rows[tip.r].label} {colLabels[tip.c]}
          </span>
        </div>
      )}
    </div>
  )
}

// display: contents wrapper so each heatmap row participates in the grid
function FragmentRow({ children }: { children: ReactNode }) {
  return <div style={{ display: 'contents' }}>{children}</div>
}

/** Single-hue horizontal bars with the value direct-labeled at each bar tip. */
export function HBarChart({ data, formatValue = fmtNum }: { data: Datum[]; formatValue?: (n: number) => string }) {
  const max = Math.max(1, ...data.map(d => d.value))
  return (
    <div className="hbars">
      {data.map(d => (
        <div key={d.label} className="hbar-row">
          <span className="hbar-label">{d.label}</span>
          <div className="hbar-track">
            <div className="hbar-fill" style={{ width: `${Math.max(1, (d.value / max) * 100)}%` }} />
            <span className="hbar-value">{formatValue(d.value)}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
