import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ComponentProps, ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup, renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Calendar } from '../components/Calendar'
import { People } from '../components/People'
import { PeopleStats } from '../components/PeopleStats'
import { ListStatsSwitch } from '../components/planner/ListStatsSwitch'
import { useDeepLinks } from '../components/planner/useDeepLinks'
import { ListCard, MonthCalendar } from '../components/stats'
import { graphicInk, readableInk } from '../contrast'
import type { CalendarEntry, Person, Place, Recipe, Task } from '../types'
import { elements, press, propsOf, settled, type El } from './rendered'
import { sheetSource } from './source'

// People → Stats, drawn on the server as the tests see every screen: with
// nobody, with people and nothing seen, and with a household's visits; every
// figure beside the same one on the list; the switch that reaches it, the
// palette's link to it, and the day its month opens on the Calendar. The
// counting itself is people-stats.test.ts's.

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
const PROPS: StatsProps = { people: PEOPLE, tasks: TASKS, entries: ENTRIES, onSaw: noop, onOpenPerson: noop, onOpenDay: noop, now: NOW }
const stats = (over: Partial<StatsProps> = {}) => html(<PeopleStats {...PROPS} {...over} />)
const list = () => html(<People people={PEOPLE} tasks={TASKS} entries={ENTRIES} onSave={noop} onDelete={noop} onLogVisit={noop} onPlan={noop} onOpenTask={noop} />)

/** The card titled `title`, head to foot. */
function cardOf(page: string, title: string): string {
  const head = page.indexOf(`<h3>${title}</h3>`)
  if (head < 0) throw new Error(`no ${title} card`)
  return page.slice(page.lastIndexOf('<section', head), page.indexOf('</section>', head))
}
/** The names a list card lists, in order. */
const namesIn = (card: string) => [...card.matchAll(/class="stats-list-name">([^<]+)</g)].map(m => m[1])
const tile = (label: string, value: string) => `<div class="stat-label">${label}</div><div class="stat-value">${value}</div>`

