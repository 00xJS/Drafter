import { Suspense, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { formatMoney } from '../bills'
import { doneBefore, doneByPriority, doneByTag, doneMonths, habitReport, inWindowBefore, journalReport, moneyReport, paidToDate, taskReport, workDone } from '../lensstats'
import { wardrobeCosts } from '../wardrobe'
import { kitchenIndex, kitchenTiles } from '../kitchenstats'
import { countOf } from '../people'
import { getTogethers, peopleSeen } from '../peoplestats'
import { outingsAt } from '../places'
import { DAY_WINDOWS, countDays, distinctDays, monthBuckets, type DayWindow } from '../stats'
import { inWindow } from '../../shared/stats.mts'
import { localDayKey } from '../../shared/journal.mts'
import { PERSONAL_AREAS, describeDelta, scopeRecords, type InsightInput, type InsightPeriod, type Scoped, type Whose } from '../../shared/insights.mts'
import { useDayClock } from '../useDayClock'
import { MOOD_META, MOODS, type CalendarEntry, type Garment, type GroceryList, type Habit, type JournalEntry, type Meal, type Outfit, type Person, type Place, type Recipe, type Task, type Wear } from '../types'
import type { PersonFilter } from '../people'
import type { PlaceFilter } from '../places'
import type { WearIndex } from '../wardrobe'
import { dateKey } from '../utils'
import { wearIndex } from '../../shared/wardrobe.mts'
import { AreaCard, ChartCard, DeltaBadge, HeatGrid, MonthBars, RankedBars, Ring, StatTile, Stepper, WindowSwitch } from './stats'
import { Highlights } from './insights/Highlights'
import { KitchenStats, PeopleStats, PlacesStats, WardrobeStats } from './planner/lazy'
import type { StatsArea, StatsTab } from './planner/routes'

/*
 * Insights → Stats, the lens: the one place you never add anything to, and
 * where every figure the app keeps can be read. It opens on the Highlights
 * (components/insights), and each area's figures are a page pushed over them:
 * what you finish, pay, keep up and write, counted here from src/lensstats.ts,
 * and People, Places, Kitchen and the Wardrobe drawn from THEIR OWN components
 * — the ones their areas draw, reading the same find boxes and chips
 * (useListFilters), so one view, one chunk, one set of numbers wherever you
 * look. The Overview it used to open on is the This year page.
 *
 * Whose log each page counts is decided once, by scopeRecords
 * (shared/insights.mts) — the rule the Highlights and the monthly recap use:
 * under Mine your own work, visits, outings and meals; under Both of us every
 * member's the device can already read, labelled on every page. The journal,
 * habits and clothes are yours under either.
 *
 * Nothing personal leaves the device, and nothing written in the journal is
 * quoted — the journal's figures are counts and moods only.
 */

/** What a page's own window switch offers: the kit's windows. */
const LENS_WINDOWS: readonly { key: DayWindow; label: string }[] = DAY_WINDOWS

/**
 * The pages the window switch governs. Money is counted by a year, chosen on
 * its own ‹ 2026 ›, and the four area views bring their own switches inside
 * their cards — so on those five a page-level switch would sit there doing
 * nothing, which is worse than not being there. It is shown only where it works.
 */
const WINDOWED: ReadonlySet<StatsTab> = new Set<StatsTab>(['year', 'tasks', 'habits', 'journal'])

/** The day an instant falls on, on this device's calendar: the Highlights' and every page's. */
const localDayOf = (iso: string): string => localDayKey(new Date(iso))

/**
 * Where the Highlights were scrolled to when a page was pushed over them, so
 * ‹ Back lands where you left; a page itself opens at its top.
 */
const scroll = { highlights: 0 }

export interface StatsLensProps {
  /** The Highlights, or the page pushed over them. */
  tab: StatsTab
  /** Push a page over the Highlights: an area's figures, or the year. */
  onOpen(page: Exclude<StatsTab, 'highlights'>): void
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
  /**
   * The viewer. The address book is the household's; who saw whom, where you
   * went and what you finished are each member's own (v3.24), and the
   * journal, habits and clothes are yours alone.
   */
  myId?: string | null
  /** More than one member shares the planner: Mine · Both of us is offered, and Both is labelled wherever it counts. */
  household?: boolean
  /** Whose log the shared areas count. Mine, unless the household is more than one and this device chose Both. */
  whose?: Whose
  onWhose?(w: Whose): void
  /** The Highlights' Week · Month · Year, and which one by its key (null for now). */
  period?: InsightPeriod
  onPeriod?(p: InsightPeriod): void
  at?: string | null
  onAt?(key: string | null): void
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

const noop = () => {}

export function StatsLens(p: StatsLensProps) {
  const { tab, now: handed } = p
  // One clock for the day, as People's and Places' Stats keep one. A fresh
  // `new Date()` in the parameter list is a new object every render, and it is
  // a dependency of every report below — so each keystroke in a find box, each
  // sync and each toast recomputed the lot. Midnight starts the new day's
  // clock (useDayClock), even on a lens left open overnight.
  const now = useDayClock(handed)
  // a page opens on the last 30 days, and the year's on the last 12 months
  const [span, setSpan] = useState<DayWindow>(tab === 'year' ? 365 : 30)
  const [year, setYear] = useState(now.getFullYear())
  const myId = p.myId ?? null
  // alone there is nobody else's log to count, whatever this device once chose
  const whose: Whose = p.household && p.whose === 'both' ? 'both' : 'mine'
  const today = dateKey(now)
  const scoped = useMemo(
    () => scopeRecords({ tasks: p.tasks, meals: p.meals, journal: p.journal, habits: p.habits, garments: p.garments, wears: p.wears, myId, whose }),
    [p.tasks, p.meals, p.journal, p.habits, p.garments, p.wears, myId, whose],
  )
  const input = useMemo<InsightInput>(
    () => ({
      tasks: p.tasks,
      events: p.events,
      people: p.people,
      places: p.places,
      meals: p.meals,
      recipes: p.recipes,
      journal: p.journal,
      habits: p.habits,
      garments: p.garments,
      wears: p.wears,
      myId,
      whose,
      now,
      today,
      dayKeyOf: localDayOf,
    }),
    [p.tasks, p.events, p.people, p.places, p.meals, p.recipes, p.journal, p.habits, p.garments, p.wears, myId, whose, now, today],
  )
  const open = (page: Exclude<StatsTab, 'highlights'>) => {
    scroll.highlights = typeof window === 'undefined' ? 0 : window.scrollY
    p.onOpen(page)
  }
  if (tab === 'highlights')
    return (
      <HighlightsPage>
        <Highlights
          input={input}
          household={!!p.household}
          onWhose={p.onWhose ?? noop}
          period={p.period ?? 'week'}
          onPeriod={p.onPeriod ?? noop}
          at={p.at ?? null}
          onAt={p.onAt ?? noop}
          onOpen={open}
        />
      </HighlightsPage>
    )
  const spanWords = span === 'all' ? 'all time' : (LENS_WINDOWS.find(w => w.key === span)?.label.toLowerCase() ?? 'all time')
  const lens: Lens = { ...p, scoped, whose, span, spanWords, now, year, setYear, onOpen: open }
  return (
    <StatsPage key={tab}>
      <div className={`stats-lens stats-page ink-${tab}`}>
        {(whose === 'both' || WINDOWED.has(tab)) && (
          <div className="stats-bar">
            {whose === 'both' && <WhoseLine page={tab} />}
            {/* One question at a time: the pages the window governs all read it,
                so choosing 12 months on Tasks and opening the year keeps what
                you were asking. Where it would govern nothing it is not drawn. */}
            {WINDOWED.has(tab) && (
              <div className="stats-window">
                <WindowSwitch value={span} onChange={setSpan} windows={LENS_WINDOWS} />
              </div>
            )}
          </div>
        )}
        {tab === 'year' && <YearLens {...lens} />}
        {tab === 'tasks' && <TasksLens {...lens} />}
        {tab === 'money' && <MoneyLens {...lens} />}
        {tab === 'habits' && <HabitsLens {...lens} />}
        {tab === 'journal' && <JournalLens {...lens} />}
        {/* The four areas that count themselves, drawn here as they are drawn
            there. Each waits on its own chunk, so the lens's own pages never
            wait on a chunk they do not use. */}
        <Suspense fallback={<div className="view-pending" aria-busy="true" />}>
          {tab === 'people' && <AreaPeople {...lens} />}
          {tab === 'places' && <AreaPlaces {...lens} />}
          {tab === 'kitchen' && (
            <KitchenStats recipes={p.recipes} meals={scoped.meals} groceries={p.groceries} places={p.places} onOpenRecipe={p.areas.onOpenRecipe} onGoDay={p.areas.onGoMealDay} />
          )}
          {tab === 'wardrobe' && (
            <WardrobeStats
              garments={scoped.garments}
              outfits={p.outfits}
              byId={p.areas.byId}
              ix={p.areas.wearIx}
              onOpenPiece={p.areas.onOpenPiece}
              onRetire={p.areas.onRetirePiece}
              onSaveOutfit={p.areas.onSaveOutfit}
              onGoDay={p.areas.onGoWearDay}
            />
          )}
        </Suspense>
      </div>
    </StatsPage>
  )
}

/** The Highlights, put back where they were scrolled to when a page was pushed over them. */
function HighlightsPage({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    if (scroll.highlights > 0) window.scrollTo(0, scroll.highlights)
    scroll.highlights = 0
  }, [])
  return <>{children}</>
}

/** A page pushed over the Highlights opens at its top, wherever they were scrolled to. */
function StatsPage({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    window.scrollTo(0, 0)
  }, [])
  return <>{children}</>
}

