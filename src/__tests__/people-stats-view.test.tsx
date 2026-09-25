import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { useState, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup, renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Calendar } from '../components/Calendar'
import { People } from '../components/People'
import { PeopleStats } from '../components/PeopleStats'
import { ListStatsSwitch } from '../components/planner/ListStatsSwitch'
import { Segmented } from '../components/stats/Segmented'
import { CAL_MODE_KEY, INNER_VIEW_KEYS, PEOPLE_TAB_KEY, type CalendarMode, type InnerView, type KeepTab, type View } from '../components/planner/routes'
import { useDeepLinks } from '../components/planner/useDeepLinks'
import { useNavigation } from '../components/planner/useNavigation'
import { ListCard, MonthCalendar } from '../components/stats'
import { contrast, graphicInk, mixHex, readableInk } from '../contrast'
import { NO_PERSON_FILTER } from '../people'
import { THEME_HEX, type Theme } from '../theme'
import { PROJECT_COLORS, type CalendarEntry, type Person, type Place, type Recipe, type Task } from '../types'
import { elements, press, propsOf, settled, type El } from './rendered'
import { sheetSource, viewSheet } from './source'

// People → Stats, drawn on the server as the tests see every screen: with
// nobody, with people and nothing seen, and with a household's visits, in the
// light theme and the dark; every figure beside the same one on the list; the
// switch that reaches it and the shell that remembers it, the palette's link
// to it, and the day its month opens on the Calendar. The counting itself is
// people-stats.test.ts's.

/** The theme useTheme reports: light, as its server snapshot is, unless a test turns it dark. */
const painted = vi.hoisted(() => ({ theme: 'light' as Theme }))
vi.mock('../theme', async importOriginal => ({ ...(await importOriginal<typeof import('../theme')>()), useTheme: () => painted.theme }))

const NOW = new Date(2026, 8, 14, 12, 0) // Monday 14 September 2026, local noon
const STAMP = '2026-01-01T00:00:00.000Z'
const at = (m: number, d: number, h = 12) => new Date(2026, m - 1, d, h).toISOString()
const noop = () => {}
const html = (node: ReactNode) => renderToStaticMarkup(node as ReactElement).replace(/<!-- -->/g, '')
const source = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

const person = (id: string, name: string, over: Partial<Person> = {}): Person => ({ kind: 'person', id, name, color: '#3b82f6', group: 'family', createdAt: STAMP, updatedAt: STAMP, ...over })
let seq = 0
const done = (when: string, peopleIds: string[], over: Partial<Task> = {}): Task => ({
  kind: 'task',
  id: `t${++seq}`,
  title: 'Visit',
  description: '',
  status: 'done',
  priority: 'normal',
  tags: ['visit'],
  peopleIds,
  completedAt: when,
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
})

// A–Z, as the store keeps them
const PEOPLE = [
  person('ben', 'Ben', { group: 'friends', cadenceDays: 30 }),
  person('dad', 'Dad', { color: '#10b981' }),
  person('gran', 'Gran', { cadenceDays: 14 }),
  person('jo', 'Jo', { group: 'friends', color: '#ef4444' }),
  person('kit', 'Kit', { group: 'other', createdAt: at(8, 25, 9) }),
  person('mum', 'Mum', { emoji: '👩', color: '#fbbf24', cadenceDays: 14, birthday: '1966-09-26' }),
  person('newbie', 'Newbie', { group: 'other', createdAt: at(9, 11, 9) }),
  person('sam', 'Sam', { group: 'friends', color: '#8b5cf6', birthday: '0000-09-14' }),
]
const TASKS = [
  done(at(9, 12, 13), ['mum', 'dad', 'sam', 'jo']), // Saturday's dinner
  done(at(9, 12, 20), ['sam']), // and drinks with Sam that evening
  done(at(9, 13), ['mum', 'dad']),
  done(at(9, 11), ['dad']),
  // logged by someone else in the household: Mine / Everyone narrows nothing here
  done(at(9, 10), ['mum'], { ownerId: 'partner', assigneeId: 'partner' }),
  done(at(8, 1), ['mum', 'dad', 'gran', 'ben']),
  done(at(7, 5), ['sam']),
  // still to do: not a visit
  done(at(9, 14), ['mum'], { status: 'todo', completedAt: undefined }),
]
/** Wednesday's lunch with Sam, on your own calendar. */
const ENTRIES: CalendarEntry[] = [{ kind: 'event', id: 'lunch', title: 'Lunch', start: at(9, 9, 13), end: at(9, 9, 14), allDay: false, peopleIds: ['sam'], createdAt: STAMP, updatedAt: STAMP }]

type StatsProps = ComponentProps<typeof PeopleStats>
const PROPS: StatsProps = { people: PEOPLE, tasks: TASKS, entries: ENTRIES, filter: NO_PERSON_FILTER, onFilter: noop, onSaw: noop, onOpenPerson: noop, onOpenDay: noop, now: NOW }
const stats = (over: Partial<StatsProps> = {}) => html(<PeopleStats {...PROPS} {...over} />)
const list = () => html(<People people={PEOPLE} tasks={TASKS} entries={ENTRIES} filter={NO_PERSON_FILTER} onFilter={noop} onSave={noop} onDelete={noop} onLogVisit={noop} onPlan={noop} onOpenTask={noop} />)
/** People → Stats with its chip and find box held, as the People tab holds them, so a chip pressed narrows the next render. */
function Held(props: StatsProps) {
  const [filter, onFilter] = useState(props.filter)
  return PeopleStats({ ...props, filter, onFilter })
}

