// @vitest-environment happy-dom
import { render } from './dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The warm-up a moment after launch (components/planner/lazy.ts). On the web
// every lazy chunk is fetched ahead of the tap that needs it, the assistant's
// own views last; in the iOS app, where the bundle is already on disk and
// fetching saves nothing, only what the top bar opens from every screen is
// parsed ahead, and the rest wait for a finger on their tab or button.

const shell = vi.hoisted(() => ({ native: false }))
vi.mock('../native', () => ({ isNative: () => shell.native }))
const load = vi.hoisted(() => ({ scheduled: [] as unknown[][], warmed: [] as unknown[][] }))
vi.mock('../lazyload', async importOriginal => ({
  ...(await importOriginal<typeof import('../lazyload')>()),
  schedulePreload: (preloads: unknown[]) => {
    load.scheduled.push(preloads)
    return () => {}
  },
  warm: (...preloads: unknown[]) => void load.warmed.push(preloads),
}))

import * as lazy from '../components/planner/lazy'
import { NATIVE_PRELOAD_ORDER, PRELOAD_ORDER, preloadOrder, useWarmChunks } from '../components/planner/lazy'

/** Every view and sheet lazy.ts loads on demand, by name. */
const views = Object.entries(lazy).filter(([, v]) => typeof v === 'function' && 'preload' in v) as [string, { preload: () => Promise<void> }][]
const named = (order: readonly unknown[]) => order.map(p => views.find(([, v]) => v.preload === p)?.[0] ?? '?')

function Launch({ owner }: { owner: boolean }) {
  useWarmChunks(owner)
  return null
}

beforeEach(() => {
  load.scheduled = []
  load.warmed = []
})

describe('the warm-up on the web', () => {
  it('warms every lazy view and sheet once, Admin aside', () => {
    const names = named(PRELOAD_ORDER)
    expect(new Set(names).size).toBe(names.length)
    expect([...names].sort()).toEqual(views.map(([name]) => name).filter(n => n !== 'Admin').sort())
  })

  it("starts with what the top bar opens from anywhere, and leaves the assistant's own views to last", () => {
    const names = named(PRELOAD_ORDER)
    expect(names.slice(0, 3)).toEqual(['TaskEditor', 'Search', 'Settings'])
    expect(names.slice(-2)).toEqual(['Chat', 'AskSheet'])
  })

  it("is the launch's, with Admin's for the owner", () => {
    shell.native = false
    render(<Launch owner />)
    expect(load.scheduled).toEqual([PRELOAD_ORDER])
    expect(load.warmed).toEqual([[lazy.Admin.preload]])
  })
})

describe('the warm-up in the iOS app', () => {
  it('parses only the task editor, search and Settings ahead', () => {
    expect(named(NATIVE_PRELOAD_ORDER)).toEqual(['TaskEditor', 'Search', 'Settings'])
    expect(preloadOrder(true)).toBe(NATIVE_PRELOAD_ORDER)
    expect(preloadOrder(false)).toBe(PRELOAD_ORDER)
  })

  it("is the launch's, and leaves even the owner's Admin to be opened", () => {
    shell.native = true
    render(<Launch owner />)
    expect(load.scheduled).toEqual([NATIVE_PRELOAD_ORDER])
    expect(load.warmed).toEqual([])
  })
})