/** Under Both of us, whose figures a page holds, so none can be taken for yours alone. */
function WhoseLine({ page }: { page: StatsTab }) {
  const personal = PERSONAL_AREAS.has(page as StatsArea)
  return (
    <p className="whose-note">
      {personal ? (
        <>
          <span className="badge whose-badge just-you">Just you</span> Your own, as under Mine: nobody else’s is ever counted here.
        </>
      ) : page === 'year' ? (
        <>
          <span className="badge whose-badge">Both of us</span> Tasks, money, people, places and meals count everyone in the household; the journal, habits and clothes are yours alone.
        </>
      ) : (
        <>
          <span className="badge whose-badge">Both of us</span> Every member’s log is counted here, not only yours.
        </>
      )}
    </p>
  )
}

type Lens = StatsLensProps & {
  scoped: Scoped
  whose: Whose
  span: DayWindow
  spanWords: string
  now: Date
  year: number
  setYear(y: number): void
  onOpen(page: Exclude<StatsTab, 'highlights'>): void
}

/** ‹ year › over a card, stopping at this year: no year still to come is offered. */
function YearStep({ year, setYear, now }: { year: number; setYear(y: number): void; now: Date }) {
  return <Stepper label={String(year)} unit="year" canNext={year < now.getFullYear()} onStep={d => setYear(year + d)} />
}

