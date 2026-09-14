import { useState } from 'react'
import { graphicInk, heatStyle } from '../../contrast'
import { daysAgo, daysBetween, shortDay } from '../../kitchen'
import { countOf } from '../../people'
import { useTheme, type Theme } from '../../theme'
import type { Garment, Outfit } from '../../types'
import { dateKey } from '../../utils'
import {
  NOT_WORN_DAYS,
  mostWorn,
  neverWorn,
  notWornLately,
  outfitLabel,
  repeatedOutfits,
  wardrobeTiles,
  wardrobeYearReport,
  wearsByMonth,
  type WearIndex,
  type WearWindow,
} from '../../wardrobe'
import { StatTile, TrendBadge } from '../bits'
import { Collage, GarmentPhoto } from './GarmentPhoto'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const SPANS: { key: WearWindow; label: string }[] = [
  { key: 30, label: '30 days' },
  { key: 365, label: '12 months' },
  { key: 'all', label: 'All' },
]

interface Props {
  garments: Garment[]
  outfits: Outfit[]
  byId: ReadonlyMap<string, Garment>
  ix: WearIndex
  onOpenPiece(id: string): void
  onRetire(g: Garment): void
  onSaveOutfit(pieces: string[]): void
  /** The clock the trends are read from; the tests hand one in. */
  now?: Date
}

/**
 * A piece's colour as a mark on the card. A photo's white or navy is moved just
 * far enough to stand out on the theme's card; a piece with no colour takes the
 * chart's own.
 */
const mark = (g: Garment, theme: Theme) => (g.color ? graphicInk(g.color, theme) : 'var(--viz-series-1)')

