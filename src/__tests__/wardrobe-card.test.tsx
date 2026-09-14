import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Today } from '../components/Today'
import { WardrobeCard } from '../components/wardrobe/WardrobeCard'
import type { Garment, GarmentType, Outfit, Task, Wear } from '../types'
import type { Forecast } from '../weather'
import { button, press, settled } from './rendered'
import { plannerSource } from './source'

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

type CardProps = ComponentProps<typeof WardrobeCard>
const cardProps = (over: Partial<CardProps> = {}): CardProps => ({ garments: wardrobe, outfits: [], wears: [], dayKey: TODAY, onLog: noop, onOpen: noop, now: AT_NINE, forecast: null, ...over })
const card = (over: Partial<CardProps> = {}) => renderToStaticMarkup(<WardrobeCard {...cardProps(over)} />)
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

describe('a look planned for today', () => {
  const planned = (date: string, ids: string[], over: Partial<Wear> = {}): Wear => ({ ...look(date, ids), planned: true, ...over })

  it('shows the plan with one tap to say it was worn, instead of the chips', () => {
    const html = card({ wears: [look(ago(1), ['tee', 'jeans']), planned(TODAY, ['shirt', 'chinos'])] })
    expect(html).toContain('class="chart-card wardrobe-card logged planned"')
    expect(html).toContain('<span class="muted">Planned:</span> shirt + chinos')
    expect(html).toContain('<button type="button" class="btn primary">Wore it</button>')
    expect(html).toContain('>Change</button>')
    expect(chips(html)).toBe(0)
    expect(html).not.toContain('What are you wearing?')
  })

  it('gives way to a look worn today, and a plan for tomorrow is not today’s', () => {
    expect(card({ wears: [planned(TODAY, ['shirt', 'chinos']), look(TODAY, ['tee', 'jeans'])] })).toContain('<span class="muted">Wearing</span> tee + jeans')
    expect(card({ wears: [planned(ago(-1), ['shirt', 'chinos'])] })).toContain('What are you wearing?')
  })

  it('asks "Forgot yesterday?" when yesterday was only planned', () => {
    expect(card({ wears: [planned(ago(1), ['tee', 'jeans']), look(ago(2), ['shirt', 'chinos'])], now: AT_NINE })).toContain('Forgot yesterday? Log it')
  })

  it('says the plan was worn with the one tap: the same look, a plan no longer, stamped newer, with the plan kept for Undo', () => {
    const plan = planned(TODAY, ['shirt', 'chinos'])
    const onLog = vi.fn<CardProps['onLog']>()
    press(settled(WardrobeCard, cardProps({ wears: [plan], onLog })), 'Wore it')
    expect(onLog).toHaveBeenCalledTimes(1)
    const [worn, opts] = onLog.mock.calls[0]
    expect(worn).toMatchObject({ id: plan.id, date: TODAY, garmentIds: ['shirt', 'chinos'] })
    expect('planned' in worn).toBe(false)
    expect(worn.updatedAt > plan.updatedAt).toBe(true)
    expect(opts).toEqual({ before: plan })
  })

  it('still asks "Forgot yesterday?" in the morning when today is planned', () => {
    const wears = [planned(TODAY, ['shirt', 'chinos']), look(ago(2), ['tee', 'jeans'])]
    expect(card({ wears, now: AT_NINE })).toContain('>Forgot yesterday? Log it</button>')
    expect(card({ wears, now: AT_ONE })).not.toContain('Forgot yesterday?')
    const onOpen = vi.fn<CardProps['onOpen']>()
    press(settled(WardrobeCard, cardProps({ wears, onOpen })), 'Forgot yesterday? Log it')
    expect(onOpen).toHaveBeenCalledWith({ date: ago(1) })
  })

  it('shows a note under the look, or a way to add one', () => {
    const noted = card({ wears: [{ ...look(TODAY, ['tee', 'jeans']), note: 'wedding' }] })
    expect(noted).toContain('class="wardrobe-card-note has-note"')
    expect(noted).toContain('>wedding</button>')
    expect(card({ wears: [look(TODAY, ['tee', 'jeans'])] })).toContain('>+ Note</button>')
    expect(card({ wears: [planned(TODAY, ['shirt', 'chinos'], { note: 'interview' })] })).toContain('>interview</button>')
  })
})

