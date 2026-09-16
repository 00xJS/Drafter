import { Suspense, useMemo, useState } from 'react'
import { formatMoney } from '../bills'
import { doneByPriority, doneByTag, doneMonths, habitReport, journalReport, moneyReport, taskReport } from '../lensstats'
import { wardrobeCosts } from '../wardrobe'
import { kitchenIndex, kitchenTiles } from '../kitchenstats'
import { countOf } from '../people'
import { getTogethers, peopleSeen } from '../peoplestats'
import { outingsAt } from '../places'
import { DAY_WINDOWS, countDays, distinctDays, monthBuckets, type DayWindow } from '../stats'
import { inWindow } from '../../shared/stats.mjs'
import { useTheme } from '../theme'
import { MOOD_META, MOODS, type CalendarEntry, type Garment, type GroceryList, type Habit, type JournalEntry, type Meal, type Outfit, type Person, type Place, type Recipe, type Task, type Wear } from '../types'
import type { PersonFilter } from '../people'
import type { PlaceFilter } from '../places'
import type { WearIndex } from '../wardrobe'
import { dateKey } from '../utils'
import { wearIndex } from '../../shared/wardrobe.mjs'
import { AreaCard, ChartCard, HeatGrid, MonthBars, RankedBars, Ring, Segmented, StatTile, Stepper, StreakTiles, WindowSwitch, markInk } from './stats'
import { KitchenStats, PeopleStats, PlacesStats, WardrobeStats } from './planner/lazy'
import { STATS_TABS, type StatsTab } from './planner/routes'

/*
 * The Stats lens: the sixth tab, and the only one you never add anything to.
 * Every figure the app keeps is in here — nothing sends you to another tab to
 * read half of them.
 *
 * Overview reads across all of it and its cards move the segment below.
 * Four segments hold the areas with nowhere else to be counted (what you
 * finish, what you pay, what you keep up, what you write), and those are
 * counted in src/lensstats.ts, pure. The other four — People, Places, Kitchen
 * and the Wardrobe — keep Stats of their own inside their areas, and the lens
 * draws THE SAME COMPONENT rather than a second version of it, reading the
 * same find boxes and chips (useListFilters). One view, one chunk, one set of
 * numbers, wherever you look at it.
 *
 * Nothing personal leaves the device, and nothing written in the journal is
 * quoted — the journal's figures are counts and moods only.
 */

/** What the lens's own segments count by: the kit's own windows. */
const LENS_WINDOWS: readonly { key: DayWindow; label: string }[] = DAY_WINDOWS

/**
 * The segments the window switch governs. Money is counted by a year, chosen on
 * its own ‹ 2026 ›, and the four area views bring their own switches inside
 * their cards — so on those five the page-level switch would sit there doing
 * nothing, which is worse than not being there. It is shown only where it works.
 */
const WINDOWED: ReadonlySet<StatsTab> = new Set<StatsTab>(['overview', 'tasks', 'habits', 'journal'])

export interface StatsLensProps {
  tab: StatsTab
  onTab(tab: StatsTab): void
  tasks: Task[]
  people: Person[]
  places: Place[]
  events: CalendarEntry[]
  meals: Meal[]
  recipes: Recipe[]
  journal: JournalEntry[]
  habits: Habit[]
  garments: Garment[]
  outfits: Outfit[]
  wears: Wear[]
  groceries: GroceryList[]
  /** Tasks → List, for the counters that are really a to-do list. */
  onTasks(): void
  /** Everything the four areas' own Stats need, handed straight through (see StatsScreen). */
  areas: AreaProps
  now?: Date
}

/**
 * What the four in-area Stats are given. They are the components People,
 * Places, Kitchen and Home → Wardrobe draw, unchanged, so this is their own
 * contract — the lens only passes it along. The filters are the lists' own
 * (useListFilters), which is what keeps a figure here equal to the same figure
 * there.
 */
