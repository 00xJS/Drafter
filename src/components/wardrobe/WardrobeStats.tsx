import { useEffect, useRef, useState } from 'react'
import { formatMoney } from '../../bills'
import { daysAgo, daysBetween, shortDay } from '../../kitchen'
import { countOf } from '../../people'
import { useTheme } from '../../theme'
import type { Garment, Outfit } from '../../types'
import { dateKey } from '../../utils'
import {
  NOT_WORN_DAYS,
  wardrobeCosts,
  lookCalendar,
  lookOn,
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
} from '../../wardrobe'
import { ChartCard, ListCard, ListRow, MonthBars, MonthCalendar, Podium, RankedBars, StatTile, Stepper, StreakTiles, YearTable, markInk } from '../stats'
import { Collage, GarmentPhoto } from './GarmentPhoto'

/** The Stats kit grew out of this screen, which keeps its own wardrobe- classes. */
const PREFIX = 'wardrobe'

interface Props {
  garments: Garment[]
  outfits: Outfit[]
  byId: ReadonlyMap<string, Garment>
  ix: WearIndex
  onOpenPiece(id: string): void
  onRetire(g: Garment): void
  onSaveOutfit(pieces: string[]): void
  /** A piece from the unworn lists, straight into today's look — the piece sheet's own Wear today. */
  onWearToday?(g: Garment): void
  /** Outfit on a day: the photo calendar's days open it, to see a look or log one. */
  onGoDay?(day: string): void
  /** The clock the trends are read from; the tests hand one in. */
  now?: Date
}

/** A piece as the kit ranks it: by its id and name, with its days. */
const ranked = (r: { garment: Garment; count: number }) => ({ key: r.garment.id, name: r.garment.name, count: r.count, garment: r.garment })

/** "Watch", "Trainers and Watch", "Mac, Trainers and Watch". */
const andList = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

/**
 * A piece in one of the two lists that name what is going unworn, with the two
 * answers to that beside it: wear it today, or let it go.
 *
 * Wear today is the point of the list. Reading that a coat has rested 90 days
 * and being able to do nothing about it from there is how a figure stays a
 * figure. It is the piece sheet's own Wear today — the piece goes into today's
 * look where it stands, with the toast's Undo behind it — so one label means
 * one thing wherever it is pressed.
 */
function PieceRow({
  garment,
  line,
  onOpen,
  onRetire,
  onWearToday,
  onActed,
}: {
  garment: Garment
  line: string
  onOpen(id: string): void
  onRetire(g: Garment): void
  onWearToday?(g: Garment): void
  /** Told which card was acted in, so focus can be handed on once the row has gone. */
  onActed(card: HTMLElement | null): void
}) {
  return (
    <ListRow
      prefix={PREFIX}
      picture={<GarmentPhoto garment={garment} className="thumb-40" />}
      name={garment.name}
      line={line}
      onOpen={() => onOpen(garment.id)}
      action={
        <span className="wardrobe-list-actions">
          {onWearToday && (
            <button
              type="button"
              className="btn"
              onClick={e => {
                onActed(e.currentTarget.closest('.chart-card'))
                onWearToday(garment)
              }}
            >
              Wear today
            </button>
          )}
          <button
            type="button"
            className="btn subtle"
            onClick={e => {
              onActed(e.currentTarget.closest('.chart-card'))
              onRetire(garment)
            }}
          >
            Retire
          </button>
        </span>
      }
    />
  )
}

/**
 * Stats: what you wear, counted in days — the streaks; the month in photos;
 * the podium of the three most worn of all time; the most worn over 30 days,
 * 12 months or all time; what has rested 60 days or more; what was never
 * worn; the days logged each month, with each piece's year; your uniform and
 * the other outfits you repeat; and the cost per wear of the pieces with a
 * price. Retired pieces still count in the history, and nowhere else. Drawn
 * with the Stats kit (components/stats), which People, Places and Kitchen
 * share.
 */
