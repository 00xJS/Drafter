import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { StatTile as BitsStatTile, TrendBadge as BitsTrendBadge } from '../components/bits'
import {
  ChartCard,
  ListCard,
  ListRow,
  MonthBars,
  MonthCalendar,
  Podium,
  RankedBars,
  StatTile,
  Stepper,
  StreakTiles,
  TrendBadge,
  WindowSwitch,
  YearTable,
  markInk,
} from '../components/stats'
import { graphicInk, heatStyle } from '../contrast'
import type { DayWindow } from '../stats'
import { elements, settled, type El } from './rendered'
import { sheetSource } from './source'

// The Stats kit, drawn on the server as the tests see every screen: each piece
// empty and with figures, its words, its classes and its colours. What it
// draws is handed to it; it counts nothing of its own.

const html = (node: ReactNode) => renderToStaticMarkup(node as ReactElement).replace(/<!-- -->/g, '')
/** The element a card holds at the right of its head: its switch or its stepper. */
const asideOf = (tree: ReactNode) => elements(tree).find(e => e.type === ChartCard)!.props.aside as El

describe('StatTile and StreakTiles', () => {
  it('are the tiles bits.tsx has always exported', () => {
    expect(BitsStatTile).toBe(StatTile)
    expect(BitsTrendBadge).toBe(TrendBadge)
  })

  it('draws an inert tile, with a line under it only when there is one', () => {
    expect(html(<StatTile label="Places" value="0" />)).toBe('<div class="stat-tile"><div class="stat-label">Places</div><div class="stat-value">0</div></div>')
    expect(html(<StatTile label="Overdue" value="2" sub="past your target rhythm" warn className="kpi-wide" />)).toBe(
      '<div class="stat-tile kpi-wide"><div class="stat-label">Overdue</div><div class="stat-value stat-warn">2</div><div class="stat-sub">past your target rhythm</div></div>',
    )
  })

  it('becomes a button with somewhere to jump, and stays one, unavailable, without', () => {
    expect(html(<StatTile label="Today" value="3" onJump={() => {}} />)).toContain('<button type="button" class="stat-tile stat-jump" title="Go to Today">')
    expect(html(<StatTile label="Today" value="0" onJump={null} />)).toContain('<button type="button" class="stat-tile stat-jump" aria-disabled="true">')
  })

  it('asks for a first day with no run, and says the best is none', () => {
    expect(html(<StreakTiles current={0} best={0} today={false} />)).toBe(
      '<div class="stat-tile"><div class="stat-label">Streak</div><div class="stat-value">0 days</div><div class="stat-sub">log a day to start one</div></div>' +
        '<div class="stat-tile"><div class="stat-label">Best streak</div><div class="stat-value">0 days</div><div class="stat-sub">logged in a row</div></div>',
    )
  })

  it('asks for today while it waits, says so once it counts, and speaks in its own words', () => {
    expect(html(<StreakTiles current={2} best={5} today={false} />)).toMatch(/Streak<\/div><div class="stat-value">2 days<\/div><div class="stat-sub">log today to keep it going</)
    expect(html(<StreakTiles current={1} best={5} today />)).toMatch(/1 day<\/div><div class="stat-sub">logged in a row, today too</)
    const cooked = html(<StreakTiles current={3} best={3} today noun="dinner" words={{ today: 'cooked in a row', best: 'cooked in a row' }} />)
    expect(cooked).toContain('3 dinners</div><div class="stat-sub">cooked in a row</div>')
  })
})

describe('TrendBadge', () => {
  it('reads more lately, drifting or steady, in tokens', () => {
    expect(html(<TrendBadge trend={0} />)).toBe('<small class="muted">steady</small>')
    expect(html(<TrendBadge trend={2} />)).toBe('<span class="badge" style="background:var(--tone-sky-bg);color:var(--tone-sky)">↑ more lately</span>')
    expect(html(<TrendBadge trend={-1} />)).toBe('<span class="badge" style="background:var(--tone-amber-bg);color:var(--tone-amber)">↓ drifting</span>')
  })
})

