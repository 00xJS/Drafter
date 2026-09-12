import { describe, expect, it } from 'vitest'
import { mealIdeasFor } from '../../shared/weekplan.mjs'

// Today's meal ideas: when lunch or dinner has nothing planned, a few ideas to
// get the day's plans going — what is popular, and old favourites not had for
// longest. They read the same cooking history the week plan ranks dinners by.

const DAY = '2026-09-16' // a Wednesday
const now = new Date('2026-09-16T07:00:00.000Z')
const STAMP = '2026-01-01T00:00:00.000Z'
type Row = Record<string, unknown>

const recipe = (id: string, over: Row = {}): Row => ({ kind: 'recipe', id, name: id, ingredients: [], tags: [], createdAt: STAMP, updatedAt: STAMP, ...over })
const meal = (date: string, slot: string, over: Row = {}): Row => ({ kind: 'meal', id: `meal~${date}~${slot}~${String(over.recipeId ?? over.placeId ?? 'x')}`, date, slot, title: 'Meal', createdAt: STAMP, updatedAt: STAMP, ...over })
const cooked = (recipeId: string, slot: string, ...dates: string[]) => dates.map(d => meal(d, slot, { recipeId }))
const ateAt = (placeId: string, slot: string, ...dates: string[]) => dates.map(d => meal(d, slot, { out: true, placeId }))
const place = (id: string, category: string): Row => ({ kind: 'place', id, name: id, color: '#fff', category, createdAt: STAMP, updatedAt: STAMP })
const outing = (id: string, placeId: string, completedAt: string): Row => ({ kind: 'task', id, title: id, description: '', status: 'done', priority: 'normal', completedAt, placeId, tags: [], createdAt: STAMP, updatedAt: STAMP })

function items(): Row[] {
  return [
    recipe('pasta'),
    ...cooked('pasta', 'dinner', '2026-09-01', '2026-08-25', '2026-08-18', '2026-08-11', '2026-08-04', '2026-07-28'),
    recipe('curry'),
    ...cooked('curry', 'dinner', '2026-08-20', '2026-07-10', '2026-06-05'),
    recipe('soup', { tags: ['Quick'] }),
    ...cooked('soup', 'lunch', '2026-06-01', '2026-05-01'),
    recipe('stew'),
    ...cooked('stew', 'dinner', '2025-11-01', '2025-10-01'),
    recipe('toast'),
    ...cooked('toast', 'lunch', '2026-09-15'),
    recipe('risotto'),
    ...cooked('risotto', 'dinner', '2026-05-05', '2026-09-19'),
    recipe('fresh'),
    place('nopi', 'restaurant'),
    outing('o1', 'nopi', '2026-05-03T19:00:00.000Z'),
    ...ateAt('nopi', 'dinner', '2026-04-10', '2026-03-01'),
    place('pret', 'cafe'),
    ...ateAt('pret', 'lunch', '2026-09-02', '2026-08-26', '2026-08-19', '2026-08-12'),
    place('park', 'outdoors'),
    outing('o2', 'park', '2026-08-01T12:00:00.000Z'),
    outing('o3', 'park', '2026-07-01T12:00:00.000Z'),
    place('burger', 'fastfood'),
    ...ateAt('burger', 'lunch', '2026-09-12'),
    place('newplace', 'restaurant'),
    meal(DAY, 'breakfast', { title: 'Porridge' }),
  ]
}

const ideas = (list: Row[], o: { slots?: ('breakfast' | 'lunch' | 'dinner')[]; dismissed?: string[] } = {}) => mealIdeasFor(list, { dayKey: DAY, now, tz: 'UTC', ...o })
const show = (slot: { ideas: { kind: string; id: string; why: string }[] }) => slot.ideas.map(i => [i.kind, i.id, i.why])

describe('mealIdeasFor', () => {
  it('alternates popular and longest-ago for lunch, leaning to cafés and quick recipes', () => {
    const [lunch] = ideas(items())
    expect(lunch.slot).toBe('lunch')
    expect(lunch.missing).toBe(true)
    expect(show(lunch)).toEqual([
      ['place', 'pret', 'Been 4× in six months'],
      ['recipe', 'soup', 'Not cooked in 4 months'],
      ['recipe', 'pasta', 'Cooked 6× in six months'],
      ['recipe', 'stew', 'Not cooked in 11 months'],
    ])
  })

  it('never offers dinner what lunch already offered, and says when you last went', () => {
    const [lunch, dinner] = ideas(items())
    expect(dinner.slot).toBe('dinner')
    expect(show(dinner)).toEqual([
      ['recipe', 'curry', 'Cooked 3× in six months'],
      ['place', 'nopi', "Haven't been since 3 May"],
    ])
    const lunchIds = new Set(lunch.ideas.map(i => i.id))
    for (const i of dinner.ideas) expect(lunchIds.has(i.id)).toBe(false)
  })

  it('skips anything had in the last week, planned for the week ahead, never tried, or not somewhere you eat', () => {
    const all = ideas(items()).flatMap(s => s.ideas.map(i => i.id))
    for (const id of ['toast', 'burger', 'risotto', 'fresh', 'park', 'newplace']) expect(all).not.toContain(id)
  })

  it('has nothing to suggest for a slot that already has a meal, eaten out with no place included', () => {
    const [lunch, dinner] = ideas([...items(), meal(DAY, 'dinner', { out: true, title: 'Eating out' })])
    expect(dinner).toEqual({ slot: 'dinner', missing: false, ideas: [] })
    expect(lunch.ideas).toHaveLength(4)
  })

  it('fills in behind a dismissed idea', () => {
    const [lunch] = ideas(items(), { dismissed: [`idea:${DAY}:lunch:place:pret`] })
    expect(lunch.ideas.map(i => i.id)).toEqual(['soup', 'stew', 'pasta', 'nopi'])
    expect(lunch.ideas[0].key).toBe(`idea:${DAY}:lunch:recipe:soup`)
  })

  it('breaks ties by name, and is the same whatever order the records come in', () => {
    const twins = [recipe('zucchini'), ...cooked('zucchini', 'dinner', '2026-08-01', '2026-07-01'), recipe('aubergine'), ...cooked('aubergine', 'dinner', '2026-08-01', '2026-07-01')]
    expect(ideas(twins, { slots: ['dinner'] })[0].ideas.map(i => i.id)).toEqual(['aubergine', 'zucchini'])
    expect(ideas([...items()].reverse())).toEqual(ideas(items()))
  })

  it('returns nothing for a day that is not a day', () => {
    expect(mealIdeasFor(items(), { dayKey: '2026-02-30', now })).toEqual([])
  })
})
