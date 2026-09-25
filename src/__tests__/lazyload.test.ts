import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Suspense, createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHUNK_RELOAD_KEY, CHUNK_RELOAD_WINDOW_MS, preloadable, schedulePreload, shouldReloadForChunk } from '../lazyload'

type Named = { name: string }
const hello: ComponentType<Named> = ({ name }) => createElement('b', null, `hi ${name}`)

describe('preloadable: fetched once, and instant once here', () => {
  it('fetches the chunk once, however often it is asked for', async () => {
    const factory = vi.fn(() => Promise.resolve(hello))
    const View = preloadable(factory)
    await Promise.all([View.preload(), View.preload()])
    await View.preload()
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('does not remember a failure: the next ask fetches again', async () => {
    const factory = vi.fn<() => Promise<ComponentType<Named>>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(hello)
    const View = preloadable(factory)
    await expect(View.preload()).rejects.toThrow('offline')
    await expect(View.preload()).resolves.toBeUndefined()
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('suspends only while the chunk is on its way', async () => {
    const View = preloadable(() => Promise.resolve(hello))
    const page = () => renderToString(createElement(Suspense, { fallback: createElement('i', null, 'pending') }, createElement(View, { name: 'Jo' })))
    // react-dom/server reports the suspended boundary; that is the case under test
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(page()).toContain('pending')
    quiet.mockRestore()
    await View.preload()
    // warmed: rendered directly, so there is no fallback for React to throttle
    expect(page()).toContain('hi Jo')
    expect(page()).not.toContain('pending')
  })
})

describe('the reload-once guard for a chunk that will not load', () => {
  const memory = () => {
    const values = new Map<string, string>()
    return { values, getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v) }
  }

  it('reloads for the first failure, and notes when', () => {
    const s = memory()
    expect(shouldReloadForChunk(s, 1_000_000)).toBe(true)
    expect(s.values.get(CHUNK_RELOAD_KEY)).toBe('1000000')
  })

  it('does not reload again inside the window, so a missing file cannot loop the page', () => {
    const s = memory()
    shouldReloadForChunk(s, 1_000_000)
    expect(shouldReloadForChunk(s, 1_000_000 + CHUNK_RELOAD_WINDOW_MS - 1)).toBe(false)
    expect(s.values.get(CHUNK_RELOAD_KEY)).toBe('1000000')
  })

  it('reloads again for a later deploy', () => {
    const s = memory()
    shouldReloadForChunk(s, 1_000_000)
    expect(shouldReloadForChunk(s, 1_000_000 + CHUNK_RELOAD_WINDOW_MS)).toBe(true)
  })

  it('never reloads when it cannot note the reload down', () => {
    expect(shouldReloadForChunk(null)).toBe(false)
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
    }
    expect(shouldReloadForChunk(full)).toBe(false)
    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {},
    }
    expect(shouldReloadForChunk(blocked)).toBe(false)
  })
})

describe('schedulePreload: after launch, one chunk at a time', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits, then fetches in order, each after the last, and past a failure', async () => {
    vi.useFakeTimers()
    const order: string[] = []
    let release = () => {}
    const first = () => {
      order.push('editor')
      return new Promise<void>(r => (release = r))
    }
    const failing = () => {
      order.push('search')
      return Promise.reject(new Error('gone'))
    }
    const last = () => {
      order.push('calendar')
      return Promise.resolve()
    }
    schedulePreload([first, failing, last], 1500)
    await vi.advanceTimersByTimeAsync(1499)
    expect(order).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(order).toEqual(['editor'])
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['editor', 'search', 'calendar'])
  })

  it('fetches nothing once cancelled', async () => {
    vi.useFakeTimers()
    const preload = vi.fn(() => Promise.resolve())
    const cancel = schedulePreload([preload])
    cancel()
    await vi.advanceTimersByTimeAsync(5000)
    expect(preload).not.toHaveBeenCalled()
  })
})

/*
 * A lazy view is only lazy if nothing reaches it statically: one plain import
 * from the shell (or anything the shell imports) pulls its chunk back into the
 * first load. Walk the static imports from both entry points and make sure
 * none of the lazy set is on the way.
 */