/** What a window is set against, in the words of a tile's change. */
const beforeWords = (w: DayWindow) => (w === 365 ? 'on the 12 months before' : 'on the 30 days before')

/** A tile's change on the window before: nothing for All, which has no before. */
function WindowChange({ now, before, window, unit }: { now: number; before: number | null; window: DayWindow; unit?: 'points' }) {
  if (before === null || window === 'all') return null
  const d = describeDelta(now - before, beforeWords(window), unit)
  return <DeltaBadge by={d.by} text={d.text} than={d.than} />
}

// ---- People and Places, by whose log --------------------------------------------

/** People's own Stats, counting the visits whose log is asked for: yours (v3.24), or every member's under Both of us. */
function AreaPeople({ people, tasks, events, areas: a, scoped }: Lens) {
  return (
    <PeopleStats
      people={people}
      tasks={tasks}
      entries={events}
      filter={a.peopleFilter}
      onFilter={a.onPeopleFilter}
      onSaw={a.onSaw}
      onOpenPerson={a.onOpenPerson}
      onOpenDay={a.onOpenDay}
      // whom you saw is your own log (v3.24): without it, a household
      // member's visits counted as yours here and nowhere else. Under Both of
      // us, null counts everyone's, and the page says so above.
      myId={scoped.visitsOf}
    />
  )
}