export interface AreaProps {
  peopleFilter: PersonFilter
  onPeopleFilter(f: PersonFilter): void
  placeFilter: PlaceFilter
  onPlaceFilter(f: PlaceFilter): void
  mineOnCalendar: boolean
  onOpenPerson(p: Person): void
  onOpenPlace(p: Place): void
  onOpenDay(day: string): void
  onSaw(p: Person): void
  onPlanAt(p: Place): void
  onOpenRecipe(r: Recipe): void
  onGoMealDay(day: string): void
  onOpenPiece(id: string): void
  onRetirePiece(g: Garment): void
  onSaveOutfit(pieces: string[]): void
  onGoWearDay(day: string): void
  /** liveById(garments) and wearIndex(wears, today), memoized by the screen. */
  byId: ReadonlyMap<string, Garment>
  wearIx: WearIndex
}

export function StatsLens(p: StatsLensProps) {
  const { tab, onTab, areas: a, now: handed } = p
  // One clock for the day, as People's and Places' Stats keep one. A fresh
  // `new Date()` in the parameter list is a new object every render, and it is
  // a dependency of every report below — so each keystroke in a find box, each
  // sync and each toast recomputed the lot. The first render after midnight
  // starts the new day's clock.
  const today = dateKey(handed ?? new Date())
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `today` is the point: a new day, a new clock
  const now = useMemo(() => handed ?? new Date(), [handed, today])
  const [span, setSpan] = useState<DayWindow>(30)
  const [year, setYear] = useState(now.getFullYear())
  // the headings read "The last {spanWords}", so 'All' has to become words that
  // finish that sentence — "the last all" is not a phrase
  const spanWords = span === 'all' ? 'all time' : (LENS_WINDOWS.find(w => w.key === span)?.label.toLowerCase() ?? 'all time')
  return (
    <>
      <div className="stats-bar">
        {/* nine segments: more than a phone line holds, so the track scrolls
            and keeps the chosen one in view */}
        <Segmented items={STATS_TABS} value={tab} onChange={onTab} label="Stats view" scroll />
        {/* One question at a time: the segments the window governs all read it,
            so choosing 12 months on Tasks and moving to Habits keeps what you
            were asking. Where it would govern nothing it is not drawn. */}
        {WINDOWED.has(tab) && (
          <div className="stats-window">
            <WindowSwitch value={span} onChange={setSpan} windows={LENS_WINDOWS} />
          </div>
        )}
      </div>
      <div className="stats-lens">
        {tab === 'overview' && <Overview {...p} span={span} spanWords={spanWords} now={now} />}
        {tab === 'tasks' && <TasksLens {...p} span={span} spanWords={spanWords} year={year} setYear={setYear} now={now} />}
        {tab === 'money' && <MoneyLens {...p} span={span} spanWords={spanWords} year={year} setYear={setYear} now={now} />}
        {tab === 'habits' && <HabitsLens {...p} span={span} spanWords={spanWords} now={now} />}
        {tab === 'journal' && <JournalLens {...p} span={span} spanWords={spanWords} year={year} setYear={setYear} now={now} />}
        {/* The four areas that count themselves, drawn here as they are drawn
            there. Each waits on its own chunk, so the lens's own segments never
            wait on a chunk they do not use. */}
        <Suspense fallback={<div className="view-pending" aria-busy="true" />}>
          {tab === 'people' && (
            <PeopleStats
              people={p.people}
              tasks={p.tasks}
              entries={p.events}
              filter={a.peopleFilter}
              onFilter={a.onPeopleFilter}
              onSaw={a.onSaw}
              onOpenPerson={a.onOpenPerson}
              onOpenDay={a.onOpenDay}
              mineOnCalendar={a.mineOnCalendar}
            />
          )}
          {tab === 'places' && (
            <PlacesStats
              places={p.places}
              people={p.people}
              tasks={p.tasks}
              meals={p.meals}
              filter={a.placeFilter}
              onFilter={a.onPlaceFilter}
              onOpenPlace={a.onOpenPlace}
              onPlan={a.onPlanAt}
              onOpenPerson={a.onOpenPerson}
              onOpenDay={a.onOpenDay}
              mineOnCalendar={a.mineOnCalendar}
            />
          )}
          {tab === 'kitchen' && <KitchenStats recipes={p.recipes} meals={p.meals} groceries={p.groceries} places={p.places} onOpenRecipe={a.onOpenRecipe} onGoDay={a.onGoMealDay} />}
          {tab === 'wardrobe' && (
            <WardrobeStats
              garments={p.garments}
              outfits={p.outfits}
              byId={a.byId}
              ix={a.wearIx}
              onOpenPiece={a.onOpenPiece}
              onRetire={a.onRetirePiece}
              onSaveOutfit={a.onSaveOutfit}
              onGoDay={a.onGoWearDay}
            />
          )}
        </Suspense>
      </div>
    </>
  )
}

