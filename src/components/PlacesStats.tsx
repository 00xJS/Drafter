import { useMemo, useState } from 'react'
import { readableInk } from '../contrast'
import { daysAgo, daysBetween, shortDay } from '../kitchen'
import { countOf } from '../people'
import { placeEmoji, placeStats, placeYearReport } from '../places'
import {
  companyOnOutings,
  kindChips,
  mealsOut,
  mostVisited,
  neverBeen,
  notBeenBack,
  outingsByKind,
  outingsByMonth,
  placesByDay,
  placesOfKind,
  placesTiles,
  usualCompany,
  type KindFilter,
} from '../placestats'
import { MONTHS } from '../stats'
import { useTheme } from '../theme'
import { PLACE_CATEGORY_META, type Meal, type Person, type Place, type Task } from '../types'
import { dateKey } from '../utils'
import { PersonFace } from './PersonFace'
import { ChartCard, ListCard, ListRow, MonthBars, MonthCalendar, Podium, RankedBars, StatTile, Stepper, YearTable, markInk } from './stats'

interface Props {
  places: Place[]
  people: Person[]
  /** The tasks the list is handed: every one, as places are the household's. */
  tasks: Task[]
  /** Meals eaten out at a place count as outings there, as they do on the list. */
  meals: Meal[]
  /** Places → List with this place's row open: the podium, the bars and the lists open it. */
  onOpenPlace(place: Place): void
  /** A trip there, as the row's Plan a trip plans one. */
  onPlan(place: Place): void
  /** A person's card on People: Who you go with opens it. */
  onOpenPerson?(person: Person): void
  /** The Calendar on a day: the month calendar's days open it. */
  onOpenDay?(day: string): void
  /**
   * Mine is on in a household. These figures still count everyone's outings,
   * as the list does, but the Calendar a day opens shows only your tasks, so
   * the month calendar says so.
   */
  mineOnCalendar?: boolean
  /** The clock the figures are read from; the tests hand one in. */
  now?: Date
}

/** "Nopi", "Nopi and Pret", "Pret, Nopi and Franco's". */
const andList = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

/** The year table's month heads: one letter each, as the table under the list always had, so it stays narrow. */
const INITIALS = MONTHS.map(m => m.slice(0, 1))

/** How many places a calendar day shows before "+n". */
const DAY_DOTS = 3

/** A place's emoji on its own colour, that colour moved as far as it takes to read on this theme (readableInk). */
function PlaceMark({ place, className }: { place: Place; className: string }) {
  const theme = useTheme()
  return (
    <span className={`place-mark ${className}`} style={{ background: readableInk(place.color, theme) }} aria-hidden="true">
      {placeEmoji(place)}
    </span>
  )
}

/** A calendar day's places: up to three emoji, then "+n". The day's own label names them all. */
function PlaceDots({ places }: { places: readonly Place[] }) {
  return (
    <span className="place-dots" aria-hidden="true">
      {places.slice(0, DAY_DOTS).map(p => (
        <PlaceMark key={p.id} place={p} className="place-dot" />
      ))}
      {places.length > DAY_DOTS && <span className="place-dots-more">+{places.length - DAY_DOTS}</span>}
    </span>
  )
}

function PlaceListRow({ place, line, onOpen, onPlan }: { place: Place; line: string; onOpen(p: Place): void; onPlan(p: Place): void }) {
  return (
    <ListRow
      picture={<PlaceMark place={place} className="thumb-40" />}
      name={place.name}
      line={line}
      onOpen={() => onOpen(place)}
      action={
        <button type="button" className="btn subtle" onClick={() => onPlan(place)}>
          Plan a trip
        </button>
      }
    />
  )
}

/**
 * People → Places → Stats: where you go, counted in outings — the list's kind
 * chips, narrowing everything under them; the tiles; the month in places; the
 * podium of the three most visited of all time; the most visited over 30 days,
 * 12 months or all time; where you have not been back and where you have never
 * been; the year by month with the year in places under it; each kind's share
 * (under All); who you go with; and the meals eaten out. Every figure is read
 * off the rows' own stats (src/placestats.ts), so it agrees with the list, and
 * drawn with the Stats kit (components/stats).
 */
