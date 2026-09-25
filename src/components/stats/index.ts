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
 * - Segmented: one track with a thumb that slides, for a switch that swaps the panel under it.
 * - Ring: "13 of 15" as an arc. Sparkline: a series small enough to sit in a row.
 * - HeatGrid: a year of days as a column per week — runs and gaps in one glance.
 * - AreaCard: one area's line on the year's page (and the Highlights' way to it), and the way to that area's page.
 * - DeltaBadge: a figure's change on the period before, where it has one.
 * - RankedBars: ranked bars under that switch. Podium: the top three.
 * - MonthCalendar: a month grid with ‹ ›, each day drawn through a render prop.
 * - MonthBars: a year by month, with its total and a TrendBadge.
 * - ListCard and ListRow: a titled list, such as "not lately" or "never".
 * - YearTable: the heat table, scrolling inside .table-scroll.
 * - Narrowed: the line saying what a list's find box or chip leaves Stats counting, with Show all; with nothing left, the empty state.
 * - markInk: a row's own colour as a mark (graphicInk); a year table's cells take heatStyle.
 *
 * Every colour is a theme token, or a user's colour through src/contrast.ts.
 * The styles live in 05-stats-charts.css, 11-people-review-search.css (the
 * year table), 18-wardrobe.css (the podium, the photo calendar, and the
 * stats- classes beside the wardrobe- ones that `prefix="wardrobe"` keeps) and
 * 18-stats-lens.css (the pieces the Stats lens added, and the lens's layout);
 * the segmented track itself is in 04-table-modal.css.
 * Import the kit from a lazy view only: StatTile and TrendBadge reach the
 * first load through bits.tsx, and nothing else here should.
 */

export { StatTile, StreakTiles, type StreakWords } from './StatTile'
export { TrendBadge } from './TrendBadge'
export { DeltaBadge } from './DeltaBadge'
export { ChartCard, Stepper, WindowSwitch } from './ChartCard'
export { RankedBars, type Ranked } from './RankedBars'
export { Podium } from './Podium'
export { MonthCalendar, type MonthDay } from './MonthCalendar'
export { MonthBars } from './MonthBars'
export { ListCard, ListRow } from './ListCard'
export { YearTable, type YearRow } from './YearTable'
export { Narrowed } from './Narrowed'
export { markInk } from './ink'
export { Segmented } from './Segmented'
export { Ring } from './Ring'
export { Sparkline } from './Sparkline'
export { HeatGrid, heatDays, type HeatDay } from './HeatGrid'
export { AreaCard } from './AreaCard'
