// @vitest-environment happy-dom
import { fireEvent, render, screen } from './dom'
import { describe, expect, it } from 'vitest'
import { SplitBar } from '../components/insights/Highlights'
import { KitchenStats } from '../components/kitchen/KitchenStats'
import { ReviewDays } from '../components/ReviewDays'
import { HeatGrid } from '../components/stats'
import type { Meal, Recipe } from '../types'

// A chart's figures were in its marks' titles and nowhere else: a pointer
// reads a title, and a phone has no pointer to rest on one, so on the phone
// the charts showed their shapes and none of their numbers. A tap on a mark
// says it in a line under the chart (useReadout), as the Journal's mood chart
// says a day under a scrub; the Highlights' split bar, inside a card that
// opens its area when tapped, prints its figures instead.

const readout = (within: HTMLElement = document.body) => within.querySelector('.chart-readout')?.textContent

describe('a year of days (HeatGrid)', () => {
  it('says a tapped day and its count under the grid, with a hint until then', () => {
    const { container } = render(<HeatGrid counts={new Map([['2026-09-22', 3]])} end={new Date(2026, 8, 25, 12)} weeks={4} label="Days with something done" noun="task" />)
    expect(readout(container)).toBe('Tap a day to read it')
    fireEvent.click(container.querySelector('[data-read^="Tue, Sep 22"]') as HTMLElement)
    expect(readout(container)).toBe('Tue, Sep 22: 3 tasks')
    fireEvent.click(container.querySelector('[data-read^="Mon, Sep 21"]') as HTMLElement)
    expect(readout(container)).toBe('Mon, Sep 21: 0 tasks')
    // a day still to come has nothing to say
    expect(container.querySelector('.heat-cell.ahead')?.hasAttribute('data-read')).toBe(false)
  })
})

describe('the Review’s Done ✓ strip', () => {
  it('says a tapped day and what was done on it', () => {
    const { container } = render(<ReviewDays counts={[0, 2, 1]} start={new Date(2026, 8, 20)} />)
    const bars = container.querySelectorAll('.review-day')
    expect(bars).toHaveLength(3)
    fireEvent.click(bars[1])
    expect(readout(container)).toBe('Mon, Sep 21: 2 done')
    // and a screen reader hears the days with anything done
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Done by day: Mon, Sep 21: 2 done, Tue, Sep 22: 1 done')
  })
})

describe('Kitchen → Stats, the year’s meals by month', () => {
  it('says a tapped month’s three figures under the chart', () => {
    const STAMP = '2026-01-01T00:00:00.000Z'
    const curry: Recipe = { kind: 'recipe', id: 'curry', name: 'Curry', ingredients: [], tags: [], createdAt: STAMP, updatedAt: STAMP }
    const meal = (date: string, over: Partial<Meal>): Meal => ({ kind: 'meal', id: `meal~${date}~dinner`, date, slot: 'dinner', title: 'Meal', createdAt: STAMP, updatedAt: STAMP, ...over })
    // a meal out with no place named is one bought, by the Kitchen's rules
    const meals = [meal('2026-09-02', { recipeId: 'curry', title: 'Curry' }), meal('2026-09-03', { recipeId: 'curry', title: 'Curry' }), meal('2026-09-04', { out: true, title: 'Tacos' })]
    const { container } = render(<KitchenStats recipes={[curry]} meals={meals} groceries={[]} places={[]} onOpenRecipe={() => {}} onGoDay={() => {}} now={new Date(2026, 8, 14, 18)} />)
    const chart = container.querySelector('.kitchen-month-bars') as HTMLElement
    expect(readout(chart)).toBe('Tap a month to read it')
    fireEvent.click(chart.querySelector('[data-read^="Sep"] rect') as Element)
    expect(readout(chart)).toBe('Sep: 2 cooked, 0 eaten out, 1 bought')
  })
})

describe('the Highlights’ split bar', () => {
  it('prints each way’s count under the bar, in its colour, leaving out a way with none', () => {
    const { container } = render(
      <SplitBar
        parts={[
          { key: 'cooked', label: 'Cooked', value: 12 },
          { key: 'out', label: 'Eaten out', value: 3 },
          { key: 'bought', label: 'Bought', value: 0 },
        ]}
      />,
    )
    const key = [...container.querySelectorAll('.split-key-part')]
    expect(key.map(k => k.textContent)).toEqual(['12', '3'])
    expect(key.map(k => k.querySelector('i')?.className)).toEqual(['split-cooked', 'split-out'])
  })
})