/** Days logged in each month of the year, on the shared chart styles. */
function MonthBars({ months, current }: { months: number[]; current: number }) {
  const [w, h, base] = [360, 112, 94]
  const most = Math.max(1, ...months)
  const slot = w / 12
  return (
    <div className="chart-plot wardrobe-month-bars">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Days logged: ${months.map((n, i) => `${MONTHS[i]} ${n}`).join(', ')}`}>
        <line className="axis-base" x1={0} x2={w} y1={base} y2={base} />
        {months.map((n, i) => {
          const tall = (n / most) * (base - 8)
          return (
            <g key={i}>
              {n > 0 && (
                <rect className={i === current ? 'bar hot' : 'bar'} x={i * slot + slot * 0.2} y={base - tall} width={slot * 0.6} height={tall} rx={2}>
                  <title>{`${MONTHS[i]}: ${countOf(n, 'day')}`}</title>
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
  )
}

function PieceRow({ garment, line, onOpen, onRetire }: { garment: Garment; line: string; onOpen(id: string): void; onRetire(g: Garment): void }) {
  return (
    <li className="wardrobe-list-row">
      <button type="button" className="wardrobe-list-piece" onClick={() => onOpen(garment.id)}>
        <GarmentPhoto garment={garment} className="thumb-40" />
        <span>
          <span className="wardrobe-list-name">{garment.name}</span>
          <small className="muted">{line}</small>
        </span>
      </button>
      <button type="button" className="btn subtle" onClick={() => onRetire(garment)}>
        Retire
      </button>
    </li>
  )
}

/**
 * Stats: what you wear, counted in days — the most worn over 30 days, 12
 * months or all time; what has rested 60 days or more; what was never worn;
 * the days logged each month, with each piece's year; and the outfits you
 * repeat most. Retired pieces still count in the history, and nowhere else.
 */
export function WardrobeStats({ garments, outfits, byId, ix, onOpenPiece, onRetire, onSaveOutfit, now = new Date() }: Props) {
  const theme = useTheme()
  const [span, setSpan] = useState<WearWindow>(30)
  const thisYear = Number(ix.dayKey.slice(0, 4))
  const [year, setYear] = useState(thisYear)
  const tiles = wardrobeTiles(garments, ix)
  const top = mostWorn(garments, ix, span)
  const most = Math.max(1, ...top.map(r => r.count))
  const rested = notWornLately(garments, ix)
  const never = neverWorn(garments, ix)
  const months = wearsByMonth(ix, year, now)
  const report = wardrobeYearReport(garments, ix, year, now).slice(0, 20)
  const repeats = repeatedOutfits(ix, byId, outfits).slice(0, 5)

  return (
    <div className="wardrobe-stats">
      <div className="kpi-row wardrobe-tiles">
        <StatTile label="Clothes" value={String(tiles.pieces)} sub="in use; retired ones aside" />
        <StatTile label="Days logged" value={`${tiles.loggedThisMonth} of ${tiles.daysThisMonth}`} sub="this month so far" />
        <StatTile label="Worn lately" value={`${tiles.wornLately} of ${tiles.pieces}`} sub="pieces worn in the last 90 days" />
      </div>

      <section className="chart-card">
        <header className="chart-head">
          <div>
            <h3>Most worn</h3>
            <p className="chart-sub">Days worn: two looks on one day count once</p>
          </div>
          <span className="segmented">
            {SPANS.map(s => (
              <button key={String(s.key)} type="button" aria-pressed={span === s.key} className={span === s.key ? 'seg on' : 'seg'} onClick={() => setSpan(s.key)}>
                {s.label}
              </button>
            ))}
          </span>
        </header>
        {top.length === 0 ? (
          <p className="empty">Log a few days and your most worn shows here.</p>
        ) : (
          <div className="hbars wardrobe-hbars">
            {top.map(r => (
              <div key={r.garment.id} className="hbar-row">
                <button type="button" className="wardrobe-hbar-label" onClick={() => onOpenPiece(r.garment.id)}>
                  <GarmentPhoto garment={r.garment} className="thumb-28" />
                  <span className="wardrobe-hbar-name">{r.garment.name}</span>
                  {r.garment.archivedAt && <span className="badge wardrobe-retired">Retired</span>}
                </button>
                <span className="hbar-track">
                  <span className="hbar-fill" style={{ width: `${Math.max(4, (r.count / most) * 85)}%`, background: mark(r.garment, theme) }} />
                  <span className="hbar-value">{r.count}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="chart-card">
        <header className="chart-head">
          <div>
            <h3>Not worn lately</h3>
            <p className="chart-sub">Worn before, but not in {NOT_WORN_DAYS} days or more</p>
          </div>
        </header>
        {rested.length === 0 ? (
          <p className="empty">Nothing has rested that long.</p>
        ) : (
          <ul className="wardrobe-list">
            {rested.map(g => (
              <PieceRow key={g.id} garment={g} line={`Last worn ${daysAgo(daysBetween(ix.days.get(g.id)![0], ix.dayKey))}`} onOpen={onOpenPiece} onRetire={onRetire} />
            ))}
          </ul>
        )}
      </section>

      <section className="chart-card">
        <header className="chart-head">
          <div>
            <h3>Never worn</h3>
            <p className="chart-sub">Added a week or more ago, and not logged since</p>
          </div>
        </header>
        {never.length === 0 ? (
          <p className="empty">Everything added over a week ago has been worn.</p>
        ) : (
          <ul className="wardrobe-list">
            {never.map(g => (
              <PieceRow key={g.id} garment={g} line={`Added ${daysAgo(daysBetween(dateKey(g.createdAt), ix.dayKey))}`} onOpen={onOpenPiece} onRetire={onRetire} />
            ))}
          </ul>
        )}
      </section>

      <section className="chart-card year-report wardrobe-months">
        <header className="chart-head">
          <div>
            <h3>Wears by month</h3>
            <p className="chart-sub">Days logged each month · trend compares the last 90 days with the 90 before</p>
          </div>
          <span className="segmented">
            <button type="button" className="seg" aria-label="Previous year" onClick={() => setYear(y => y - 1)}>
              ‹
            </button>
            <button type="button" className="seg on">
              {year}
            </button>
            <button type="button" className="seg" aria-label="Next year" onClick={() => setYear(y => y + 1)}>
              ›
            </button>
          </span>
        </header>
        <MonthBars months={months.months} current={year === thisYear ? Number(ix.dayKey.slice(5, 7)) - 1 : -1} />
        <p className="wardrobe-month-total">
          {countOf(months.total, 'day')} logged in {year} <TrendBadge trend={months.trend} />
        </p>
        <details className="wardrobe-by-piece">
          <summary>By piece</summary>
          {report.length === 0 ? (
            <p className="empty">Nothing was worn in {year}.</p>
          ) : (
            <div className="table-scroll">
              <table className="year-table">
                <thead>
                  <tr>
                    <th>Piece</th>
                    {MONTHS.map((m, i) => (
                      <th key={i} className="num">
                        {m}
                      </th>
                    ))}
                    <th className="num">Days</th>
                    <th>Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {report.map(r => (
                    <tr key={r.garment.id}>
                      <td>
                        <span className="pdot" style={{ background: mark(r.garment, theme) }} /> {r.garment.name}
                      </td>
                      {r.months.map((n, i) => (
                        <td
                          key={i}
                          className="num year-cell"
                          title={n > 0 ? countOf(n, 'day') : undefined}
                          style={n > 0 ? heatStyle(mark(r.garment, theme), n, theme) : undefined}
                        >
                          {n || ''}
                        </td>
                      ))}
                      <td className="num">
                        <strong>{r.total}</strong>
                      </td>
                      <td>
                        <TrendBadge trend={r.trend} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </details>
      </section>

      <section className="chart-card">
        <header className="chart-head">
          <div>
            <h3>Most repeated outfits</h3>
            <p className="chart-sub">The same top and bottom, or one-piece, whatever went with them</p>
          </div>
        </header>
        {repeats.length === 0 ? (
          <p className="empty">Wear the same top and bottom on two days and they show here.</p>
        ) : (
          <ul className="wardrobe-repeats">
            {repeats.map(r => (
              <li key={r.key} className="wardrobe-repeat">
                <Collage ids={r.garmentIds} byId={byId} />
                <span className="wardrobe-repeat-text">
                  <span className="wardrobe-list-name">{r.outfit?.name || outfitLabel(r.garmentIds, byId)}</span>
                  <small className="muted">
                    ×{r.days} · last {shortDay(r.lastWorn, ix.dayKey)}
                  </small>
                </span>
                {!r.outfit && (
                  <button type="button" className="btn subtle" onClick={() => onSaveOutfit(r.garmentIds)}>
                    Save as outfit
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
