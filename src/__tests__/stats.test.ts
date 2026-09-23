import { describe, expect, it } from 'vitest'
import { streak as journalStreak } from '../../shared/journal.mts'
import * as sharedPeople from '../../shared/people.mts'
import { habitStreak } from '../../shared/review.mts'
import * as sharedStats from '../../shared/stats.mts'
import * as sharedWardrobe from '../../shared/wardrobe.mts'
import * as kitchen from '../kitchen'
import * as people from '../people'
import {
  DAY_WINDOWS,
  MONTHS,
  TREND_DAYS,
  countDays,
  dayStreaks,
  daysBetween,
  daysWithin,
  distinctDays,
  inWindow,
  monthBuckets,
  monthGrid,
  monthsAndTrend,
  recentTrend,
  shiftMonth,
  topN,
} from '../stats'
import type { JournalEntry } from '../types'
import { dateKey } from '../utils'

// The counting every Stats view shares (src/stats.ts), and the day-key rules
// under it that the server counts by too (shared/stats.mts). Each figure is a
// count of day keys, so none moves with the zone or the hour it is read at.

const TODAY = '2026-09-14'
/** The day key `n` days before TODAY. */
const ago = (n: number) => new Date(Date.UTC(2026, 8, 14 - n)).toISOString().slice(0, 10)
/** An instant on this device's calendar, as a visit's `at` is stored. */
const at = (month: number, day: number, hour = 12, minute = 0) => ({ at: new Date(2026, month - 1, day, hour, minute).toISOString() })

describe('the rules move, and the old names still reach them', () => {
  it('are the server’s own, re-exported under the same names', () => {
    for (const name of ['daysBetween', 'inWindow', 'daysWithin', 'distinctDays', 'dayStreaks', 'topN'] as const) {
      expect((sharedStats as Record<string, unknown>)[name], name).toBeTypeOf('function')
    }
    expect(daysBetween).toBe(sharedStats.daysBetween)
    expect(dayStreaks).toBe(sharedStats.dayStreaks)
    expect(topN).toBe(sharedStats.topN)
  })

  it('leave Kitchen’s daysBetween, People’s visitDays and monthsAndTrend, and the wardrobe’s daysWithin where they were', () => {
    expect(kitchen.daysBetween).toBe(daysBetween)
    expect(people.monthsAndTrend).toBe(monthsAndTrend)
    expect(sharedPeople.visitDays).toBe(distinctDays)
    expect(sharedWardrobe.daysWithin).toBe(daysWithin)
  })
})

describe('daysBetween', () => {
  it('counts whole days between keys, across a month, a year and a clock change', () => {
    expect(daysBetween('2026-09-14', '2026-09-14')).toBe(0)
    expect(daysBetween('2026-08-31', '2026-09-01')).toBe(1)
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1)
    // the clocks go forward on 29 March in London and back on 25 October
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2)
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2)
    expect(daysBetween('2026-09-14', '2026-09-10')).toBe(-4)
  })
})

describe('day windows', () => {
  it('offers 30 days, 12 months and all time, in the switch’s words', () => {
    expect(DAY_WINDOWS).toEqual([
      { key: 30, label: '30 days' },
      { key: 365, label: '12 months' },
      { key: 'all', label: 'All' },
    ])
  })

  it('puts today and the 29 days before it in the last 30, and the 30th day before in none of them', () => {
    expect(inWindow(TODAY, TODAY, 30)).toBe(true)
    expect(inWindow(ago(29), TODAY, 30)).toBe(true)
    expect(inWindow(ago(30), TODAY, 30)).toBe(false)
    expect(inWindow(ago(364), TODAY, 365)).toBe(true)
    expect(inWindow(ago(365), TODAY, 365)).toBe(false)
    expect(inWindow(ago(4000), TODAY, 'all')).toBe(true)
  })

  it('counts no day still to come, and no key that is not a day', () => {
    expect(inWindow('2026-09-15', TODAY, 30)).toBe(false)
    expect(inWindow('2026-09-15', TODAY, 'all')).toBe(false)
    expect(inWindow('someday', TODAY, 'all')).toBe(false)
  })

  it('counts the days inside a window', () => {
    const days = [TODAY, ago(1), ago(29), ago(30), ago(200), ago(400), '2026-10-01']
    expect(daysWithin(days, TODAY, 30)).toBe(3)
    expect(daysWithin(days, TODAY, 365)).toBe(5)
    expect(daysWithin(days, TODAY, 'all')).toBe(6)
    expect(daysWithin([], TODAY, 'all')).toBe(0)
  })
})

