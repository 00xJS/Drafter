import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Today } from '../components/Today'
import { WardrobeCard } from '../components/wardrobe/WardrobeCard'
import type { Garment, GarmentType, Outfit, Task, Wear } from '../types'

// Today's "What are you wearing?": when it shows at all, what it offers, the
// one line once today has a look, "Forgot yesterday?", and where it sits on
// Today — frozen when Today mounts, like the journal card's evening place.

const T0 = '2026-08-01T09:00:00.000Z'
const TODAY = '2026-09-14'
const noop = () => {}
const AT_NINE = new Date(2026, 8, 14, 9)
const AT_ONE = new Date(2026, 8, 14, 13)

function ago(n: number): string {
  const [y, m, d] = TODAY.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10)
}
const piece = (id: string, type: GarmentType, over: Partial<Garment> = {}): Garment => ({ kind: 'garment', id, name: id, type, createdAt: T0, updatedAt: T0, ...over })
let looks = 0
const look = (date: string, garmentIds: string[]): Wear => {
  looks++
  return { kind: 'wear', id: `wear~${date}~${String(looks).padStart(10, '0')}`, date, garmentIds, createdAt: `${date}T08:00:00.000Z`, updatedAt: `${date}T08:00:00.000Z` }
}
const outfit = (id: string, garmentIds: string[], name?: string): Outfit => ({ kind: 'outfit', id, name, garmentIds, createdAt: T0, updatedAt: T0 })

const wardrobe = [piece('tee', 'top'), piece('shirt', 'top'), piece('polo', 'top'), piece('jumper', 'top'), piece('jeans', 'bottom'), piece('chinos', 'bottom'), piece('dress', 'onepiece')]

const card = (over: Partial<ComponentProps<typeof WardrobeCard>> = {}) =>
  renderToStaticMarkup(<WardrobeCard garments={wardrobe} outfits={[]} wears={[]} dayKey={TODAY} onLog={noop} onOpen={noop} now={AT_NINE} {...over} />)
/** The one-tap chips, Pick… aside. */
const chips = (html: string) => html.match(/class="wardrobe-chip"/g)?.length ?? 0

describe('the Today card', () => {
  it('is not there until the wardrobe can dress you', () => {
    expect(card({ garments: [] })).toBe('')
    expect(card({ garments: [piece('tee', 'top')] })).toBe('')
    // a retired bottom is no bottom to wear
    expect(card({ garments: [piece('tee', 'top'), piece('jeans', 'bottom', { archivedAt: T0 })] })).toBe('')
    expect(card({ garments: [piece('dress', 'onepiece')] })).toContain('What are you wearing?')
  })

  it('offers at most three looks you wear, then Pick…', () => {
    const wears = [look(ago(1), ['tee', 'jeans']), look(ago(2), ['shirt', 'chinos']), look(ago(3), ['polo', 'jeans']), look(ago(4), ['jumper', 'chinos']), look(ago(5), ['dress'])]
    const html = card({ wears })
    expect(html).toContain('<h3>What are you wearing?</h3>')
    expect(html).toContain('Tap one to log it, or pick')
    expect(chips(html)).toBe(3)
    expect(html).toContain('>Pick…</button>')
    expect(html).toContain('tee + jeans')
  })

  it('offers a saved outfit by its name to a wardrobe with nothing logged yet', () => {
    const html = card({ outfits: [outfit('o1', ['shirt', 'chinos'], 'Friday smart')] })
    expect(chips(html)).toBe(1)
    expect(html).toContain('>Friday smart</span>')
    expect(html).toContain('title="A saved outfit"')
    // and with nothing saved or worn, Pick… alone
    expect(chips(card())).toBe(0)
    expect(card()).toContain('>Pick…</button>')
  })

  it('is one line with Change once today has a look', () => {
    const html = card({ wears: [look(ago(1), ['shirt', 'chinos']), look(TODAY, ['tee', 'jeans'])] })
    expect(html).toContain('class="chart-card wardrobe-card logged"')
    expect(html).toContain('tee + jeans')
    expect(html).toContain('>Change</button>')
    expect(html).not.toContain('What are you wearing?')
    expect(chips(html)).toBe(0)
  })

  it('asks "Forgot yesterday?" before noon only, when yesterday is empty and an earlier day is not', () => {
    const earlier = [look(ago(2), ['tee', 'jeans'])]
    expect(card({ wears: earlier, now: AT_NINE })).toContain('>Forgot yesterday? Log it</button>')
    expect(card({ wears: earlier, now: AT_ONE })).not.toContain('Forgot yesterday?')
    expect(card({ wears: [], now: AT_NINE })).not.toContain('Forgot yesterday?')
    expect(card({ wears: [...earlier, look(ago(1), ['shirt', 'chinos'])], now: AT_NINE })).not.toContain('Forgot yesterday?')
  })
})