describe('ChartCard, Stepper and WindowSwitch', () => {
  it('draws a card with its title alone, and with its line, its switch and what it holds', () => {
    expect(html(<ChartCard title="Top three" />)).toBe('<section class="chart-card"><header class="chart-head"><div><h3>Top three</h3></div></header></section>')
    expect(html(<ChartCard title="Seen" sub="In days" aside={<b>x</b>} className="year-report">
      <p>body</p>
    </ChartCard>)).toBe('<section class="chart-card year-report"><header class="chart-head"><div><h3>Seen</h3><p class="chart-sub">In days</p></div><b>x</b></header><p>body</p></section>')
  })

  it('steps a year both ways, and stops a month at the present', () => {
    const onStep = vi.fn()
    const year = settled(Stepper, { label: '2026', unit: 'year', onStep })
    expect(html(year)).toBe(
      '<span class="segmented"><button type="button" class="seg" aria-label="Previous year">‹</button><button type="button" class="seg on">2026</button><button type="button" class="seg" aria-label="Next year">›</button></span>',
    )
    const [back, , on] = elements(year).filter(e => e.type === 'button')
    ;(back.props.onClick as () => void)()
    ;(on.props.onClick as () => void)()
    expect(onStep.mock.calls).toEqual([[-1], [1]])
    expect(html(<Stepper label="Sep 2026" unit="month" onStep={onStep} canNext={false} />)).toContain('aria-label="Next month" disabled=""')
  })

  it('presses the window it counts by', () => {
    const onChange = vi.fn()
    const tree = settled(WindowSwitch, { value: 365 as DayWindow, onChange })
    expect(html(tree)).toBe(
      '<span class="segmented"><button type="button" aria-pressed="false" class="seg">30 days</button><button type="button" aria-pressed="true" class="seg on">12 months</button><button type="button" aria-pressed="false" class="seg">All</button></span>',
    )
    ;(elements(tree).filter(e => e.type === 'button')[2].props.onClick as () => void)()
    expect(onChange).toHaveBeenCalledWith('all')
    expect(html(<WindowSwitch value={30} onChange={onChange} windows={[{ key: 30, label: 'Month' }]} />)).toBe(
      '<span class="segmented"><button type="button" aria-pressed="true" class="seg on">Month</button></span>',
    )
  })
})

describe('RankedBars', () => {
  type Row = { key: string; name: string; count: number; color?: string }
  const rows: Record<string, Row[]> = {
    '30': [
      { key: 'mum', name: 'Mum', count: 4, color: '#f2f2f2' },
      { key: 'sam', name: 'Sam', count: 2 },
    ],
    '365': [{ key: 'mum', name: 'Mum', count: 40, color: '#f2f2f2' }],
    all: [],
  }
  const props = (over: Partial<Parameters<typeof RankedBars<Row>>[0]> = {}) => ({
    title: 'Seen most',
    sub: 'Days seen',
    empty: 'Nobody yet.',
    rank: (w: DayWindow) => rows[String(w)],
    color: (r: Row) => r.color,
    ...over,
  })

  it('says what it would show when nothing counts in the window', () => {
    const out = html(<RankedBars {...props({ initial: 'all' })} />)
    expect(out).toContain('<h3>Seen most</h3><p class="chart-sub">Days seen</p>')
    expect(out).toContain('<p class="empty">Nobody yet.</p>')
    expect(out).not.toContain('hbars')
  })

  it('draws each bar against the first, in its own colour moved to stand out, and its area’s without one', () => {
    const out = html(<RankedBars {...props()} />)
    expect(out).toContain('<div class="hbars stats-hbars">')
    expect(out).toContain(`<span class="hbar-fill" style="width:85%;background:${graphicInk('#f2f2f2', 'light')}"></span><span class="hbar-value">4</span>`)
    // no colour of its own: its area's (an .ink-* ancestor), or the chart series outside one
    expect(out).toContain('<span class="hbar-fill" style="width:42.5%;background:var(--area-ink, var(--viz-series-1))"></span><span class="hbar-value">2</span>')
    // a label, not a button, with nothing to open
    expect(out).toContain('<span class="stats-hbar-label"><span class="stats-hbar-name">Mum</span></span>')
  })

  it('opens a row from its picture and name, with its badge', () => {
    const onOpen = vi.fn()
    const tree = settled(RankedBars<Row>, props({ picture: r => <i className="avatar">{r.name[0]}</i>, badge: r => r.key === 'sam' && <b>new</b>, onOpen }))
    const out = html(tree)
    expect(out).toContain('<button type="button" class="stats-hbar-label"><i class="avatar">S</i><span class="stats-hbar-name">Sam</span><b>new</b></button>')
    const bars = elements(tree).find(e => e.props.className === 'hbars stats-hbars')!
    ;(elements(bars).filter(e => e.type === 'button')[0].props.onClick as () => void)()
    expect(onOpen).toHaveBeenCalledWith(rows['30'][0])
  })

  it('counts the window its switch is pressed to', () => {
    const tree = settled(RankedBars<Row>, props(), t => (asideOf(t).props.onChange as (w: DayWindow) => void)(365))
    const out = html(tree)
    expect(out).toContain('aria-pressed="true" class="seg on">12 months</button>')
    expect(out).toContain('<span class="hbar-value">40</span>')
    expect(out).not.toContain('Sam')
  })

  it('keeps the wardrobe’s classes under its prefix', () => {
    expect(html(<RankedBars {...props()} prefix="wardrobe" />)).toContain('<div class="hbars wardrobe-hbars"><div class="hbar-row"><span class="wardrobe-hbar-label"><span class="wardrobe-hbar-name">Mum</span>')
  })
})