const SRC = fileURLToPath(new URL('../', import.meta.url))
const component = (name: string) => resolve(SRC, 'components', `${name}.tsx`)
/** The views and overlays planner/lazy.ts loads on demand. */
const LAZY_VIEWS = ['Calendar', 'TasksTable', 'Board', 'Finance', 'NotesView', 'People', 'Places', 'PeopleStats', 'PlacesStats', 'Kitchen', 'kitchen/KitchenStats', 'Review', 'Journal', 'wardrobe/Wardrobe', 'TaskEditor', 'ProjectEditor', 'EventEditor', 'AttendancePicker', 'Search', 'Trash', 'Settings', 'Admin', 'PlanDaySheet', 'ShutdownSheet', 'WeekPlanSheet', 'AskSheet', 'ImHereSheet', 'RhythmSheet']
/** …and what only they use, which must travel with them. */
const LAZY_ONLY = [
  ...['TaskCard', 'GithubCard', 'RichNotes', 'MealSlotRow', 'PeoplePicker'].map(component),
  // the meal picker (the Kitchen's, the calendar's, the chat's and the planning
  // sheets') and This week's day cards
  ...['MealPicker', 'kitchen/MealCards'].map(component),
  // Finance draws Bills inside it (v3.27), so the month of bills travels with
  // the paydays and the accounts rather than shipping as a second chunk
  component('Bills'),
  resolve(SRC, 'finance.ts'),
  // …and its pay periods, Manage, the rows and sheets they open, and the bills + Bill fills in
  ...[
    'finance/Periods',
    'finance/Manage',
    'finance/Rows',
    'finance/Goals',
    'finance/CashLineChart',
    'finance/LineSheet',
    'finance/AddSheet',
    'finance/CheckInSheet',
    'finance/BillSheet',
    'finance/PaydaySheet',
    'finance/GoalSheet',
    'finance/AccountSheet',
    'finance/KindPicker',
    'finance/SheetActions',
    'finance/ShareChoice',
  ].map(component),
  resolve(SRC, 'components', 'finance', 'labels.ts'),
  resolve(SRC, 'billtemplates.ts'),
  // Kitchen → Stats' counting travels with it
  resolve(SRC, 'kitchenstats.ts'),
  // …and filling recipes in: ✨ Fill in, Fill them in, Import from a link
  resolve(SRC, 'recipefill.ts'),
  resolve(SRC, 'recipeimport.ts'),
  component('kitchen/RecipeCapture'),
  component('kitchen/RecipeFillFlow'),
  // the wardrobe's screens and its photo pipeline: only Today's card and its
  // thumbnails ride in the Planner chunk. WardrobeStats has a preloadable of
  // its own too (the Stats lens draws it), so it must stay out of the first
  // load by BOTH routes — hence it is listed here as well as among the views.
  ...[
    'wardrobe/OutfitComposer',
    'wardrobe/WeekStrip',
    'wardrobe/LookSlot',
    'wardrobe/PiecePicker',
    'wardrobe/PlanWeekSheet',
    'wardrobe/SavedOutfits',
    'wardrobe/Clothes',
    'wardrobe/GarmentSheet',
    'wardrobe/PieceDetails',
    'wardrobe/WardrobeStats',
  ].map(component),
  resolve(SRC, 'components', 'wardrobe', 'composer.ts'),
  resolve(SRC, 'components', 'wardrobe', 'board.ts'),
  // People → Stats' and Places → Stats' counting travels with its view, and the face both draw a person with
  resolve(SRC, 'peoplestats.ts'),
  resolve(SRC, 'placestats.ts'),
  component('PersonFace'),
  resolve(SRC, 'markdown.ts'),
  resolve(SRC, 'photo.ts'),
  // …and the task editor's and the notes pad's pictures, saved through it
  resolve(SRC, 'picture.ts'),
  // Find address, and the lookup behind it: the place editor's and the rhythm sheet's
  component('AddressFinder'),
  resolve(SRC, 'geocode.ts'),
  // The assistant: its prompts and parsers, the retrieval Ask runs over the
  // device, and the chat's actions. The palette's capture files a line through
  // capture.ts and asks the model with import('../../ai'); nothing else in the
  // shell may reach them (check-precache.mjs holds the built chunks to the same).
  resolve(SRC, 'ai.ts'),
  resolve(SRC, 'ask.ts'),
  resolve(SRC, 'chatactions.ts'),
  // The calendar mirrors' engine and Settings' calendar actions: the shell
  // holds the feeds and the mirrors' state (calendarstate.ts) and fetches this
  // with the first mirror pass or the first entry written through to a mirror.
  resolve(SRC, 'calendars.ts'),
  // A GitHub board's rules: loaded by the first push or pull, and nothing
  // pushes or pulls until a project has a board linked (githubboard.ts).
  resolve(SRC, 'githubsync.ts'),
]

/** Static edges only: `import type` and import() are not followed. */
function staticImports(file: string): string[] {
  const code = readFileSync(file, 'utf8')
  const specs = [...code.matchAll(/^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm)].map(m => m[1])
  return specs.flatMap(spec => {
    const base = resolve(dirname(file), spec)
    const hit = [base, `${base}.ts`, `${base}.tsx`].find(p => existsSync(p) && statSync(p).isFile())
    return hit && /\.(tsx?|mts|mjs)$/.test(hit) ? [hit] : []
  })
}

function reachable(entries: string[]): Set<string> {
  const seen = new Set<string>()
  const todo = [...entries]
  while (todo.length) {
    const file = todo.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    todo.push(...staticImports(file))
  }
  return seen
}

