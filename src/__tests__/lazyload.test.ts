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
const LAZY_VIEWS = ['Calendar', 'Roadmap', 'TasksTable', 'Board', 'Bills', 'NotesView', 'People', 'Places', 'Kitchen', 'Review', 'TaskEditor', 'ProjectEditor', 'EventEditor', 'AttendancePicker', 'Search', 'Trash', 'Settings', 'Admin', 'PlanDaySheet', 'ShutdownSheet', 'WeekPlanSheet', 'AskSheet']
/** …and what only they use, which must travel with them. */
const LAZY_ONLY = [...['TaskCard', 'GithubCard', 'RichNotes', 'MealSlotRow'].map(component), resolve(SRC, 'markdown.ts')]

/** Static edges only: `import type` and import() are not followed. */
function staticImports(file: string): string[] {
  const code = readFileSync(file, 'utf8')
  const specs = [...code.matchAll(/^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm)].map(m => m[1])
  return specs.flatMap(spec => {
    const base = resolve(dirname(file), spec)
    const hit = [base, `${base}.ts`, `${base}.tsx`].find(p => existsSync(p) && statSync(p).isFile())
    return hit && /\.(tsx?|mjs)$/.test(hit) ? [hit] : []
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

  it('reaches none of the lazy views, overlays or what only they use', () => {
    const leaked = [...LAZY_VIEWS.map(component), ...LAZY_ONLY].filter(f => shell.has(f)).map(f => f.slice(SRC.length))
    expect(leaked).toEqual([])
  })

  it('loads every one of them through planner/lazy.ts', () => {
    const lazy = readFileSync(resolve(SRC, 'components/planner/lazy.ts'), 'utf8')
    for (const name of LAZY_VIEWS) expect(lazy).toContain(`import('../${name}')`)
  })
})
