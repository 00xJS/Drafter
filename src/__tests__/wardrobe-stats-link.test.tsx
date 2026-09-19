import { useState, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PlannerCtx } from '../components/planner/ctx'
import { HomeScreen } from '../components/planner/HomeScreen'
import { Wardrobe as LazyWardrobe } from '../components/planner/lazy'
import { useDeepLinks } from '../components/planner/useDeepLinks'
import { useNavigation, type WardrobeOpen } from '../components/planner/useNavigation'
import { GarmentSheet } from '../components/wardrobe/GarmentSheet'
import { OutfitComposer } from '../components/wardrobe/OutfitComposer'
import { Wardrobe } from '../components/wardrobe/Wardrobe'
import { WardrobeStats } from '../components/wardrobe/WardrobeStats'
import type { Garment, GarmentType, Outfit } from '../types'
import { elements, press, propsOf, textOf } from './rendered'

// Wardrobe → Stats from a link and from the palette: ?view=wardrobe-stats
// through the shell's own navigation to Home as it draws, ?view=wardrobe still
// on today's composer, and a way in that arrives while the Wardrobe is already
// on screen, on Outfit or Clothes, moving it all the same. The command itself
// is in commands.test.ts, and the link's table in routes.test.ts.
//
// The Wardrobe takes a way in with an effect, and a server render runs none.
// So while `effects.on` is set an effect runs as it is met, whenever its deps
// have changed since the render before, as React runs it once the screen has
// drawn; what it sets is applied by the same render, which calls the Wardrobe
// again, so the last tree is the Wardrobe after it.

const effects = vi.hoisted(() => ({ on: false, at: 0, deps: [] as (readonly unknown[] | undefined)[] }))
vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>()
  const useEffect = ((effect: () => void, deps?: readonly unknown[]) => {
    if (!effects.on) return react.useEffect(effect, deps)
    const at = effects.at++
    const was = effects.deps[at]
    if (at < effects.deps.length && deps && was && deps.length === was.length && deps.every((d, i) => Object.is(d, was[i]))) return
    effects.deps[at] = deps
    effect()
  }) as typeof react.useEffect
  return { ...react, useEffect }
})

afterEach(() => {
  effects.on = false
  effects.at = 0
  effects.deps = []
  vi.useRealTimers()
})

const noop = () => {}
const T0 = '2026-08-01T09:00:00.000Z'
const piece = (id: string, type: GarmentType): Garment => ({ kind: 'garment', id, name: id, type, createdAt: T0, updatedAt: T0 })
const GARMENTS = [piece('navy-tee', 'top'), piece('grey-tee', 'top'), piece('jeans', 'bottom'), piece('cords', 'bottom')]
const FRIDAY: Outfit = { kind: 'outfit', id: 'o1', name: 'Friday', garmentIds: ['navy-tee', 'jeans'], createdAt: T0, updatedAt: T0 }

/** Monday 14 September 2026, mid-morning. */
const at10 = () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 14, 10))
}

/** The Wardrobe's own switch as a tree has it: the view that is selected. */
const selected = (tree: ReactNode) =>
  elements(tree)
    .filter(e => e.type === 'button' && e.props.role === 'tab' && e.props['aria-selected'])
    .map(e => textOf(e.props.children))

describe('a way in while the Wardrobe is already on screen', () => {
  /**
   * The Wardrobe on screen on `from`, chosen with its own button; then a way
   * in arrives, as the palette or a link hands it one through the shell. The
   * tree it showed just before, the tree it settled on, and how often it told
   * the shell it had taken a way in.
   */
  function onScreen(from: 'Outfit' | 'Clothes' | 'Stats', next: WardrobeOpen) {
    at10()
    effects.on = true
    const trees: ReactNode[] = []
    let taken = 0
    function Shell() {
      effects.at = 0
      const [open, setOpen] = useState<WardrobeOpen | null>(null)
      const [step, setStep] = useState(0)
      const tree = Wardrobe({
        garments: GARMENTS,
        outfits: [FRIDAY],
        wears: [],
        onSave: noop,
        onRemove: noop,
        onRestore: noop,
        showToast: noop,
        open,
        onOpenConsumed: () => {
          taken++
          setOpen(null)
        },
      })
      trees.push(tree)
      if (step === 0 && from !== 'Outfit') press(tree, from)
      if (step === 1) setOpen(next)
      if (step < 2) setStep(step + 1)
      return null
    }
    renderToStaticMarkup(<Shell />)
    effects.on = false
    return { before: trees[1], after: trees[trees.length - 1], taken }
  }

  it('moves Outfit or Clothes to Stats for Wardrobe stats and ?view=wardrobe-stats, and lets the hand-off go', () => {
    for (const from of ['Outfit', 'Clothes'] as const) {
      const { before, after, taken } = onScreen(from, { tab: 'stats' })
      expect(selected(before), from).toEqual([from])
      expect(selected(after), from).toEqual(['Stats'])
      expect(elements(after).some(e => e.type === WardrobeStats), from).toBe(true)
      // taken once and let go of, so the same way in works again next time
      expect(taken, from).toBe(1)
    }
  })

  it('still takes Add clothing, a day, a saved outfit and a piece from where it is, as it takes them on arrival', () => {
    const add = onScreen('Outfit', { tab: 'clothes', add: true })
    expect(selected(add.after)).toEqual(['Clothes'])
    expect(propsOf(add.after, GarmentSheet).mode).toEqual({ kind: 'add', type: undefined })
    // a day, or a saved outfit for the rows: the composer
    const day = onScreen('Stats', { date: '2026-09-12' })
    expect(selected(day.after)).toEqual(['Outfit'])
    expect(propsOf(day.after, OutfitComposer).day).toBe('2026-09-12')
    const rows = onScreen('Clothes', { outfitId: 'o1' })
    expect(selected(rows.after)).toEqual(['Outfit'])
    expect(propsOf(rows.after, OutfitComposer).pending).toEqual(['navy-tee', 'jeans'])
    // a piece opens its sheet over whichever view is showing
    const one = onScreen('Stats', { garmentId: 'grey-tee' })
    expect(selected(one.after)).toEqual(['Stats'])
    expect(propsOf(one.after, GarmentSheet).mode).toEqual({ kind: 'edit', id: 'grey-tee' })
    for (const way of [add, day, rows, one]) expect(way.taken).toBe(1)
  })
})

