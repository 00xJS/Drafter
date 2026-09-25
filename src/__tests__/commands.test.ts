import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Search } from '../components/Search'
import { PLAN_DAY_QUICK_UNTIL, SHUT_DOWN_QUICK_FROM, buildPaletteCommands, type PaletteNav, type PaletteOverlays } from '../components/planner/commands'
import { INNER_VIEW_KEYS, VIEWS, type CalendarMode, type HomeTab, type InnerView, type InsightsTab, type KeepTab, type KitchenTab, type StatsTab, type TasksTab, type View } from '../components/planner/routes'
import type { WardrobeOpen } from '../components/planner/useNavigation'
import type { Sheet } from '../components/planner/useOverlays'
import { localDayKey } from '../journal'
import { elements, textOf, typeInto, type El } from './rendered'

interface ShellState {
  view: View
  homeTab: HomeTab
  tasksTab: TasksTab
  keepTab: KeepTab
  /** each segment's own List · Stats */
  peopleView: InnerView
  placesView: InnerView
  calMode: CalendarMode
  /** what a tab tap re-reads: the segment last chosen on purpose */
  rememberedTasks: TasksTab
  rememberedKeep: KeepTab
  rememberedPeopleView: InnerView
  rememberedPlacesView: InnerView
  rememberedCal: CalendarMode
  rememberedKitchen: KitchenTab
  journalDate: string | null
  /** the one-shot way into Keep → Wardrobe, when a command made one */
  wardrobe: WardrobeOpen | null
  /** the one-shot Kitchen segment, when a command named one */
  kitchenTab: KitchenTab | null
  /** Insights' own segment: the lens, the journal archive or the week */
  insightsTab: InsightsTab
  /** the Stats page pushed over the Highlights, when a command named one; a tab tap lands on the Highlights */
  statsTab: StatsTab | null
  settingsOpen: boolean
  newTasks: unknown[][]
  /** the planning sheets opened, in order */
  sheets: Sheet[]
  /** Finance's Check in, asked for */
  checkIn: boolean
  /** Finance's + Bill sheet asked for. */
  addBill?: boolean
}

/** Two starting points that disagree on every field, so no landing is true by accident. The first is on the month a day from a Stats view left, the Day remembered; in each, People's and Places' switches are on different halves. */
const STARTS: ShellState[] = [
  {
    view: 'keep',
    homeTab: 'today',
    tasksTab: 'notes',
    keepTab: 'places',
    peopleView: 'list',
    placesView: 'stats',
    calMode: 'month',
    rememberedTasks: 'bills',
    rememberedKeep: 'places',
    rememberedPeopleView: 'list',
    rememberedPlacesView: 'stats',
    rememberedCal: 'day',
    rememberedKitchen: 'grocery',
    journalDate: null,
    wardrobe: null,
    kitchenTab: null,
    statsTab: null,
    insightsTab: 'stats',
    settingsOpen: false,
    newTasks: [],
    sheets: [],
    checkIn: false,
  },
  {
    view: 'home',
    homeTab: 'today',
    tasksTab: 'list',
    keepTab: 'people',
    peopleView: 'stats',
    placesView: 'list',
    calMode: 'week',
    rememberedTasks: 'board',
    rememberedKeep: 'people',
    rememberedPeopleView: 'stats',
    rememberedPlacesView: 'list',
    rememberedCal: 'month',
    rememberedKitchen: 'week',
    journalDate: null,
    wardrobe: null,
    kitchenTab: null,
    statsTab: null,
    insightsTab: 'stats',
    settingsOpen: false,
    newTasks: [],
    sheets: [],
    checkIn: false,
  },
]

