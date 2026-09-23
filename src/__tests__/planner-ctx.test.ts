import { describe, expect, it, vi } from 'vitest'
import { createCtxMemo, type PlannerParts } from '../components/planner/ctx'

// Planner's context is handed down as one prop. Its hooks return fresh
// closures every render; the memo keeps the context the same object while no
// value in it changed, and every function in it the same function for good —
// one that calls the latest render's.

const NAV = ['goView', 'setView', 'openJournal', 'openReview', 'goTasksTab', 'setKeepTab', 'goInnerView', 'openWardrobe', 'openKitchen', 'openLens', 'newTask', 'setPushed', 'openSheet'] as const

/** One render's parts: the same data, and a new closure for every function, as Planner's hooks hand back. */
function render(data: Record<string, unknown>, calls: string[], tag: string): PlannerParts {
  const fns = Object.fromEntries(NAV.map(name => [name, (...args: unknown[]) => void calls.push(`${tag}:${name}(${args.join(',')})`)]))
  return { ...data, ...fns, showToast: (msg: string) => void calls.push(`${tag}:showToast(${msg})`) } as unknown as PlannerParts
}

describe('the planner context', () => {
  const store = { tasks: [] }
  const household = { myId: 'me' }

  it('is the same object while no value in it changed, however new its closures are', () => {
    const calls: string[] = []
    const memo = createCtxMemo(() => new Date(2026, 8, 22, 9))
    const first = memo(render({ store, household, view: 'home' }, calls, 'r1'))
    const second = memo(render({ store, household, view: 'home' }, calls, 'r2'))
    expect(second).toBe(first)
    // the function is the first render's stand-in, and calls the second render's closure
    second.showToast('Saved')
    expect(calls).toEqual(['r2:showToast(Saved)'])
  })

  it('is a new object when a value changes — with the very same functions', () => {
    const calls: string[] = []
    const memo = createCtxMemo(() => new Date(2026, 8, 22, 9))
    const first = memo(render({ store, household, view: 'home' }, calls, 'r1'))
    const next = memo(render({ store: { tasks: [{ id: 'a' }] }, household, view: 'home' }, calls, 'r2'))
    expect(next).not.toBe(first)
    expect(next.showToast).toBe(first.showToast)
    expect(next.goView).toBe(first.goView)
    const moved = memo(render({ store: next.store, household, view: 'tasks' }, calls, 'r3'))
    expect(moved).not.toBe(next)
    expect(moved.view).toBe('tasks')
  })

  it('draws the palette’s commands once an hour, and they run the latest navigation', () => {
    const calls: string[] = []
    let hour = 9
    const clock = vi.fn(() => new Date(2026, 8, 22, hour))
    const memo = createCtxMemo(clock)
    const morning = memo(render({ store, household }, calls, 'r1'))
    const later = memo(render({ store, household }, calls, 'r2'))
    expect(later.paletteCommands).toBe(morning.paletteCommands)
    // before noon Plan my day is a quick action
    expect(morning.paletteCommands.find(c => c.id === 'plan-day')?.quick).toBe(true)
    later.paletteCommands.find(c => c.id === 'go-home')!.run()
    expect(calls).toEqual(['r2:goView(home)'])

    hour = 18
    const evening = memo(render({ store, household }, calls, 'r3'))
    expect(evening.paletteCommands).not.toBe(morning.paletteCommands)
    expect(evening.paletteCommands.find(c => c.id === 'plan-day')?.quick).toBe(false)
    expect(evening.paletteCommands.find(c => c.id === 'shut-down')?.quick).toBe(true)
  })

  it('a value that stops being a function is handed down as it is', () => {
    const memo = createCtxMemo(() => new Date(2026, 8, 22, 9))
    const calls: string[] = []
    const first = memo({ ...render({ store, household }, calls, 'r1'), mirrorEvent: () => {} } as unknown as PlannerParts)
    expect(typeof (first as unknown as { mirrorEvent: unknown }).mirrorEvent).toBe('function')
    const next = memo({ ...render({ store, household }, calls, 'r2'), mirrorEvent: undefined } as unknown as PlannerParts)
    expect((next as unknown as { mirrorEvent: unknown }).mirrorEvent).toBeUndefined()
    expect(next).not.toBe(first)
  })
})