type Lens = StatsLensProps & { span: DayWindow; spanWords: string; now: Date }
type YearLens = Lens & { year: number; setYear(y: number): void }

/** ‹ year › over a card, stopping at this year: no year still to come is offered. */
function YearStep({ year, setYear, now }: { year: number; setYear(y: number): void; now: Date }) {
  return <Stepper label={String(year)} unit="year" canNext={year < now.getFullYear()} onStep={d => setYear(year + d)} />
}

// ---- Overview --------------------------------------------------------------------

function Overview(p: Lens) {
  const { tasks, people, places, events, meals, recipes, journal, habits, garments, wears, areas: a, span, spanWords, now } = p
  const theme = useTheme()
  const year = now.getFullYear()
  const report = useMemo(() => taskReport(tasks, span, now), [tasks, span, now])
  const ix = useMemo(() => kitchenIndex(recipes, meals, places, now), [recipes, meals, places, now])
  const kitchen = useMemo(() => kitchenTiles(ix), [ix])
  const wear = useMemo(() => wearIndex(wears, dateKey(now)), [wears, now])
  // seenTasks is a HAYSTACK — every task plus the past events with people on
  // them — which People narrows per person. Mapping it raw made every day you
  // finished any chore a day you saw someone, and counted tasks in Trash too.
  // getTogethers is the narrowing People's own tiles use, so the two agree.
  const { seen, all } = useMemo(() => peopleSeen(people, tasks, events, now), [people, tasks, events, now])
  const together = useMemo(() => getTogethers(all, seen), [all, seen])
  const jr = useMemo(() => journalReport(journal, span, year, now), [journal, span, year, now])
  const hr = useMemo(() => habitReport(habits, span, now), [habits, span, now])
  const money = useMemo(() => moneyReport(tasks, year, now), [tasks, year, now])
  // the Wardrobe's own rule, over the index the screen built: a piece's price
  // over the DAYS it was worn, so the lens and Home → Wardrobe agree exactly
  const clothes = useMemo(() => wardrobeCosts(garments, a.wearIx), [garments, a.wearIx])
  const doneSeries = useMemo(() => monthBuckets(together, year, countDays), [together, year])
  // every tile under "the last …" counts that window and nothing else, so the
  // four of them are answering one question rather than four
  const today = dateKey(now)
  const peopleDays = useMemo(() => distinctDays(together, iso => dateKey(new Date(iso))).filter(d => inWindow(d, today, span)), [together, today, span])
  const cookedDays = useMemo(() => ix.meals.filter(m => ix.ways.get(m.id) === 'cooked' && inWindow(m.date, today, span)).map(m => m.date), [ix, today, span])
  const dressedDays = useMemo(() => wear.logged.filter(d => inWindow(d, today, span)), [wear, today, span])
  // outingsAt is the app's one rule for having been somewhere: a done task
  // carrying the place, AND a past meal eaten out there — counting a takeaway
  // is what keeps the Kitchen and Places agreeing. Only over places that still
  // exist, or the ring could read more than its own total.
  const livePlaces = useMemo(() => places.filter(pl => !pl.deletedAt), [places])
  const placesVisited = useMemo(() => livePlaces.filter(pl => outingsAt(pl.id, tasks, meals, now).length > 0).length, [livePlaces, tasks, meals, now])
  const done = useMemo(() => monthBuckets(tasks.filter(t => !t.deletedAt && t.status === 'done' && t.completedAt).map(t => ({ at: t.completedAt as string })), year), [tasks, year])
  return (
    <>
      <section className="stats-section">
        <h2>The last {spanWords}</h2>
        <div className="kpi-row">
          <StatTile label="Finished" value={String(report.done)} sub={report.done === 0 ? 'nothing ticked off yet' : `${countOf(report.days.length, 'day')} with something done`} />
          <StatTile label="Days seen" value={String(peopleDays.length)} sub="with anyone on your list" />
          <StatTile label="Cooked at home" value={String(new Set(cookedDays).size)} sub="days with a meal you made" />
          <StatTile label="Days dressed" value={String(dressedDays.length)} sub="looks you logged" />
        </div>
      </section>

      <section className="stats-section">
        <h2>Kept up</h2>
        <p className="stats-note">A streak waits for today rather than breaking on it.</p>
        <div className="kpi-row">
          <StreakTiles current={report.streaks.current} best={report.streaks.best} today={report.streaks.today} words={{ today: 'with something done, today too', waiting: 'finish one to keep it going', none: 'finish something to start one', best: 'with something done' }} />
          <StatTile label="Journal" value={countOf(jr.streaks.current, 'day')} sub={jr.streaks.today ? 'written in a row, today too' : 'write today to keep it going'} />
          <StatTile label="Habits kept" value={`${hr.pct}%`} sub={hr.due > 0 ? `${hr.done} of ${hr.due} due in the last ${spanWords}` : 'nothing was due'} />
        </div>
      </section>

      <section className="stats-section">
        <h2>Each area</h2>
        {/* Every one of these opens a segment of THIS tab. Nothing here sends
            you to another tab to read the rest of your own figures. */}
        <p className="stats-note">Each opens that area&rsquo;s own figures, here.</p>
        <div className="area-list">
          <AreaCard name="Tasks" value={`${report.open} open`} sub={report.overdue > 0 ? `${report.overdue} past their date` : 'nothing overdue'} series={done} seriesLabel="Finished each month" onOpen={() => p.onTab('tasks')} openLabel="Open Tasks" />
          <AreaCard name="Money" value={formatMoney(money.spent)} sub={`paid in ${year}`} series={money.months} seriesLabel={`What you paid each month of ${year}`} onOpen={() => p.onTab('money')} openLabel="Open Money" />
          <AreaCard
            name="People"
            value={countOf(peopleDays.length, 'day')}
            sub={`with anyone, in the last ${spanWords}`}
            series={doneSeries}
            seriesLabel="Days you saw someone each month"
            onOpen={() => p.onTab('people')}
            openLabel="Open People"
          />
          <AreaCard
            name="Places"
            value={countOf(placesVisited, 'place')}
            sub="you have been to at least once"
            onOpen={() => p.onTab('places')}
            openLabel="Open Places"
            aside={<Ring value={placesVisited} of={Math.max(1, livePlaces.length)} size={52} label={String(placesVisited)} tone={markInk(undefined, theme)} />}
          />
          <AreaCard
            name="Kitchen"
            value={`${kitchen.cookedDays} of ${kitchen.daysThisMonth}`}
            sub="days cooked at home this month"
            onOpen={() => p.onTab('kitchen')}
            openLabel="Open Kitchen"
            aside={<Ring value={kitchen.cookedDays} of={Math.max(1, kitchen.daysThisMonth)} size={52} label={`${Math.round((kitchen.cookedDays / Math.max(1, kitchen.daysThisMonth)) * 100)}%`} />}
          />
          <AreaCard
            name="Wardrobe"
            value={countOf(garments.filter(g => !g.deletedAt && !g.archivedAt).length, 'piece')}
            sub={clothes.perWear === undefined ? 'nothing priced yet' : `${formatMoney(clothes.perWear)} a wear`}
            onOpen={() => p.onTab('wardrobe')}
            openLabel="Open Wardrobe"
          />
          <AreaCard name="Habits" value={`${hr.pct}%`} sub={hr.due > 0 ? `of ${hr.due} days due` : 'nothing was due'} onOpen={() => p.onTab('habits')} openLabel="Open Habits" />
          <AreaCard name="Journal" value={countOf(jr.entries, 'entry').replace('entrys', 'entries')} sub={`written in the last ${spanWords}`} onOpen={() => p.onTab('journal')} openLabel="Open Journal" />
        </div>
      </section>

      <section className="stats-section">
        <h2>A year of days</h2>
        <p className="stats-note">Every day you finished something. A column is a week; the newest is on the right.</p>
        <ChartCard title="Days with something done" sub={countOf(report.streaks.best, 'day').concat(' is the longest run there has been')}>
          <HeatGrid counts={new Map(countsByDay(tasks))} end={now} label="Days with something done" noun="task" />
        </ChartCard>
      </section>
    </>
  )
}

