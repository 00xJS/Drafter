import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLAN_DAY_QUICK_UNTIL, SHUT_DOWN_QUICK_FROM, buildPaletteCommands, type PaletteNav, type PaletteOverlays } from '../components/planner/commands'
import { INNER_VIEW_KEYS, VIEWS, type CalendarMode, type HomeTab, type InnerView, type KitchenTab, type PeopleTab, type TasksTab, type View } from '../components/planner/routes'
import type { WardrobeOpen } from '../components/planner/useNavigation'
import type { Sheet } from '../components/planner/useOverlays'
import { localDayKey } from '../journal'

interface ShellState {
  view: View
  homeTab: HomeTab
  tasksTab: TasksTab
  peopleTab: PeopleTab
  /** each segment's own List · Stats */
  peopleView: InnerView
  placesView: InnerView
  calMode: CalendarMode
  /** what a tab tap re-reads: the segment last chosen on purpose */
  rememberedTasks: TasksTab
  rememberedPeople: PeopleTab
  rememberedPeopleView: InnerView
  rememberedPlacesView: InnerView
  rememberedCal: CalendarMode
  rememberedKitchen: KitchenTab
  journalDate: string | null
  /** the one-shot way into Home → Wardrobe, when a command made one */
  wardrobe: WardrobeOpen | null
  /** the one-shot Kitchen segment, when a command named one */
  kitchenTab: KitchenTab | null
  settingsOpen: boolean
  newTasks: unknown[][]
  /** the planning sheets opened, in order */
  sheets: Sheet[]
}