/** 2pm: between the morning's quick action and the evening's, so the palette's other rows are pinned on their own. */
const AFTERNOON = new Date(2026, 8, 14, 14, 0)

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A stand-in shell: the moves useNavigation and useOverlays make, on plain state. */
function shell(start: ShellState, now: Date = AFTERNOON) {
  const s: ShellState = { ...start, newTasks: [], sheets: [] }
  // what storage holds: the List · Stats chosen on each segment's own switch
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k === INNER_VIEW_KEYS.people ? s.rememberedPeopleView : k === INNER_VIEW_KEYS.places ? s.rememberedPlacesView : null),
  })
  const nav: PaletteNav = {
    goView: v => {
      if (v === 'home') s.homeTab = 'today'
      if (v === 'tasks') s.tasksTab = s.rememberedTasks
      if (v === 'calendar') s.calMode = s.rememberedCal
      if (v === 'insights') {
        // a tab tap lands on the Highlights: a page pushed over them is never remembered
        s.statsTab = 'highlights'
        s.insightsTab = 'stats'
      }
      if (v === 'keep') {
        s.keepTab = s.rememberedKeep
        s.peopleView = s.rememberedPeopleView
        s.placesView = s.rememberedPlacesView
        if (s.rememberedKeep === 'kitchen') s.kitchenTab = s.rememberedKitchen
      }
      s.view = v
    },
    goInnerView: (tab, v) => {
      if (tab === 'people') s.peopleView = v
      else s.placesView = v
    },
    setView: v => {
      s.view = v
    },
    openReview: () => {
      s.view = 'insights'
      s.insightsTab = 'review'
    },
    openJournal: date => {
      if (date) s.journalDate = date
      s.insightsTab = 'journal'
      s.view = 'insights'
    },
    goTasksTab: tab => {
      s.tasksTab = tab
    },
    setKeepTab: tab => {
      s.keepTab = tab
      s.rememberedKeep = tab
    },
    openWardrobe: (o = {}) => {
      s.wardrobe = o
      s.keepTab = 'wardrobe'
      s.view = 'keep'
    },
    openKitchen: tab => {
      s.kitchenTab = tab ?? s.rememberedKitchen
      s.keepTab = 'kitchen'
      s.view = 'keep'
    },
    openLens: tab => {
      s.statsTab = tab ?? 'highlights'
      s.insightsTab = 'stats'
      s.view = 'insights'
    },
    openFinanceCheckIn: () => {
      s.checkIn = true
      s.tasksTab = 'bills'
      s.view = 'tasks'
    },
    openFinanceBill: () => {
      s.addBill = true
      s.tasksTab = 'bills'
      s.view = 'tasks'
    },
  }
  const overlays: PaletteOverlays = {
    newTask: (...args) => {
      s.newTasks.push(args)
    },
    // Settings is a pushed screen now, not a flag: the palette asks for it by name
    setPushed: to => {
      s.settingsOpen = to === 'settings'
    },
    openSheet: sheet => {
      s.sheets.push(sheet)
    },
  }
  return { s, nav, overlays, commands: buildPaletteCommands(nav, overlays, now) }
}

/** Run one command from a starting point and return where the shell ended up. */
function run(id: string, start = STARTS[0], now: Date = AFTERNOON): ShellState {
  const { s, commands } = shell(start, now)
  const cmd = commands.find(c => c.id === id)
  if (!cmd) throw new Error(`no command ${id}`)
  cmd.run()
  return s
}

const commands = shell(STARTS[0]).commands