describe('distinct days', () => {
  it('keeps each day once, in the order it first comes, on the calendar it is handed', () => {
    const visits = [at(9, 6, 20), at(9, 6, 9), at(9, 5, 23, 50), at(9, 1)]
    expect(distinctDays(visits, dateKey)).toEqual(['2026-09-06', '2026-09-05', '2026-09-01'])
    // a calendar that files everything on one day sees one day
    expect(distinctDays(visits, () => '2026-09-01')).toEqual(['2026-09-01'])
  })

  it('leaves out what its calendar cannot read, and reads nothing as nothing', () => {
    expect(distinctDays([{ at: 'x' }, at(9, 2)], a => (a === 'x' ? null : dateKey(a)))).toEqual(['2026-09-02'])
    expect(distinctDays(null, dateKey)).toEqual([])
    expect(distinctDays([], dateKey)).toEqual([])
  })

  it('counts three events on one Saturday as one day', () => {
    expect(countDays([at(9, 5, 10), at(9, 5, 13), at(9, 5, 19), at(9, 6)])).toBe(2)
    expect(countDays([])).toBe(0)
  })
})

describe('streaks: days in a row', () => {
  it('runs to today and keeps the best run apart, a day listed twice being one day', () => {
    expect(dayStreaks([TODAY, ago(1), ago(1), ago(3), ago(4), ago(5), ago(6)], TODAY)).toEqual({ current: 2, best: 4 })
  })

  it('lets an unlogged today wait rather than break the run, and ends it once yesterday is missed too', () => {
    expect(dayStreaks([ago(1), ago(2)], TODAY)).toEqual({ current: 2, best: 2 })
    expect(dayStreaks([ago(2), ago(3)], TODAY)).toEqual({ current: 0, best: 2 })
    expect(dayStreaks([], TODAY)).toEqual({ current: 0, best: 0 })
  })

  it('reads days in any order, and counts none still to come or that is not a day', () => {
    expect(dayStreaks([ago(4), TODAY, ago(2), ago(1), ago(3)], TODAY)).toEqual({ current: 5, best: 5 })
    expect(dayStreaks(['2026-09-15', '2026-09-16', TODAY, 'soon'], TODAY)).toEqual({ current: 1, best: 1 })
  })

  it('runs across a month and a year end', () => {
    expect(dayStreaks(['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02'], '2026-01-03')).toEqual({ current: 4, best: 4 })
  })

  it('keeps the habits’ rule: a daily habit’s streak is the current run over the days it was done', () => {
    const cases = [[TODAY, ago(1), ago(2)], [ago(1), ago(2), ago(3), ago(7)], [ago(2)], [TODAY], [], [TODAY, ago(2), ago(3)]]
    for (const done of cases) expect(dayStreaks(done, TODAY).current, done.join()).toBe(habitStreak({ done }, TODAY))
  })

  it('is the journal’s streak too', () => {
    const entry = (date: string): JournalEntry => ({ kind: 'journal', id: `journal~${date}~x`, date, body: 'x', createdAt: `${date}T08:00:00.000Z`, updatedAt: `${date}T08:00:00.000Z` })
    const entries = [TODAY, ago(1), ago(3), ago(4), ago(5)].map(entry)
    expect(journalStreak(entries, TODAY)).toBe(dayStreaks(entries.map(e => e.date), TODAY).current)
    expect(journalStreak(entries, TODAY)).toBe(2)
    expect(journalStreak([{ ...entry(TODAY), deletedAt: TODAY }], TODAY)).toBe(0)
  })
})