/** Places' own Stats, counting the outings whose log is asked for; a meal shared with the household counts for both either way. */
function AreaPlaces({ places, people, tasks, meals, areas: a, scoped }: Lens) {
  return (
    <PlacesStats
      places={places}
      people={people}
      tasks={tasks}
      meals={meals}
      filter={a.placeFilter}
      onFilter={a.onPlaceFilter}
      onOpenPlace={a.onOpenPlace}
      onPlan={a.onPlanAt}
      onOpenPerson={a.onOpenPerson}
      onOpenDay={a.onOpenDay}
      myId={scoped.visitsOf}
    />
  )
}

// ---- This year: what the Overview held ---------------------------------------------

function YearLens(p: Lens) {
  const { people, places, events, recipes, garments, areas: a, scoped, span, spanWords, now } = p
  const tasks = scoped.work
  const year = now.getFullYear()
  const report = useMemo(() => taskReport(tasks, span, now), [tasks, span, now])
  const ix = useMemo(() => kitchenIndex(recipes, scoped.meals, places, now), [recipes, scoped.meals, places, now])
  const kitchen = useMemo(() => kitchenTiles(ix), [ix])
  const wear = useMemo(() => wearIndex(scoped.wears, dateKey(now)), [scoped.wears, now])
  // seenTasks is a HAYSTACK — every task plus the past events with people on
  // them — which People narrows per person. Mapping it raw made every day you
  // finished any chore a day you saw someone, and counted tasks in Trash too.
  // getTogethers is the narrowing People's own tiles use, so the two agree.
  const { seen, all } = useMemo(() => peopleSeen(people, p.tasks, events, now, scoped.visitsOf), [people, p.tasks, events, now, scoped.visitsOf])
  const together = useMemo(() => getTogethers(all, seen), [all, seen])
  const jr = useMemo(() => journalReport(scoped.journal, span, year, now), [scoped.journal, span, year, now])
  const hr = useMemo(() => habitReport(scoped.habits, span, now), [scoped.habits, span, now])
  const money = useMemo(() => moneyReport(tasks, year, now), [tasks, year, now])
  // the Wardrobe's own rule, over the index the screen built: a piece's price
  // over the DAYS it was worn, so the lens and Home → Wardrobe agree exactly
  const clothes = useMemo(() => wardrobeCosts(garments, a.wearIx), [garments, a.wearIx])
  const doneSeries = useMemo(() => monthBuckets(together, year, countDays), [together, year])
  // every tile under "the last …" counts that window and nothing else, so the
  // four of them are answering one question rather than four; each is set
  // against the window before, counted the same way
  const today = dateKey(now)
  const seenDays = useMemo(() => distinctDays(together, iso => dateKey(new Date(iso))), [together])
  const cookedAll = useMemo(() => [...new Set(ix.meals.filter(m => ix.ways.get(m.id) === 'cooked').map(m => m.date))], [ix])
  const peopleDays = seenDays.filter(d => inWindow(d, today, span))
  const cookedDays = cookedAll.filter(d => inWindow(d, today, span))
  const dressedDays = wear.logged.filter(d => inWindow(d, today, span))
  const before = (days: readonly string[]) => (span === 'all' ? null : days.filter(d => inWindowBefore(d, today, span)).length)
  // outingsAt is the app's one rule for having been somewhere: a done task
  // carrying the place, AND a past meal eaten out there — counting a takeaway
  // is what keeps the Kitchen and Places agreeing. Only over places that still
  // exist, or the ring could read more than its own total. Your own outings
  // under Mine, as Places → Stats counts them.
  const livePlaces = useMemo(() => places.filter(pl => !pl.deletedAt), [places])
  const placesVisited = useMemo(() => livePlaces.filter(pl => outingsAt(pl.id, p.tasks, p.meals, now, scoped.visitsOf).length > 0).length, [livePlaces, p.tasks, p.meals, now, scoped.visitsOf])
  // doneMonths, not a recount: the Tasks page's own "Each month" bars are
  // these twelve numbers, and this sparkline is the way into that page
  const done = useMemo(() => doneMonths(tasks, year, now).months, [tasks, year, now])
  const pieces = garments.filter(g => !g.deletedAt && !g.archivedAt).length
  const tile = (label: string, days: readonly string[], sub: string) =>
    days.length > 0 && <StatTile label={label} value={String(days.length)} sub={sub} trend={<WindowChange now={days.length} before={before(days)} window={span} />} />
  return (
    <>
      <section className="stats-section">
        <h2>A year of days</h2>
        <p className="stats-note">Every day you finished something. A column is a week; the newest is on the right.</p>
        <ChartCard title="Days with something done" sub={report.streaks.best > 0 ? `${countOf(report.streaks.best, 'day')} is the longest run there has been` : 'Finish something and the day lights up'}>
          <HeatGrid counts={new Map(countsByDay(tasks))} end={now} label="Days with something done" noun="task" />
        </ChartCard>
      </section>

      {(report.streaks.best > 0 || jr.streaks.current > 0 || hr.due > 0) && (
        <section className="stats-section">
          <h2>Kept up</h2>
          <p className="stats-note">A streak waits for today rather than breaking on it.</p>
          <div className="kpi-row">
            {report.streaks.current > 0 && <StatTile label="Streak" value={countOf(report.streaks.current, 'day')} sub={report.streaks.today ? 'with something done, today too' : 'finish one to keep it going'} />}
            {report.streaks.best > 0 && <StatTile label="Best streak" value={countOf(report.streaks.best, 'day')} sub="with something done" />}
            {jr.streaks.current > 0 && <StatTile label="Journal" value={countOf(jr.streaks.current, 'day')} sub={jr.streaks.today ? 'written in a row, today too' : 'write today to keep it going'} />}
            {hr.due > 0 && <StatTile label="Habits kept" value={`${hr.pct}%`} sub={`${hr.done} of ${hr.due} due in the last ${spanWords}`} />}
          </div>
        </section>
      )}

      <section className="stats-section">
        <h2>Each area</h2>
        {/* Every one of these opens a page of THIS tab. Nothing here sends
            you to another tab to read the rest of your own figures. */}
        <p className="stats-note">Each opens that area&rsquo;s own figures, here.</p>
        {/* each card in its own area's colour, as its page is drawn */}
        <div className="area-list">
          <div className="ink-tasks">
            <AreaCard name="Tasks" value={`${report.open} open`} sub={report.overdue > 0 ? `${report.overdue} past their date` : 'nothing overdue'} series={done} seriesLabel="Finished each month" onOpen={() => p.onOpen('tasks')} openLabel="Open Tasks" />
          </div>
          <div className="ink-money">
            <AreaCard name="Money" value={formatMoney(money.spent)} sub={`paid in ${year}`} series={money.months} seriesLabel={`What you paid each month of ${year}`} onOpen={() => p.onOpen('money')} openLabel="Open Money" />
          </div>
          <div className="ink-people">
            <AreaCard
              name="People"
              value={countOf(peopleDays.length, 'day')}
              sub={`with anyone, in the last ${spanWords}`}
              series={doneSeries}
              seriesLabel="Days you saw someone each month"
              onOpen={() => p.onOpen('people')}
              openLabel="Open People"
            />
          </div>
          <div className="ink-places">
            <AreaCard
              name="Places"
              value={countOf(placesVisited, 'place')}
              sub="you have been to at least once"
              onOpen={() => p.onOpen('places')}
              openLabel="Open Places"
              aside={<Ring value={placesVisited} of={Math.max(1, livePlaces.length)} size={52} label={String(placesVisited)} />}
            />
          </div>
          <div className="ink-kitchen">
            <AreaCard
              name="Kitchen"
              value={`${kitchen.cookedDays} of ${kitchen.daysThisMonth}`}
              sub="days cooked at home this month"
              onOpen={() => p.onOpen('kitchen')}
              openLabel="Open Kitchen"
              aside={<Ring value={kitchen.cookedDays} of={Math.max(1, kitchen.daysThisMonth)} size={52} label={`${Math.round((kitchen.cookedDays / Math.max(1, kitchen.daysThisMonth)) * 100)}%`} />}
            />
          </div>
          <div className="ink-wardrobe">
            <AreaCard
              name="Wardrobe"
              value={countOf(pieces, 'piece')}
              sub={clothes.perWear === undefined ? 'nothing priced yet' : `${formatMoney(clothes.perWear)} a wear`}
              onOpen={() => p.onOpen('wardrobe')}
              openLabel="Open Wardrobe"
            />
          </div>
          <div className="ink-habits">
            <AreaCard name="Habits" value={`${hr.pct}%`} sub={hr.due > 0 ? `of ${hr.due} days due` : 'nothing was due'} onOpen={() => p.onOpen('habits')} openLabel="Open Habits" />
          </div>
          <div className="ink-journal">
            <AreaCard name="Journal" value={countOf(jr.entries, 'entry').replace('entrys', 'entries')} sub={`written in the last ${spanWords}`} onOpen={() => p.onOpen('journal')} openLabel="Open Journal" />
          </div>
        </div>
      </section>

      {(report.done > 0 || peopleDays.length > 0 || cookedDays.length > 0 || dressedDays.length > 0) && (
        <section className="stats-section">
          <h2>The last {spanWords}</h2>
          <div className="kpi-row">
            {report.done > 0 && (
              <StatTile
                label="Finished"
                value={String(report.done)}
                sub={`${countOf(report.days.length, 'day')} with something done`}
                trend={<WindowChange now={report.done} before={doneBefore(tasks, span, now)} window={span} />}
              />
            )}
            {tile('Days seen', peopleDays, 'with anyone on your list')}
            {tile('Cooked at home', cookedDays, 'days with a meal you made')}
            {tile('Days dressed', dressedDays, 'looks you logged')}
          </div>
        </section>
      )}
    </>
  )
}

