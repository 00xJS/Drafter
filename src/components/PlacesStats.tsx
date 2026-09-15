import { useState } from 'react'
import { readableInk } from '../contrast'
import { daysAgo, daysBetween, shortDay } from '../kitchen'
import { countOf } from '../people'
import { placeEmoji, placeStats, placeYearReport } from '../places'
import { companyOnOutings, mealsOut, mostVisited, neverBeen, notBeenBack, outingsByKind, outingsByMonth, placesByDay, placesTiles, usualCompany } from '../placestats'
import { MONTHS } from '../stats'
import { useTheme } from '../theme'
import { PLACE_CATEGORY_META, type Meal, type Person, type Place, type Task } from '../types'
import { dateKey } from '../utils'
import { ChartCard, ListCard, ListRow, MonthBars, MonthCalendar, Podium, RankedBars, StatTile, Stepper, YearTable } from './stats'

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

/** A person as their row on People draws them: their emoji or initial on their own colour. */
function PersonMark({ person }: { person: Person }) {
  return (
    <span className="person-avatar small" style={{ background: person.color }} aria-hidden="true">
      {person.emoji ?? person.name.slice(0, 1).toUpperCase()}
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
 * People → Places → Stats: where you go, counted in outings — the tiles; the
 * month in places; the podium of the three most visited of all time; the most
 * visited over 30 days, 12 months or all time; where you have not been back
 * and where you have never been; the year by month with the year in places
 * under it; each kind's share; who you go with; and the meals eaten out. Every
 * figure is read off the rows' own stats (src/placestats.ts), so it agrees
 * with the list, and drawn with the Stats kit (components/stats).
 */
export function PlacesStats({ places, people, tasks, meals, onOpenPlace, onPlan, onOpenPerson, onOpenDay, now = new Date() }: Props) {
  const thisYear = now.getFullYear()
  const [year, setYear] = useState(thisYear)
  const todayKey = dateKey(now)

  if (places.length === 0)
    return (
      <div className="place-stats">
        <div className="chart-card">
          <p className="empty">Add the places you go on the list — restaurants, parks, venues — and log an outing: how often you go, where, and who with shows here.</p>
        </div>
      </div>
    )

  const stats = places.map(p => placeStats(p, tasks, people, now, meals))
  const tiles = placesTiles(stats, now)
  const podium = mostVisited(stats, 'all', now, 3)
  const back = notBeenBack(stats)
  const never = neverBeen(stats)
  const days = placesByDay(stats)
  const months = outingsByMonth(stats, year, now)
  const report = placeYearReport(places, tasks, meals, year, now).map(r => ({ ...r, key: r.place.id, name: r.place.name }))
  const usual = usualCompany(stats)
  const eaten = mealsOut(stats, thisYear)
  /** A month of the calendar in words: its outings, as the year's bars count them, on how many days. */
  const monthLine = (y: number, m: number) => {
    const outings = outingsByMonth(stats, y, now).months[m - 1]
    const prefix = `${y}-${String(m).padStart(2, '0')}`
    const out = [...days.keys()].filter(k => k.startsWith(prefix)).length
    return outings ? `Where you went each day · ${countOf(outings, 'outing')} on ${countOf(out, 'day')}` : 'Where you went each day · no outings'
  }

  return (
    <div className="place-stats">
      <div className="kpi-row people-kpis">
        <StatTile label="Places" value={String(tiles.places)} sub="saved, every kind" />
        <StatTile label="Outings this year" value={String(tiles.outingsThisYear)} sub="a meal eaten out there included" />
        <StatTile label="Outings this month" value={String(tiles.outingsThisMonth)} sub={`in ${MONTHS[now.getMonth()]} so far`} />
        <StatTile label="Been a while" value={String(tiles.beenAWhile)} sub="due or overdue a return" />
        <StatTile label="New this year" value={String(tiles.newThisYear)} sub={`a first outing in ${thisYear}`} className="kpi-wide" />
      </div>

      <MonthCalendar
        title="Where you went"
        today={todayKey}
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
        empty="Nothing in this window yet: log an outing, or eat out somewhere you saved."
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
            line={`${PLACE_CATEGORY_META[s.place.category].label} · saved ${daysAgo(daysBetween(dateKey(s.place.createdAt), todayKey))}`}
            onOpen={onOpenPlace}
            onPlan={onPlan}
          />
        )}
      />

      <ChartCard
        className="year-report place-stats-year"
        title="The year in places"
        sub="Outings per month, a meal eaten out there included, two in one day counted as two · trend compares outings in the last 90 days with the 90 before"
        aside={<Stepper label={String(year)} unit="year" onStep={delta => setYear(y => y + delta)} />}
      >
        <MonthBars
          months={months.months}
          current={year === thisYear ? now.getMonth() : -1}
          label="Outings"
          noun="outing"
          total={`${countOf(months.total, 'outing')} in ${year}`}
          trend={months.trend}
        />
        <YearTable rows={report} head="Place" noun="outing" totalHead="Outings" months={INITIALS} color={r => r.place.color} />
      </ChartCard>

      <RankedBars
        title="By kind"
        sub="Each kind of place's share of your outings"
        empty="Nothing in this window yet."
        rank={span => outingsByKind(stats, span, now)}
        picture={r => (
          <span className="place-kind-emoji" aria-hidden="true">
            {r.emoji}
          </span>
        )}
        badge={r => <small className="muted">{Math.round(r.share * 100)}%</small>}
      />

      <RankedBars
        title="Who you go with"
        sub="Who was there on your outings; a meal eaten out records the place, not the company"
        empty="Tick who was there when you log an outing, and who you go with shows here."
        rank={span => companyOnOutings(stats, people, span, now)}
        color={r => r.person.color}
        picture={r => <PersonMark person={r.person} />}
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
            line={`${countOf(r.count, 'meal')} · last ${shortDay(r.last, todayKey)}`}
            onOpen={() => onOpenPlace(r.place)}
          />
        )}
      />
    </div>
  )
}