/** Each day paired with how many tasks were finished on it. */
function countsByDay(tasks: readonly Task[]): [string, number][] {
  const counts = new Map<string, number>()
  for (const t of tasks) {
    if (t.deletedAt || t.status !== 'done' || !t.completedAt) continue
    const key = dateKey(new Date(t.completedAt))
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts]
}

// ---- Tasks -----------------------------------------------------------------------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function TasksLens(p: YearLens) {
  const { tasks, span, spanWords, year, setYear, now } = p
  const report = useMemo(() => taskReport(tasks, span, now), [tasks, span, now])
  const months = useMemo(() => doneMonths(tasks, year, now), [tasks, year, now])
  const busiest = Math.max(1, ...report.weekday)
  return (
    <>
      <section className="stats-section">
        <h2>The last {spanWords}</h2>
        <div className="kpi-row">
          <StatTile label="Finished" value={String(report.done)} sub={`over ${countOf(report.days.length, 'day')}`} />
          <StatTile label="Still open" value={String(report.open)} sub="to do, doing or blocked" />
          <StatTile label="Overdue" value={String(report.overdue)} warn={report.overdue > 0} sub="past their date" onJump={p.onTasks} />
          <StreakTiles current={report.streaks.current} best={report.streaks.best} today={report.streaks.today} words={{ today: 'with something done, today too', waiting: 'finish one to keep it going', none: 'finish something to start one', best: 'with something done' }} />
        </div>
      </section>

      <section className="stats-section">
        <h2>When the work happens</h2>
        <ChartCard title="Each month" sub={`What you finished in ${year}`} aside={<YearStep year={year} setYear={setYear} now={now} />}>
          <MonthBars months={months.months} current={year === now.getFullYear() ? now.getMonth() : -1} label={`Finished each month of ${year}`} noun="task" total={countOf(months.total, 'task')} trend={months.trend} />
        </ChartCard>
        <ChartCard title="Which day of the week" sub={`Finished in the last ${spanWords}`}>
          {report.done === 0 ? (
            <p className="empty">Nothing was finished in this window.</p>
          ) : (
            <div className="lens-rows">
              {report.weekday.map((n, i) => (
                <div className="lens-row" key={WEEKDAYS[i]}>
                  <span className="lens-row-name">
                    <b>{WEEKDAYS[i]}</b>
                  </span>
                  <span className="lens-meter">
                    <span style={{ width: `${(n / busiest) * 100}%` }} />
                  </span>
                  <span className="lens-row-value">{n}</span>
                </div>
              ))}
            </div>
          )}
        </ChartCard>
        <ChartCard title="A year of days" sub="Every day you finished something">
          <HeatGrid counts={new Map(countsByDay(tasks))} end={now} label="Days with something done" noun="task" />
        </ChartCard>
      </section>

      <section className="stats-section">
        <h2>What the work is</h2>
        <RankedBars title="By tag" sub="Finished work, counted once per tag it carried" empty="No finished task carried a tag in this window." rank={w => doneByTag(tasks, w, now)} window={span} />
        <RankedBars title="By the priority it carried" sub="Finished work, as it was marked when you ticked it" empty="Nothing was finished in this window." rank={w => doneByPriority(tasks, w, now)} window={span} />
      </section>

      {(report.byStatus.length > 0 || report.aging.length > 0) && (
        <section className="stats-section">
          <h2>What is waiting</h2>
          <p className="stats-note">Open work is what is open now — no window narrows it.</p>
          {report.byStatus.length > 0 && (
            <ChartCard title="By status" sub="Everything still open">
              <div className="lens-rows">
                {report.byStatus.map(r => (
                  <div className="lens-row" key={r.key}>
                    <span className="lens-row-name">
                      <b>{r.name}</b>
                    </span>
                    <span className="lens-meter">
                      <span style={{ width: `${(r.count / Math.max(1, report.open)) * 100}%` }} />
                    </span>
                    <span className="lens-row-value">{r.count}</span>
                  </div>
                ))}
              </div>
            </ChartCard>
          )}
          {report.aging.length > 0 && (
            <ChartCard title="How long overdue" sub="The ones past their date, by how long they have waited">
              <div className="lens-rows">
                {report.aging.map(r => (
                  <div className="lens-row" key={r.key}>
                    <span className="lens-row-name">
                      <b>{r.name}</b>
                    </span>
                    <span className="lens-meter">
                      <span style={{ width: `${(r.count / Math.max(1, report.overdue)) * 100}%` }} />
                    </span>
                    <span className="lens-row-value">{r.count}</span>
                  </div>
                ))}
              </div>
            </ChartCard>
          )}
        </section>
      )}
    </>
  )
}