describe('the palette’s own commands', () => {
  it('gives every command its own id', () => {
    const ids = commands.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('offers New task and New bill before you type, and nothing else', () => {
    expect(commands.filter(c => c.quick).map(c => c.id)).toEqual(['new-task', 'new-bill'])
  })

  it('has no New project, offered or typed for: there is one ongoing project', () => {
    expect(commands.find(c => c.id === 'new-project')).toBeUndefined()
    expect(commands.filter(c => /project/i.test(`${c.label} ${c.keywords ?? ''}`)).map(c => c.id)).toEqual([])
  })

  it('opens the editors the toolbar does', () => {
    expect(run('new-task').newTasks).toEqual([[]])
  })

  it('opens Finance’s own + Bill, from anywhere, never the bare task editor', () => {
    for (const start of STARTS) {
      const s = run('new-bill', start)
      expect(s).toMatchObject({ addBill: true, view: 'tasks', tasksTab: 'bills' })
      expect(s.newTasks).toEqual([])
    }
  })

  it('opens Plan next week, Ask Drafter and I\'m here over wherever you are, typed for rather than offered', () => {
    for (const start of STARTS) {
      const week = run('plan-week', start)
      expect(week.sheets).toEqual([{ kind: 'week' }])
      expect(week.view).toBe(start.view)
      expect(run('ask', start).sheets).toEqual([{ kind: 'ask' }])
      expect(run('im-here', start).sheets).toEqual([{ kind: 'imhere' }])
      expect(run('im-here', start).view).toBe(start.view)
    }
    expect(commands.find(c => c.id === 'plan-week')?.quick).toBe(false)
    expect(commands.find(c => c.id === 'ask')?.keywords).toMatch(/question/)
    expect(commands.find(c => c.id === 'im-here')?.keywords).toMatch(/nearby/)
  })

  it('opens Finance’s Check in, typed for rather than offered', () => {
    for (const start of STARTS) expect(run('check-in', start)).toMatchObject({ checkIn: true, view: 'tasks', tasksTab: 'bills' })
    expect(commands.find(c => c.id === 'check-in')).toMatchObject({ label: 'Check in balances', quick: false })
  })

  it('opens Settings where you are', () => {
    for (const start of STARTS) {
      const s = run('go-settings', start)
      expect(s.settingsOpen).toBe(true)
      expect(s.view).toBe(start.view)
    }
  })

  const landings: [string, Partial<ShellState>][] = [
    ['go-home', { view: 'home', homeTab: 'today' }],
    ['go-week', { view: 'insights', insightsTab: 'review' }],
    ['go-journal', { view: 'insights', insightsTab: 'journal' }],
    ['go-wardrobe', { view: 'keep', keepTab: 'wardrobe' }],
    ['go-tasks', { view: 'tasks', tasksTab: 'list' }],
    ['go-board', { view: 'tasks', tasksTab: 'board' }],
    ['go-bills', { view: 'tasks', tasksTab: 'bills' }],
    ['go-notes', { view: 'tasks', tasksTab: 'notes' }],
    ['go-calendar', { view: 'calendar' }],
    // the four things you keep are four segments of one tab now
    ['go-people', { view: 'keep', keepTab: 'people' }],
    ['go-places', { view: 'keep', keepTab: 'places' }],
    ['go-kitchen', { view: 'keep', keepTab: 'kitchen' }],
    // every "… stats" row lands in the one tab that holds every figure
    ['go-people-stats', { view: 'insights', statsTab: 'people' }],
    ['go-places-stats', { view: 'insights', statsTab: 'places' }],
    ['go-kitchen-stats', { view: 'insights', statsTab: 'kitchen' }],
    ['go-wardrobe-stats', { view: 'insights', statsTab: 'wardrobe' }],
    ['go-stats', { view: 'insights', statsTab: 'highlights' }],
    // the Overview became the year's page, pushed over the Highlights
    ['go-year-stats', { view: 'insights', statsTab: 'year' }],
    ['go-task-stats', { view: 'insights', statsTab: 'tasks' }],
    ['go-money-stats', { view: 'insights', statsTab: 'money' }],
    ['go-habit-stats', { view: 'insights', statsTab: 'habits' }],
    ['go-journal-stats', { view: 'insights', statsTab: 'journal' }],
  ]

  it.each(landings)('%s lands on its tab and segment from anywhere', (id, where) => {
    for (const start of STARTS) expect(run(id, start)).toMatchObject(where)
  })

  it('sends Kitchen stats to the lens, and leaves the plain Kitchen where it was left', () => {
    const stats = commands.find(c => c.id === 'go-kitchen-stats')
    expect(stats).toMatchObject({ label: 'Kitchen stats', icon: 'stats' })
    expect(stats?.quick).toBeFalsy()
    for (const word of ['cooked', 'eaten out', 'bought']) expect(stats?.keywords).toContain(word)
    for (const start of STARTS) {
      // every figure in the app is in the Stats tab, so "Kitchen stats" goes
      // there, on its Kitchen segment — and moves no segment of the Kitchen itself
      const s = run('go-kitchen-stats', start)
      expect(s).toMatchObject({ view: 'insights', statsTab: 'kitchen', homeTab: start.homeTab, tasksTab: start.tasksTab, keepTab: start.keepTab, kitchenTab: start.kitchenTab, wardrobe: null, settingsOpen: false })
      // the plain Kitchen still opens where it was last left
      expect(run('go-kitchen', start).kitchenTab).toBe(start.rememberedKitchen)
    }
  })

  it('opens an area’s page for the visit only, and the plain Stats on its Highlights', () => {
    const stats = commands.find(c => c.id === 'go-money-stats')
    expect(stats).toMatchObject({ label: 'Money stats', icon: 'stats' })
    expect(stats?.quick).toBeFalsy()
    for (const word of ['spending', 'paid', 'subscriptions']) expect(stats?.keywords).toContain(word)
    for (const start of STARTS) {
      // a lens segment moves nothing else
      expect(run('go-money-stats', start)).toMatchObject({ homeTab: start.homeTab, tasksTab: start.tasksTab, keepTab: start.keepTab, wardrobe: null, settingsOpen: false })
      // and the plain Stats opens on the Highlights, as a tab tap does, even straight after one of them
      const { s: after, commands: cmds } = shell(start)
      cmds.find(c => c.id === 'go-money-stats')!.run()
      cmds.find(c => c.id === 'go-stats')!.run()
      expect(after).toMatchObject({ view: 'insights', statsTab: 'highlights' })
    }
  })

  it('has a way to every tab', () => {
    const go = commands.filter(c => c.id.startsWith('go-') && c.id !== 'go-settings').map(c => c.id)
    expect(go.sort()).toEqual(landings.map(([id]) => id).sort())
    expect([...new Set(landings.map(([, where]) => where.view))].sort()).toEqual([...VIEWS].sort())
  })

  it('opens the journal on today’s entry', () => {
    expect(run('go-journal').journalDate).toBe(localDayKey())
  })

  it('moves the Tasks segment for the visit only, and remembers People or Places', () => {
    for (const start of STARTS) {
      expect(run('go-board', start).rememberedTasks).toBe(start.rememberedTasks)
      expect(run('go-places', start).rememberedKeep).toBe('places')
      expect(run('go-people', start).rememberedKeep).toBe('people')
    }
  })

  it('opens the Calendar on the mode last chosen, as a tab tap does, not on the month a day from a Stats view left', () => {
    for (const start of STARTS) expect(run('go-calendar', start)).toMatchObject({ view: 'calendar', calMode: start.rememberedCal })
  })

  it('sends People stats and Places stats to the lens, leaving both lists\u2019 own switches alone', () => {
    const people = commands.find(c => c.id === 'go-people-stats')!
    const places = commands.find(c => c.id === 'go-places-stats')!
    expect(people).toMatchObject({ label: 'People stats', icon: 'stats' })
    expect(places).toMatchObject({ label: 'Places stats', icon: 'stats' })
    expect(people.quick).toBeFalsy()
    expect(places.quick).toBeFalsy()
    for (const word of ['insights', 'most seen', 'together', 'streak']) expect(people.keywords).toContain(word)
    for (const word of ['insights', 'outings', 'visited']) expect(places.keywords).toContain(word)
    for (const start of STARTS) {
      // the same figures the People tab draws beside its list, read in the one
      // tab that holds every figure — and neither List · Stats switch moves
      expect(run('go-people-stats', start)).toMatchObject({ view: 'insights', statsTab: 'people', keepTab: start.keepTab, peopleView: start.peopleView, placesView: start.placesView })
      expect(run('go-places-stats', start)).toMatchObject({ view: 'insights', statsTab: 'places', keepTab: start.keepTab, peopleView: start.peopleView, placesView: start.placesView })
    }
  })

  it('opens People or Places on the List or Stats last chosen there, so a one-shot Stats does not linger', () => {
    for (const start of STARTS) {
      const { s, commands: cmds } = shell(start)
      cmds.find(c => c.id === 'go-people')!.run()
      expect(s).toMatchObject({ view: 'keep', keepTab: 'people', peopleView: start.rememberedPeopleView, rememberedPeopleView: start.rememberedPeopleView })
      cmds.find(c => c.id === 'go-places')!.run()
      expect(s).toMatchObject({ view: 'keep', keepTab: 'places', placesView: start.rememberedPlacesView, rememberedPlacesView: start.rememberedPlacesView })
    }
    // the list when nothing was chosen, or storage cannot be read
    const { s, commands: cmds } = shell({ ...STARTS[1], placesView: 'stats' })
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
    })
    cmds.find(c => c.id === 'go-people')!.run()
    expect(s).toMatchObject({ view: 'keep', keepTab: 'people', peopleView: 'list' })
    cmds.find(c => c.id === 'go-places')!.run()
    expect(s).toMatchObject({ view: 'keep', keepTab: 'places', placesView: 'list' })
  })
})