/**
 * Days with work finished, for the year grid — off `workDone`, which is the
 * app's own rule for what counts.
 *
 * It used to take every done task, logged visits included, while the tiles and
 * the streak line on the same card took `workDone`. So a grid cell lit for a
 * get-together, its title read "1 task" for something that is not one, and the
 * card said "1 day is the longest run there has been" above a grid showing
 * three.
 */
function countsByDay(tasks: readonly Task[]): [string, number][] {
  const counts = new Map<string, number>()
  for (const t of workDone(tasks)) {
    const key = dateKey(new Date(t.completedAt as string))
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts]
}

// ---- Tasks -----------------------------------------------------------------------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function TasksLens(p: Lens) {
  const { scoped, span, spanWords, year, setYear, now } = p
  const tasks = scoped.work
  const report = useMemo(() => taskReport(tasks, span, now), [tasks, span, now])
  const months = useMemo(() => doneMonths(tasks, year, now), [tasks, year, now])
  const before = useMemo(() => doneBefore(tasks, span, now), [tasks, span, now])
  const busiest = Math.max(1, ...report.weekday)
  const streak = report.streaks
  return (
    <>
      {/* the figure the page is about first, then the charts; a tile is drawn only for something there is */}
      {(report.done > 0 || streak.current > 0) && (
        <div className="kpi-row lens-lead">
          {report.done > 0 && <StatTile label="Finished" value={String(report.done)} sub={`on ${countOf(report.days.length, 'day')}`} trend={<WindowChange now={report.done} before={before} window={span} />} />}
          {streak.current > 0 && <StatTile label="Streak" value={countOf(streak.current, 'day')} sub={streak.today ? 'with something done, today too' : 'finish one to keep it going'} />}
        </div>
      )}

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
        <ChartCard title="A year of days" sub={streak.best > 0 ? `Every day you finished something · ${countOf(streak.best, 'day')} is the best run` : 'Every day you finished something'}>
          <HeatGrid counts={new Map(countsByDay(tasks))} end={now} label="Days with something done" noun="task" />
        </ChartCard>
      </section>

      <section className="stats-section">
        <h2>What the work is</h2>
        <RankedBars title="By tag" sub="Finished work, counted once per tag it carried" empty="No finished task carried a tag in this window." rank={w => doneByTag(tasks, w, now)} window={span} />
        <RankedBars title="By the priority it carried" sub="Finished work, as it was marked when you ticked it" empty="Nothing was finished in this window." rank={w => doneByPriority(tasks, w, now)} window={span} />
      </section>

      {(report.open > 0 || streak.best > 0) && (
        <section className="stats-section">
          <h2>What is waiting</h2>
          <p className="stats-note">Open work is what is open now — no window narrows it.</p>
          <div className="kpi-row">
            {report.open > 0 && <StatTile label="Still open" value={String(report.open)} sub="to do, doing or blocked" onJump={p.onTasks} />}
            {report.overdue > 0 && <StatTile label="Overdue" value={String(report.overdue)} warn sub="past their date" onJump={p.onTasks} />}
            {streak.best > 0 && <StatTile label="Best streak" value={countOf(streak.best, 'day')} sub="with something done" />}
          </div>
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

function MoneyLens(p: Lens) {
  const { scoped, garments, areas: a, year, setYear, now, whose } = p
  const tasks = scoped.work
  const money = useMemo(() => moneyReport(tasks, year, now), [tasks, year, now])
  // set against the year before at the same point in it, while this one is still going
  const thisYear = year === now.getFullYear()
  const before = useMemo(() => paidToDate(tasks, year - 1, thisYear ? dateKey(now).slice(5) : undefined), [tasks, year, thisYear, now])
  const clothes = useMemo(() => wardrobeCosts(garments, a.wearIx), [garments, a.wearIx])
  const busiestPayee = Math.max(1, ...money.byPayee.map(r => r.count))
  const busiestKind = Math.max(1, ...money.byKind.map(r => r.count))
  const perMonth = money.spent > 0 ? Math.round(money.spent / Math.max(1, money.months.filter(m => m > 0).length)) : 0
  const change = describeDelta(money.spent - before, thisYear ? `on ${year - 1} to date` : `on ${year - 1}`, 'money')
  return (
    <>
      <p className="stats-note">Counted from what a finished task actually cost — a bill pays itself its own amount unless you changed it.</p>
      {money.spent > 0 && (
        <div className="kpi-row lens-lead">
          <StatTile label="Paid" value={formatMoney(money.spent)} sub={`across ${year}`} trend={<DeltaBadge by={change.by} text={change.text} than={change.than} />} />
          {perMonth > 0 && <StatTile label="A month" value={formatMoney(perMonth)} sub="on the months anything was paid" />}
        </div>
      )}

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

      {/* These two are not the year's: what is still owed is owed now, and a
          wardrobe is bought over years. Both say so, under a heading of their
          own rather than beside the year's figures. */}
      {(money.dueNow > 0 || clothes.spent > 0) && (
        <section className="stats-section">
          <h2>Now, and all time</h2>
          <div className="kpi-row">
            {money.dueNow > 0 && <StatTile label="Still to pay" value={String(money.dueNow)} warn sub={money.dueNowTotal > 0 ? `open now · about ${formatMoney(money.dueNowTotal)}` : 'open now · bills not yet ticked'} />}
            {clothes.spent > 0 && (
              <StatTile
                label="Clothes"
                value={formatMoney(clothes.spent)}
                sub={`${whose === 'both' ? 'yours, ' : ''}${clothes.perWear === undefined ? 'all time · nothing worn yet' : `all time · ${formatMoney(clothes.perWear)} a wear`}`}
              />
            )}
          </div>
        </section>
      )}
    </>
  )
}

// ---- Habits ----------------------------------------------------------------------

/** The same clock a window earlier: what the window before this one is counted at. */
const windowEarlier = (now: Date, w: DayWindow): Date => new Date(now.getFullYear(), now.getMonth(), now.getDate() - (w === 'all' ? 0 : w), now.getHours(), now.getMinutes())

function HabitsLens(p: Lens) {
  const { scoped, span, spanWords, now } = p
  const habits = scoped.habits
  const hr = useMemo(() => habitReport(habits, span, now), [habits, span, now])
  const earlier = useMemo(() => (span === 'all' ? null : habitReport(habits, span, windowEarlier(now, span))), [habits, span, now])
  const clean = useMemo(() => new Map(hr.cleanDays.map(d => [d, 1] as [string, number])), [hr.cleanDays])
  if (hr.rows.length === 0) {
    return (
      <section className="stats-section">
        <ChartCard title="Nothing to count yet" sub="Habits live on Home → Today; each one you add is counted here.">
          <p className="empty">No habit was due in the last {spanWords}.</p>
        </ChartCard>
      </section>
    )
  }
  const cleanInWindow = hr.cleanDays.filter(d => inWindow(d, dateKey(now), span)).length
  return (
    <>
      <p className="stats-note">A day you were not due is not a day you missed, and today waits rather than breaks a run.</p>
      {(hr.done > 0 || hr.streaks.current > 0) && (
        <div className="kpi-row lens-lead">
          {hr.done > 0 && (
            <StatTile
              label="Kept"
              value={`${hr.pct}%`}
              sub={`${hr.done} of ${hr.due} days due`}
              trend={earlier && earlier.due > 0 ? <WindowChange now={hr.pct} before={earlier.pct} window={span} unit="points" /> : undefined}
            />
          )}
          {hr.streaks.current > 0 && <StatTile label="Streak" value={countOf(hr.streaks.current, 'day')} sub={hr.streaks.today ? 'clean in a row, today too' : 'keep today to hold it'} />}
        </div>
      )}

      <section className="stats-section">
        <h2>Each habit</h2>
        <ChartCard title="How each one went" sub={`Days kept of days due, over the last ${spanWords}`}>
          <div className="lens-rows">
            {hr.rows.map(r => (
              <div className="lens-row" key={r.habit.id}>
                {/* one colour for the area, as every chart here: the habit's own colour is its dot on Today */}
                <Ring value={r.done} of={Math.max(1, r.due)} size={44} label={`${r.pct}%`} />
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
        <ChartCard title="A year of days" sub="A day is lit when everything due that day was kept">
          <HeatGrid counts={clean} end={now} label="Clean days" noun="clean day" />
        </ChartCard>
      </section>

      {(cleanInWindow > 0 || hr.streaks.best > 0) && (
        <section className="stats-section">
          <h2>Clean days</h2>
          <div className="kpi-row">
            {cleanInWindow > 0 && <StatTile label="Clean days" value={String(cleanInWindow)} sub={`everything due kept, in the last ${spanWords}`} />}
            {hr.streaks.best > 0 && <StatTile label="Best streak" value={countOf(hr.streaks.best, 'day')} sub="clean in a row" />}
          </div>
        </section>
      )}
    </>
  )
}

// ---- Journal ---------------------------------------------------------------------

function JournalLens(p: Lens) {
  const { scoped, span, spanWords, year, setYear, now } = p
  const journal = scoped.journal
  const jr = useMemo(() => journalReport(journal, span, year, now), [journal, span, year, now])
  const earlier = useMemo(() => (span === 'all' ? null : journalReport(journal, span, year, windowEarlier(now, span))), [journal, span, year, now])
  const counts = useMemo(() => new Map(journal.filter(e => !e.deletedAt).map(e => [e.date, 1] as [string, number])), [journal])
  const mostMood = Math.max(1, ...jr.moodCounts)
  const withMood = jr.moodCounts.reduce((a, b) => a + b, 0)
  return (
    <>
      <p className="stats-note">Counts and moods only — nothing you wrote is shown here.</p>
      {(jr.entries > 0 || jr.streaks.current > 0) && (
        <div className="kpi-row lens-lead">
          {jr.entries > 0 && <StatTile label="Entries" value={String(jr.entries)} sub={`over ${countOf(jr.days.length, 'day')}`} trend={<WindowChange now={jr.entries} before={earlier?.entries ?? null} window={span} />} />}
          {jr.streaks.current > 0 && <StatTile label="Streak" value={countOf(jr.streaks.current, 'day')} sub={jr.streaks.today ? 'written in a row, today too' : 'write today to keep it going'} />}
        </div>
      )}

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

      {(jr.words > 0 || jr.mood !== null || jr.streaks.best > 0) && (
        <section className="stats-section">
          <h2>The last {spanWords}</h2>
          <div className="kpi-row">
            {jr.words > 0 && <StatTile label="Words" value={jr.words.toLocaleString()} sub="written in this window" trend={<WindowChange now={jr.words} before={earlier?.words ?? null} window={span} />} />}
            {jr.mood !== null && <StatTile label="Mood" value={jr.mood.toFixed(1)} sub={`average of ${countOf(withMood, 'entry').replace('entrys', 'entries')}`} />}
            {jr.streaks.best > 0 && <StatTile label="Best streak" value={countOf(jr.streaks.best, 'day')} sub="written in a row" />}
          </div>
        </section>
      )}
    </>
  )
}
