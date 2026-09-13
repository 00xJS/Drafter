import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLAN_DAY_QUICK_UNTIL, SHUT_DOWN_QUICK_FROM, buildPaletteCommands, type PaletteNav, type PaletteOverlays } from '../components/planner/commands'
import { VIEWS, type HomeTab, type PeopleTab, type TasksTab, type View } from '../components/planner/routes'
import type { Sheet } from '../components/planner/useOverlays'
import { localDayKey } from '../journal'

interface ShellState {
  view: View
  homeTab: HomeTab
  tasksTab: TasksTab
  peopleTab: PeopleTab
  /** what a tab tap re-reads: the segment last chosen on purpose */
  rememberedTasks: TasksTab
  rememberedPeople: PeopleTab
  journalDate: string | null
  settingsOpen: boolean
  newTasks: unknown[][]
  /** the planning sheets opened, in order */
  sheets: Sheet[]
}

/** Two starting points that disagree on every field, so no landing is true by accident. */
const STARTS: ShellState[] = [
  { view: 'kitchen', homeTab: 'journal', tasksTab: 'notes', peopleTab: 'places', rememberedTasks: 'bills', rememberedPeople: 'places', journalDate: null, settingsOpen: false, newTasks: [], sheets: [] },
  { view: 'home', homeTab: 'today', tasksTab: 'list', peopleTab: 'people', rememberedTasks: 'board', rememberedPeople: 'people', journalDate: null, settingsOpen: false, newTasks: [], sheets: [] },
]

/** 2pm: between the morning's quick action and the evening's, so the palette's other rows are pinned on their own. */
const AFTERNOON = new Date(2026, 8, 14, 14, 0)

/** A stand-in shell: the moves useNavigation and useOverlays make, on plain state. */
function shell(start: ShellState, now: Date = AFTERNOON) {
  const s: ShellState = { ...start, newTasks: [], sheets: [] }
  const nav: PaletteNav = {
    goView: v => {
      if (v === 'home') s.homeTab = 'today'
      if (v === 'tasks') s.tasksTab = s.rememberedTasks
      if (v === 'people') s.peopleTab = s.rememberedPeople
      s.view = v
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
    ['go-tasks', { view: 'tasks', tasksTab: 'list' }],
    ['go-board', { view: 'tasks', tasksTab: 'board' }],
    ['go-bills', { view: 'tasks', tasksTab: 'bills' }],
    ['go-notes', { view: 'tasks', tasksTab: 'notes' }],
    ['go-calendar', { view: 'calendar' }],
    ['go-people', { view: 'people', peopleTab: 'people' }],
    ['go-places', { view: 'people', peopleTab: 'places' }],
    ['go-kitchen', { view: 'kitchen' }],
  ]

  it.each(landings)('%s lands on its tab and segment from anywhere', (id, where) => {
    for (const start of STARTS) expect(run(id, start)).toMatchObject(where)
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