describe('the wardrobe in the palette', () => {
  const find = (id: string) => commands.find(c => c.id === id)

  it('offers Wardrobe, What am I wearing? and Add clothing when typed for, never before', () => {
    expect(find('go-wardrobe')).toMatchObject({ label: 'Wardrobe', icon: 'wardrobe' })
    expect(find('log-wear')).toMatchObject({ label: 'What am I wearing?', icon: 'wardrobe', quick: false })
    expect(find('add-clothing')).toMatchObject({ label: 'Add clothing', icon: 'camera', quick: false })
    expect(find('go-wardrobe')?.quick).toBeFalsy()
    for (const word of ['clothes', 'outfit', 'closet', 'wear']) expect(find('go-wardrobe')?.keywords).toContain(word)
    for (const word of ['outfit', 'today', 'log']) expect(find('log-wear')?.keywords).toContain(word)
    for (const word of ['photo', 'garment', 'shirt']) expect(find('add-clothing')?.keywords).toContain(word)
  })

  it('lands on today’s composer, or on Clothes with the sheet to add a piece, from anywhere', () => {
    for (const start of STARTS) {
      expect(run('log-wear', start)).toMatchObject({ view: 'keep', keepTab: 'wardrobe', wardrobe: { date: localDayKey() } })
      expect(run('add-clothing', start)).toMatchObject({ view: 'keep', keepTab: 'wardrobe', wardrobe: { tab: 'clothes', add: true } })
      // the plain way in names nothing, so the segment opens as it would from its button
      expect(run('go-wardrobe', start).wardrobe).toEqual({})
    }
  })

  it('offers Wardrobe stats when typed for, and lands on them in the Stats tab from anywhere, for that visit', () => {
    const stats = find('go-wardrobe-stats')
    expect(stats).toMatchObject({ label: 'Wardrobe stats', icon: 'stats' })
    expect(stats?.quick).toBeFalsy()
    for (const word of ['most worn', 'never worn', 'cost per wear', 'streak', 'uniform', 'insights', 'figures']) expect(stats?.keywords).toContain(word)
    for (const start of STARTS) {
      // the wardrobe's figures are the Stats tab's Wardrobe segment; Home →
      // Wardrobe is left alone, composer and all
      const s = run('go-wardrobe-stats', start)
      expect(s).toMatchObject({ view: 'insights', statsTab: 'wardrobe', homeTab: start.homeTab })
      expect(s.wardrobe).toBeNull()
    }
  })

  it('moves nothing else', () => {
    for (const start of STARTS) {
      for (const id of ['go-wardrobe', 'log-wear', 'add-clothing', 'go-wardrobe-stats']) {
        const s = run(id, start)
        // keepTab is not on this list since v3.29: the Wardrobe is one of
        // Keep's four, so landing on it IS moving that segment. Everything
        // outside the tab it lands in stays where it was.
        expect(s).toMatchObject({ tasksTab: start.tasksTab, journalDate: start.journalDate, settingsOpen: false })
        expect(s.sheets).toEqual([])
        expect(s.newTasks).toEqual([])
      }
    }
    // …and the three that go to the Wardrobe itself leave the lens alone
    for (const start of STARTS) for (const id of ['go-wardrobe', 'log-wear', 'add-clothing']) expect(run(id, start).statsTab).toBe(start.statsTab)
  })
})