describe('the weather on the card', () => {
  const COLD: Forecast = { tempC: 6, hiC: 9, loC: 3, rainPct: 20, code: 3, unit: '°C' }
  const MILD: Forecast = { tempC: 17, hiC: 20, loC: 11, rainPct: 10, code: 1, unit: '°C' }
  const withMac = [...wardrobe, piece('mac', 'outerwear', { name: 'Mac' })]

  it('offers the coat when today is cold or wet, as a choice the chips then take', () => {
    const html = card({ garments: withMac, forecast: COLD, wears: [look(ago(1), ['tee', 'jeans'])] })
    expect(html).toContain('Cold today · 9° at most')
    expect(html).toContain('<button type="button" aria-pressed="false" class="toggle">+ Mac</button>')
    // until it is asked for, the chips log the look as it was worn
    expect(html).not.toContain('collage-badge outer')
  })

  it('puts the coat on the one-tap looks once it is asked for, and not before', () => {
    const onLog = vi.fn<CardProps['onLog']>()
    const props = cardProps({ garments: withMac, forecast: COLD, wears: [look(ago(1), ['tee', 'jeans'])], onLog })
    press(settled(WardrobeCard, props), 'tee + jeans')
    expect(onLog.mock.lastCall?.[0].garmentIds).toEqual(['tee', 'jeans'])
    const asked = settled(WardrobeCard, props, t => press(t, '+ Mac'))
    expect(button(asked, '+ Mac').props['aria-pressed']).toBe(true)
    press(asked, 'tee + jeans')
    expect(onLog.mock.lastCall?.[0].garmentIds).toEqual(['tee', 'jeans', 'mac'])
  })

  it('offers no coat with no one-tap look to put it on: Pick… opens Outfit, which offers it there', () => {
    const html = card({ garments: withMac, forecast: COLD })
    expect(chips(html)).toBe(0)
    expect(html).not.toContain('wardrobe-weather')
    expect(html).toContain('>Pick…</button>')
  })

  it('says nothing on a mild dry day, with no forecast, or with no outerwear', () => {
    expect(card({ garments: withMac, forecast: MILD })).not.toContain('wardrobe-weather')
    expect(card({ garments: withMac, forecast: null })).not.toContain('wardrobe-weather')
    expect(card({ garments: wardrobe, forecast: COLD })).not.toContain('wardrobe-weather')
  })

  it('offers to add the coat to a plan without one; once dressed it keeps quiet', () => {
    const plan: Wear = { ...look(TODAY, ['tee', 'jeans']), planned: true }
    expect(card({ garments: withMac, forecast: COLD, wears: [plan] })).toContain('>Add Mac</button>')
    expect(card({ garments: withMac, forecast: COLD, wears: [{ ...plan, garmentIds: ['tee', 'jeans', 'mac'] }] })).not.toContain('Add Mac')
    expect(card({ garments: withMac, forecast: COLD, wears: [look(TODAY, ['tee', 'jeans'])] })).not.toContain('wardrobe-weather')
  })
})

describe('the shell behind the card', () => {
  it('undoes an edit by writing the look back, stamped newer, and a new look by removing it', () => {
    const shell = plannerSource()
    expect(shell).toContain("onLogWear={(w, { before, msg = 'Logged for today' } = {}) => {")
    expect(shell).toContain('before ? store.upsert({ ...before, updatedAt: newerStamp(w.updatedAt) }) : store.remove(w.id)')
  })
})
