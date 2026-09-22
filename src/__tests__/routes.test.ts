import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CAL_MODE_KEY,
  CALENDAR_MODES,
  COMPACT_TABS,
  HOME_TABS,
  INNER_VIEWS,
  INNER_VIEW_KEYS,
  LEGACY_VIEW_TO_HOME,
  LEGACY_VIEW_TO_TASKS,
  PEOPLE_TAB_KEY,
  STATS_TABS,
  STATS_VIEW_TO_PEOPLE,
  TASKS_TAB_KEY,
  TASKS_TABS,
  VIEW_ICONS,
  VIEW_LABELS,
  VIEW_TO_KITCHEN,
  VIEW_TO_STATS,
  KEEP_TABS,
  KEEP_TAB_KEY,
  LEGACY_VIEW,
  LEGACY_VIEW_TO_INSIGHTS,
  LEGACY_VIEW_TO_KEEP,
  VIEW_TO_WARDROBE,
  VIEWS,
  WARDROBE_TABS,
  peopleTabOfStatsView,
  storedCalMode,
  storedInnerView,
  storedInnerViews,
  statsTabOfView,
  storedKeepTab,
  storedStatsTab,
  storedTasksTab,
  viewIn,
  wardrobeTabOfView,
} from '../components/planner/routes'

/*
 * The shell's routing table: six tabs, the segments inside them, and the old
 * link names that still have to land somewhere.
 *
 * Five of the six are nouns — things you add to. Stats is the sixth and is a
 * lens: the only tab you never put anything into. It joined on 2026-09-15; the
 * rule it replaced ("five tabs") is now "five nouns and one lens, and still no
 * More drawer".
 */

describe('five tabs, the same on the phone and the desktop', () => {
  it('puts the five on the phone bar in its own order, and nothing else', () => {
    expect(COMPACT_TABS.map(t => t.id)).toEqual(['home', 'calendar', 'tasks', 'keep', 'insights'])
    expect([...COMPACT_TABS.map(t => t.id)].sort()).toEqual([...VIEWS].sort())
  })

  it('labels and draws every view on the desktop strip', () => {
    expect(Object.keys(VIEW_LABELS)).toEqual(VIEWS)
    expect(Object.keys(VIEW_ICONS).sort()).toEqual([...VIEWS].sort())
    for (const t of COMPACT_TABS) expect(t.label).toBe(VIEW_LABELS[t.id])
  })

  it('keeps the segments each tab holds', () => {
    // Home IS the day at v3.29: the Wardrobe went to Keep, the Week and the
    // Journal archive to Insights, and the Chat to a sheet off the top bar
    expect(HOME_TABS.map(t => t.key)).toEqual(['today'])
    expect(TASKS_TABS.map(t => t.key)).toEqual(['list', 'board', 'bills', 'notes'])
    expect(CALENDAR_MODES).toEqual(['month', 'week', 'day'])
  })

  it('gives People and Places each a List · Stats switch inside its segment, never a tab of its own', () => {
    expect(INNER_VIEWS.map(v => [v.key, v.label])).toEqual([
      ['list', 'List'],
      ['stats', 'Stats'],
    ])
    // the lens is a tab; a segment's OWN figures stay inside that segment,
    // because they count only what its find box and chip leave and the lens
    // has no list to read
    expect(VIEWS as string[]).not.toContain('places')
  })

  it('holds every area\u2019s figures as a segment of the lens, and a link to each', () => {
    expect(STATS_TABS.map(t => [t.key, t.label])).toEqual([
      ['overview', 'Overview'],
      ['tasks', 'Tasks'],
      ['money', 'Money'],
      ['people', 'People'],
      ['places', 'Places'],
      ['kitchen', 'Kitchen'],
      ['wardrobe', 'Wardrobe'],
      ['habits', 'Habits'],
      ['journal', 'Journal'],
    ])
    // every segment but the Overview has a link of its own, `stats-<segment>`
    const segments = STATS_TABS.map(t => t.key).filter(k => k !== 'overview') as string[]
    expect(Object.values(VIEW_TO_STATS).sort()).toEqual([...segments].sort())
    for (const key of segments) expect(statsTabOfView(`stats-${key}`)).toBe(key)
    // a bare ?view=stats names no segment, so the lens opens on the one last
    // chosen — as ?view=kitchen does
    expect(statsTabOfView('stats')).toBeNull()
    expect(statsTabOfView('constructor')).toBeNull()
    expect(statsTabOfView(undefined)).toBeNull()
  })

  it('leaves the areas\u2019 own shipped links pointing where they always did', () => {
    // ?view=people-stats and the other three were released pointing at the
    // Stats each area keeps inside itself. The lens draws those same figures
    // now, but a link already in a Shortcut, a reminder or someone's notes must
    // not quietly change where it lands.
    for (const name of ['people-stats', 'places-stats', 'kitchen-stats', 'wardrobe-stats']) expect(statsTabOfView(name)).toBeNull()
    expect(peopleTabOfStatsView('people-stats')).toBe('people')
    expect(VIEW_TO_KITCHEN['kitchen-stats']).toBe('stats')
    expect(VIEW_TO_WARDROBE['wardrobe-stats']).toBe('stats')
  })

  it('remembers the lens segment chosen on its own track, and nothing else', () => {
    const read = (v: string | null) => {
      vi.stubGlobal('localStorage', { getItem: () => v })
      return storedStatsTab()
    }
    expect(read(null)).toBe('overview')
    expect(read('money')).toBe('money')
    expect(read('wardrobe')).toBe('wardrobe')
    expect(read('recipes')).toBe('overview')
    expect(read('__proto__')).toBe('overview')
  })

  it('gives the wardrobe a segment of Keep, never a tab of its own', () => {
    expect(VIEWS).toHaveLength(5)
    expect(VIEWS as string[]).not.toContain('wardrobe')
    // it left Home in v3.29 for the tab that holds the other things you keep
    expect((HOME_TABS as { key: string }[]).find(t => t.key === 'wardrobe')).toBeUndefined()
    expect(KEEP_TABS.find(t => t.key === 'wardrobe')?.label).toBe('Wardrobe')
    expect(WARDROBE_TABS.map(t => [t.key, t.label])).toEqual([
      ['outfit', 'Outfit'],
      ['clothes', 'Clothes'],
      ['stats', 'Stats'],
    ])
  })

  it('keeps the four things you keep in one tab, and the five tabs in one bar', () => {
    expect(KEEP_TABS.map(t => [t.key, t.label])).toEqual([
      ['people', 'People'],
      ['places', 'Places'],
      ['kitchen', 'Kitchen'],
      ['wardrobe', 'Wardrobe'],
    ])
    // the tabs People, Kitchen and Stats used to be are gone as views …
    for (const gone of ['people', 'places', 'kitchen', 'stats']) expect(VIEWS as string[]).not.toContain(gone)
    // … and every link that named one still lands on what it named
    expect(LEGACY_VIEW_TO_KEEP.people).toBe('people')
    expect(LEGACY_VIEW_TO_KEEP.places).toBe('places')
    expect(LEGACY_VIEW_TO_KEEP.kitchen).toBe('kitchen')
    expect(LEGACY_VIEW_TO_KEEP.wardrobe).toBe('wardrobe')
    expect(LEGACY_VIEW.stats).toBe('insights')
  })
})

