import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MealPicker } from '../components/MealPicker'
import { lastWentShort, visitIndex } from '../kitchen'
import { Meal, Place, Task } from '../types'

// The meal picker says when you last went to each place under Eat out, as it
// says when each recipe was last cooked: both are there to choose by.

const STAMP = '2026-01-01T00:00:00.000Z'
const now = new Date(2026, 8, 12, 12, 0) // Saturday 12 September 2026, local noon
const place = (id: string, name: string): Place => ({ kind: 'place', id, name, color: '#c0392b', category: 'restaurant', createdAt: STAMP, updatedAt: STAMP })
const grill = place('grill', 'Grill House')
const cafe = place('cafe', 'Corner Cafe')
const pizza = place('pizza', 'Pizza Place')
const coffee: Task = { kind: 'task', id: 't1', title: 'Coffee', description: '', status: 'done', priority: 'normal', tags: [], placeId: 'cafe', completedAt: new Date(2026, 8, 9, 10).toISOString(), createdAt: STAMP, updatedAt: STAMP }
const ateOut = (date: string, placeId: string, slot: Meal['slot'] = 'lunch'): Meal => ({ kind: 'meal', id: `meal~${date}~${slot}`, date, slot, out: true, placeId, title: 'Out', createdAt: STAMP, updatedAt: STAMP })
// React puts a marker between neighbouring text nodes; the words are what matter
const text = (html: string) => html.replace(/<!-- -->/g, '')

describe('when each place was last gone to', () => {
  const ix = visitIndex([grill, cafe, pizza], [coffee], [ateOut('2026-09-02', 'grill'), ateOut('2026-09-20', 'pizza')], now)

  it('counts a done task there and a meal eaten there, never one still to come', () => {
    expect(lastWentShort(ix, 'cafe')).toBe('3 days ago')
    expect(lastWentShort(ix, 'grill')).toBe('10 days ago')
    // the pizza lunch is next week: a plan, not a visit
    expect(lastWentShort(ix, 'pizza')).toBe('new')
  })

  it('says it beside each place under Eat out, and ticks the one chosen', () => {
    const html = text(
      renderToStaticMarkup(
        <MealPicker
          date="2026-09-12"
          slot="dinner"
          meal={ateOut('2026-09-12', 'grill', 'dinner')}
          recipes={[]}
          places={[grill, cafe, pizza]}
          visited={ix}
          onPick={() => {}}
          onCreatePlace={() => grill}
          onClose={() => {}}
        />,
      ),
    )
    // a meal out opens on Eat out
    expect(html).toContain('<span class="meal-pick-name">Corner Cafe</span><span class="meal-pick-when">went 3 days ago</span>')
    expect(html).toContain('<span class="meal-pick-name">Pizza Place</span><span class="meal-pick-when">never been</span>')
    expect(html).toMatch(/class="meal-pick-row on" aria-pressed="true">[^]*?Grill House/)
  })

  it('reads names only when no index is given', () => {
    const html = text(
      renderToStaticMarkup(<MealPicker date="2026-09-12" slot="dinner" meal={ateOut('2026-09-12', 'cafe', 'dinner')} recipes={[]} places={[cafe]} onPick={() => {}} onCreatePlace={() => cafe} onClose={() => {}} />),
    )
    expect(html).toContain('<span class="meal-pick-name">Corner Cafe</span><span class="meal-pick-when"></span>')
  })
})
