import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KitchenStats } from '../components/kitchen/KitchenStats'
import { PeopleStats } from '../components/PeopleStats'
import { PlacesStats } from '../components/PlacesStats'
import { ChartCard, Stepper } from '../components/stats'
import { WardrobeStats } from '../components/wardrobe/WardrobeStats'
import { NO_PERSON_FILTER } from '../people'
import { NO_PLACE_FILTER } from '../places'
import type { Person, Place } from '../types'
import { liveById, wearIndex } from '../wardrobe'
import { elements, settled, type El } from './rendered'

// ‹ year › on each Stats view's year card stops at this year: a year still to
// come has nothing in it yet. Next is off on this year and on again once you
// step back, and a press that reaches it anyway leaves the year where it is.
// Previous goes back as far as you like, as the month calendar's does.

const STAMP = '2026-01-01T00:00:00.000Z'
/** Monday 14 September 2026, local noon. */
const NOW = new Date(2026, 8, 14, 12, 0)
const TODAY = '2026-09-14'
const noop = () => {}
const html = (node: ReactNode) => renderToStaticMarkup(node as ReactElement).replace(/<!-- -->/g, '')

const mum: Person = { kind: 'person', id: 'mum', name: 'Mum', color: '#3b82f6', group: 'family', createdAt: STAMP, updatedAt: STAMP }
const cafe: Place = { kind: 'place', id: 'cafe', name: 'Café Nero', color: '#0369a1', category: 'cafe', createdAt: STAMP, updatedAt: STAMP }

type Act = (tree: ReactNode) => void
/** Each view, handed the clock and as little as draws its year card, and that card's title. */
const VIEWS: { name: string; card: string; draw(act?: Act): ReactNode }[] = [
  {
    name: 'People',
    card: 'The year with people',
    draw: act => settled(PeopleStats, { people: [mum], tasks: [], filter: NO_PERSON_FILTER, onFilter: noop, onSaw: noop, onOpenPerson: noop, onOpenDay: noop, now: NOW }, act),
  },
  {
    name: 'Places',
    card: 'The year in places',
    draw: act => settled(PlacesStats, { places: [cafe], people: [], tasks: [], meals: [], filter: NO_PLACE_FILTER, onFilter: noop, onOpenPlace: noop, onPlan: noop, onOpenPerson: noop, onOpenDay: noop, now: NOW }, act),
  },
  {
    name: 'Wardrobe',
    card: 'Wears by month',
    draw: act => settled(WardrobeStats, { garments: [], outfits: [], byId: liveById([]), ix: wearIndex([], TODAY), onOpenPiece: noop, onRetire: noop, onSaveOutfit: noop, now: NOW }, act),
  },
  {
    name: 'Kitchen',
    card: 'Meals by month',
    draw: act => settled(KitchenStats, { recipes: [], meals: [], groceries: [], places: [], onOpenRecipe: noop, onGoDay: noop, now: NOW }, act),
  },
]

/** What the stepper at the head of a view's year card was handed. */
function yearStepper(tree: ReactNode, card: string) {
  const head = elements(tree).find(e => e.type === ChartCard && e.props.title === card)
  if (!head) throw new Error(`no ${card} card`)
  const aside = head.props.aside as El
  expect(aside.type).toBe(Stepper)
  return aside.props as { label: string; unit: string; canNext?: boolean; onStep(delta: -1 | 1): void }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe.each(VIEWS)('$name → Stats, ‹ year ›', ({ card, draw }) => {
  /** The view after its year stepper is pressed, once for each step, in one go. */
  const stepped = (...steps: (-1 | 1)[]) =>
    draw(tree => {
      const { onStep } = yearStepper(tree, card)
      for (const d of steps) onStep(d)
    })

  it('opens on this year with Next off', () => {
    const tree = draw()
    expect(yearStepper(tree, card)).toMatchObject({ label: '2026', unit: 'year', canNext: false })
    expect(html(tree)).toContain('<button type="button" class="seg on">2026</button><button type="button" class="seg" aria-label="Next year" disabled="">›</button>')
  })

  it('turns Next on once you step back, and steps back as far as you like', () => {
    const back = stepped(-1)
    expect(yearStepper(back, card)).toMatchObject({ label: '2025', canNext: true })
    expect(html(back)).toContain('<button type="button" class="seg on">2025</button><button type="button" class="seg" aria-label="Next year">›</button>')
    expect(yearStepper(stepped(-1, -1, -1, -1, -1, -1, -1, -1, -1, -1), card)).toMatchObject({ label: '2016', canNext: true })
  })

  it('leaves this year alone when Next is pressed on it, and never steps past it', () => {
    expect(yearStepper(stepped(1), card)).toMatchObject({ label: '2026', canNext: false })
    // back a year, then on twice: this year again, never next year
    expect(yearStepper(stepped(-1, 1, 1), card)).toMatchObject({ label: '2026', canNext: false })
  })
})