describe('old links still land on a segment', () => {
  it('sends board, bills and notes to that segment of Tasks', () => {
    expect(LEGACY_VIEW_TO_TASKS).toEqual({ board: 'board', bills: 'bills', notes: 'notes' })
    const segments = TASKS_TABS.map(t => t.key) as string[]
    for (const tab of Object.values(LEGACY_VIEW_TO_TASKS)) expect(segments).toContain(tab)
  })

  it('sends the former Today view to Home, and Review to Insights', () => {
    expect(LEGACY_VIEW_TO_HOME).toEqual({ today: 'today' })
    // ?view=review names Insights' Review segment now
    expect(LEGACY_VIEW_TO_INSIGHTS.review).toBe('review')
    expect(LEGACY_VIEW_TO_INSIGHTS.journal).toBe('journal')
    const segments = HOME_TABS.map(t => t.key) as string[]
    for (const tab of Object.values(LEGACY_VIEW_TO_HOME)) expect(segments).toContain(tab)
    // and every view that stopped being a tab lands on the segment it named
    const kept = KEEP_TABS.map(t => t.key) as string[]
    for (const tab of Object.values(LEGACY_VIEW_TO_KEEP)) expect(kept).toContain(tab)
    for (const v of Object.values(LEGACY_VIEW)) expect(VIEWS as string[]).toContain(v)
  })

  it('opens People or Places on its Stats for ?view=people-stats or ?view=places-stats, names no live view or old link has', () => {
    expect(STATS_VIEW_TO_PEOPLE).toEqual({ 'people-stats': 'people', 'places-stats': 'places' })
    const taken = [...VIEWS, ...Object.keys(LEGACY_VIEW_TO_TASKS), ...Object.keys(LEGACY_VIEW_TO_HOME)] as string[]
    for (const name of Object.keys(STATS_VIEW_TO_PEOPLE)) expect(taken).not.toContain(name)
  })

  it('reads a Stats view’s own names only, so an inherited one opens nothing', () => {
    expect(peopleTabOfStatsView('people-stats')).toBe('people')
    expect(peopleTabOfStatsView('places-stats')).toBe('places')
    for (const name of [undefined, '', 'people', 'stats', 'constructor', 'toString', '__proto__']) expect(peopleTabOfStatsView(name)).toBeNull()
  })

  it('opens Home → Wardrobe on its Stats for ?view=wardrobe-stats, and leaves ?view=wardrobe to the composer', () => {
    expect(VIEW_TO_WARDROBE).toEqual({ 'wardrobe-stats': 'stats' })
    const views = WARDROBE_TABS.map(t => t.key) as string[]
    for (const tab of Object.values(VIEW_TO_WARDROBE)) expect(views).toContain(tab)
    expect(wardrobeTabOfView('wardrobe-stats')).toBe('stats')
    // the plain link names none of the Wardrobe's own views, and nor does a name every object inherits
    for (const name of [undefined, '', 'wardrobe', 'stats', 'outfit', 'clothes', 'constructor', 'toString', '__proto__', 'hasOwnProperty'])
      expect(wardrobeTabOfView(name), String(name)).toBeNull()
    // ?view=wardrobe names Keep's Wardrobe segment since v3.29, not a Home page
    expect(LEGACY_VIEW_TO_KEEP.wardrobe).toBe('wardrobe')
  })

  it('reads every link table by its own names, so an inherited one names nothing', () => {
    expect(viewIn(LEGACY_VIEW_TO_TASKS, 'board')).toBe('board')
    expect(viewIn(LEGACY_VIEW_TO_HOME, 'today')).toBe('today')
    expect(viewIn(LEGACY_VIEW_TO_INSIGHTS, 'review')).toBe('review')
    for (const table of [LEGACY_VIEW_TO_TASKS, LEGACY_VIEW_TO_HOME, LEGACY_VIEW_TO_KEEP, LEGACY_VIEW_TO_INSIGHTS, STATS_VIEW_TO_PEOPLE, VIEW_TO_KITCHEN, VIEW_TO_WARDROBE] as Record<string, unknown>[])
      for (const name of [undefined, '', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(viewIn(table, name), String(name)).toBeNull()
  })

  it('never shadows a live view with a legacy name', () => {
    const legacy = [...Object.keys(LEGACY_VIEW_TO_TASKS), ...Object.keys(LEGACY_VIEW_TO_HOME), ...Object.keys(STATS_VIEW_TO_PEOPLE), ...Object.keys(VIEW_TO_KITCHEN), ...Object.keys(VIEW_TO_WARDROBE)]
    for (const name of legacy) expect(VIEWS as string[]).not.toContain(name)
    expect(new Set(legacy).size).toBe(legacy.length)
  })
})

describe('People’s and Places’ own List · Stats', () => {
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

  it('reopens the Keep segment last chosen, and falls back to People', () => {
    withStorage({ [KEEP_TAB_KEY]: 'kitchen' })
    expect(storedKeepTab()).toBe('kitchen')
    withStorage({ [KEEP_TAB_KEY]: 'wardrobe' })
    expect(storedKeepTab()).toBe('wardrobe')
    withStorage({ [KEEP_TAB_KEY]: 'nonsense' })
    expect(storedKeepTab()).toBe('people')
    withStorage({})
    expect(storedKeepTab()).toBe('people')
  })

  it('inherits the old People · Places key, so Keep opens where its predecessor was left', () => {
    // a phone updating into v3.29 has drafter:people-tab and no drafter:keep-tab
    withStorage({ [PEOPLE_TAB_KEY]: 'places' })
    expect(storedKeepTab()).toBe('places')
    withStorage({ [PEOPLE_TAB_KEY]: 'people' })
    expect(storedKeepTab()).toBe('people')
    // and the new key wins once anything has been chosen on the new track
    withStorage({ [PEOPLE_TAB_KEY]: 'places', [KEEP_TAB_KEY]: 'kitchen' })
    expect(storedKeepTab()).toBe('kitchen')
  })

  it('reopens Places on Stats only when Stats was chosen', () => {
    withStorage({ [INNER_VIEW_KEYS.places]: 'stats' })
    expect(storedInnerView('places')).toBe('stats')
    for (const other of ['list', 'board', '']) {
      withStorage({ [INNER_VIEW_KEYS.places]: other })
      expect(storedInnerView('places')).toBe('list')
    }
    withStorage({})
    expect(storedInnerView('places')).toBe('list')
  })

  it('reopens the Calendar on the mode chosen on its buttons, and on Month for anything else', () => {
    for (const mode of CALENDAR_MODES) {
      withStorage({ [CAL_MODE_KEY]: mode })
      expect(storedCalMode()).toBe(mode)
    }
    for (const other of ['board', 'stats', '', 'timeline']) {
      withStorage({ [CAL_MODE_KEY]: other })
      expect(storedCalMode()).toBe('month')
    }
    withStorage({})
    expect(storedCalMode()).toBe('month')
  })

  it('falls back to the first segment when storage cannot be read', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
    })
    expect(storedTasksTab()).toBe('list')
    expect(storedKeepTab()).toBe('people')
    expect(storedInnerView('places')).toBe('list')
    expect(storedCalMode()).toBe('month')
  })
})