describe('a year by month, and the trend', () => {
  it('gives the months in words, January first', () => {
    expect(MONTHS).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'])
  })

  it('buckets each item in its month of the year, on this device’s calendar, and leaves other years out', () => {
    const items = [at(1, 3), at(1, 20), at(3, 31, 23, 30), at(12, 31, 23, 59), { at: new Date(2025, 11, 31, 23).toISOString() }]
    expect(monthBuckets(items, 2026)).toEqual([2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1])
    expect(monthBuckets(items, 2025)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
    expect(monthBuckets([], 2026)).toEqual(Array(12).fill(0))
  })

  it('counts a bucket in days when asked: two events on a day are one', () => {
    expect(monthBuckets([at(2, 7, 10), at(2, 7, 19), at(2, 8)], 2026, countDays).slice(0, 3)).toEqual([0, 2, 0])
  })

  it('compares the last 90 days with the 90 before: positive when more lately', () => {
    const now = new Date(2026, 8, 14, 12)
    const daysBack = (n: number) => ({ at: new Date(2026, 8, 14 - n, 12).toISOString() })
    expect(TREND_DAYS).toBe(90)
    expect(recentTrend([daysBack(1), daysBack(89), daysBack(95)], now)).toBe(1)
    expect(recentTrend([daysBack(10), daysBack(100), daysBack(170)], now)).toBe(-1)
    expect(recentTrend([daysBack(10), daysBack(100)], now)).toBe(0)
    // 180 days back and more is in neither window
    expect(recentTrend([daysBack(181)], now)).toBe(0)
    expect(recentTrend([], now)).toBe(0)
    // a shorter span, counted in days
    expect(recentTrend([daysBack(1), daysBack(1), daysBack(40)], now, countDays, 30)).toBe(0)
  })

  it('makes a year table’s row of the two: the months, their total and the trend', () => {
    const now = new Date(2026, 8, 14, 12)
    const items = [at(9, 1), at(9, 2), at(5, 1), at(4, 1)]
    const row = monthsAndTrend(items, 2026, now)
    expect(row.months).toEqual(monthBuckets(items, 2026))
    expect(row.total).toBe(4)
    expect(row.trend).toBe(recentTrend(items, now))
    expect(monthsAndTrend([], 2026, now)).toEqual({ months: Array(12).fill(0), total: 0, trend: 0 })
  })
})

describe('a month as a grid', () => {
  it('lays a month out as whole Sunday-to-Saturday weeks, padded with null', () => {
    // Tuesday 1 September: Sunday and Monday before it are padding
    const sep = monthGrid(2026, 9)
    expect(sep).toHaveLength(35)
    expect(sep.slice(0, 3)).toEqual([null, null, '2026-09-01'])
    expect(sep.filter(Boolean)).toHaveLength(30)
    expect(sep.slice(31)).toEqual(['2026-09-30', null, null, null])
  })

  it('pads nothing for a February that starts on a Sunday, and runs to six weeks when a month needs them', () => {
    expect(monthGrid(2026, 2)).toEqual(Array.from({ length: 28 }, (_, i) => `2026-02-${String(i + 1).padStart(2, '0')}`))
    // Saturday 1 August
    const aug = monthGrid(2026, 8)
    expect(aug).toHaveLength(42)
    expect(aug.indexOf('2026-08-01')).toBe(6)
  })

  it('steps a month back and on across the year', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-09', 0)).toBe('2026-09')
    expect(shiftMonth('2026-09', -13)).toBe('2025-08')
  })
})

describe('the top few', () => {
  const rows = [
    { name: 'Tee', n: 3, last: '2026-09-01' },
    { name: 'Jeans', n: 5, last: '2026-09-02' },
    { name: 'Coat', n: 3, last: '2026-09-10' },
    { name: 'Boots', n: 3, last: '2026-09-01' },
    { name: 'Hat', n: 0, last: '' },
  ]
  const by = { count: (r: (typeof rows)[number]) => r.n, name: (r: (typeof rows)[number]) => r.name }

  it('ranks most first, settles a tie by name, and leaves out what counts nothing', () => {
    expect(topN(rows, 10, by).map(r => r.name)).toEqual(['Jeans', 'Boots', 'Coat', 'Tee'])
    expect(topN(rows, 2, by).map(r => r.name)).toEqual(['Jeans', 'Boots'])
    expect(topN(rows, Infinity, by)).toHaveLength(4)
  })

  it('settles a tie by `tie` first when given, then by name', () => {
    expect(topN(rows, 3, { ...by, tie: (a, b) => b.last.localeCompare(a.last) }).map(r => r.name)).toEqual(['Jeans', 'Coat', 'Boots'])
  })

  it('leaves the rows it was handed as they were, and ranks none from none', () => {
    const before = rows.map(r => r.name)
    topN(rows, 3, by)
    expect(rows.map(r => r.name)).toEqual(before)
    expect(topN([], 3, by)).toEqual([])
    expect(topN(rows, 0, by)).toEqual([])
  })
})