beforeEach(() => {
  // the list reads the clock; Stats is handed it
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe('with nobody on the list', () => {
  it('says what will show here, and draws nothing else', () => {
    expect(stats({ people: [], tasks: [], entries: [] })).toBe(
      '<div class="people-stats"><div class="chart-card"><p class="empty">Add the people you want to keep close on the List. Once you have seen them, who you see most, how often and who is due a catch-up show here.</p></div></div>',
    )
  })
})

describe('with people, and nobody seen yet', () => {
  const page = () => stats({ tasks: [], entries: [] })

  it('counts them, and zeros every other tile', () => {
    const out = page()
    expect(out).toContain('<div class="stat-tile kpi-wide"><div class="stat-label">People</div><div class="stat-value">8</div><div class="stat-sub">on your list</div></div>')
    for (const [label, value] of [
      ['This month', '0 of 14'],
      ['Seen lately', '0 of 8'],
      ['Overdue', '0'],
      ['Due a catch-up', '0'],
      ['Days together', '0'],
      ['Occasions', '0'],
      ['People seen', '0'],
    ])
      expect(out, label).toContain(tile(label, value))
    expect(out).toContain(`${tile('Streak', '0 days')}<div class="stat-sub">see someone to start one</div>`)
  })

  it('says each card is empty, stands nobody on the podium, and lists who was added a fortnight ago', () => {
    const out = page()
    expect(out).not.toContain('Top three')
    expect(cardOf(out, 'Most seen')).toContain('<p class="empty">Nobody was seen in this time.</p>')
    expect(cardOf(out, 'Not seen lately')).toContain('<p class="empty">Nobody is past their rhythm.</p>')
    expect(cardOf(out, 'Often together')).toContain('<p class="empty">Two people seen on the same day, twice or more, show here.</p>')
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
    expect(podium).toContain(`<span class="stats-face podium-face" style="background:#fbbf2422;color:${ink}" aria-hidden="true">👩</span>`)
    expect(podium).toContain('aria-hidden="true">D</span>')
  })

  it('ranks the most seen over 30 days, each bar in its colour moved to show on the card', () => {
    const bars = cardOf(stats(), 'Most seen')
    expect([...bars.matchAll(/stats-hbar-name">([^<]+)</g)].map(m => m[1])).toEqual(['Dad', 'Mum', 'Sam', 'Jo'])
    expect(bars).toContain(`background:${graphicInk('#fbbf24', 'light')}`)
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
    const tree = settled(PeopleStats, { ...PROPS, onSaw, onOpenPerson })
    const card = elements(tree).find(e => e.type === ListCard && e.props.title === 'Not seen lately')!
    const line = (card.props.row as (item: unknown) => El)((card.props.items as unknown[])[0])
    // the row draws a ListRow: its button opens the card, its action logs the visit
    const row = (line.type as (props: Record<string, unknown>) => El)(line.props)
    ;((row.props.action as El).props.onClick as () => void)()
    ;(row.props.onOpen as () => void)()
    expect(onSaw).toHaveBeenCalledWith(PEOPLE[2])
    expect(onOpenPerson).toHaveBeenCalledWith(PEOPLE[2])
  })

  it('shows each day’s faces, three and then +n, and opens the day on the Calendar', () => {
    const cal = cardOf(stats(), 'Who you saw')
    expect(cal).toContain('<p class="chart-sub">Each day’s people · 5 days with someone</p>')
    const day = cal.match(/<li class="photo-cal-cell has-people"><button type="button" class="photo-cal-day" aria-label="Sat 12 Sep: Dad, Jo, Mum and Sam">([\s\S]*?)<\/button><\/li>/)
    expect(day).not.toBeNull()
    expect(day![1].match(/class="stats-face people-cal-face"/g)).toHaveLength(3)
    expect(day![1]).toContain('<span class="people-cal-more" aria-hidden="true">+1</span>')
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
  })

  it('shows each group’s share on All, the pairs seen together, and what is coming up', () => {
    const out = stats()
    const groups = cardOf(out, 'Groups')
    for (const share of ['71% · 5 days', '57% · 4 days', '0% · 0 days']) expect(groups).toContain(share)
    const pairs = cardOf(out, 'Often together')
    expect(namesIn(pairs)).toEqual(['Dad and Mum'])
    expect(pairs).toContain('Both seen on 3 days · last Sun 13 Sep')
    const soon = cardOf(out, 'Coming up')
    expect(namesIn(soon)).toEqual(['Sam', 'Mum'])
    expect(soon).toContain('Birthday · today')
    expect(soon).toContain('Birthday · turns 60 · Sat 26 Sep, in 12 days')
  })

  it('narrows every figure to a group with the list’s own chips, and says whose year it is', () => {
    const out = html(settled(PeopleStats, PROPS, tree => press(tree, 'Friends 3')))
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

  it('is what the list reads: every task whoever logged it, and your own events; Mine / Everyone narrows neither', () => {
    for (const prop of ['people={store.people}', 'tasks={store.tasks}', 'entries={store.events}']) {
      expect(element('PeopleStats'), prop).toContain(prop)
      expect(element('People'), prop).toContain(prop)
    }
    expect(screen).not.toMatch(/filteredTasks|mineOnly/)
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
  it('is the wardrobe’s kind of switch: two tabs of small buttons', () => {
    const onChange = vi.fn()
    expect(html(<ListStatsSwitch label="People list or stats" value="list" onChange={onChange} />)).toBe(
      '<div class="list-stats-bar"><span class="segmented list-stats-seg" role="tablist" aria-label="People list or stats"><button type="button" role="tab" aria-selected="true" class="seg on">List</button><button type="button" role="tab" aria-selected="false" class="seg">Stats</button></span></div>',
    )
    press(ListStatsSwitch({ label: 'People list or stats', value: 'list', onChange }), 'Stats')
    expect(onChange).toHaveBeenCalledWith('stats')
  })

  it('sits in the People segment, remembered for it alone, with Stats loaded on demand', () => {
    const screen = source('components/planner/PeopleScreen.tsx')
    expect(screen).toContain("<ListStatsSwitch label=\"People list or stats\" value={innerViews.people} onChange={v => setInnerView('people', v)} />")
    expect(screen).toMatch(/innerViews\.people === 'stats' \? \(\s*<PeopleStats/)
    expect(screen).toContain("import { People, PeopleStats, Places } from './lazy'")
    expect(source('components/planner/lazy.ts')).toContain("import('../PeopleStats')")
    // under the tab-level segments, never inside them, where the native shell draws its track
    expect(screen.indexOf('<ListStatsSwitch')).toBeGreaterThan(screen.indexOf('<div className="people-tab-seg">'))
    expect(screen.slice(screen.indexOf('<div className="people-tab-seg">'), screen.indexOf('<ListStatsSwitch'))).toContain('</div>')
  })

  it('is remembered only when chosen, re-read by a tab tap, and gives way to the list for a card', () => {
    const nav = source('components/planner/useNavigation.ts')
    expect(nav.match(/localStorage\.setItem\(INNER_VIEW_KEYS/g)).toHaveLength(1)
    expect(nav).toMatch(/const setInnerView = \(tab: PeopleTab, v: InnerView\) => \{\s*goInnerView\(tab, v\)/)
    expect(nav).toMatch(/if \(v === 'people'\) \{\s*goPeopleTab\(storedPeopleTab\(\)\)\s*startTransition\(\(\) => showInnerViews\(storedInnerViews\(\)\)\)/)
    expect(nav).toMatch(/const openPerson = [\s\S]*?setView\('people'\)[\s\S]*?goInnerView\('people', 'list'\)\s*\}/)
    expect(nav).toMatch(/const openPlace = [\s\S]*?setView\('people'\)[\s\S]*?goInnerView\('places', 'list'\)\s*\}/)
    expect(nav).toMatch(/const openStats = \(tab: PeopleTab\) => \{\s*goPeopleTab\(tab\)\s*goInnerView\(tab, 'stats'\)\s*setView\('people'\)/)
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
      goPeopleTab: log('peopleTab'),
      setHomeTab: log('homeTab'),
      setView: log('view'),
      openJournal: log('journal'),
      openPlace: log('place'),
      openPerson: log('person'),
      openStats: log('stats'),
      changeStatus: log('changeStatus'),
      defer: log('defer'),
    } as unknown as Parameters<typeof useDeepLinks>[0]
    let apply: (raw: string) => void = () => {}
    function Shell() {
      const { applyLinkRef } = useDeepLinks(deps)
      apply = raw => applyLinkRef.current(raw)
      return null
    }
    renderToString(<Shell />)
    return { apply, calls }
  }

  it('opens People → People on its Stats for that visit, from the web and from drafter://open, and writes nothing', () => {
    for (const raw of ['/?view=people-stats', 'drafter://open?view=people-stats']) {
      const { apply, calls } = links()
      apply(raw)
      expect(calls, raw).toEqual(['stats ["people"]'])
    }
  })

  it('leaves a plain ?view=people where it was', () => {
    const { apply, calls } = links()
    apply('/?view=people')
    expect(calls).toEqual(['view ["people"]'])
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

  it('is handed through the shell once, and the Timeline gives way to the month', () => {
    const nav = source('components/planner/useNavigation.ts')
    expect(nav).toMatch(/const openCalendarDay = \(day: string\) => \{\s*setCalendarOpenDay\(day\)[\s\S]*?if \(calMode === 'timeline'\) setCalMode\('month'\)\s*setView\('calendar'\)/)
    const screen = source('components/planner/CalendarScreen.tsx')
    expect(screen).toContain('openDay={calendarOpenDay}')
    expect(screen).toContain('onOpenDayConsumed={() => setCalendarOpenDay(null)}')
  })
})

describe('its styles', () => {
  const css = sheetSource()
  const phone = [...css.matchAll(/@media \(max-width: 640px\) \{([\s\S]*?)\n\}/g)].map(m => m[1]).join('\n')
  const block = css.slice(css.indexOf('People → Stats (PeopleStats)'), css.indexOf('@media (max-width: 640px)', css.indexOf('People → Stats (PeopleStats)')))

  it('keeps the phone’s rules behind the phone guard: two faces a line in a 375pt month', () => {
    expect(phone).toMatch(/\.people-cal-face \{[^}]*width: 14px/)
    expect(phone).toMatch(/\.list-stats-bar \{[^}]*margin-bottom: 6px/)
    expect(block).toMatch(/\.people-cal-face \{[^}]*width: 18px/)
  })

  it('draws with tokens alone, and never puts the switch under the native tab track', () => {
    expect(block.length).toBeGreaterThan(0)
    expect(block.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
    expect(css).not.toMatch(/\.people-tab-seg[^{}]*\.list-stats/)
    // the chips wrap and the table scrolls in its own box, so 375pt never scrolls sideways
    expect(css).toMatch(/\.people-controls \{[^}]*flex-wrap: wrap/)
  })
})
