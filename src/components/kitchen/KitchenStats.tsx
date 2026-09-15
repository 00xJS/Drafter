import { useMemo, useState } from 'react'
import { NOT_LATELY_DAYS, cookedLine, daysAgo, daysBetween, mealLabel } from '../../kitchen'
import {
  MEAL_WAYS,
  dinnerDays,
  dinnerStreaks,
  dishMark,
  goesWith,
  kitchenIndex,
  kitchenTiles,
  mealMonths,
  mostBought,
  mostCooked,
  neverCooked,
  notCookedLately,
  slotShares,
  type CookedRow,
  type DayDinner,
  type KitchenIndex,
  type MealMonths,
  type MealWay,
  type Shares,
} from '../../kitchenstats'
import { countOf } from '../../people'
import { placeEmoji } from '../../places'
import { MONTHS, type DayWindow } from '../../stats'
import { MEAL_SLOT_META, type GroceryList, type Meal, type MealSlot, type Place, type Recipe } from '../../types'
import { dateKey } from '../../utils'
import { ChartCard, ListCard, ListRow, MonthCalendar, Podium, RankedBars, StatTile, Stepper, StreakTiles, TrendBadge, WindowSwitch, type MonthDay, type StreakWords } from '../stats'

interface Props {
  recipes: Recipe[]
  meals: Meal[]
  groceries: GroceryList[]
  /** Where a meal eaten out was: its emoji on the calendar. */
  places: Place[]
  /** A recipe opens in cook mode, as it does from the Recipes list. */
  onOpenRecipe(r: Recipe): void
  /** A day of the dinner calendar opens This week on it. */
  onGoDay(day: string): void
  /** The clock the figures are read from; the tests hand one in. */
  now?: Date
}

/** A recipe as the kit ranks it: by its id and name, with its days. */
const ranked = (r: CookedRow) => ({ key: r.recipe.id, name: r.recipe.name, count: r.count, recipe: r.recipe })

/** The streak tiles, in dinners cooked at home. */
const DINNERS: Partial<StreakWords> = {
  today: 'cooked at home in a row, tonight too',
  waiting: 'cook tonight to keep it going',
  none: 'cook a dinner at home to start one',
  best: 'cooked at home in a row',
}
/** …and when tonight's dinner is out already, which no cooking tonight will change. */
const DINNERS_OUT: Partial<StreakWords> = { ...DINNERS, waiting: 'eating out tonight' }

/** "2 lunches", "1 dinner". */
const slotCount = (n: number, slot: MealSlot) => `${n} ${slot}${n === 1 ? '' : slot === 'lunch' ? 'es' : 's'}`
const percent = (n: number, of: number) => Math.round((n / of) * 100)
const total = (months: readonly number[]) => months.reduce((a, b) => a + b, 0)

/** A dish's emoji or first letters on a tile of its own. Its name is beside it, so a screen reader skips it. */
function Dish({ recipe, className }: { recipe: Recipe; className: string }) {
  return (
    <span className={`kitchen-dish ${className}`} aria-hidden="true">
      {dishMark(recipe.name, recipe.emoji)}
    </span>
  )
}

function RecipeRow({ recipe, line, onOpen }: { recipe: Recipe; line: string; onOpen(r: Recipe): void }) {
  return <ListRow picture={<Dish recipe={recipe} className="thumb-40" />} name={recipe.name} line={line} onOpen={() => onOpen(recipe)} />
}

/**
 * A day's dinner under its date: its dish, the place it was eaten at, or 🥡
 * when it was bought. A dinner out whose outing has not come yet here shows
 * its place with no bar, a plan until the tiles and the place's card count it.
 */
