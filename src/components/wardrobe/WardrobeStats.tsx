import { useState } from 'react'
import { formatMoney } from '../../bills'
import { graphicInk, heatStyle } from '../../contrast'
import { daysAgo, daysBetween, shortDay } from '../../kitchen'
import { countOf } from '../../people'
import { useTheme, type Theme } from '../../theme'
import type { Garment, Outfit } from '../../types'
import { dateKey } from '../../utils'
import {
  NOT_WORN_DAYS,
  costPerWear,
  lookCalendar,
  mostWorn,
  neverWorn,
  notWornLately,
  outfitLabel,
  repeatedOutfits,
  wardrobeTiles,
  wardrobeYearReport,
  wearStreaks,
  wearsByMonth,
  yourUniform,
  type WearIndex,
  type WearWindow,
} from '../../wardrobe'
import { StatTile, TrendBadge } from '../bits'
import { Collage, GarmentPhoto } from './GarmentPhoto'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** The photo calendar's weeks run Sunday to Saturday, as the Calendar's do. */
const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const PLACES = ['First', 'Second', 'Third']
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
  /** Outfit on a day: the photo calendar's days open it, to see a look or log one. */
  onGoDay?(day: string): void
  /** The clock the trends are read from; the tests hand one in. */
  now?: Date
}

/**
 * A piece's colour as a mark on the card. A photo's white or navy is moved just
 * far enough to stand out on the theme's card; a piece with no colour takes the
 * chart's own.
 */
const mark = (g: Garment, theme: Theme) => (g.color ? graphicInk(g.color, theme) : 'var(--viz-series-1)')

/** "Watch", "Trainers and Watch", "Mac, Trainers and Watch". */
const andList = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

/** A "YYYY-MM" month moved by `delta` months. */
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

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

/**
 * The month in photos: Sunday-to-Saturday weeks with each day's look as a
 * small collage. A day that has come opens Outfit on it — to see its look, or
 * to log one it never had; a day still to come is only its number.
 */
