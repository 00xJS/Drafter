import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MealSlotRow } from '../components/MealSlotRow'
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

  it('says it beside each place in the picker, but not on the one chosen', () => {
    const html = text(
      renderToStaticMarkup(
        <MealSlotRow
          date="2026-09-12"
          slot="dinner"
          meal={ateOut('2026-09-12', 'grill', 'dinner')}
          recipes={[]}
          places={[grill, cafe, pizza]}
          visited={ix}
          onSave={() => {}}
          onClear={() => {}}
          onCreatePlace={() => grill}
        />,
      ),
    )
    expect(html).toContain('Corner Cafe · 3 days ago</option>')
    expect(html).toContain('Pizza Place · new</option>')
    // the closed picker is that night's dinner, so the chosen place reads its name alone
    expect(html).toContain('Grill House</option>')
  })

  it('reads names only when no index is given', () => {
    const html = text(renderToStaticMarkup(<MealSlotRow date="2026-09-12" slot="dinner" recipes={[]} places={[cafe]} onSave={() => {}} onClear={() => {}} onCreatePlace={() => cafe} />))
    expect(html).toContain('Corner Cafe</option>')
  })
})
