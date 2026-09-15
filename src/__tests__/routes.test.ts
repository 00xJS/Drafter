import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CALENDAR_MODES,
  COMPACT_TABS,
  HOME_TABS,
  INNER_VIEWS,
  INNER_VIEW_KEYS,
  LEGACY_VIEW_TO_HOME,
  LEGACY_VIEW_TO_TASKS,
  PEOPLE_TAB_KEY,
  STATS_VIEW_TO_PEOPLE,
  TASKS_TAB_KEY,
  TASKS_TABS,
  VIEW_ICONS,
  VIEW_LABELS,
  VIEWS,
  WARDROBE_TABS,
  storedInnerView,
  storedInnerViews,
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
    expect(HOME_TABS.map(t => t.key)).toEqual(['today', 'week', 'journal', 'wardrobe'])
    expect(TASKS_TABS.map(t => t.key)).toEqual(['list', 'board', 'bills', 'notes'])
    expect(CALENDAR_MODES).toEqual(['month', 'week', 'timeline'])
  })

  it('gives the wardrobe a segment on Home, never a tab of its own', () => {
    expect(VIEWS).toHaveLength(5)
    expect(VIEWS as string[]).not.toContain('wardrobe')
    expect(HOME_TABS.find(t => t.key === 'wardrobe')?.label).toBe('Wardrobe')
    expect(WARDROBE_TABS.map(t => [t.key, t.label])).toEqual([
      ['outfit', 'Outfit'],
      ['clothes', 'Clothes'],
      ['stats', 'Stats'],
    ])
  })
})

describe('old links still land on a segment', () => {
  it('sends board, bills and notes to that segment of Tasks', () => {
    expect(LEGACY_VIEW_TO_TASKS).toEqual({ board: 'board', bills: 'bills', notes: 'notes' })
    const segments = TASKS_TABS.map(t => t.key) as string[]
    for (const tab of Object.values(LEGACY_VIEW_TO_TASKS)) expect(segments).toContain(tab)
  })

  it('sends the former Today and Review views to Home’s day and week, and ?view=wardrobe to the wardrobe', () => {
    expect(LEGACY_VIEW_TO_HOME).toEqual({ today: 'today', review: 'week', wardrobe: 'wardrobe' })
    const segments = HOME_TABS.map(t => t.key) as string[]
    for (const tab of Object.values(LEGACY_VIEW_TO_HOME)) expect(segments).toContain(tab)
  })

  it('never shadows a live view with a legacy name', () => {
    const legacy = [...Object.keys(LEGACY_VIEW_TO_TASKS), ...Object.keys(LEGACY_VIEW_TO_HOME), ...Object.keys(STATS_VIEW_TO_PEOPLE)]
    for (const name of legacy) expect(VIEWS as string[]).not.toContain(name)
    expect(new Set(legacy).size).toBe(legacy.length)
  })

  it('sends ?view=people-stats to People → People on its Stats', () => {
    expect(STATS_VIEW_TO_PEOPLE).toEqual({ 'people-stats': 'people' })
  })
})

describe('People’s own List · Stats', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('offers the list first, then the figures', () => {
    expect(INNER_VIEWS.map(v => [v.key, v.label])).toEqual([
      ['list', 'List'],
      ['stats', 'Stats'],
    ])
  })

  it('remembers each segment’s choice under its own key, and opens on the list otherwise', () => {
    expect(INNER_VIEW_KEYS).toEqual({ people: 'drafter:people-view', places: 'drafter:places-view' })
    expect(new Set(Object.values(INNER_VIEW_KEYS)).size).toBe(2)
    expect(Object.values(INNER_VIEW_KEYS)).not.toContain(PEOPLE_TAB_KEY)
    const values: Record<string, string> = { 'drafter:people-view': 'stats' }
    vi.stubGlobal('localStorage', { getItem: (k: string) => values[k] ?? null })
    expect(storedInnerView('people')).toBe('stats')
    expect(storedInnerView('places')).toBe('list')
    expect(storedInnerViews()).toEqual({ people: 'stats', places: 'list' })
    values['drafter:people-view'] = 'board'
    expect(storedInnerView('people')).toBe('list')
  })

  it('opens on the list when storage cannot be read', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
    })
    expect(storedInnerViews()).toEqual({ people: 'list', places: 'list' })
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