/** The card titled `title`, head to foot. */
function cardOf(page: string, title: string): string {
  const head = page.indexOf(`<h3>${title}</h3>`)
  if (head < 0) throw new Error(`no ${title} card`)
  return page.slice(page.lastIndexOf('<section', head), page.indexOf('</section>', head))
}
/** The names a list card lists, in order. */
const namesIn = (card: string) => [...card.matchAll(/class="stats-list-name">([^<]+)</g)].map(m => m[1])
const tile = (label: string, value: string) => `<div class="stat-label">${label}</div><div class="stat-value">${value}</div>`
/** Each face drawn: its class, its colour, the ground its tint is laid over, and its ink. */
const facesIn = (page: string) =>
  [...page.matchAll(/class="stats-face ([\w-]+)" style="background:linear-gradient\((#[0-9a-f]{6})22, #[0-9a-f]{8}\), var\((--surface(?:-2)?)\);color:(#[0-9a-f]{6})"/g)].map(m => ({
    className: m[1],
    color: m[2],
    ground: m[3],
    ink: m[4],
  }))
/** Saw them's handler on one of a list card's rows. */
function sawOn(tree: ReactNode, title: string, index: number) {
  const card = elements(tree).find(e => e.type === ListCard && e.props.title === title)!
  const line = (card.props.row as (item: unknown) => El)((card.props.items as unknown[])[index])
  // the row draws a ListRow: its button opens the card, its action logs the visit
  const row = (line.type as (props: Record<string, unknown>) => El)(line.props)
  return { row, saw: (row.props.action as El).props.onClick as (e: { currentTarget: unknown }) => void }
}

beforeEach(() => {
  // the list reads the clock; Stats is handed it
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  painted.theme = 'light'
})

describe('with nobody on the list', () => {
  it('says what will show here, and draws nothing else', () => {
    expect(stats({ people: [], tasks: [], entries: [] })).toBe(
      '<div class="people-stats"><div class="chart-card"><p class="empty">Add the people you want to keep close on the List. Once you have seen them, who you see most, how often and who is due a catch-up show here.</p></div></div>',
    )
  })
})

describe('with people, and nobody seen yet', () => {
  const page = () => stats({ tasks: [], entries: [] })

  it('counts them, and draws no tile for a figure of nothing', () => {
    const out = page()
    expect(out).toContain('<div class="stat-tile"><div class="stat-label">People</div><div class="stat-value">8</div><div class="stat-sub">on your list</div></div>')
    // "Overdue 0", "Streak 0 days" and the rest were most of what the page was
    for (const label of ['This month', 'Seen lately', 'Overdue', 'Due a catch-up', 'Streak', 'Best streak']) expect(out, label).not.toContain(`<div class="stat-label">${label}</div>`)
    // the all-time card still says what all time has held, in its own words
    for (const [label, value] of [
      ['Days together', '0'],
      ['Occasions', '0'],
      ['People seen', '0'],
    ])
      expect(out, label).toContain(tile(label, value))
  })

  it('says each card is empty, stands nobody on the podium, and lists who was added a fortnight ago', () => {
    const out = page()
    expect(out).not.toContain('Top three')
    expect(cardOf(out, 'Most seen')).toContain('<p class="empty">Log a visit, or finish a task with someone on it, and your most seen show here.</p>')
    expect(cardOf(out, 'Not seen lately')).toContain('<p class="empty">Nobody is past their rhythm.</p>')
    expect(cardOf(out, 'Often together')).toContain('<p class="empty">Two people seen on the same day, twice or more, show here.</p>')
    expect(cardOf(out, 'Groups')).toContain('<p class="empty">Log a visit and each group’s share shows here.</p>')
    // added in January and in August; Newbie, three days ago, not yet
    expect(namesIn(cardOf(out, 'Never seen'))).toEqual(['Ben', 'Dad', 'Gran', 'Jo', 'Mum', 'Sam', 'Kit'])
    expect(cardOf(out, 'Who you saw')).toContain('<p class="chart-sub">Each day’s people · 0 days with someone</p>')
    expect(cardOf(out, 'The year with people')).toContain('0 days with someone in 2026')
  })
})