describe('the Kitchen’s and the Wardrobe’s stats, typed into Search', () => {
  const noop = () => {}
  /** The field: what is typed there is the query, and ↓ and Enter move to a row and open it. */
  const field = (tree: ReactNode) => elements(tree).find(e => e.type === 'input' && e.props.role === 'combobox')!
  const keyDown = (tree: ReactNode, key: string) => (field(tree).props.onKeyDown as (e: { key: string; shiftKey: boolean; preventDefault(): void }) => void)({ key, shiftKey: false, preventDefault: noop })
  /** The result rows, in order. */
  const rows = (tree: ReactNode): El[] => elements(tree).filter(e => e.type === 'li' && e.props.role === 'option')

  /**
   * Search over the palette's own commands, built on the stand-in shell from
   * `start`, with nothing else in it to find. vitest runs in node with no DOM,
   * so it is called inside a server render and walked a render at a time, as
   * rendered.tsx walks a component: each step runs on one render, and the next
   * shows what it did. Returns where the shell ended up and every tree drawn.
   */
  function palette(start: ShellState, steps: ((tree: ReactNode) => void)[]) {
    const { s, commands: cmds } = shell(start)
    const onCreateTask = vi.fn()
    const onClose = vi.fn()
    const trees: ReactNode[] = []
    function Probe() {
      const tree = Search({ tasks: [], projects: [], people: [], commands: cmds, onOpenTask: noop, onOpenProject: noop, onOpenPerson: noop, onCreateTask, onClose })
      trees.push(tree)
      steps[trees.length - 1]?.(tree)
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    return { s, trees, onCreateTask, onClose }
  }

  const typed: [string, string, string, Partial<ShellState>][] = [
    ['wardrobe stats', 'Wardrobe stats', 'go-wardrobe-stats', { view: 'insights', statsTab: 'wardrobe' }],
    ['cost per wear', 'Wardrobe stats', 'go-wardrobe-stats', { view: 'insights', statsTab: 'wardrobe' }],
    ['kitchen stats', 'Kitchen stats', 'go-kitchen-stats', { view: 'insights', statsTab: 'kitchen' }],
    ['eaten out', 'Kitchen stats', 'go-kitchen-stats', { view: 'insights', statsTab: 'kitchen' }],
    // the lens's own segments answer for themselves. "cost per wear" is NOT
    // among Money's words: the Wardrobe's Stats is where that figure is worked
    // out, and a phrase that names one place must keep naming it.
    ['outgoings', 'Money stats', 'go-money-stats', { view: 'insights', statsTab: 'money' }],
    ['clean days', 'Habit stats', 'go-habit-stats', { view: 'insights', statsTab: 'habits' }],
  ]

  it.each(typed)('“%s” shows the %s row, and Enter or a tap on it lands there from anywhere', (words, label, id, where) => {
    for (const start of STARTS) {
      const { s, trees, onCreateTask, onClose } = palette(start, [
        tree => typeInto(tree, p => p.role === 'combobox', words),
        // the words head the list as a task to create, so ↓ goes down to the row
        tree => {
          const at = rows(tree).findIndex(r => r.key === id)
          for (let i = 0; i < at; i++) keyDown(tree, 'ArrowDown')
        },
        tree => keyDown(tree, 'Enter'),
      ])
      expect(trees, words).toHaveLength(3)
      // the one command the words find, under the task they would create, named as the palette names it
      const shown = rows(trees[1])
      expect(shown.map(r => r.key), words).toEqual(['create', id])
      expect(textOf(shown[1].props.children), words).toBe(label)
      // ↓ made it the row Enter opens
      expect(field(trees[2]).props['aria-activedescendant'], words).toBe(rows(trees[2])[1].props.id)
      expect(s, words).toMatchObject(where)
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(onCreateTask).not.toHaveBeenCalled()

      // a tap on the row, with no key at all
      const tap = palette(start, [tree => typeInto(tree, p => p.role === 'combobox', words)])
      ;(rows(tap.trees[1]).find(r => r.key === id)!.props.onClick as () => void)()
      expect(tap.s, words).toMatchObject(where)
      expect(tap.onCreateTask).not.toHaveBeenCalled()
    }
  })
})

describe('the day’s routines in the palette', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const quickAt = (h: number, m = 0) =>
    shell(STARTS[0], new Date(2026, 8, 14, h, m))
      .commands.filter(c => c.quick)
      .map(c => c.id)

  it('offers Plan my day before you type until noon, and Shut down from five', () => {
    expect(PLAN_DAY_QUICK_UNTIL).toBe(12)
    expect(SHUT_DOWN_QUICK_FROM).toBe(17)
    expect(quickAt(6)).toEqual(['new-task', 'plan-day', 'new-bill'])
    expect(quickAt(11, 59)).toEqual(['new-task', 'plan-day', 'new-bill'])
    expect(quickAt(12)).toEqual(['new-task', 'new-bill'])
    expect(quickAt(16, 59)).toEqual(['new-task', 'new-bill'])
    expect(quickAt(17)).toEqual(['new-task', 'shut-down', 'new-bill'])
    expect(quickAt(23, 30)).toEqual(['new-task', 'shut-down', 'new-bill'])
  })

  it('is still found by typing at any hour', () => {
    const cmds = shell(STARTS[0], AFTERNOON).commands
    const day = cmds.find(c => c.id === 'plan-day')!
    const shut = cmds.find(c => c.id === 'shut-down')!
    expect(day).toMatchObject({ label: 'Plan my day', quick: false })
    expect(shut).toMatchObject({ label: 'Shut down', quick: false })
    for (const w of ['morning', 'focus', 'today']) expect(day.keywords).toContain(w)
    for (const w of ['evening', 'wrap', 'close', 'tomorrow']) expect(shut.keywords).toContain(w)
  })

  it('opens each sheet over wherever you are, and does nothing else', () => {
    for (const start of STARTS) {
      const day = run('plan-day', start)
      expect(day.sheets).toEqual([{ kind: 'day' }])
      const shut = run('shut-down', start, new Date(2026, 8, 14, 18))
      expect(shut.sheets).toEqual([{ kind: 'shutdown' }])
      for (const s of [day, shut]) {
        expect(s).toMatchObject({ view: start.view, homeTab: start.homeTab, tasksTab: start.tasksTab, keepTab: start.keepTab, settingsOpen: false })
        expect(s.newTasks).toEqual([])
      }
    }
  })

  it('reads the clock when none is handed in', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { nav, overlays } = shell(STARTS[0])
    vi.setSystemTime(new Date(2026, 8, 14, 8, 15))
    expect(buildPaletteCommands(nav, overlays).find(c => c.id === 'plan-day')?.quick).toBe(true)
    vi.setSystemTime(new Date(2026, 8, 14, 18, 45))
    const evening = buildPaletteCommands(nav, overlays)
    expect(evening.find(c => c.id === 'plan-day')?.quick).toBe(false)
    expect(evening.find(c => c.id === 'shut-down')?.quick).toBe(true)
  })
})