describe('Podium', () => {
  type Row = { key: string; name: string; count: number }
  const top: Row[] = [
    { key: 'a', name: 'Mum', count: 9 },
    { key: 'b', name: 'Sam', count: 5 },
    { key: 'c', name: 'Jo', count: 1 },
    { key: 'd', name: 'Al', count: 1 },
  ]
  const picture = (r: Row) => <i className="podium-photo">{r.name[0]}</i>

  it('stands nobody on three empty steps, hidden from a screen reader', () => {
    expect(html(<Podium top={[]} picture={picture} />)).toBe(
      '<ol class="podium">' + [1, 2, 3].map(n => `<li class="podium-place rank-${n} vacant" aria-hidden="true"><span class="podium-step"></span></li>`).join('') + '</ol>',
    )
  })

  it('stands the first three in reading order, names each for a screen reader, and opens it', () => {
    const onOpen = vi.fn()
    const tree = settled(Podium<Row>, { top, picture, noun: 'day', note: r => (r.key === 'c' ? ' · Moved away' : ''), onOpen })
    const out = html(tree)
    expect([...out.matchAll(/class="podium-piece" aria-label="([^"]+)"/g)].map(m => m[1])).toEqual(['First: Mum, 9 days', 'Second: Sam, 5 days', 'Third: Jo, 1 day'])
    expect(out).toContain('<i class="podium-photo">M</i><span class="podium-name">Mum</span><span class="podium-count">9 days</span>')
    expect(out).toContain('<span class="podium-count">1 day · Moved away</span>')
    expect(out).not.toContain('Al')
    expect(out).not.toContain('vacant')
    ;(elements(tree).filter(e => e.type === 'button')[1].props.onClick as () => void)()
    expect(onOpen).toHaveBeenCalledWith(top[1])
  })

  it('keeps first in the middle with one, and draws a picture, not a button, with nothing to open', () => {
    const out = html(<Podium top={top.slice(0, 1)} picture={picture} noun="outing" />)
    expect(out).toContain('<li class="podium-place rank-1"><span class="podium-piece"><i class="podium-photo">M</i><span class="podium-name">Mum</span><span class="podium-count">9 outings</span></span><span class="podium-step" aria-hidden="true">1</span></li>')
    expect(out.match(/rank-\d vacant/g)).toEqual(['rank-2 vacant', 'rank-3 vacant'])
  })
})

describe('MonthCalendar', () => {
  const today = '2026-09-14'
  const busy = new Set(['2026-09-01', '2026-09-14', '2026-08-20'])
  const day = (key: string) => (busy.has(key) ? { what: 'dinner with Mum', content: <i className="avatar">M</i>, className: 'has-look' } : { what: 'nothing' })

  it('draws a month of nothing: padding, today marked, the days to come dashed and inert', () => {
    const out = html(<MonthCalendar today={today} title="Days out" day={() => ({ what: 'nothing' })} />)
    expect(out).toContain('<section class="chart-card stats-photo-cal"><header class="chart-head"><div><h3>Days out</h3></div>')
    expect(out).toContain('<div class="photo-cal-head" aria-hidden="true"><span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span></div>')
    expect(out).toContain('<ol class="photo-cal" aria-label="Sep 2026">')
    expect(out.match(/class="photo-cal-pad"/g)).toHaveLength(5)
    expect(out.match(/class="photo-cal-cell[^"]*"/g)).toHaveLength(30)
    expect(out).toContain('<li class="photo-cal-cell today"><span class="photo-cal-day" title="Mon 14 Sep: nothing"><span class="photo-cal-num">14</span></span></li>')
    expect(out).toContain('<li class="photo-cal-cell later"><span class="photo-cal-day"><span class="photo-cal-num">15</span></span></li>')
    expect(out).not.toContain('<button type="button" class="photo-cal-day"')
    expect(out).toMatch(/aria-label="Next month" disabled=""/)
  })

  it('draws each day through its render prop, and opens a day that has come', () => {
    const onOpen = vi.fn()
    const tree = settled(MonthCalendar, { today, title: 'Days out', sub: (y: number, m: number) => `${m}/${y}`, day, onOpen })
    const out = html(tree)
    expect(out).toContain('<p class="chart-sub">9/2026</p>')
    expect(out).toContain('<li class="photo-cal-cell has-look"><button type="button" class="photo-cal-day" aria-label="Tue 1 Sep: dinner with Mum"><i class="avatar">M</i><span class="photo-cal-num">1</span></button></li>')
    expect(out).toContain('<li class="photo-cal-cell has-look today"><button type="button" class="photo-cal-day" aria-label="Mon 14 Sep: dinner with Mum">')
    expect(out).toContain('aria-label="Fri 11 Sep: nothing"')
    expect(out.match(/<button type="button" class="photo-cal-day"/g)).toHaveLength(14)
    const cell = elements(tree).find(e => e.type === 'button' && e.props['aria-label'] === 'Fri 11 Sep: nothing')!
    ;(cell.props.onClick as () => void)()
    expect(onOpen).toHaveBeenCalledWith('2026-09-11')
  })

  it('steps back a month, with its own line, and on again as far as today’s', () => {
    const tree = settled(MonthCalendar, { today, title: 'Days out', sub: (y: number, m: number) => `${m}/${y}`, day }, t => (asideOf(t).props.onStep as (d: number) => void)(-1))
    const out = html(tree)
    expect(out).toContain('<ol class="photo-cal" aria-label="Aug 2026">')
    expect(out).toContain('<p class="chart-sub">8/2026</p>')
    // a past month has no today and nothing still to come, and › is offered again
    expect(out).not.toMatch(/photo-cal-cell[^"]*(today|later)/)
    expect(out).not.toContain('disabled')
    expect(out).toContain('<li class="photo-cal-cell has-look"><span class="photo-cal-day" title="Thu 20 Aug: dinner with Mum">')
  })
})

describe('MonthBars', () => {
  it('draws a year of nothing as twelve ticks on the baseline, steady', () => {
    const out = html(<MonthBars months={Array(12).fill(0)} current={8} label="Days seen" total="0 days in 2026" trend={0} />)
    expect(out).toContain('<div class="chart-plot stats-month-bars"><svg viewBox="0 0 360 112" role="img" aria-label="Days seen: Jan 0, Feb 0, Mar 0, Apr 0, May 0, Jun 0, Jul 0, Aug 0, Sep 0, Oct 0, Nov 0, Dec 0">')
    expect(out).not.toContain('<rect')
    expect(out.match(/class="tick-label"/g)).toHaveLength(12)
    expect(out).toContain('<p class="stats-month-total">0 days in 2026 <small class="muted">steady</small></p>')
  })

  it('draws a bar for each month with any, this month’s hot, each with its tooltip, and the total with its trend', () => {
    const months = [2, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 1]
    const out = html(<MonthBars months={months} current={8} label="Outings" noun="outing" total="7 outings in 2026" trend={3} />)
    expect(out.match(/<rect /g)).toHaveLength(3)
    expect(out).toContain('<rect class="bar hot" x="246" y="8" width="18" height="86" rx="2"><title>Sep: 4 outings</title></rect>')
    expect(out).toContain('<title>Dec: 1 outing</title>')
    expect(out).toMatch(/<rect class="bar" x="6"[^>]*><title>Jan: 2 outings<\/title>/)
    expect(out).toContain('<p class="stats-month-total">7 outings in 2026 <span class="badge"')
    expect(html(<MonthBars months={months} current={-1} label="Outings" total="" trend={0} />)).not.toContain('bar hot')
  })
})

describe('ListCard and ListRow', () => {
  it('says there is nothing, in words, with no items', () => {
    expect(html(<ListCard title="Not seen lately" sub="In 90 days or more" items={[]} empty="Everyone has been seen." row={() => null} />)).toBe(
      '<section class="chart-card"><header class="chart-head"><div><h3>Not seen lately</h3><p class="chart-sub">In 90 days or more</p></div></header><p class="empty">Everyone has been seen.</p></section>',
    )
    expect(html(<ListCard title="Never" items={[]} row={() => null} />)).toBe('<section class="chart-card"><header class="chart-head"><div><h3>Never</h3></div></header></section>')
  })

  it('lists each item through its row: a picture, a name and a line that open it, and an action at its end', () => {
    const onOpen = vi.fn()
    const people = [
      { id: 'mum', name: 'Mum', line: 'Last seen 4 months ago' },
      { id: 'jo', name: 'Jo', line: 'Last seen 3 months ago' },
    ]
    const out = html(
      <ListCard
        title="Not seen lately"
        items={people}
        row={p => <ListRow key={p.id} picture={<i className="avatar">{p.name[0]}</i>} name={p.name} line={p.line} onOpen={onOpen} action={<button type="button">Plan</button>} />}
      />,
    )
    expect(out).toContain('<ul class="stats-list"><li class="stats-list-row"><button type="button" class="stats-list-piece"><i class="avatar">M</i><span><span class="stats-list-name">Mum</span><small class="muted">Last seen 4 months ago</small></span></button><button type="button">Plan</button></li>')
    expect(out.match(/class="stats-list-row"/g)).toHaveLength(2)
    const row = settled(ListRow, { name: 'Mum', onOpen })
    ;(elements(row).find(e => e.type === 'button')!.props.onClick as () => void)()
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('draws a row with nothing to open as a picture and words, and keeps the wardrobe’s classes under its prefix', () => {
    expect(html(<ListRow name="Mum" />)).toBe('<li class="stats-list-row"><span class="stats-list-piece"><span><span class="stats-list-name">Mum</span></span></span></li>')
    expect(html(<ListRow prefix="wardrobe" name="tee" line="Added 6 weeks ago" onOpen={() => {}} />)).toBe(
      '<li class="wardrobe-list-row"><button type="button" class="wardrobe-list-piece"><span><span class="wardrobe-list-name">tee</span><small class="muted">Added 6 weeks ago</small></span></button></li>',
    )
  })
})

describe('YearTable', () => {
  type Row = { key: string; name: string; months: number[]; total: number; trend: number; color: string; events: number }
  const row = (key: string, color: string, months: number[], trend = 0, events = 0): Row => ({ key, name: key, color, months, total: months.reduce((a, b) => a + b, 0), trend, events })
  const indigo = row('Indigo', '#4f46e5', [0, 0, 0, 0, 0, 0, 1, 4, 0, 0, 0, 0], 2, 6)

  it('says there is nothing, in words, with no rows, or draws its heads alone', () => {
    expect(html(<YearTable rows={[] as Row[]} head="Place" noun="outing" totalHead="Outings" color={r => r.color} empty="Nowhere yet." />)).toBe('<p class="empty">Nowhere yet.</p>')
    const bare = html(<YearTable rows={[]} head="Place" noun="outing" totalHead="Outings" color={(r: Row) => r.color} />)
    expect(bare).toContain('<div class="table-scroll"><table class="year-table"><thead><tr><th>Place</th><th class="num">Jan</th>')
    expect(bare).toContain('<th class="num">Outings</th><th>Trend</th></tr></thead><tbody></tbody>')
  })

  it('tints each month’s cell at the heat the tables use, readable on a deep colour, with the total and the trend', () => {
    const out = html(<YearTable rows={[indigo]} head="Place" noun="outing" totalHead="Outings" color={r => r.color} />)
    expect(out).toContain('<td><span class="pdot" style="background:#4f46e5"></span> Indigo</td>')
    const july = heatStyle('#4f46e5', 1, 'light')
    const august = heatStyle('#4f46e5', 4, 'light')
    expect(out).toContain(`<td class="num year-cell" title="1 outing" style="background:${july.background}">1</td>`)
    expect(out).toContain(`<td class="num year-cell" title="4 outings" style="background:${august.background};color:${august.color}">4</td>`)
    expect(out.match(/<td class="num year-cell"><\/td>/g)).toHaveLength(10)
    expect(out).toContain('<td class="num"><strong>5</strong></td><td><span class="badge"')
  })

  it('takes one letter a month where room is short, a column before the trend, and a mark’s colour as drawn', () => {
    const out = html(
      <YearTable
        rows={[indigo]}
        head="Person"
        noun="day"
        totalHead="Days"
        months={['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']}
        extra={{ head: 'Events', className: 'year-events', cell: r => r.events }}
        color={r => markInk(r.color, 'light')}
      />,
    )
    expect(out).toContain('<th>Person</th><th class="num">J</th><th class="num">F</th>')
    expect(out).toContain('<th class="num">Days</th><th class="num">Events</th><th>Trend</th>')
    expect(out).toContain('<td class="num"><strong>5</strong></td><td class="num year-events">6</td><td>')
    expect(out).toContain(`title="4 days" style="background:${heatStyle(markInk('#4f46e5', 'light'), 4, 'light').background}`)
  })
})

describe('markInk', () => {
  it('moves a pale colour to stand out on the card, and gives its area’s to none', () => {
    expect(markInk('#f2f2f2', 'light')).toBe(graphicInk('#f2f2f2', 'light'))
    expect(markInk('#f2f2f2', 'light')).not.toBe('#f2f2f2')
    expect(markInk('#f2f2f2', 'dark')).toBe('#f2f2f2')
    expect(markInk(undefined, 'dark')).toBe('var(--area-ink, var(--viz-series-1))')
    expect(markInk('var(--tone-sky)', 'light')).toBe('var(--tone-sky)')
  })
})

describe('the kit’s own styles', () => {
  const css = sheetSource()

  it('draws each stats- class as its wardrobe- twin, in one rule', () => {
    for (const name of ['hbars .hbar-row', 'hbar-label', 'hbar-name', 'list', 'list-row', 'list-piece', 'list-piece > span', 'list-name', 'month-total']) {
      const esc = name.replace(/[.>]/g, m => `\\${m}`)
      expect(css, name).toMatch(new RegExp(`\\.wardrobe-${esc}(?![\\w-])[^{}]*\\.stats-${esc}(?![\\w-])[^{}]*\\{`))
    }
  })

  it('gives a row that opens something the 44pt floor on a touch screen, as the wardrobe’s has', () => {
    expect(css).toMatch(/@media \(pointer: coarse\) \{[^@]*\.stats-list-piece,/)
  })

  it('dims a stepper’s › stopped at the present, as the wardrobe’s day steps are', () => {
    expect(css).toMatch(/\.seg:disabled \{\s*opacity: 0\.35;\s*cursor: not-allowed;\s*\}/)
    expect(css).toMatch(/\.wardrobe-step:disabled \{\s*opacity: 0\.35;/)
  })
})

describe('the kit stays out of the first load', () => {
  const SRC = fileURLToPath(new URL('../', import.meta.url))
  /** Static edges only: `import type` and import() are not followed (lazyload.test.ts's walk). */
  const reach = (entries: string[]) => {
    const seen = new Set<string>()
    const todo = [...entries]
    while (todo.length) {
      const file = todo.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      const code = readFileSync(file, 'utf8')
      for (const m of code.matchAll(/^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm)) {
        const base = resolve(dirname(file), m[1])
        const hit = [base, `${base}.ts`, `${base}.tsx`].find(p => existsSync(p) && statSync(p).isFile())
        if (hit && /\.(tsx?|mts|mjs)$/.test(hit)) todo.push(hit)
      }
    }
    return seen
  }
  const shell = reach([resolve(SRC, 'main.tsx'), resolve(SRC, 'components/Planner.tsx')])
  const kit = (name: string) => resolve(SRC, 'components/stats', name)

  it('lets StatTile and TrendBadge ride in through bits.tsx, and nothing else of it', () => {
    expect(shell).toContain(kit('StatTile.tsx'))
    expect(shell).toContain(kit('TrendBadge.tsx'))
    const heavy = ['index.ts', 'ChartCard.tsx', 'RankedBars.tsx', 'Podium.tsx', 'MonthCalendar.tsx', 'MonthBars.tsx', 'ListCard.tsx', 'YearTable.tsx', 'ink.ts'].map(kit)
    expect(heavy.filter(f => shell.has(f)).map(f => f.slice(SRC.length))).toEqual([])
  })

  it('draws the wardrobe’s Stats with it', () => {
    const stats = readFileSync(resolve(SRC, 'components/wardrobe/WardrobeStats.tsx'), 'utf8')
    expect(stats).toMatch(/from '\.\.\/stats'/)
    expect(stats).not.toMatch(/function (Podium|MonthBars|PhotoCalendar)\b/)
  })
})