function dinnerCell({ meal, way, place }: DayDinner, ix: KitchenIndex): MonthDay {
  const mark = (text: string) => (
    <span className="kitchen-cal-dish" aria-hidden="true">
      {text}
    </span>
  )
  if (!way) return { what: place ? `eating out at ${place.name}, still to come` : 'eating out, still to come', content: place && mark(placeEmoji(place)), className: 'dinner-planned' }
  if (way === 'out' && place) return { what: `eaten out at ${place.name}`, content: mark(placeEmoji(place)), className: 'dinner-out' }
  if (way === 'bought') return { what: meal.title && meal.title !== 'Eating out' ? `bought: ${meal.title}` : 'bought, no place named', content: mark('🥡'), className: 'dinner-bought' }
  const recipe = meal.recipeId ? ix.recipeById.get(meal.recipeId) : undefined
  return { what: mealLabel(meal), content: mark(dishMark(recipe?.name ?? meal.title, recipe?.emoji)), className: 'dinner-cooked' }
}

/** The key under a chart: each way's colour beside its name, with its count when there is one. */
function WayKey({ counts }: { counts?: Record<MealWay, number> }) {
  return (
    <ul className="kitchen-legend">
      {MEAL_WAYS.map(w => (
        <li key={w.key}>
          <span className={`kitchen-swatch kitchen-way-${w.key}`} aria-hidden="true" />
          {w.label}
          {counts && <strong>{counts[w.key]}</strong>}
        </li>
      ))}
    </ul>
  )
}

/**
 * The year's meals by month: a column a month, stacked cooked, eaten out and
 * bought from the baseline up with a 2px gap of the card between them, this
 * month's label drawn stronger. Pointed at, a month says its three figures;
 * the chart says them all to a screen reader.
 */