export function WardrobeStats({ garments, outfits, byId, ix, onOpenPiece, onRetire, onSaveOutfit, onGoDay, onWearToday, now = new Date() }: Props) {
  const theme = useTheme()
  const thisYear = Number(ix.dayKey.slice(0, 4))
  const [year, setYear] = useState(thisYear)
  const tiles = wardrobeTiles(garments, ix)
  const streaks = wearStreaks(ix)
  const podium = mostWorn(garments, ix, 'all', 3).map(ranked)
  const rested = notWornLately(garments, ix)
  const never = neverWorn(garments, ix)

  /**
   * Where focus goes once a row has been acted on.
   *
   * Retire sets archivedAt and Wear today makes the piece worn, and both lists
   * filter on exactly those — so the `<li>` holding the pressed button
   * unmounts, and the browser drops focus to `<body>`. A keyboard reader is
   * then back at the top of the document with nothing to say what happened.
   *
   * This has to wait for React to commit: doing it in the click handler, even
   * behind a requestAnimationFrame, focuses the button that is about to go and
   * lands on body anyway (measured). An effect runs after the new list is on
   * the page, so the row it lands on is one that survived.
   */
  const acted = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const card = acted.current
    if (!card) return
    acted.current = null
    // The CARD, not the list: a list that empties is replaced by its "nothing
    // here" paragraph, and a detached <ul> has no card left to ask.
    const next = card.querySelector<HTMLElement>('.wardrobe-list-row button')
    const heading = card.querySelector<HTMLElement>('h3')
    const to = next ?? heading
    if (!to) return
    // a heading is not focusable on its own; it is the right place to land when
    // the list has just emptied, so it takes a tabindex for the moment
    if (to === heading) to.tabIndex = -1
    to.focus({ preventScroll: true })
  })
  const months = wearsByMonth(ix, year, now)
  const report = wardrobeYearReport(garments, ix, year, now)
    .slice(0, 20)
    .map(r => ({ ...r, key: r.garment.id, name: r.garment.name }))
  const uniform = yourUniform(ix, byId, outfits)
  // your uniform heads the list, so the rest follow it: five in all, as before
  const repeats = repeatedOutfits(ix, byId, outfits).slice(1, 5)
  const cost = wardrobeCosts(garments, ix)

  return (
    <div className="wardrobe-stats">
      <div className="kpi-row wardrobe-tiles">
        <StatTile label="Clothes" value={String(tiles.pieces)} sub="in use; retired ones aside" />
        <StatTile label="Days logged" value={`${tiles.loggedThisMonth} of ${tiles.daysThisMonth}`} sub="this month so far" />
        <StatTile label="Worn lately" value={`${tiles.wornLately} of ${tiles.pieces}`} sub="pieces worn in the last 90 days" />
        <StreakTiles current={streaks.current} best={streaks.best} today={ix.looks.has(ix.dayKey)} />
      </div>

      <MonthCalendar
        prefix={PREFIX}
        title="Photo calendar"
        today={ix.dayKey}
        sub={(y, m) => `Each day’s look · ${countOf(lookCalendar(ix, y, m).filter(c => c.look).length, 'day')} logged`}
        day={day => {
          // a day that has come opens Outfit on it — to see its look, or to log one it never had
          const on = lookOn(ix, day)
          if (!on) return { what: 'nothing logged' }
          return {
            what: `${outfitLabel(on.look.garmentIds, byId)}${on.looks > 1 ? `, and ${countOf(on.looks - 1, 'more look')}` : ''}`,
            content: <Collage ids={on.look.garmentIds} byId={byId} />,
            className: 'has-look',
          }
        }}
        onOpen={onGoDay}
      />

      {podium.length > 0 && (
        <ChartCard title="Top three" sub="Your most worn of all time, in days">
          <Podium
            top={podium}
            picture={r => <GarmentPhoto garment={r.garment} className="podium-photo" />}
            note={r => (r.garment.archivedAt ? ' · Retired' : '')}
            onOpen={r => onOpenPiece(r.key)}
          />
        </ChartCard>
      )}

      <RankedBars
        prefix={PREFIX}
        title="Most worn"
        sub="Days worn: two looks on one day count once"
        empty="Log a few days and your most worn shows here."
        rank={span => mostWorn(garments, ix, span).map(ranked)}
        // a photo's white or navy is moved just far enough to stand out on the theme's card
        color={r => r.garment.color}
        picture={r => <GarmentPhoto garment={r.garment} className="thumb-28" />}
        badge={r => r.garment.archivedAt && <span className="badge wardrobe-retired">Retired</span>}
        onOpen={r => onOpenPiece(r.key)}
      />

      <ListCard
        prefix={PREFIX}
        title="Not worn lately"
        sub={`Worn before, but not in ${NOT_WORN_DAYS} days or more`}
        items={rested}
        empty="Nothing has rested that long."
        row={g => (
          <PieceRow
            key={g.id}
            garment={g}
            line={`Last worn ${daysAgo(daysBetween(ix.days.get(g.id)![0], ix.dayKey))}`}
            onOpen={onOpenPiece}
            onRetire={onRetire}
            onWearToday={onWearToday}
            onActed={card => {
              acted.current = card
            }}
          />
        )}
      />

      <ListCard
        prefix={PREFIX}
        title="Never worn"
        sub="Added a week or more ago, and not logged since"
        items={never}
        empty="Everything added over a week ago has been worn."
        row={g => (
          <PieceRow
            key={g.id}
            garment={g}
            line={`Added ${daysAgo(daysBetween(dateKey(g.createdAt), ix.dayKey))}`}
            onOpen={onOpenPiece}
            onRetire={onRetire}
            onWearToday={onWearToday}
            onActed={card => {
              acted.current = card
            }}
          />
        )}
      />

      <ChartCard
        className="year-report wardrobe-months"
        title="Wears by month"
        sub="Days logged each month · trend compares the last 90 days with the 90 before"
        aside={<Stepper label={String(year)} unit="year" canNext={year < thisYear} onStep={delta => setYear(y => Math.min(thisYear, y + delta))} />}
      >
        <MonthBars
          prefix={PREFIX}
          months={months.months}
          current={year === thisYear ? Number(ix.dayKey.slice(5, 7)) - 1 : -1}
          label="Days logged"
          total={`${countOf(months.total, 'day')} logged in ${year}`}
          trend={months.trend}
        />
        <details className="wardrobe-by-piece">
          <summary>By piece</summary>
          <YearTable rows={report} head="Piece" noun="day" totalHead="Days" color={r => markInk(r.garment.color, theme)} empty={`Nothing was worn in ${year}.`} />
        </details>
      </ChartCard>

      <ChartCard title="Most repeated outfits" sub="The same top and bottom, or one-piece, whatever went with them">
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
      </ChartCard>

      {cost.rows.length > 0 && (
        <ListCard
          prefix={PREFIX}
          title="Cost per wear"
          sub={`${formatMoney(cost.spent)} across ${countOf(cost.rows.length, 'piece')}${cost.perWear !== undefined ? ` · ${formatMoney(cost.perWear)} a wear overall` : ''}`}
          items={cost.rows.slice(0, 20)}
          row={r => (
            <ListRow
              key={r.garment.id}
              prefix={PREFIX}
              picture={<GarmentPhoto garment={r.garment} className="thumb-40" />}
              name={r.garment.name}
              line={`${formatMoney(r.price)} · ${r.wears > 0 ? `worn on ${countOf(r.wears, 'day')}` : 'not worn yet'}`}
              onOpen={() => onOpenPiece(r.garment.id)}
              action={
                <span className="wardrobe-cpw">
                  {r.perWear !== undefined ? (
                    <>
                      <strong>{formatMoney(r.perWear)}</strong> <small className="muted">a wear</small>
                    </>
                  ) : (
                    <small className="muted">no wears yet</small>
                  )}
                </span>
              }
            />
          )}
        />
      )}
    </div>
  )
}