describe('the lazy set stays out of the first load', () => {
  const shell = reachable([resolve(SRC, 'main.tsx'), component('Planner')])

  it('walks the real graph: the shell reaches its screens and Today', () => {
    expect(shell).toContain(resolve(SRC, 'components/planner/HomeScreen.tsx'))
    expect(shell).toContain(resolve(SRC, 'components/planner/lazy.ts'))
    expect(shell).toContain(component('Today'))
  })

  it('reaches the small halves the launch needs, which stand in for the lazy ones', () => {
    // capture.ts for ai.ts, calendarstate.ts for calendars.ts, JournalCard for
    // the journal page, githubboard.ts for githubsync.ts: if one of these stops
    // being reached, the split has been undone some other way
    for (const file of ['capture.ts', 'calendarstate.ts', 'githubboard.ts'].map(f => resolve(SRC, f))) expect(shell).toContain(file)
    expect(shell).toContain(component('JournalCard'))
  })

  it('reaches none of the lazy views, overlays or what only they use', () => {
    const leaked = [...LAZY_VIEWS.map(component), ...LAZY_ONLY].filter(f => shell.has(f)).map(f => f.slice(SRC.length))
    expect(leaked).toEqual([])
  })

  it('loads every one of them through planner/lazy.ts, or the Stats registry it re-exports', () => {
    // the four areas' Stats sit in lazystats.ts, which the Kitchen and the
    // Stats lens import: lazy.ts names every lazy chunk, and a view that
    // imported it was renamed with it on every deploy
    const lazy = readFileSync(resolve(SRC, 'components/planner/lazy.ts'), 'utf8') + readFileSync(resolve(SRC, 'components/planner/lazystats.ts'), 'utf8')
    for (const name of LAZY_VIEWS) expect(lazy).toContain(`import('../${name}')`)
  })
})

/*
 * The iPhone's warm-up (planner/lazy.ts NATIVE_PRELOAD_ORDER) parses the task
 * editor, the palette and Settings a moment after launch, and it parsed the
 * assistant's code (ai.ts and the retrieval Ask runs, ask.ts) and the
 * calendar mirrors' engine (calendars.ts) with them, through a few static
 * imports: the palette's question rule, the editor's ✨ buttons, and Settings'
 * calendar sections. Those load when used now, and none is on the way.
 */
describe('the warm-up parses no assistant code and no calendar mirrors', () => {
  const warm = reachable(['TaskEditor', 'Search', 'Settings'].map(component))

  it('walks the real graph: the three reach their small halves', () => {
    for (const file of ['questions.ts', 'refine.ts', 'calendarsettings.ts', 'taskform.ts'].map(f => resolve(SRC, f))) expect(warm).toContain(file)
  })

  it('reaches neither the assistant nor the mirrors’ engine', () => {
    const reached = ['ai.ts', 'ask.ts', 'chatactions.ts', 'calendars.ts', 'components/settings/GoogleCalendar.tsx', 'components/settings/OutlookCalendars.tsx'].filter(f => warm.has(resolve(SRC, f)))
    expect(reached).toEqual([])
  })

  it('still loads them where they are used: the editor’s ✨ buttons and Settings → Calendars', () => {
    expect(readFileSync(component('TaskEditor'), 'utf8')).toContain("const assistant = () => import('../ai')")
    expect(readFileSync(component('Settings'), 'utf8')).toContain("import('./settings/Calendars')")
  })
})

/*
 * The screens behind every tab but Home, and the pushed ones, are chunks of
 * their own, fetched with their views: none is drawn at launch. A screen
 * draws the views the shell hands it (p.views), and imports neither the
 * views' files nor planner/lazy.ts, which names every lazy chunk — a chunk
 * that did was renamed whenever any view changed. Today's wardrobe card is
 * fetched when the wardrobe can dress you.
 */
describe('the screens and the wardrobe card load on demand', () => {
  const SCREENS = ['CalendarScreen', 'TasksScreen', 'KeepScreen', 'InsightsScreen', 'SettingsScreen', 'ChatScreen', 'AdminScreen']
  const planner = (name: string) => resolve(SRC, 'components/planner', `${name}.tsx`)
  const lazySrc = readFileSync(resolve(SRC, 'components/planner/lazy.ts'), 'utf8')

  it('loads each through planner/lazy.ts, and Home with the shell', () => {
    for (const name of SCREENS) expect(lazySrc).toContain(`import('./${name}')`)
    expect(lazySrc).toContain("import('../wardrobe/WardrobeCard')")
    const shell = reachable([resolve(SRC, 'main.tsx'), component('Planner')])
    expect(shell).toContain(planner('HomeScreen'))
    expect([...SCREENS.map(planner), component('wardrobe/WardrobeCard')].filter(f => shell.has(f)).map(f => f.slice(SRC.length))).toEqual([])
  })

  it('draws the views the shell hands it, reaching neither lazy.ts nor a view’s file', () => {
    for (const name of SCREENS) {
      const reach = reachable([planner(name)])
      expect(reach.has(resolve(SRC, 'components/planner/lazy.ts')), name).toBe(false)
      expect(LAZY_VIEWS.map(component).filter(f => reach.has(f)).map(f => f.slice(SRC.length)), name).toEqual([])
    }
  })
})
