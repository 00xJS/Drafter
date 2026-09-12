import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CALENDAR_MODES,
  COMPACT_TABS,
  HOME_TABS,
  LEGACY_VIEW_TO_HOME,
  LEGACY_VIEW_TO_TASKS,
  PEOPLE_TAB_KEY,
  TASKS_TAB_KEY,
  TASKS_TABS,
  VIEW_ICONS,
  VIEW_LABELS,
  VIEWS,
  storedPeopleTab,
  storedTasksTab,
} from '../components/planner/routes'

/*
 * The shell's routing table: five tabs, the segments inside them, and the old
 * link names that still have to land somewhere.
 */

describe('five tabs, the same on the phone and the desktop', () => {
  it('puts the five nouns on the phone bar in its own order, and nothing else', () => {
    expect(COMPACT_TABS.map(t => t.id)).toEqual(['home', 'calendar', 'tasks', 'kitchen', 'people'])
    expect([...COMPACT_TABS.map(t => t.id)].sort()).toEqual([...VIEWS].sort())
  })

  it('labels and draws every view on the desktop strip', () => {
    expect(Object.keys(VIEW_LABELS)).toEqual(VIEWS)
    expect(Object.keys(VIEW_ICONS).sort()).toEqual([...VIEWS].sort())
    for (const t of COMPACT_TABS) expect(t.label).toBe(VIEW_LABELS[t.id])
  })

  it('keeps the segments each tab holds', () => {
    expect(HOME_TABS.map(t => t.key)).toEqual(['today', 'week', 'journal'])
    expect(TASKS_TABS.map(t => t.key)).toEqual(['list', 'board', 'bills', 'notes'])
    expect(CALENDAR_MODES).toEqual(['month', 'week', 'timeline'])
  })
})

describe('old links still land on a segment', () => {
  it('sends board, bills and notes to that segment of Tasks', () => {
    expect(LEGACY_VIEW_TO_TASKS).toEqual({ board: 'board', bills: 'bills', notes: 'notes' })
    const segments = TASKS_TABS.map(t => t.key) as string[]
    for (const tab of Object.values(LEGACY_VIEW_TO_TASKS)) expect(segments).toContain(tab)
  })

  it('sends the former Today and Review views to Home’s day and week', () => {
    expect(LEGACY_VIEW_TO_HOME).toEqual({ today: 'today', review: 'week' })
  })

  it('never shadows a live view with a legacy name', () => {
    const legacy = [...Object.keys(LEGACY_VIEW_TO_TASKS), ...Object.keys(LEGACY_VIEW_TO_HOME)]
    for (const name of legacy) expect(VIEWS as string[]).not.toContain(name)
  })
})

describe('the remembered segment', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const withStorage = (values: Record<string, string>) =>
    vi.stubGlobal('localStorage', { getItem: (k: string) => values[k] ?? null })

  it('reopens the Tasks segment that was chosen, and the list for anything else', () => {
    for (const tab of ['board', 'bills', 'notes']) {
      withStorage({ [TASKS_TAB_KEY]: tab })
      expect(storedTasksTab()).toBe(tab)
    }
    withStorage({ [TASKS_TAB_KEY]: 'list' })
    expect(storedTasksTab()).toBe('list')
    withStorage({ [TASKS_TAB_KEY]: 'timeline' })
    expect(storedTasksTab()).toBe('list')
    withStorage({})
    expect(storedTasksTab()).toBe('list')
  })

  it('reopens Places only when Places was chosen', () => {
    withStorage({ [PEOPLE_TAB_KEY]: 'places' })
    expect(storedPeopleTab()).toBe('places')
    withStorage({ [PEOPLE_TAB_KEY]: 'nonsense' })
    expect(storedPeopleTab()).toBe('people')
    withStorage({})
    expect(storedPeopleTab()).toBe('people')
  })

  it('falls back to the first segment when storage cannot be read', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
    })
    expect(storedTasksTab()).toBe('list')
    expect(storedPeopleTab()).toBe('people')
  })
})