describe('where the card sits on Today', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const task = (id: string, over: Partial<Task> = {}): Task => ({ kind: 'task', id, title: `Task ${id}`, description: '', status: 'todo', priority: 'normal', tags: [], createdAt: T0, updatedAt: T0, ...over })

  function today(hour: number, withWardrobe = true, tasks?: Task[], garments = wardrobe) {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 14, hour))
    // the journal card asks the viewport how wide it is; a static render has none
    if (typeof window === 'undefined') vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) })
    const focus = tasks ?? [task('garage', { title: 'Sort the garage', focusOn: TODAY, focusBy: 'me' })]
    const props: ComponentProps<typeof Today> = {
      tasks: focus,
      allTasks: focus,
      people: [],
      places: [],
      reviews: [],
      onPlanWith: noop,
      onWentTo: noop,
      onPlanAt: noop,
      onPlanOccasion: noop,
      onSaw: noop,
      onSaveReview: noop,
      projects: [],
      events: [],
      sourceMap: new Map(),
      onPlan: noop,
      onOpen: noop,
      onStatus: noop,
      onDefer: noop,
      onDeferAll: noop,
      onNew: noop,
      meals: [],
      recipes: [],
      onOpenKitchen: noop,
      onOpenReview: noop,
      onCookRecipe: noop,
      journal: [],
      onSaveJournal: noop,
      onDeleteJournal: noop,
      onOpenJournal: noop,
      habits: [],
      onSaveHabit: noop,
      onDeleteHabit: noop,
      routines: [],
      onSaveRoutine: noop,
      onDeleteRoutine: noop,
      myId: 'me',
      ...(withWardrobe ? { garments, outfits: [], wears: [], onLogWear: noop, onOpenWardrobe: noop } : {}),
    }
    return renderToStaticMarkup(<Today {...props} />)
  }

  it('leaves Today as it was when the shell passes no wardrobe', () => {
    const html = today(9, false)
    expect(html).toContain('id="today-focus"')
    expect(html).not.toContain('wardrobe-card')
  })

  it('sits straight under the focus card in the morning', () => {
    const html = today(9)
    const focus = html.indexOf('id="today-focus"')
    const at = html.indexOf('wardrobe-card')
    expect(focus).toBeGreaterThan(-1)
    expect(at).toBeGreaterThan(focus)
    expect(at).toBeLessThan(html.indexOf('class="kpi-row"'))
  })

  it('sits just above the habits after noon', () => {
    const html = today(13)
    const at = html.indexOf('wardrobe-card')
    const habits = html.indexOf('habits-card')
    expect(at).toBeGreaterThan(html.indexOf('class="kpi-row"'))
    expect(at).toBeLessThan(habits)
    // nothing between the two but the habits card's own opening tag
    expect(html.slice(at, habits).match(/<section/g)).toHaveLength(1)
  })

  it('shows the card instead of the welcome when there are no tasks yet but the wardrobe can dress you', () => {
    const html = today(9, true, [])
    expect(html).toContain('What are you wearing?')
    expect(html).not.toContain('Welcome to your planner')
    // a wardrobe that cannot dress you yet leaves the welcome as it was
    const bare = today(9, true, [], [piece('tee', 'top')])
    expect(bare).toContain('Welcome to your planner')
    expect(bare).not.toContain('wardrobe-card')
  })
})