// ---- Money -----------------------------------------------------------------------

function MoneyLens(p: YearLens) {
  const { tasks, garments, areas: a, year, setYear, now } = p
  const money = useMemo(() => moneyReport(tasks, year, now), [tasks, year, now])
  const clothes = useMemo(() => wardrobeCosts(garments, a.wearIx), [garments, a.wearIx])
  const busiestPayee = Math.max(1, ...money.byPayee.map(r => r.count))
  const busiestKind = Math.max(1, ...money.byKind.map(r => r.count))
  const perMonth = money.spent > 0 ? Math.round(money.spent / Math.max(1, money.months.filter(m => m > 0).length)) : 0
  return (
    <>
      <section className="stats-section">
        <h2>{year}</h2>
        <p className="stats-note">Counted from what a finished task actually cost — a bill pays itself its own amount unless you changed it.</p>
        <div className="kpi-row">
          <StatTile label="Paid" value={formatMoney(money.spent)} sub={`across ${year}`} />
          <StatTile label="A month" value={formatMoney(perMonth)} sub="on the months anything was paid" />
          {/* These last two are not the year's: what is still owed is owed now,
              and a wardrobe is bought over years. Both say so, because they sit
              in a row under a year heading where three tiles are that year's. */}
          <StatTile label="Still to pay" value={String(money.dueNow)} warn={money.dueNow > 0} sub={money.dueNowTotal > 0 ? `open now · about ${formatMoney(money.dueNowTotal)}` : 'open now · bills not yet ticked'} />
          <StatTile label="Clothes" value={formatMoney(clothes.spent)} sub={clothes.perWear === undefined ? 'all time · nothing worn yet' : `all time · ${formatMoney(clothes.perWear)} a wear`} />
        </div>
      </section>

      <section className="stats-section">
        <h2>Each month</h2>
        <ChartCard title="What you paid" sub={`Every month of ${year}`} aside={<YearStep year={year} setYear={setYear} now={now} />}>
          <MonthBars months={money.months} current={year === now.getFullYear() ? now.getMonth() : -1} label={`Paid each month of ${year}`} noun="dollar" total={formatMoney(money.spent)} trend={money.trend} />
        </ChartCard>
      </section>

      <section className="stats-section">
        <h2>Where it went</h2>
        <ChartCard title="By who was paid" sub={`Everything with an amount, in ${year}`}>
          {money.byPayee.length === 0 ? (
            <p className="empty">Nothing with an amount was paid in {year}.</p>
          ) : (
            <div className="lens-rows">
              {money.byPayee.map(r => (
                <div className="lens-row" key={r.key}>
                  <span className="lens-row-name">
                    <b>{r.name}</b>
                  </span>
                  <span className="lens-meter">
                    <span style={{ width: `${(r.count / busiestPayee) * 100}%` }} />
                  </span>
                  <span className="lens-row-value">{formatMoney(r.count)}</span>
                </div>
              ))}
            </div>
          )}
        </ChartCard>
        {money.byKind.length > 0 && (
          <ChartCard title="By kind of payment" sub="The repeating ones: bills, cards, subscriptions, loans">
            <div className="lens-rows">
              {money.byKind.map(r => (
                <div className="lens-row" key={r.key}>
                  <span className="lens-row-name">
                    <b>{r.name}</b>
                  </span>
                  <span className="lens-meter">
                    <span style={{ width: `${(r.count / busiestKind) * 100}%` }} />
                  </span>
                  <span className="lens-row-value">{formatMoney(r.count)}</span>
                </div>
              ))}
            </div>
          </ChartCard>
        )}
      </section>
    </>
  )
}