function PhotoCalendar({ ix, byId, onGoDay }: { ix: WearIndex; byId: ReadonlyMap<string, Garment>; onGoDay?(day: string): void }) {
  const thisMonth = ix.dayKey.slice(0, 7)
  const [month, setMonth] = useState(thisMonth)
  const [y, m] = month.split('-').map(Number)
  const cells = lookCalendar(ix, y, m)
  const logged = cells.filter(c => c.look).length
  return (
    <section className="chart-card wardrobe-photo-cal">
      <header className="chart-head">
        <div>
          <h3>Photo calendar</h3>
          <p className="chart-sub">Each day’s look · {countOf(logged, 'day')} logged</p>
        </div>
        <span className="segmented">
          <button type="button" className="seg" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
            ‹
          </button>
          <button type="button" className="seg on">
            {MONTHS[m - 1]} {y}
          </button>
          <button type="button" className="seg" aria-label="Next month" disabled={month >= thisMonth} onClick={() => setMonth(shiftMonth(month, 1))}>
            ›
          </button>
        </span>
      </header>
      <div className="photo-cal-head" aria-hidden="true">
        {WEEKDAY_INITIALS.map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
      <ol className="photo-cal" aria-label={`${MONTHS[m - 1]} ${y}`}>
        {cells.map((c, i) => {
          if (!c.day) return <li key={`pad-${i}`} className="photo-cal-pad" aria-hidden="true" />
          const day = c.day
          const come = day <= ix.dayKey
          const what = c.look ? `${outfitLabel(c.look.garmentIds, byId)}${c.looks > 1 ? `, and ${countOf(c.looks - 1, 'more look')}` : ''}` : 'nothing logged'
          const face = (
            <>
              {c.look && <Collage ids={c.look.garmentIds} byId={byId} />}
              <span className="photo-cal-num">{Number(day.slice(8))}</span>
            </>
          )
          return (
            <li key={day} className={['photo-cal-cell', c.look ? 'has-look' : '', day === ix.dayKey ? 'today' : '', come ? '' : 'later'].filter(Boolean).join(' ')}>
              {come && onGoDay ? (
                <button type="button" className="photo-cal-day" aria-label={`${shortDay(day, ix.dayKey)}: ${what}`} onClick={() => onGoDay(day)}>
                  {face}
                </button>
              ) : (
                <span className="photo-cal-day" title={come ? `${shortDay(day, ix.dayKey)}: ${what}` : undefined}>
                  {face}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

/**
 * The three most worn of all time on a podium: first in the middle and raised
 * highest, second to its left, third to its right. A place nobody has reached
 * yet is an empty step, so first stays in the middle with one or two pieces.
 */
function Podium({ top, onOpen }: { top: { garment: Garment; count: number }[]; onOpen(id: string): void }) {
  return (
    <ol className="podium">
      {top.map((r, i) => (
        <li key={r.garment.id} className={`podium-place rank-${i + 1}`}>
          <button type="button" className="podium-piece" aria-label={`${PLACES[i]}: ${r.garment.name}, ${countOf(r.count, 'day')}`} onClick={() => onOpen(r.garment.id)}>
            <GarmentPhoto garment={r.garment} className="podium-photo" />
            <span className="podium-name">{r.garment.name}</span>
            <span className="podium-count">
              {countOf(r.count, 'day')}
              {r.garment.archivedAt ? ' · Retired' : ''}
            </span>
          </button>
          <span className="podium-step" aria-hidden="true">
            {i + 1}
          </span>
        </li>
      ))}
      {PLACES.slice(top.length).map((place, j) => (
        <li key={place} className={`podium-place rank-${top.length + j + 1} vacant`} aria-hidden="true">
          <span className="podium-step" />
        </li>
      ))}
    </ol>
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
 * Stats: what you wear, counted in days — the streaks; the month in photos;
 * the podium of the three most worn of all time; the most worn over 30 days,
 * 12 months or all time; what has rested 60 days or more; what was never
 * worn; the days logged each month, with each piece's year; your uniform and
 * the other outfits you repeat; and the cost per wear of the pieces with a
 * price. Retired pieces still count in the history, and nowhere else.
 */
export function WardrobeStats({ garments, outfits, byId, ix, onOpenPiece, onRetire, onSaveOutfit, onGoDay, now = new Date() }: Props) {
  const theme = useTheme()
  const [span, setSpan] = useState<WearWindow>(30)
  const thisYear = Number(ix.dayKey.slice(0, 4))
  const [year, setYear] = useState(thisYear)
  const tiles = wardrobeTiles(garments, ix)
  const streaks = wearStreaks(ix)
  const podium = mostWorn(garments, ix, 'all', 3)
  const top = mostWorn(garments, ix, span)
  const most = Math.max(1, ...top.map(r => r.count))
  const rested = notWornLately(garments, ix)
  const never = neverWorn(garments, ix)
  const months = wearsByMonth(ix, year, now)
  const report = wardrobeYearReport(garments, ix, year, now).slice(0, 20)
  const uniform = yourUniform(ix, byId, outfits)
  // your uniform heads the list, so the rest follow it: five in all, as before
  const repeats = repeatedOutfits(ix, byId, outfits).slice(1, 5)
  const cost = costPerWear(garments, ix)
  const streakSub = ix.looks.has(ix.dayKey) ? 'logged in a row, today too' : streaks.current > 0 ? 'log today to keep it going' : 'log a day to start one'

  return (
    <div className="wardrobe-stats">
      <div className="kpi-row wardrobe-tiles">
        <StatTile label="Clothes" value={String(tiles.pieces)} sub="in use; retired ones aside" />
        <StatTile label="Days logged" value={`${tiles.loggedThisMonth} of ${tiles.daysThisMonth}`} sub="this month so far" />
        <StatTile label="Worn lately" value={`${tiles.wornLately} of ${tiles.pieces}`} sub="pieces worn in the last 90 days" />
        <StatTile label="Streak" value={countOf(streaks.current, 'day')} sub={streakSub} />
        <StatTile label="Best streak" value={countOf(streaks.best, 'day')} sub="logged in a row" />
      </div>

      <PhotoCalendar ix={ix} byId={byId} onGoDay={onGoDay} />

      {podium.length > 0 && (
        <section className="chart-card">
          <header className="chart-head">
            <div>
              <h3>Top three</h3>
              <p className="chart-sub">Your most worn of all time, in days</p>
            </div>
          </header>
          <Podium top={podium} onOpen={onOpenPiece} />
        </section>
      )}

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
        {!uniform ? (
          <p className="empty">Wear the same top and bottom on two days and they show here.</p>
        ) : (
          <>
            <div className="wardrobe-uniform">
              <Collage ids={uniform.garmentIds} byId={byId} />
              <span className="wardrobe-uniform-text">
                <span className="wardrobe-uniform-label">Your uniform</span>
                <span className="wardrobe-list-name">{uniform.outfit?.name || outfitLabel(uniform.garmentIds, byId)}</span>
                <small className="muted">
                  ×{uniform.days} · last {shortDay(uniform.lastWorn, ix.dayKey)}
                </small>
                <small className="muted">
                  {Math.round(uniform.share * 100)}% of the days you logged
                  {uniform.usually.length > 0 ? ` · usually with ${andList(uniform.usually.map(g => g.name))}` : ''}
                </small>
                {!uniform.outfit && (
                  <button type="button" className="btn subtle" onClick={() => onSaveOutfit(uniform.garmentIds)}>
                    Save as outfit
                  </button>
                )}
              </span>
            </div>
            {repeats.length > 0 && (
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
          </>
        )}
      </section>

      {cost.rows.length > 0 && (
        <section className="chart-card">
          <header className="chart-head">
            <div>
              <h3>Cost per wear</h3>
              <p className="chart-sub">
                {formatMoney(cost.spent)} across {countOf(cost.rows.length, 'piece')}
                {cost.perWear !== undefined ? ` · ${formatMoney(cost.perWear)} a wear overall` : ''}
              </p>
            </div>
          </header>
          <ul className="wardrobe-list">
            {cost.rows.slice(0, 20).map(r => (
              <li key={r.garment.id} className="wardrobe-list-row">
                <button type="button" className="wardrobe-list-piece" onClick={() => onOpenPiece(r.garment.id)}>
                  <GarmentPhoto garment={r.garment} className="thumb-40" />
                  <span>
                    <span className="wardrobe-list-name">{r.garment.name}</span>
                    <small className="muted">
                      {formatMoney(r.price)} · {r.wears > 0 ? `worn on ${countOf(r.wears, 'day')}` : 'not worn yet'}
                    </small>
                  </span>
                </button>
                <span className="wardrobe-cpw">
                  {r.perWear !== undefined ? (
                    <>
                      <strong>{formatMoney(r.perWear)}</strong> <small className="muted">a wear</small>
                    </>
                  ) : (
                    <small className="muted">no wears yet</small>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