describe('with a household’s visits', () => {
  it('reads the tiles', () => {
    const out = stats()
    for (const [label, value] of [
      ['People', '8'],
      ['This month', '5 of 14'],
      ['Seen lately', '6 of 8'],
      ['Due a catch-up', '1'],
      ['Streak', '5 days'],
      ['Best streak', '5 days'],
      ['Days together', '7'],
      ['Occasions', '8'],
      ['People seen', '15'],
    ])
      expect(out, label).toContain(tile(label, value))
    expect(out).toContain('<div class="stat-label">Overdue</div><div class="stat-value stat-warn">1</div><div class="stat-sub">past your target rhythm</div>')
    // due is the list's badge: past the rhythm, short of overdue, so it never reads as Not seen lately's count
    expect(out).toContain(`${tile('Due a catch-up', '1')}<div class="stat-sub">past your target rhythm, not yet overdue</div>`)
    // today has nobody yet: the run waits for it
    expect(out).toContain('see someone today to keep it going')
  })

  it('stands the three most seen of all time on the podium, each face in their colour, made to read', () => {
    const out = stats()
    const podium = out.slice(out.indexOf('<ol class="podium">'), out.indexOf('</ol>', out.indexOf('<ol class="podium">')))
    expect([...podium.matchAll(/<span class="podium-name">([^<]+)<\/span>/g)].map(m => m[1])).toEqual(['Dad', 'Mum', 'Sam'])
    expect(podium).toContain('aria-label="First: Dad, 4 days"')
    const ink = readableInk('#fbbf24', 'light', { tint: true })
    expect(ink).not.toBe('#fbbf24')
    // the tint laid over the card's own ground, so the face is opaque
    expect(podium).toContain(`<span class="stats-face podium-face" style="background:linear-gradient(#fbbf2422, #fbbf2422), var(--surface);color:${ink}" aria-hidden="true">👩</span>`)
    expect(podium).toContain('aria-hidden="true">D</span>')
  })

  it('ranks the most seen over 30 days, every bar in People’s one colour', () => {
    const bars = cardOf(stats(), 'Most seen')
    expect([...bars.matchAll(/stats-hbar-name">([^<]+)</g)].map(m => m[1])).toEqual(['Dad', 'Mum', 'Sam', 'Jo'])
    // not a rainbow of each person's own: their colour is their face beside the bar
    const fills = [...bars.matchAll(/class="hbar-fill" style="width:[\d.]+%;background:([^"]+)"/g)].map(m => m[1])
    expect(fills).toHaveLength(4)
    expect(new Set(fills)).toEqual(new Set(['var(--area-ink, var(--viz-series-1))']))
    expect(bars).not.toContain(`background:${graphicInk('#fbbf24', 'light')}`)
    expect(bars).toContain('aria-pressed="true" class="seg on">30 days</button>')
  })

  it('lists who is past their rhythm with Saw them, and who was never seen', () => {
    const out = stats()
    const rested = cardOf(out, 'Not seen lately')
    expect(namesIn(rested)).toEqual(['Gran', 'Ben'])
    expect(rested).toContain('Last seen 44 days ago — you aimed for every 14 days')
    expect(rested).toContain('<button type="button" class="btn subtle" aria-label="Saw them: Gran">Saw them</button>')
    const never = cardOf(out, 'Never seen')
    expect(namesIn(never)).toEqual(['Kit'])
    expect(never).toContain('Added 3 weeks ago')
  })

  it('logs a visit from Saw them, and opens a person from their name', () => {
    const onSaw = vi.fn()
    const onOpenPerson = vi.fn()
    const { row, saw } = sawOn(settled(PeopleStats, { ...PROPS, onSaw, onOpenPerson }), 'Not seen lately', 0)
    saw({ currentTarget: { closest: () => null } })
    ;(row.props.onOpen as () => void)()
    expect(onSaw).toHaveBeenCalledWith(PEOPLE[2])
    expect(onOpenPerson).toHaveBeenCalledWith(PEOPLE[2])
  })

  it('keeps a keyboard’s place when Saw them takes its row away: the next row’s Saw them, the one before, else the card’s heading', () => {
    const onSaw = vi.fn()
    const tree = settled(PeopleStats, { ...PROPS, onSaw })
    const focused: string[] = []
    const focusable = (name: string) => ({ tabIndex: 0, focus: () => void focused.push(name) })
    const heading = focusable('heading')
    /** A Saw them button in its row, between these rows' own Saw them, in the card. */
    const button = (next: object | null, before: object | null) => {
      const neighbour = (b: object | null) => b && { querySelector: () => b }
      const li = { nextElementSibling: neighbour(next), previousElementSibling: neighbour(before) }
      return { closest: (selector: string) => (selector === 'li' ? li : { querySelector: () => heading }) }
    }
    const press = (b: object, held: boolean) => {
      vi.stubGlobal('document', { activeElement: held ? b : null })
      sawOn(tree, 'Not seen lately', 0).saw({ currentTarget: b })
    }
    // a tap leaves no focus on the button, so nothing moves
    press(button(focusable('next'), null), false)
    expect(focused).toEqual([])
    press(button(focusable('next'), focusable('before')), true)
    press(button(null, focusable('before')), true)
    press(button(null, null), true)
    expect(focused).toEqual(['next', 'before', 'heading'])
    // the heading takes focus without joining the tab order
    expect(heading.tabIndex).toBe(-1)
    expect(onSaw).toHaveBeenCalledTimes(4)
  })

  it('shows each day’s faces, three and then +n, and opens the day on the Calendar', () => {
    const cal = cardOf(stats(), 'Who you saw')
    expect(cal).toContain('<p class="chart-sub">Each day’s people · 5 days with someone</p>')
    const day = cal.match(/<li class="photo-cal-cell has-people"><button type="button" class="photo-cal-day" aria-label="Sat 12 Sep: Dad, Jo, Mum and Sam">([\s\S]*?)<\/button><\/li>/)
    expect(day).not.toBeNull()
    expect(day![1].match(/class="stats-face people-cal-face"/g)).toHaveLength(3)
    expect(day![1]).toContain('<span class="people-cal-more" aria-hidden="true">+1</span>')
    // laid over the day cell's own ground, and written for it
    expect(facesIn(day![1]).map(f => [f.color, f.ground])).toEqual([
      ['#10b981', '--surface-2'],
      ['#ef4444', '--surface-2'],
      ['#fbbf24', '--surface-2'],
    ])
    expect(cal).toContain('<li class="photo-cal-cell today"><button type="button" class="photo-cal-day" aria-label="Mon 14 Sep: nobody seen">')
    const onOpenDay = vi.fn()
    expect(propsOf(settled(PeopleStats, { ...PROPS, onOpenDay }), MonthCalendar).onOpen).toBe(onOpenDay)
    // without a way to the Calendar the days are only pictures
    expect(cardOf(stats({ onOpenDay: undefined }), 'Who you saw')).not.toContain('class="photo-cal-day" aria-label')
  })

  it('keeps the year with people: each person’s days a month, the days, the events and the trend, in its own scroller', () => {
    const year = cardOf(stats(), 'The year with people')
    expect(year).toContain('<p class="chart-sub">Days seen per month, however many events a day held · trend compares days seen in the last 90 days with the 90 before</p>')
    expect(year).toContain('aria-label="Previous year"')
    expect(year).toContain('<div class="table-scroll"><table class="year-table">')
    expect(year).toContain('<th class="num">Days</th><th class="num">Events</th><th>Trend</th>')
    // Sam: three days, four events
    expect(year).toMatch(/<\/span> Sam<\/td>(<td[^>]*>[^<]*<\/td>){12}<td class="num"><strong>3<\/strong><\/td><td class="num year-events">4<\/td>/)
    expect(year).toContain('7 days with someone in 2026')
    // each row's dot a mark, moved to stand out on the card
    const amber = graphicInk('#fbbf24', 'light')
    expect(amber).not.toBe('#fbbf24')
    expect(year).toContain(`<span class="pdot" style="background:${amber}"></span> Mum</td>`)
  })

  it('shows each group’s share on All, over 30 days first, the pairs seen together, and what is coming up', () => {
    const out = stats()
    const groups = cardOf(out, 'Groups')
    expect(groups).toContain('aria-pressed="true" class="seg on">30 days</button>')
    // the days by the name, the share alone at the bar's end
    for (const [name, days, share] of [
      ['Family', '4 days', '80%'],
      ['Friends', '2 days', '40%'],
      ['Other', '0 days', '0%'],
    ])
      expect(groups, name).toMatch(new RegExp(`<span class="stats-hbar-name">${name}</span><small class="muted people-group-days">${days}</small></span><span class="hbar-track">(<span class="hbar-fill"[^>]*></span>)?<span class="hbar-value">${share}</span>`))
    // Friends' share is half Family's, and so is its bar
    const widths = [...groups.matchAll(/class="hbar-fill" style="width:([\d.]+)%"/g)].map(m => Number(m[1]))
    expect(widths).toHaveLength(2)
    expect(widths[1] / widths[0]).toBeCloseTo(0.5)
    expect(Math.max(...widths)).toBeLessThanOrEqual(75)
    const pairs = cardOf(out, 'Often together')
    expect(namesIn(pairs)).toEqual(['Dad and Mum'])
    expect(pairs).toContain('Both seen on 3 days · last Sun 13 Sep')
    const soon = cardOf(out, 'Coming up')
    expect(namesIn(soon)).toEqual(['Sam', 'Mum'])
    expect(soon).toContain('Birthday · today')
    expect(soon).toContain('Birthday · turns 60 · Sat 26 Sep, in 12 days')
  })

  it('narrows every figure to a group with the list’s own chips, and says whose year it is', () => {
    const out = html(settled(Held, PROPS, tree => press(tree, 'Friends 3')))
    expect(out).toContain('<button type="button" aria-pressed="true" class="seg on">Friends <span class="board-count">3</span></button>')
    expect(out).toContain('<div class="stat-label">People</div><div class="stat-value">3</div><div class="stat-sub">in Friends</div>')
    expect(out).toContain(tile('This month', '2 of 14'))
    expect(out).toContain('<h3>The year with friends</h3>')
    expect(namesIn(cardOf(out, 'Not seen lately'))).toEqual(['Ben'])
    // a comparison of the groups, so on All alone
    expect(out).not.toContain('<h3>Groups</h3>')
  })

  it('carries no wardrobe class', () => {
    expect(stats()).not.toMatch(/wardrobe-/)
  })
})

describe('in the dark theme', () => {
  it('writes every face to read on the ground it is laid over, the month’s on the raised day cell', () => {
    painted.theme = 'dark'
    const out = stats()
    const faces = facesIn(out)
    expect(faces.length).toBeGreaterThan(20)
    for (const f of faces) {
      const ground = f.ground === '--surface-2' ? THEME_HEX.dark.raised : THEME_HEX.dark.surface
      expect(contrast(f.ink, mixHex(f.color, ground, 0x22 / 255)), `${f.className} ${f.color}`).toBeGreaterThanOrEqual(4.5)
    }
    const month = facesIn(cardOf(out, 'Who you saw'))
    expect(month.length).toBeGreaterThan(0)
    expect(month.every(f => f.ground === '--surface-2')).toBe(true)
    expect(faces.filter(f => f.className !== 'people-cal-face').every(f => f.ground === '--surface')).toBe(true)
    // Jo's red: ink worked out for the card would fall short on the raised cell
    const cell = mixHex('#ef4444', THEME_HEX.dark.raised, 0x22 / 255)
    expect(contrast(readableInk('#ef4444', 'dark', { tint: true }), cell)).toBeLessThan(4.5)
    expect(month.find(f => f.color === '#ef4444')?.ink).toBe(readableInk('#ef4444', 'dark', { tint: true, ground: 'raised' }))
  })

  it('reads on the raised day cell in every colour a person can be given, and on the card', () => {
    for (const c of [...PROJECT_COLORS, ...PEOPLE.map(p => p.color)]) {
      const onCell = contrast(readableInk(c, 'dark', { tint: true, ground: 'raised' }), mixHex(c, THEME_HEX.dark.raised, 0x22 / 255))
      const onCard = contrast(readableInk(c, 'dark', { tint: true }), mixHex(c, THEME_HEX.dark.surface, 0x22 / 255))
      expect(onCell, c).toBeGreaterThanOrEqual(4.5)
      expect(onCard, c).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps every year-table dot in its own colour, which clears 3:1 on the dark card, and the bars in People’s', () => {
    painted.theme = 'dark'
    const out = stats()
    for (const c of ['#fbbf24', '#10b981', '#8b5cf6', '#ef4444']) expect(graphicInk(c, 'dark'), c).toBe(c)
    expect(cardOf(out, 'Most seen')).not.toContain('background:#fbbf24')
    expect(cardOf(out, 'Most seen')).toContain('background:var(--area-ink, var(--viz-series-1))')
    expect(cardOf(out, 'The year with people')).toContain('<span class="pdot" style="background:#fbbf24"></span> Mum</td>')
  })
})

describe('every figure agrees with the list', () => {
  it('ranks 30 days by each row’s own 30-day figure, and counts as seen lately each row with a 90-day one', () => {
    const rows = list()
    const bars = cardOf(stats(), 'Most seen')
    let lately = 0
    for (const p of PEOPLE) {
      const days30 = rows.match(new RegExp(`id="person-${p.id}"[\\s\\S]*?title="Last 30 days: [^"]*"><strong>(\\d+)</strong>`))![1]
      const days90 = rows.match(new RegExp(`id="person-${p.id}"[\\s\\S]*?title="Last 90 days: [^"]*"><strong>(\\d+)</strong>`))![1]
      const bar = bars.match(new RegExp(`stats-hbar-name">${p.name}</span>[\\s\\S]*?hbar-value">(\\d+)<`))?.[1] ?? '0'
      expect(bar, p.name).toBe(days30)
      if (Number(days90) > 0) lately++
    }
    expect(stats()).toContain(tile('Seen lately', `${lately} of ${PEOPLE.length}`))
  })

  it('counts each group as its chip does, and who is overdue or due as the badges do', () => {
    const rows = list()
    const out = stats()
    for (const g of ['All', 'Family', 'Friends', 'Other']) {
      const count = new RegExp(`${g} <span class="board-count">(\\d+)</span>`)
      expect(out.match(count)?.[1], g).toBe(rows.match(count)?.[1])
    }
    expect(out).toContain(`Overdue</div><div class="stat-value stat-warn">${rows.split('>Overdue</span>').length - 1}</div>`)
    expect(out).toContain(tile('Due a catch-up', String(rows.split('>Due a catch-up</span>').length - 1)))
  })

  it('leaves the list its people: no tiles, no year table', () => {
    const rows = list()
    expect(rows).toContain('class="people-list"')
    expect(rows).not.toContain('kpi-row')
    expect(rows).not.toContain('year-report')
    expect(rows).not.toContain('The year with')
  })
})

describe('what People → Stats is handed', () => {
  const screen = source('components/planner/PeopleScreen.tsx')
  const element = (name: string) => {
    const from = screen.indexOf(`<${name}\n`)
    return screen.slice(from, screen.indexOf('/>', from))
  }

  it('is what the list reads: every task whoever logged it, and your own events; nothing narrows either', () => {
    for (const prop of ['people={store.people}', 'tasks={store.tasks}', 'entries={store.events}']) {
      expect(element('PeopleStats'), prop).toContain(prop)
      expect(element('People'), prop).toContain(prop)
    }
    // Nothing narrows a count, and nothing is left that could: Mine / Everyone
    // was removed in v3.19 — who a task is FOR is now the record's own flag,
    // decided on the task and enforced by the database, not a list filter.
    expect(screen).not.toMatch(/filteredTasks/)
    expect(screen).not.toMatch(/mineOnly/)
    expect(element('PeopleStats')).not.toMatch(/mineOnCalendar/)
  })

  it('is nothing personal: no journal, habits, routines or wardrobe', () => {
    expect(element('PeopleStats')).not.toMatch(/journal|habits|routines|wears|garments|outfits|reviews/)
    const props = source('components/PeopleStats.tsx').match(/interface Props \{[\s\S]*?\n\}/)![0]
    expect(props).not.toMatch(/journal|habit|routine|wear|garment|outfit|review/i)
  })

  it('logs Saw them as Today does, and opens a person’s card and a day where they live', () => {
    expect(element('PeopleStats')).toMatch(/onSaw=\{sawThem\}/)
    expect(element('PeopleStats')).toMatch(/onOpenPerson=\{person => openPerson\(person\.id\)\}/)
    expect(element('PeopleStats')).toMatch(/onOpenDay=\{openCalendarDay\}/)
  })
})

describe('List · Stats', () => {
  it('is a track, like every other switch between views that exclude each other', () => {
    const onChange = vi.fn()
    expect(html(<ListStatsSwitch label="People list or stats" value="list" onChange={onChange} />)).toBe(
      '<div class="list-stats-bar"><span class="segmented seg-track list-stats-seg" role="tablist" aria-label="People list or stats" style="--seg-n:2;--seg-i:0"><span class="seg-thumb" aria-hidden="true"></span><button type="button" role="tab" aria-selected="true" class="seg on">List</button><button type="button" role="tab" aria-selected="false" class="seg">Stats</button></span></div>',
    )
    expect(html(<ListStatsSwitch label="People list or stats" value="list" onChange={onChange} action={<button type="button" className="btn primary">+ Add person</button>} />)).toBe(
      '<div class="list-stats-bar"><span class="segmented seg-track list-stats-seg" role="tablist" aria-label="People list or stats" style="--seg-n:2;--seg-i:0"><span class="seg-thumb" aria-hidden="true"></span><button type="button" role="tab" aria-selected="true" class="seg on">List</button><button type="button" role="tab" aria-selected="false" class="seg">Stats</button></span><span class="list-stats-action"><button type="button" class="btn primary">+ Add person</button></span></div>',
    )
    // the buttons are the shared track's now, so the press goes through it
    const tree = ListStatsSwitch({ label: 'People list or stats', value: 'list', onChange })
    press(settled(Segmented<InnerView>, propsOf<ComponentProps<typeof Segmented<InnerView>>>(tree, Segmented<InnerView>)), 'Stats')
    expect(onChange).toHaveBeenCalledWith('stats')
  })

  it('opens the add form from that row, and no longer draws the button under the title', () => {
    const props = { people: [], tasks: [], filter: NO_PERSON_FILTER, onFilter: noop, onSave: noop, onDelete: noop, onLogVisit: noop, onPlan: noop, onOpenTask: noop }
    expect(html(<People {...props} />)).not.toContain('+ Add person')
    expect(html(<People {...props} />)).not.toContain('Add a person')
    expect(html(<People {...props} openAdd />)).toContain('Add a person')
  })

  it('sits in the People segment, remembered for it alone, with Stats loaded on demand', () => {
    const screen = source('components/planner/PeopleScreen.tsx')
    expect(screen).toContain('<ListStatsSwitch')
    expect(screen).toContain('label="People list or stats"')
    expect(screen).toContain("onChange={v => setInnerView('people', v)}")
    expect(screen).toContain('+ Add person')
    expect(source('components/People.tsx')).not.toContain('+ Add person')
    expect(screen).toMatch(/innerViews\.people === 'stats' \? \(\s*<PeopleStats/)
    expect(screen).toContain("import { People, PeopleStats, Places, PlacesStats } from './lazy'")
    expect(source('components/planner/lazy.ts')).toContain("import('../PeopleStats')")
    // under Keep's own track, never inside it: KeepScreen closes that div
    // before it renders any segment's body (v3.29)
    const keep = source('components/planner/KeepScreen.tsx')
    expect(keep.slice(keep.indexOf('<div className="people-tab-seg keep-seg">'), keep.indexOf('<PeopleScreen'))).toContain('</div>')
    expect(screen).not.toContain('people-tab-seg')
  })
})

/** Where the shell stands: the tab, People's segment, each segment's List · Stats, the Calendar's mode and the day handed to it. */
interface Where {
  view: View
  keepTab: KeepTab
  people: InnerView
  places: InnerView
  calMode: CalendarMode
  day: string | null
}

/**
 * useNavigation in a shell of its own, over a storage that keeps what it is
 * given and logs every write. Each step runs on a render and the next render
 * shows where it left the shell, so `at[i + 1]` follows `steps[i]`.
 */
function journey(stored: Record<string, string>, steps: ((nav: ReturnType<typeof useNavigation>) => void)[]) {
  const kept: Record<string, string> = { ...stored }
  const writes: [string, string][] = []
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => kept[k] ?? null,
    setItem: (k: string, v: string) => {
      kept[k] = v
      writes.push([k, v])
    },
  })
  const at: Where[] = []
  function Shell() {
    const nav = useNavigation()
    // so a step that moves nothing still hands on to the next
    const [, tick] = useState(0)
    at.push({ view: nav.view, keepTab: nav.keepTab, people: nav.innerViews.people, places: nav.innerViews.places, calMode: nav.calMode, day: nav.calendarOpenDay })
    const step = steps[at.length - 1]
    if (step) {
      step(nav)
      tick(n => n + 1)
    }
    return null
  }
  renderToString(<Shell />)
  expect(at).toHaveLength(steps.length + 1)
  return { at, writes }
}

describe('the shell remembers List · Stats', () => {
  it('only from its own switch; a tab tap re-reads it, and a card opens on the list for that visit', () => {
    const { at, writes } = journey({}, [
      nav => nav.setInnerView('people', 'stats'),
      nav => nav.goView('keep'),
      nav => nav.goView('keep'),
      // a search result, Ask or a reminder: the card is on the list
      nav => nav.openPerson('mum'),
      nav => nav.goView('keep'),
      nav => nav.goView('keep'),
    ])
    expect(at[0]).toMatchObject({ view: 'home', keepTab: 'people', people: 'list' })
    expect(at[1].people).toBe('stats')
    expect(at[3]).toMatchObject({ view: 'keep', keepTab: 'people', people: 'stats' })
    expect(at[4]).toMatchObject({ view: 'keep', keepTab: 'people', people: 'list' })
    expect(at[6]).toMatchObject({ view: 'keep', keepTab: 'people', people: 'stats' })
    expect(writes).toEqual([[INNER_VIEW_KEYS.people, 'stats']])
  })

  it('opens Stats for one visit from the palette or a link, and writes nothing: the next tab tap goes back to what was chosen', () => {
    const { at, writes } = journey({ [INNER_VIEW_KEYS.people]: 'list', [PEOPLE_TAB_KEY]: 'places' }, [
      nav => nav.openStats('people'),
      nav => nav.goView('home'),
      nav => nav.goView('keep'),
    ])
    expect(at[0]).toMatchObject({ keepTab: 'places', people: 'list' })
    expect(at[1]).toMatchObject({ view: 'keep', keepTab: 'people', people: 'stats' })
    expect(at[3]).toMatchObject({ view: 'keep', keepTab: 'places', people: 'list' })
    expect(writes).toEqual([])
  })

  it('keeps each segment’s own, and opens a place on the Places list', () => {
    const { at, writes } = journey({ [INNER_VIEW_KEYS.people]: 'stats', [INNER_VIEW_KEYS.places]: 'stats' }, [nav => nav.openPlace('cafe'), nav => nav.goView('keep')])
    expect(at[0]).toMatchObject({ people: 'stats', places: 'stats' })
    expect(at[1]).toMatchObject({ view: 'keep', keepTab: 'places', people: 'stats', places: 'list' })
    expect(at[2]).toMatchObject({ keepTab: 'people', people: 'stats', places: 'stats' })
    expect(writes).toEqual([])
  })
})

describe('a day of the month opens on the Calendar', () => {
  const calendar = (over: Partial<ComponentProps<typeof Calendar>> = {}) =>
    html(
      <Calendar
        view="month"
        tasks={TASKS}
        projects={[]}
        projectMap={new Map()}
        people={PEOPLE}
        meals={[]}
        recipes={[]}
        places={[]}
        events={[]}
        sourceMap={new Map()}
        onOpen={noop}
        onNew={noop}
        onSaveMeal={noop}
        onClearMeal={noop}
        onCreatePlace={() => ({}) as Place}
        onCreateRecipe={() => ({}) as Recipe}
        onNewEvent={noop}
        onEditEvent={noop}
        onReschedule={noop}
        onPlan={noop}
        onAttendance={noop}
        onOpenProject={noop}
        onPlanOccasion={noop}
        {...over}
      />,
    )

  it('on that day’s month, with its day sheet up', () => {
    const day = new Date(2026, 2, 1)
    const out = calendar({ openDay: '2026-03-01' })
    expect(out).toContain(`<h2>${day.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>`)
    expect(out).toContain('role="dialog"')
    expect(out).toContain(`>${day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</h2>`)
    // without one, the month is this month and no sheet is up
    expect(calendar()).not.toContain('role="dialog"')
    expect(calendar({ openDay: 'not a day' })).not.toContain('role="dialog"')
  })

  it('is handed through the shell once', () => {
    const screen = source('components/planner/CalendarScreen.tsx')
    expect(screen).toContain('openDay={calendarOpenDay}')
    expect(screen).toContain('onOpenDayConsumed={() => setCalendarOpenDay(null)}')
  })

  it('the Day tab is the day itself, not a sheet over a grid', () => {
    const out = calendar({ view: 'day' })
    expect(out).toContain('class="cal-day"')
    expect(out).toContain('This day’s tasks, events and meals')
    expect(out).not.toContain('cal-grid')
    expect(out).not.toContain('role="dialog"')
  })

  it('leaves a month, a week or a day as it was', () => {
    for (const mode of ['month', 'week', 'day'] as const) {
      const { at, writes } = journey({ [CAL_MODE_KEY]: mode }, [nav => nav.openCalendarDay('2026-09-12')])
      expect(at[1]).toMatchObject({ view: 'calendar', calMode: mode, day: '2026-09-12' })
      expect(writes).toEqual([])
    }
  })

  it('remembers a mode picked on the Calendar’s own buttons', () => {
    const { at, writes } = journey({ [CAL_MODE_KEY]: 'day' }, [
      nav => nav.openCalendarDay('2026-09-12'),
      nav => nav.setCalMode('week'),
      nav => nav.goView('home'),
      nav => nav.goView('calendar'),
    ])
    expect(at[1]).toMatchObject({ view: 'calendar', calMode: 'day', day: '2026-09-12' })
    expect(at[2].calMode).toBe('week')
    expect(at[4]).toMatchObject({ view: 'calendar', calMode: 'week' })
    expect(writes).toEqual([[CAL_MODE_KEY, 'week']])
  })
})

describe('?view=people-stats', () => {
  /** useDeepLinks over stand-ins that log every call, as p3-links.test.tsx has it. */
  function links() {
    const calls: string[] = []
    const log = (name: string) => vi.fn((...args: unknown[]) => void calls.push(`${name} ${JSON.stringify(args)}`))
    const deps = {
      store: { loaded: true, journal: [], tasks: [], people: [], places: [], upsert: log('upsert'), remove: log('remove'), restore: log('restore') },
      showToast: log('toast'),
      setSettingsNonce: log('settingsNonce'),
      setSettingsOpen: log('settings'),
      setAdminOpen: log('admin'),
      setEditor: log('editor'),
      newTask: log('newTask'),
      openSheet: log('openSheet'),
      goTasksTab: log('tasksTab'),
      goKeepTab: log('keepTab'),
      setHomeTab: log('homeTab'),
      setView: log('view'),
      openJournal: log('journal'),
      openReview: log('review'),
      openPlace: log('place'),
      openPerson: log('person'),
      openStats: log('stats'),
      changeStatus: log('changeStatus'),
      defer: log('defer'),
    } as unknown as Parameters<typeof useDeepLinks>[0]
    // the ref the hook hands the native shell, kept by pushing it out of the render
    const handed: { current: (raw: string) => void }[] = []
    function Shell() {
      handed.push(useDeepLinks(deps).applyLinkRef)
      return null
    }
    renderToString(<Shell />)
    return { apply: (raw: string) => handed[handed.length - 1].current(raw), calls }
  }

  it('opens People → People on its Stats for that visit, from the web and from drafter://open, and writes nothing', () => {
    for (const raw of ['/?view=people-stats', 'drafter://open?view=people-stats']) {
      const { apply, calls } = links()
      apply(raw)
      expect(calls, raw).toEqual(['stats ["people"]'])
    }
  })

  it('sends a plain ?view=people to Keep’s People segment, on the half it was left', () => {
    // it named a tab until v3.29 and names a segment now; either way it lands
    // on People, and says nothing about List or Stats
    const { apply, calls } = links()
    apply('/?view=people')
    expect(calls).toEqual(['keepTab ["people"]', 'view ["keep"]'])
  })
})

describe('its styles', () => {
  const css = sheetSource()
  const phone = [...css.matchAll(/@media \(max-width: 640px\) \{([\s\S]*?)\n\}/g)].map(m => m[1]).join('\n')
  // its block in the partial, and the desktop half of its own sheet
  // (styles/views/people-stats.css), which holds the rules only it draws
  const own = viewSheet('people-stats.css')
  const block =
    css.slice(css.indexOf('People → Stats (PeopleStats)'), css.indexOf('@media (max-width: 640px)', css.indexOf('People → Stats (PeopleStats)'))) +
    own.slice(0, own.indexOf('@media (max-width: 640px)'))

  it('keeps the phone’s rules behind the phone guard: two faces a line in a 375pt month', () => {
    expect(phone).toMatch(/\.people-cal-face \{[^}]*width: 14px/)
    expect(phone).toMatch(/\.list-stats-bar \{[^}]*margin-bottom: 6px/)
    expect(block).toMatch(/\.people-cal-face \{[^}]*width: 18px/)
  })

  it('draws with tokens alone, and never puts the switch under the native tab track', () => {
    expect(block.length).toBeGreaterThan(0)
    expect(block.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
    expect(css).not.toMatch(/\.people-tab-seg[^{}]*\.list-stats/)
    expect(css).toMatch(/\.list-stats-action \{[^}]*margin-left: auto/)
    // the chips wrap and the table scrolls in its own box, so 375pt never scrolls sideways
    expect(css).toMatch(/\.people-controls \{[^}]*flex-wrap: wrap/)
    // a group's days stay whole beside its name, so its bar ends with the share alone
    expect(block).toMatch(/\.people-group-days \{[^}]*flex: none;[^}]*white-space: nowrap/)
  })
})

describe('the month of faces needs no caveat any more', () => {
  it('counts the same days the Calendar it opens shows', () => {
    // It used to carry one: Mine / Everyone could narrow the Calendar to your
    // own tasks while these figures counted the household's. The switch is
    // gone (v3.19), so the two agree and the line says only what it counts.
    expect(cardOf(stats(), 'Who you saw')).toMatch(/with someone<\/p>/)
    expect(stats()).not.toContain('Mine keeps the Calendar')
  })
})
