import { describe, expect, it } from 'vitest'
import { buildGroceryList, groceriesForMealDates, ingredientKey, mealId, mealsByDay, mergeIngredients } from '../kitchen'
import { Meal, Recipe } from '../types'
import { weekRange } from '../review'
import { dateKey } from '../utils'
import { weekDayKeys, weekKeyOf, weekStartKey } from '../../shared/weeks.mjs'
import { mealsInWeekOf, tonightLine } from '../../shared/kitchen.mjs'

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

describe('shared week keys', () => {
  it('agree with weekRange for ordinary dates', () => {
    for (const [y, m, d] of [[2026, 8, 8], [2026, 0, 1], [2026, 11, 31], [2027, 2, 28], [2025, 9, 26]]) {
      const local = weekRange(new Date(y, m, d, 12))
      const key = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      expect(weekKeyOf(key)).toBe(local.key)
      expect(weekStartKey(key)).toBe(dateKey(local.start))
    }
  })

  it('never gives two consecutive weeks the same key in a year that starts on a Sunday', () => {
    // 2034-01-01 is a Sunday; with millisecond maths the summer keys collided
    const keys = new Set<string>()
    for (let i = 0; i < 52; i++) {
      const d = new Date(Date.UTC(2034, 0, 1) + i * 7 * 86_400_000).toISOString().slice(0, 10)
      const k = weekKeyOf(d)!
      expect(keys.has(k)).toBe(false)
      keys.add(k)
    }
    expect(weekDayKeys('2026-09-10')).toEqual(['2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12'])
  })

  it('mealsInWeekOf and tonightLine follow the same week and day', () => {
    const meal = (date: string, slot: Meal['slot'], title: string): Meal => ({ kind: 'meal', id: mealId(date, slot), date, slot, title, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    const meals = [meal('2026-09-06', 'dinner', 'Sunday roast'), meal('2026-09-12', 'lunch', 'Soup'), meal('2026-09-13', 'dinner', 'Next week')]
    expect(mealsInWeekOf(meals, '2026-09-09').map(m => m.title)).toEqual(['Sunday roast', 'Soup'])
    expect(tonightLine(meals, [], '2026-09-06')).toBe('Tonight: Sunday roast')
    expect(tonightLine(meals, [], '2026-09-07')).toBeNull()
  })
})

describe('tonightLine is dinner only', () => {
  it('ignores a lunch-only day', () => {
    const lunch: Meal = { kind: 'meal', id: mealId('2026-09-08', 'lunch'), date: '2026-09-08', slot: 'lunch', title: 'Soup', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
    expect(tonightLine([lunch], [], '2026-09-08')).toBeNull()
  })
})

describe('day keys and week helpers', () => {
  it('isDayKey refuses impossible dates and shapes', async () => {
    const { isDayKey } = await import('../../shared/weeks.mjs')
    expect(isDayKey('2026-09-08')).toBe(true)
    expect(isDayKey('2024-02-29')).toBe(true)
    expect(isDayKey('2026-02-30')).toBe(false)
    expect(isDayKey('2026-13-01')).toBe(false)
    expect(isDayKey('20260908')).toBe(false)
    expect(isDayKey('')).toBe(false)
  })

  it('dinnerOn and groceryWeekFor follow the day and its Sunday-start week', async () => {
    const { dinnerOn, groceryWeekFor } = await import('../../shared/kitchen.mjs')
    const meal = (date: string, slot: Meal['slot'], title: string): Meal => ({ kind: 'meal', id: mealId(date, slot), date, slot, title, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    const meals = [meal('2026-09-08', 'lunch', 'Soup'), meal('2026-09-08', 'dinner', 'Pasta'), meal('2026-09-09', 'dinner', 'Curry')]
    expect(dinnerOn(meals, '2026-09-08')?.title).toBe('Pasta')
    expect(dinnerOn([meal('2026-09-08', 'lunch', 'Soup')], '2026-09-08')?.title).toBe('Soup')
    expect(dinnerOn(meals, '2026-09-10')).toBeNull()
    expect(groceryWeekFor('2026-09-08')).toBe(weekRange(new Date(2026, 8, 8, 12)).key)
  })
})
