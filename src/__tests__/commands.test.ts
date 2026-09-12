import { describe, expect, it } from 'vitest'
import { buildPaletteCommands, type PaletteNav, type PaletteOverlays } from '../components/planner/commands'
import { VIEWS, type HomeTab, type PeopleTab, type TasksTab, type View } from '../components/planner/routes'
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
  newProjects: number
}

/** Two starting points that disagree on every field, so no landing is true by accident. */
const STARTS: ShellState[] = [
  { view: 'kitchen', homeTab: 'journal', tasksTab: 'notes', peopleTab: 'places', rememberedTasks: 'bills', rememberedPeople: 'places', journalDate: null, settingsOpen: false, newTasks: [], newProjects: 0 },
  { view: 'home', homeTab: 'today', tasksTab: 'list', peopleTab: 'people', rememberedTasks: 'board', rememberedPeople: 'people', journalDate: null, settingsOpen: false, newTasks: [], newProjects: 0 },
]

/** A stand-in shell: the moves useNavigation and useOverlays make, on plain state. */
function shell(start: ShellState) {
  const s: ShellState = { ...start, newTasks: [] }
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
    newProject: () => {
      s.newProjects++
    },
    setSettingsOpen: open => {
      s.settingsOpen = open
    },
  }
  return { s, commands: buildPaletteCommands(nav, overlays) }
}

/** Run one command from a starting point and return where the shell ended up. */
function run(id: string, start = STARTS[0]): ShellState {
  const { s, commands } = shell(start)
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
    // New project is typed for, not offered
    expect(commands.find(c => c.id === 'new-project')?.quick).toBe(false)
  })

  it('opens the editors the toolbar does', () => {
    expect(run('new-task').newTasks).toEqual([[]])
    expect(run('new-bill').newTasks).toEqual([[{ bill: { kind: 'bill' }, recurrence: { freq: 'monthly' } }, { capture: false }]])
    expect(run('new-project').newProjects).toBe(1)
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
