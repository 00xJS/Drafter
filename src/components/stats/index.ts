/*
 * The Stats kit: what a Stats view is drawn with. It grew out of the
 * wardrobe's Stats and is shared by People, Places and Kitchen, so each
 * area's Stats reads alike. The figures are worked out first, pure, by that
 * area's own rules and by src/stats.ts (windows of 30 days, 12 months or all
 * time, distinct days, streaks, a year's months, the 90-day trend, the top
 * few); the kit only draws them, and counts nothing of its own.
 *
 * - StatTile, StreakTiles: counters for a kpi-row.
 * - ChartCard, with a Stepper (‹ year ›) or a WindowSwitch (30 days · 12 months · All) at its head.
 * - RankedBars: ranked bars under that switch. Podium: the top three.
 * - MonthCalendar: a month grid with ‹ ›, each day drawn through a render prop.
 * - MonthBars: a year by month, with its total and a TrendBadge.
 * - ListCard and ListRow: a titled list, such as "not lately" or "never".
 * - YearTable: the heat table, scrolling inside .table-scroll.
 * - markInk: a row's own colour as a mark (graphicInk); a year table's cells take heatStyle.
 *
 * Every colour is a theme token, or a user's colour through src/contrast.ts.
 * The styles live in 05-stats-charts.css, 11-people-review-search.css (the
 * year table) and 18-wardrobe.css (the podium, the photo calendar, and the
 * stats- classes beside the wardrobe- ones that `prefix="wardrobe"` keeps).
 * Import the kit from a lazy view only: StatTile and TrendBadge reach the
 * first load through bits.tsx, and nothing else here should.
 */

export { StatTile, StreakTiles, type StreakWords } from './StatTile'
export { TrendBadge } from './TrendBadge'
export { ChartCard, Stepper, WindowSwitch } from './ChartCard'
export { RankedBars, type Ranked } from './RankedBars'
export { Podium } from './Podium'
export { MonthCalendar, type MonthDay } from './MonthCalendar'
export { MonthBars } from './MonthBars'
export { ListCard, ListRow } from './ListCard'
export { YearTable, type YearRow } from './YearTable'
export { markInk } from './ink'
