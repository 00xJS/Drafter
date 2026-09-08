import { describe, expect, it } from 'vitest'
import { buildGroceryList, groceriesForMealDates, ingredientKey, mealId, mealsByDay, mergeIngredients } from '../kitchen'
import { Meal, Recipe } from '../types'

const recipe = (over: Partial<Recipe> & { id: string; name: string; ingredients: Recipe['ingredients'] }): Recipe => ({
  kind: 'recipe',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  tags: [],
  ...over,
})

describe('mergeIngredients', () => {
  it('adds quantities when the same ingredient and unit appear twice', () => {
    const a = recipe({
      id: 'pizza',
      name: 'Pizza',
      ingredients: [
        { id: '1', name: 'Onion', qty: 1, unit: 'ea' },
        { id: '2', name: 'Cheese', qty: 200, unit: 'g' },
      ],
    })
    const b = recipe({
      id: 'soup',
      name: 'Soup',
      ingredients: [{ id: '3', name: 'onion', qty: 2, unit: 'ea' }],
    })
    const merged = mergeIngredients([a, b])
    expect(merged.find(i => ingredientKey(i.name, i.unit) === ingredientKey('Onion', 'ea'))).toMatchObject({ qty: 3, unit: 'ea' })
    expect(merged.find(i => i.name === 'Cheese')?.qty).toBe(200)
  })

  it('keeps separate lines when the unit differs', () => {
    const r = recipe({
      id: 'r',
      name: 'Mix',
      ingredients: [
        { id: '1', name: 'Tomato', qty: 1, unit: 'can' },
        { id: '2', name: 'Tomato', qty: 2, unit: 'ea' },
      ],
    })
    expect(mergeIngredients([r])).toHaveLength(2)
  })
})

describe('buildGroceryList', () => {
  it('defaults new lines to need and preserves have/done on refresh', () => {
    const pasta = recipe({ id: 'pasta', name: 'Pasta', ingredients: [{ id: '1', name: 'Spaghetti', qty: 400, unit: 'g' }] })
    const meal: Meal = {
      kind: 'meal',
      id: mealId('2026-09-08', 'dinner'),
      date: '2026-09-08',
      slot: 'dinner',
      recipeId: 'pasta',
      title: 'Pasta',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const first = buildGroceryList('2026-W37', [meal], [pasta], null, '2026-09-07T12:00:00.000Z')
    expect(first.items[0]).toMatchObject({ name: 'Spaghetti', qty: 400, state: 'need' })
    const ticked = { ...first, items: first.items.map(i => ({ ...i, state: 'have' as const })) }
    const second = buildGroceryList('2026-W37', [meal], [pasta], ticked, '2026-09-07T13:00:00.000Z')
    expect(second.items[0].state).toBe('have')
  })

  it('keeps hand-added lines that recipes do not mention', () => {
    const pasta = recipe({ id: 'pasta', name: 'Pasta', ingredients: [{ id: '1', name: 'Spaghetti', qty: 400, unit: 'g' }] })
    const meal: Meal = {
      kind: 'meal',
      id: 'm1',
      date: '2026-09-08',
      slot: 'dinner',
      recipeId: 'pasta',
      title: 'Pasta',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const prev = buildGroceryList('2026-W37', [meal], [pasta], null)
    prev.items.push({ id: 'hand', name: 'Paper towels', state: 'need', recipeIds: [], manual: true })
    const next = buildGroceryList('2026-W37', [meal], [pasta], prev)
    expect(next.items.some(i => i.name === 'Paper towels' && i.manual)).toBe(true)
  })
})

describe('mealsByDay', () => {
  it('buckets by YYYY-MM-DD', () => {
    const map = mealsByDay([
      { kind: 'meal', id: 'a', date: '2026-09-08', slot: 'lunch', title: 'Soup', createdAt: '', updatedAt: '' },
      { kind: 'meal', id: 'b', date: '2026-09-08', slot: 'dinner', title: 'Pizza', createdAt: '', updatedAt: '' },
    ])
    expect(map.get('2026-09-08')?.map(m => m.slot)).toEqual(['dinner', 'lunch'])
  })
})

describe('groceriesForMealDates', () => {
  it('writes a grocery list for the week a dinner was planned so it can sync', () => {
    const pasta = recipe({ id: 'pasta', name: 'Pasta', ingredients: [{ id: '1', name: 'Spaghetti', qty: 400, unit: 'g' }] })
    const meal: Meal = {
      kind: 'meal',
      id: mealId('2026-09-08', 'dinner'),
      date: '2026-09-08',
      slot: 'dinner',
      recipeId: 'pasta',
      title: 'Pasta',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const lists = groceriesForMealDates([meal], [pasta], [], ['2026-09-08'], '2026-09-07T12:00:00.000Z')
    expect(lists).toHaveLength(1)
    expect(lists[0].kind).toBe('grocery')
    expect(lists[0].items[0]).toMatchObject({ name: 'Spaghetti', qty: 400, state: 'need' })
  })
})