function MealMonthsChart({ months, current }: { months: MealMonths; current: number }) {
  const [w, h, base, gap] = [360, 112, 94, 2]
  const slot = w / 12
  const most = Math.max(1, ...MONTHS.map((_, i) => MEAL_WAYS.reduce((sum, way) => sum + months[way.key][i], 0)))
  const said = (i: number) => MEAL_WAYS.map(way => `${months[way.key][i]} ${way.label.toLowerCase()}`).join(', ')
  return (
    <div className="chart-plot kitchen-month-bars">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Meals by month: ${MONTHS.map((m, i) => `${m} ${said(i)}`).join('; ')}`}>
        <line className="axis-base" x1={0} x2={w} y1={base} y2={base} />
        {MONTHS.map((m, i) => {
          let top = base
          return (
            <g key={m}>
              <title>{`${m}: ${said(i)}`}</title>
              <rect className="hit" x={i * slot} y={0} width={slot} height={base} />
              {MEAL_WAYS.filter(way => months[way.key][i] > 0).map((way, j) => {
                const tall = (months[way.key][i] / most) * (base - 8)
                const y = top - tall
                top = y
                return <rect key={way.key} className={`kitchen-way-${way.key}`} x={i * slot + slot * 0.2} y={y} width={slot * 0.6} height={Math.max(1, tall - (j > 0 ? gap : 0))} rx={2} />
              })}
              <text className={i === current ? 'tick-label now' : 'tick-label'} x={i * slot + slot / 2} y={h - 4} textAnchor="middle">
                {m}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/** One slot's meals in the window as a bar split by how they were had, with the figures in words under it. */
function ShareRow({ slot, shares }: { slot: MealSlot; shares: Shares }) {
  const label = MEAL_SLOT_META[slot].label
  const had = MEAL_WAYS.filter(w => shares[w.key] > 0)
  return (
    <li className="kitchen-share">
      <div className="kitchen-share-head">
        <strong>{label}</strong>
        <small className="muted">{shares.total ? `${slotCount(shares.total, slot)} · ${percent(shares.cooked, shares.total)}% cooked` : 'none in this window'}</small>
      </div>
      {shares.total > 0 && (
        <>
          <div className="kitchen-share-bar" role="img" aria-label={`${label}: ${MEAL_WAYS.map(w => `${shares[w.key]} ${w.label.toLowerCase()}`).join(', ')}`}>
            {had.map(w => (
              <span key={w.key} className={`kitchen-way-${w.key}`} style={{ flexGrow: shares[w.key] }} title={`${w.label}: ${shares[w.key]} of ${shares.total}, ${percent(shares[w.key], shares.total)}%`} />
            ))}
          </div>
          <small className="kitchen-share-line">{had.map(w => `${shares[w.key]} ${w.label.toLowerCase()}`).join(' · ')}</small>
        </>
      )}
    </li>
  )
}

/**
 * Kitchen → Stats: what you cook, counted by the Kitchen's own rules
 * (kitchenstats.ts) — the tiles and the streak of home-cooked dinners; the
 * month's dinners on a calendar; the podium of the three most cooked of all
 * time and the most cooked over 30 days, 12 months or all time, in days; Not
 * lately in its two halves; the meals of each month cooked, eaten out and
 * bought; how lunch and dinner were had; the sides that go with the mains
 * cooked most; and what is on the grocery list most weeks. Drawn with the
 * Stats kit (components/stats), as the wardrobe's is, in its own chunk.
 */
export function KitchenStats({ recipes, meals, groceries, places, onOpenRecipe, onGoDay, now }: Props) {
  const clock = now ?? new Date()
  const dayKey = dateKey(clock)
  // Worked out when the lists change or the day does, as the Recipes list's
  // own index is, and never again for a press of a switch or a stepper: the
  // index reads each meal once, and everything below reads the index.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ix = useMemo(() => kitchenIndex(recipes, meals, places, clock), [recipes, meals, places, dayKey])
  const thisYear = Number(dayKey.slice(0, 4))
  const [year, setYear] = useState(thisYear)
  const [span, setSpan] = useState<DayWindow>(30)
  const { tiles, streaks, podium, dinners, lately, never, pairs } = useMemo(
    () => ({
      tiles: kitchenTiles(ix),
      streaks: dinnerStreaks(ix),
      podium: mostCooked(ix, 'all', 3).map(ranked),
      dinners: dinnerDays(ix),
      lately: notCookedLately(ix),
      never: neverCooked(ix),
      pairs: goesWith(ix),
    }),
    [ix],
  )
  const months = useMemo(() => mealMonths(ix, year), [ix, year])
  // tonight's dinner out already: the streak's line says so rather than ask for a cook
  const outTonight = !!dinners.get(dayKey)?.meal.out

  return (
    <div className="kitchen-stats">
      <div className="kpi-row kitchen-tiles">
        <StatTile label="Recipes" value={String(tiles.recipes)} sub={`${tiles.notLately} not lately`} />
        <StatTile label="New recipes" value={String(tiles.newThisYear)} sub={`first cooked in ${thisYear}`} />
        <StatTile label="Cooked at home" value={`${tiles.cookedDays} of ${tiles.daysThisMonth}`} sub="days this month so far" />
        <StatTile label="Eaten out" value={String(tiles.eatenOut)} sub={tiles.bought > 0 ? `at a place this month · ${tiles.bought} bought, no place` : 'at a place this month'} />
        <StreakTiles current={streaks.current} best={streaks.best} today={streaks.today} noun="dinner" words={outTonight ? DINNERS_OUT : DINNERS} />
      </div>

      <MonthCalendar
        title="Dinners"
        today={ix.dayKey}
        sub={(y, m) => {
          const month = `${y}-${String(m).padStart(2, '0')}`
          const cooked = [...dinners].filter(([day, d]) => day.startsWith(month) && d.way === 'cooked').length
          return `Each day’s dinner · ${countOf(cooked, 'dinner')} cooked at home`
        }}
        day={day => {
          const dinner = dinners.get(day)
          return dinner ? dinnerCell(dinner, ix) : { what: 'no dinner planned' }
        }}
        onOpen={onGoDay}
      />

      {podium.length > 0 && (
        <ChartCard title="Top three" sub="Your most cooked of all time, in days">
          <Podium top={podium} picture={r => <Dish recipe={r.recipe} className="podium-photo" />} onOpen={r => onOpenRecipe(r.recipe)} />
        </ChartCard>
      )}

      <RankedBars
        title="Most cooked"
        sub="Days cooked, as the main or a side: lunch and dinner on one day count once, where a recipe’s times count each meal"
        empty="Cook from your recipes and the ones you cook most show here."
        rank={window => mostCooked(ix, window).map(ranked)}
        picture={r => <Dish recipe={r.recipe} className="thumb-28" />}
        onOpen={r => onOpenRecipe(r.recipe)}
      />

      <ListCard
        title="Not cooked lately"
        sub={`Cooked before, but not in ${NOT_LATELY_DAYS} days or more, and not planned`}
        items={lately}
        empty="Everything you’ve cooked was had this month, or is on the plan."
        row={r => <RecipeRow key={r.id} recipe={r} line={cookedLine(ix.cooked, r.id)} onOpen={onOpenRecipe} />}
      />

      <ListCard
        title="Never cooked"
        sub="Saved, not cooked yet, and not planned"
        items={never}
        empty="Every recipe has been cooked, or is on the plan."
        row={r => <RecipeRow key={r.id} recipe={r} line={`Added ${daysAgo(daysBetween(dateKey(r.createdAt), ix.dayKey))}`} onOpen={onOpenRecipe} />}
      />

      <ChartCard
        className="year-report kitchen-months"
        title="Meals by month"
        sub="Cooked at home, eaten out at a place, or bought with no place named · the trend is home-cooked days, the last 90 against the 90 before"
        aside={<Stepper label={String(year)} unit="year" onStep={delta => setYear(y => y + delta)} />}
      >
        <MealMonthsChart months={months} current={year === thisYear ? Number(ix.dayKey.slice(5, 7)) - 1 : -1} />
        <WayKey counts={{ cooked: total(months.cooked), out: total(months.out), bought: total(months.bought) }} />
        <p className="stats-month-total">
          {`${countOf(months.homeDays.total, 'home-cooked day')} in ${year}`} <TrendBadge trend={months.homeDays.trend} />
        </p>
        <details className="kitchen-by-month">
          <summary>By month</summary>
          <div className="table-scroll">
            <table className="chart-table">
              <thead>
                <tr>
                  <th>Month</th>
                  {MEAL_WAYS.map(w => (
                    <th key={w.key} className="num">
                      {w.label}
                    </th>
                  ))}
                  <th className="num">Home-cooked days</th>
                </tr>
              </thead>
              <tbody>
                {MONTHS.map((m, i) => (
                  <tr key={m}>
                    <td>{m}</td>
                    {MEAL_WAYS.map(w => (
                      <td key={w.key} className="num">
                        {months[w.key][i]}
                      </td>
                    ))}
                    <td className="num">{months.homeDays.months[i]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </ChartCard>

      <ChartCard title="Lunch and dinner" sub="How each was had" aside={<WindowSwitch value={span} onChange={setSpan} />}>
        <ul className="kitchen-shares">
          {(['lunch', 'dinner'] as const).map(slot => (
            <ShareRow key={slot} slot={slot} shares={slotShares(ix, slot, span)} />
          ))}
        </ul>
        <WayKey />
      </ChartCard>

      <ListCard
        title="Goes with"
        sub="The sides most often served with the mains you cook most"
        items={pairs}
        empty="Add sides to a cooked dinner and what goes with what shows here."
        row={p => (
          <ListRow
            key={p.main.id}
            picture={<Dish recipe={p.main} className="thumb-40" />}
            name={p.main.name}
            line={`with ${p.sides.map(s => `${s.name} ×${s.count}`).join(', ')} · ${countOf(p.meals, 'time')} as the main`}
            onOpen={() => onOpenRecipe(p.main)}
          />
        )}
      />

      <RankedBars
        title="Most bought"
        sub="Weeks each was on the grocery list to buy; what you already had is left out"
        empty="Build a grocery list or two and what you buy most shows here."
        rank={window => mostBought(groceries, ix.dayKey, window)}
      />
    </div>
  )
}