// ---- Habits ----------------------------------------------------------------------

function HabitsLens(p: Lens) {
  const { habits, span, spanWords, now } = p
  const theme = useTheme()
  const hr = useMemo(() => habitReport(habits, span, now), [habits, span, now])
  const clean = useMemo(() => new Map(hr.cleanDays.map(d => [d, 1] as [string, number])), [hr.cleanDays])
  if (hr.rows.length === 0) {
    return (
      <section className="stats-section">
        <h2>Habits</h2>
        <ChartCard title="Nothing to count yet" sub="Habits live on Home → Today; each one you add is counted here.">
          <p className="empty">No habit was due in the last {spanWords}.</p>
        </ChartCard>
      </section>
    )
  }
  return (
    <>
      <section className="stats-section">
        <h2>The last {spanWords}</h2>
        <p className="stats-note">A day you were not due is not a day you missed, and today waits rather than breaks a run.</p>
        <div className="kpi-row">
          <StatTile label="Kept" value={`${hr.pct}%`} sub={`${hr.done} of ${hr.due} days due`} />
          <StatTile label="Clean days" value={String(hr.cleanDays.length)} sub="everything due, kept" />
          <StreakTiles current={hr.streaks.current} best={hr.streaks.best} today={hr.streaks.today} words={{ today: 'clean in a row, today too', waiting: 'keep today to hold it', none: 'keep a whole day to start one', best: 'clean in a row' }} />
        </div>
      </section>

      <section className="stats-section">
        <h2>Each habit</h2>
        <ChartCard title="How each one went" sub={`Days kept of days due, over the last ${spanWords}`}>
          <div className="lens-rows">
            {hr.rows.map(r => (
              <div className="lens-row" key={r.habit.id}>
                <Ring value={r.done} of={Math.max(1, r.due)} size={44} label={`${r.pct}%`} tone={markInk(r.habit.color, theme)} />
                <span className="lens-row-name">
                  <b>
                    {r.habit.emoji ? `${r.habit.emoji} ` : ''}
                    {r.habit.name}
                  </b>
                  <span className="lens-row-sub">{r.streak > 0 ? `${countOf(r.streak, 'day')} in a row` : 'no run going'}</span>
                </span>
                {/* the ring is the share; the figure beside it is what the share is OF,
                    so the row never says the same thing twice */}
                <span className="lens-row-value">
                  {r.done} / {r.due}
                </span>
              </div>
            ))}
          </div>
        </ChartCard>
      </section>

      <section className="stats-section">
        <h2>A year of days</h2>
        <ChartCard title="Clean days" sub="A day is lit when everything due that day was kept">
          <HeatGrid counts={clean} end={now} label="Clean days" noun="clean day" />
        </ChartCard>
      </section>
    </>
  )
}