/** Two starting points that disagree on every field, so no landing is true by accident. The first is on the month a day from a Stats view left, the Timeline remembered; in each, People's and Places' switches are on different halves. */
const STARTS: ShellState[] = [
  {
    view: 'kitchen',
    homeTab: 'journal',
    tasksTab: 'notes',
    peopleTab: 'places',
    peopleView: 'list',
    placesView: 'stats',
    calMode: 'month',
    rememberedTasks: 'bills',
    rememberedPeople: 'places',
    rememberedPeopleView: 'list',
    rememberedPlacesView: 'stats',
    rememberedCal: 'timeline',
    rememberedKitchen: 'grocery',
    journalDate: null,
    wardrobe: null,
    kitchenTab: null,
    settingsOpen: false,
    newTasks: [],
    sheets: [],
  },
  {
    view: 'home',
    homeTab: 'today',
    tasksTab: 'list',
    peopleTab: 'people',
    peopleView: 'stats',
    placesView: 'list',
    calMode: 'week',
    rememberedTasks: 'board',
    rememberedPeople: 'people',
    rememberedPeopleView: 'stats',
    rememberedPlacesView: 'list',
    rememberedCal: 'month',
    rememberedKitchen: 'week',
    journalDate: null,
    wardrobe: null,
    kitchenTab: null,
    settingsOpen: false,
    newTasks: [],
    sheets: [],
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
      if (v === 'kitchen') s.kitchenTab = s.rememberedKitchen
      if (v === 'people') {
        s.peopleTab = s.rememberedPeople
        s.peopleView = s.rememberedPeopleView
        s.placesView = s.rememberedPlacesView
      }
      s.view = v
    },
    goInnerView: (tab, v) => {
      if (tab === 'people') s.peopleView = v
      else s.placesView = v
    },
    openStats: tab => {
      s.peopleTab = tab
      if (tab === 'people') s.peopleView = 'stats'
      else s.placesView = 'stats'
      s.view = 'people'
    },
    setHomeTab: tab => {
      s.homeTab = tab
    },
    setView: v => {
      s.view = v
    },
    openJournal: date => {
      if (date) s.journalDate = date
      s.homeTab = 'journal'
      s.view = 'home'
    },
    goTasksTab: tab => {
      s.tasksTab = tab
    },
    setPeopleTab: tab => {
      s.peopleTab = tab
      s.rememberedPeople = tab
    },
    openWardrobe: (o = {}) => {
      s.wardrobe = o
      s.homeTab = 'wardrobe'
      s.view = 'home'
    },
    openKitchen: tab => {
      if (tab) s.kitchenTab = tab
      s.view = 'kitchen'
    },
  }
  const overlays: PaletteOverlays = {
    newTask: (...args) => {
      s.newTasks.push(args)
    },
    setSettingsOpen: open => {
      s.settingsOpen = open
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
    expect(run('new-bill').newTasks).toEqual([[{ bill: { kind: 'bill' }, recurrence: { freq: 'monthly' } }, { capture: false }]])
  })

  it('opens Plan next week and Ask Drafter over wherever you are, typed for rather than offered', () => {
    for (const start of STARTS) {
      const week = run('plan-week', start)
      expect(week.sheets).toEqual([{ kind: 'week' }])
      expect(week.view).toBe(start.view)
      expect(run('ask', start).sheets).toEqual([{ kind: 'ask' }])
    }
    expect(commands.find(c => c.id === 'plan-week')?.quick).toBe(false)
    expect(commands.find(c => c.id === 'ask')?.keywords).toMatch(/question/)
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
    ['go-week', { view: 'home', homeTab: 'week' }],
    ['go-journal', { view: 'home', homeTab: 'journal' }],
    ['go-wardrobe', { view: 'home', homeTab: 'wardrobe' }],
    ['go-tasks', { view: 'tasks', tasksTab: 'list' }],
    ['go-board', { view: 'tasks', tasksTab: 'board' }],
    ['go-bills', { view: 'tasks', tasksTab: 'bills' }],
    ['go-notes', { view: 'tasks', tasksTab: 'notes' }],
    ['go-calendar', { view: 'calendar' }],
    ['go-people', { view: 'people', peopleTab: 'people' }],
    ['go-places', { view: 'people', peopleTab: 'places' }],
    ['go-people-stats', { view: 'people', peopleTab: 'people', peopleView: 'stats' }],
    ['go-places-stats', { view: 'people', peopleTab: 'places', placesView: 'stats' }],
    ['go-kitchen', { view: 'kitchen' }],
    ['go-kitchen-stats', { view: 'kitchen', kitchenTab: 'stats' }],
    ['go-wardrobe-stats', { view: 'home', homeTab: 'wardrobe', wardrobe: { tab: 'stats' } }],
  ]

  it.each(landings)('%s lands on its tab and segment from anywhere', (id, where) => {
    for (const start of STARTS) expect(run(id, start)).toMatchObject(where)
  })

  it('opens Kitchen on Stats for the visit only, moving no other segment, and the plain Kitchen where it was left', () => {
    const stats = commands.find(c => c.id === 'go-kitchen-stats')
    expect(stats).toMatchObject({ label: 'Kitchen stats', icon: 'kitchen' })
    expect(stats?.quick).toBeFalsy()
    for (const word of ['cooked', 'eaten out', 'bought']) expect(stats?.keywords).toContain(word)
    for (const start of STARTS) {
      const s = run('go-kitchen-stats', start)
      expect(s).toMatchObject({ homeTab: start.homeTab, tasksTab: start.tasksTab, peopleTab: start.peopleTab, rememberedPeople: start.rememberedPeople, wardrobe: null, settingsOpen: false })
      // the plain Kitchen opens where it was last left, as a tab tap does, even straight after Kitchen stats
      expect(run('go-kitchen', start).kitchenTab).toBe(start.rememberedKitchen)
      const { s: after, commands: cmds } = shell(start)
      cmds.find(c => c.id === 'go-kitchen-stats')!.run()
      cmds.find(c => c.id === 'go-kitchen')!.run()
      expect(after).toMatchObject({ view: 'kitchen', kitchenTab: start.rememberedKitchen })
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
      expect(run('go-places', start).rememberedPeople).toBe('places')
      expect(run('go-people', start).rememberedPeople).toBe('people')
    }
  })

  it('opens the Calendar on the mode last chosen, as a tab tap does, not on the month a day from a Stats view left', () => {
    for (const start of STARTS) expect(run('go-calendar', start)).toMatchObject({ view: 'calendar', calMode: start.rememberedCal })
  })

  it('opens People stats for the visit only: the next tab tap goes back to what was chosen', () => {
    expect(commands.find(c => c.id === 'go-people-stats')).toMatchObject({ label: 'People stats', icon: 'people' })
    expect(commands.find(c => c.id === 'go-people-stats')?.quick).toBeFalsy()
    for (const word of ['insights', 'most seen', 'together', 'streak']) expect(commands.find(c => c.id === 'go-people-stats')?.keywords).toContain(word)
    for (const start of STARTS) {
      const { s, nav, commands: cmds } = shell(start)
      cmds.find(c => c.id === 'go-people-stats')!.run()
      // Places' own switch stays where it was
      expect(s).toMatchObject({ view: 'people', peopleTab: 'people', peopleView: 'stats', placesView: start.placesView, rememberedPeople: start.rememberedPeople, rememberedPeopleView: start.rememberedPeopleView })
      nav.goView('people')
      expect(s).toMatchObject({ peopleTab: start.rememberedPeople, peopleView: start.rememberedPeopleView })
    }
  })

  it('opens Places stats for the visit only, found by typing "stats"', () => {
    const stats = commands.find(c => c.id === 'go-places-stats')!
    expect(stats).toMatchObject({ label: 'Places stats', icon: 'people' })
    expect(stats.quick).toBeFalsy()
    for (const word of ['insights', 'outings', 'visited']) expect(stats.keywords).toContain(word)
    for (const start of STARTS) {
      const { s, nav, commands: cmds } = shell(start)
      cmds.find(c => c.id === 'go-places-stats')!.run()
      // neither the segment nor either switch is remembered from here, and People's own switch stays where it was
      expect(s).toMatchObject({ view: 'people', peopleTab: 'places', placesView: 'stats', peopleView: start.peopleView, rememberedPeople: start.rememberedPeople, rememberedPlacesView: start.rememberedPlacesView, tasksTab: start.tasksTab })
      nav.goView('people')
      expect(s).toMatchObject({ peopleTab: start.rememberedPeople, placesView: start.rememberedPlacesView })
    }
  })

  it('opens People or Places on the List or Stats last chosen there, so a one-shot Stats does not linger', () => {
    for (const start of STARTS) {
      const { s, commands: cmds } = shell(start)
      cmds.find(c => c.id === 'go-people-stats')!.run()
      cmds.find(c => c.id === 'go-people')!.run()
      expect(s).toMatchObject({ view: 'people', peopleTab: 'people', peopleView: start.rememberedPeopleView, rememberedPeopleView: start.rememberedPeopleView })
      cmds.find(c => c.id === 'go-places-stats')!.run()
      cmds.find(c => c.id === 'go-places')!.run()
      expect(s).toMatchObject({ view: 'people', peopleTab: 'places', placesView: start.rememberedPlacesView, rememberedPlacesView: start.rememberedPlacesView })
    }
    // the list when nothing was chosen, or storage cannot be read
    const { s, commands: cmds } = shell({ ...STARTS[1], placesView: 'stats' })
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
    })
    cmds.find(c => c.id === 'go-people')!.run()
    expect(s).toMatchObject({ view: 'people', peopleTab: 'people', peopleView: 'list' })
    cmds.find(c => c.id === 'go-places')!.run()
    expect(s).toMatchObject({ view: 'people', peopleTab: 'places', placesView: 'list' })
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
      expect(run('log-wear', start)).toMatchObject({ view: 'home', homeTab: 'wardrobe', wardrobe: { date: localDayKey() } })
      expect(run('add-clothing', start)).toMatchObject({ view: 'home', homeTab: 'wardrobe', wardrobe: { tab: 'clothes', add: true } })
      // the plain way in names nothing, so the segment opens as it would from its button
      expect(run('go-wardrobe', start).wardrobe).toEqual({})
    }
  })

  it('offers Wardrobe stats when typed for, and lands on the Wardrobe’s Stats from anywhere, for that visit', () => {
    const stats = find('go-wardrobe-stats')
    expect(stats).toMatchObject({ label: 'Wardrobe stats', icon: 'wardrobe' })
    expect(stats?.quick).toBeFalsy()
    for (const word of ['most worn', 'never worn', 'cost per wear', 'streak', 'uniform', 'insights', 'figures']) expect(stats?.keywords).toContain(word)
    for (const start of STARTS) {
      // a one-shot way in, as Add clothing's is, naming the view alone: no day, no sheet, no outfit
      const s = run('go-wardrobe-stats', start)
      expect(s).toMatchObject({ view: 'home', homeTab: 'wardrobe' })
      expect(s.wardrobe).toEqual({ tab: 'stats' })
    }
  })

  it('moves nothing else', () => {
    for (const start of STARTS) {
      for (const id of ['go-wardrobe', 'log-wear', 'add-clothing', 'go-wardrobe-stats']) {
        const s = run(id, start)
        expect(s).toMatchObject({ tasksTab: start.tasksTab, peopleTab: start.peopleTab, journalDate: start.journalDate, settingsOpen: false })
        expect(s.sheets).toEqual([])
        expect(s.newTasks).toEqual([])
      }
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
        expect(s).toMatchObject({ view: start.view, homeTab: start.homeTab, tasksTab: start.tasksTab, peopleTab: start.peopleTab, settingsOpen: false })
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