export function PlacesStats({ places, people, tasks, meals, onOpenPlace, onPlan, onOpenPerson, onOpenDay, mineOnCalendar = false, now: handed }: Props) {
  const theme = useTheme()
  // One clock for the day. PeopleScreen re-renders with every Planner render
  // (a sync, a toast, a record changed on another device), so each figure is
  // worked out once and kept until what it reads changes, as the list keeps
  // its rows; the first render after midnight starts the new day's clock.
  const today = dateKey(handed ?? new Date())
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `today` is the point: a new day, a new clock
  const now = useMemo(() => handed ?? new Date(), [handed, today])
  const thisYear = now.getFullYear()
  const [year, setYear] = useState(thisYear)
  // The list's kind chips, narrowing every figure as they narrowed its tiles
  // and its table. Not remembered, as the list's are not; a kind whose last
  // place has gone falls back to All.
  const [chosen, setChosen] = useState<KindFilter>('all')
  const chips = useMemo(() => kindChips(places), [places])
  const kind: KindFilter = chosen !== 'all' && chips.some(c => c.kind === chosen) ? chosen : 'all'
  const shown = useMemo(() => placesOfKind(places, kind), [places, kind])
  const stats = useMemo(() => shown.map(p => placeStats(p, tasks, people, now, meals)), [shown, tasks, people, now, meals])
  const figures = useMemo(
    () => ({
      tiles: placesTiles(stats, now),
      podium: mostVisited(stats, 'all', now, 3),
      back: notBeenBack(stats),
      never: neverBeen(stats),
      days: placesByDay(stats),
      usual: usualCompany(stats),
      eaten: mealsOut(stats, now.getFullYear()),
    }),
    [stats, now],
  )
  const months = useMemo(() => outingsByMonth(stats, year, now), [stats, year, now])
  const report = useMemo(
    () => placeYearReport(shown, tasks, meals, year, now).map(r => ({ ...r, key: r.place.id, name: r.place.name })),
    [shown, tasks, meals, year, now],
  )

  if (places.length === 0)
    return (
      <div className="place-stats">
        <div className="chart-card">
          <p className="empty">Add the places you go on the List — restaurants, parks, venues — and log an outing: how often you go, where and who with show here.</p>
        </div>
      </div>
    )

  const { tiles, podium, back, never, days, usual, eaten } = figures
  /** A month of the calendar in words: its outings, as the year's bars count them, on how many days. */
  const monthLine = (y: number, m: number) => {
    const outings = outingsByMonth(stats, y, now).months[m - 1]
    const prefix = `${y}-${String(m).padStart(2, '0')}`
    const out = [...days.keys()].filter(k => k.startsWith(prefix)).length
    const line = outings ? `Each day’s places · ${countOf(outings, 'outing')} on ${countOf(out, 'day')}` : 'Each day’s places · no outings'
    // places are the household's, so these are everyone's outings, while the Calendar a day opens follows Mine
    return mineOnCalendar ? `${line} · counting everyone, though Mine keeps the Calendar to your tasks` : line
  }

  return (
    <div className="place-stats">
      <div className="people-controls">
        <span className="segmented" role="group" aria-label="Kind of place">
          <button type="button" aria-pressed={kind === 'all'} className={kind === 'all' ? 'seg on' : 'seg'} onClick={() => setChosen('all')}>
            All <span className="board-count">{places.length}</span>
          </button>
          {chips.map(c => (
            <button key={c.kind} type="button" aria-pressed={kind === c.kind} className={kind === c.kind ? 'seg on' : 'seg'} onClick={() => setChosen(c.kind)}>
              {PLACE_CATEGORY_META[c.kind].label} <span className="board-count">{c.count}</span>
            </button>
          ))}
        </span>
      </div>

      <div className="kpi-row people-kpis">
        <StatTile label="Places" value={String(tiles.places)} sub={kind === 'all' ? 'saved, every kind' : `saved, ${PLACE_CATEGORY_META[kind].label.toLowerCase()} only`} />
        <StatTile label="Outings this year" value={String(tiles.outingsThisYear)} sub="a meal eaten out there included" />
        <StatTile label="Outings this month" value={String(tiles.outingsThisMonth)} sub={`in ${MONTHS[now.getMonth()]} so far`} />
        <StatTile label="Been a while" value={String(tiles.beenAWhile)} sub="due or overdue a return" />
        <StatTile label="New this year" value={String(tiles.newThisYear)} sub={`a first outing in ${thisYear}`} className="kpi-wide" />
      </div>

      <MonthCalendar
        title="Where you went"
        today={today}
        sub={monthLine}
        day={key => {
          const went = days.get(key)
          if (!went) return { what: 'no outings' }
          return { what: andList(went.map(p => p.name)), content: <PlaceDots places={went} />, className: 'has-outing' }
        }}
        onOpen={onOpenDay}
      />

      {podium.length > 0 && (
        <ChartCard title="Top three" sub="Your most visited of all time, in outings">
          <Podium top={podium} noun="outing" picture={r => <PlaceMark place={r.place} className="podium-photo" />} onOpen={r => onOpenPlace(r.place)} />
        </ChartCard>
      )}

      <RankedBars
        title="Most visited"
        sub="Outings: a done task there or a meal eaten out there, two in one day counted as two"
        empty="Log an outing, or eat out somewhere you saved, and your most visited show here."
        rank={span => mostVisited(stats, span, now)}
        // a pale colour is moved just far enough to stand out on the theme's card
        color={r => r.place.color}
        picture={r => <PlaceMark place={r.place} className="thumb-28" />}
        onOpen={r => onOpenPlace(r.place)}
      />

      <ListCard
        title="Not been back"
        sub="Been before, and longer ago than their rhythm: the one you set, or with none, twice your usual gap and four months at least"
        items={back}
        empty="Nowhere has gone past its rhythm."
        row={s => <PlaceListRow key={s.place.id} place={s.place} line={s.reason} onOpen={onOpenPlace} onPlan={onPlan} />}
      />

      <ListCard
        title="Never been"
        sub="Saved, with no outing yet"
        items={never}
        empty="You have been to every place you saved."
        row={s => (
          <PlaceListRow
            key={s.place.id}
            place={s.place}
            line={`${PLACE_CATEGORY_META[s.place.category].label} · saved ${daysAgo(daysBetween(dateKey(s.place.createdAt), today))}`}
            onOpen={onOpenPlace}
            onPlan={onPlan}
          />
        )}
      />

      <ChartCard
        className="year-report place-stats-year"
        title="The year in places"
        sub="Outings per month, a meal eaten out there included, two in one day counted as two · trend compares outings in the last 90 days with the 90 before"
        aside={<Stepper label={String(year)} unit="year" canNext={year < thisYear} onStep={delta => setYear(y => Math.min(thisYear, y + delta))} />}
      >
        <MonthBars
          months={months.months}
          current={year === thisYear ? now.getMonth() : -1}
          label="Outings"
          noun="outing"
          total={`${countOf(months.total, 'outing')} in ${year}`}
          trend={months.trend}
        />
        {/* a pale place's dot and cells are its colour moved to show on the card, as the wardrobe's are */}
        <YearTable rows={report} head="Place" noun="outing" totalHead="Outings" months={INITIALS} color={r => markInk(r.place.color, theme)} />
      </ChartCard>

      {kind === 'all' && (
        <RankedBars
          title="By kind"
          sub="Each kind of place's share of your outings"
          empty="Log an outing and each kind’s share shows here."
          rank={span => outingsByKind(stats, span, now)}
          picture={r => (
            <span className="place-kind-emoji" aria-hidden="true">
              {r.emoji}
            </span>
          )}
          badge={r => <small className="muted">{Math.round(r.share * 100)}%</small>}
        />
      )}

      <RankedBars
        title="Who you go with"
        sub="Who was there on your outings; a meal eaten out records the place, not the company"
        empty="Tick who was there when you log an outing, and who you go with shows here."
        rank={span => companyOnOutings(stats, people, span, now)}
        color={r => r.person.color}
        // a face, as People → Stats draws each person: their colour read through readableInk
        picture={r => <PersonFace person={r.person} theme={theme} className="face-28" />}
        onOpen={onOpenPerson ? r => onOpenPerson(r.person) : undefined}
      />

      {usual.length > 0 && (
        <ListCard
          title="Usually with"
          sub="Your most visited places, and who you most often go there with"
          items={usual}
          row={u => (
            <ListRow
              key={u.place.id}
              picture={<PlaceMark place={u.place} className="thumb-40" />}
              name={u.place.name}
              line={`Usually with ${u.person.name} ×${u.count}`}
              onOpen={() => onOpenPlace(u.place)}
            />
          )}
        />
      )}

      <ListCard
        title="Meals out"
        sub={`${countOf(eaten.total, 'meal')} eaten out at your places in ${thisYear}${tiles.outingsThisYear ? `, of ${countOf(tiles.outingsThisYear, 'outing')}` : ''} · each on its own date once it has come, as the Outings tile counts them`}
        items={eaten.rows}
        empty="Plan a meal in Kitchen as eaten out at one of your places, and once its day has come it counts here."
        row={r => (
          <ListRow
            key={r.key}
            picture={<PlaceMark place={r.place} className="thumb-40" />}
            name={r.name}
            line={`${countOf(r.count, 'meal')} · last ${shortDay(r.last, today)}`}
            onOpen={() => onOpenPlace(r.place)}
          />
        )}
      />
    </div>
  )
}