// ---- Journal ---------------------------------------------------------------------

function JournalLens(p: YearLens) {
  const { journal, span, spanWords, year, setYear, now } = p
  const jr = useMemo(() => journalReport(journal, span, year, now), [journal, span, year, now])
  const counts = useMemo(() => new Map(journal.filter(e => !e.deletedAt).map(e => [e.date, 1] as [string, number])), [journal])
  const mostMood = Math.max(1, ...jr.moodCounts)
  return (
    <>
      <section className="stats-section">
        <h2>The last {spanWords}</h2>
        <p className="stats-note">Counts and moods only — nothing you wrote is shown here.</p>
        <div className="kpi-row">
          <StatTile label="Entries" value={String(jr.entries)} sub={`over ${countOf(jr.days.length, 'day')}`} />
          <StatTile label="Words" value={jr.words.toLocaleString()} sub="written in this window" />
          <StatTile label="Mood" value={jr.mood === null ? '—' : jr.mood.toFixed(1)} sub={jr.mood === null ? 'no entry carried one' : `average of ${countOf(jr.moodCounts.reduce((a, b) => a + b, 0), 'entry').replace('entrys', 'entries')}`} />
          <StreakTiles current={jr.streaks.current} best={jr.streaks.best} today={jr.streaks.today} words={{ today: 'written in a row, today too', waiting: 'write today to keep it going', none: 'write a day to start one', best: 'written in a row' }} />
        </div>
      </section>

      <section className="stats-section">
        <h2>How the days felt</h2>
        <ChartCard title="Each mood" sub={`The entries of the last ${spanWords} that carried one`}>
          {jr.moodCounts.every(n => n === 0) ? (
            <p className="empty">No entry in this window carried a mood.</p>
          ) : (
            <div className="mood-spread">
              {MOODS.map(m => (
                <div key={m} title={`${MOOD_META[m].label}: ${countOf(jr.moodCounts[m - 1], 'day')}`}>
                  <span className="mood-count">{jr.moodCounts[m - 1]}</span>
                  <span className="mood-bar" style={{ height: `${Math.max(3, (jr.moodCounts[m - 1] / mostMood) * 56)}px`, opacity: 0.35 + 0.65 * (m / 5) }} />
                  <span className="mood-face" aria-hidden>
                    {MOOD_META[m].emoji}
                  </span>
                  <span className="mood-count">{MOOD_META[m].label}</span>
                </div>
              ))}
            </div>
          )}
        </ChartCard>
      </section>

      <section className="stats-section">
        <h2>Each month</h2>
        <ChartCard title="Days written" sub={`Every month of ${year}`} aside={<YearStep year={year} setYear={setYear} now={now} />}>
          <MonthBars months={jr.months} current={year === now.getFullYear() ? now.getMonth() : -1} label={`Days written each month of ${year}`} noun="day" total={countOf(jr.total, 'day')} trend={jr.trend} />
        </ChartCard>
        <ChartCard title="A year of days" sub="Every day with an entry">
          <HeatGrid counts={counts} end={now} label="Days written" noun="entry" />
        </ChartCard>
      </section>
    </>
  )
}