describe('?view=wardrobe-stats, through the shell', () => {
  type Nav = ReturnType<typeof useNavigation>
  const store = { loaded: true, journal: [], tasks: [], people: [], places: [], garments: GARMENTS, outfits: [FRIDAY], wears: [], upsert: noop, remove: noop, restore: noop }
  const ctx = (nav: Nav) => ({ ...nav, store, household: { myId: null }, showToast: noop }) as unknown as PlannerCtx

  /** The shell's own navigation and link reader, walked through `steps` a render at a time, as people-stats-view.test.tsx's journey walks; where it ended. */
  function walk(steps: ((nav: Nav, link: (raw: string) => void) => void)[]): Nav {
    let last: Nav | null = null
    function Shell() {
      const nav = useNavigation()
      const { applyLinkRef } = useDeepLinks({
        store,
        showToast: noop,
        setSettingsNonce: noop,
        setSettingsOpen: noop,
        setAdminOpen: noop,
        setEditor: noop,
        newTask: noop,
        openSheet: noop,
        changeStatus: noop,
        defer: noop,
        ...nav,
      } as unknown as Parameters<typeof useDeepLinks>[0])
      const [step, setStep] = useState(0)
      last = nav
      if (step < steps.length) {
        steps[step](nav, raw => applyLinkRef.current(raw))
        setStep(step + 1)
      }
      return null
    }
    renderToStaticMarkup(<Shell />)
    return last!
  }
  /** Home as it draws where the shell ended: its segments, then the Wardrobe's, the selected ones starred. */
  const home = (nav: Nav) => {
    const html = renderToStaticMarkup(<HomeScreen p={ctx(nav)} />)
    return { html, tabs: [...html.matchAll(/role="tab" aria-selected="(true|false)" class="seg(?: on)?">([^<]+)</g)].map(m => `${m[2]}${m[1] === 'true' ? '*' : ''}`) }
  }

  beforeAll(() => LazyWardrobe.preload())

  it('lands on Home → Wardrobe → Stats, from the web and from drafter://open', () => {
    at10()
    for (const raw of ['/?view=wardrobe-stats', 'drafter://open?view=wardrobe-stats']) {
      const nav = walk([(_, link) => link(raw)])
      expect(nav, raw).toMatchObject({ view: 'home', homeTab: 'wardrobe', wardrobeOpen: { tab: 'stats' } })
      expect(home(nav).html, raw).toContain('>Today</button>')
      expect(home(nav).tabs, raw).toEqual(['Outfit', 'Clothes', 'Stats*'])
    }
  })

  it('still lands ?view=wardrobe on today’s composer', () => {
    at10()
    const nav = walk([(_, link) => link('/?view=wardrobe')])
    expect(nav).toMatchObject({ view: 'home', homeTab: 'wardrobe', wardrobeOpen: null })
    const { html, tabs } = home(nav)
    expect(html).toContain('>Today</button>')
    expect(tabs).toEqual(['Outfit*', 'Clothes', 'Stats'])
    expect(html).toContain('Today · Mon 14 Sep')
  })

  it('opens Stats for that visit only: back on the day, opening the wardrobe lands on today’s composer', () => {
    at10()
    const nav = walk([
      (_, link) => link('/?view=wardrobe-stats'),
      // the Wardrobe took it and let it go, through the hand-off HomeScreen gives it
      n => propsOf(HomeScreen({ p: ctx(n) }), LazyWardrobe).onOpenConsumed(),
      // a tap on the Home tab is the day; the wardrobe is opened from there, not a peer tab
      n => n.goView('home'),
      n => n.openWardrobe(),
    ])
    expect(nav).toMatchObject({ view: 'home', homeTab: 'wardrobe', wardrobeOpen: {} })
    const { html, tabs } = home(nav)
    expect(html).toContain('>Today</button>')
    expect(tabs).toEqual(['Outfit*', 'Clothes', 'Stats'])
    expect(html).toContain('Today · Mon 14 Sep')
  })
})
