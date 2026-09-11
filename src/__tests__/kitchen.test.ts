import { describe, expect, it } from 'vitest'
import {
  mealWrites,
  COOK_STEPS_TTL_MS,
  buildGroceryList,
  cookStepsRecipeId,
  groceriesForMealDates,
  heldGroceryLines,
  ingredientKey,
  mealId,
  mealsByDay,
  mergeIngredients,
  parseCookSteps,
  serialiseCookSteps,
  visibleGroceryLines,
} from '../kitchen'
import { GroceryLine, GroceryList, Meal, Recipe } from '../types'
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
  it('buckets by YYYY-MM-DD and orders the day breakfast, lunch, dinner', () => {
    // not alphabetically — that put dinner above lunch on the calendar
    const map = mealsByDay([
      { kind: 'meal', id: 'b', date: '2026-09-08', slot: 'dinner', title: 'Pizza', createdAt: '', updatedAt: '' },
      { kind: 'meal', id: 'a', date: '2026-09-08', slot: 'lunch', title: 'Soup', createdAt: '', updatedAt: '' },
      { kind: 'meal', id: 'c', date: '2026-09-08', slot: 'breakfast', title: 'Eggs', createdAt: '', updatedAt: '' },
    ])
    expect(map.get('2026-09-08')?.map(m => m.slot)).toEqual(['breakfast', 'lunch', 'dinner'])
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

describe('a ticked grocery line stays where it was', () => {
  const line = (id: string, state: GroceryLine['state']): GroceryLine => ({ id, name: id, state, recipeIds: [] })
  const items = [line('onion', 'need'), line('cheese', 'need'), line('milk', 'have'), line('bread', 'done')]

  it('shows only the filter when nothing has been ticked yet', () => {
    expect(visibleGroceryLines(items, 'need', new Set()).map(i => i.id)).toEqual(['onion', 'cheese'])
    expect(heldGroceryLines(items, 'need', new Set())).toEqual([])
  })

  it('keeps a line that was just ticked, in its original position', () => {
    // 'onion' is now done, so the plain filter would drop it and pull 'cheese'
    // up under the thumb that just tapped
    const after = [line('onion', 'done'), line('cheese', 'need'), line('milk', 'have'), line('bread', 'done')]
    const ticked = new Set(['onion'])
    expect(visibleGroceryLines(after, 'need', ticked).map(i => i.id)).toEqual(['onion', 'cheese'])
    // and it renders struck through, which is what makes it the undo
    expect(visibleGroceryLines(after, 'need', ticked)[0].state).toBe('done')
  })

  it('does not drag an unrelated ticked line into a filter it never matched', () => {
    // 'bread' was done before the shop started; ticking it does not make it a
    // "need" line, it only keeps it visible where it already was
    const ticked = new Set(['bread'])
    expect(visibleGroceryLines(items, 'need', ticked).map(i => i.id)).toEqual(['onion', 'cheese', 'bread'])
    expect(heldGroceryLines(items, 'need', ticked).map(i => i.id)).toEqual(['bread'])
  })

  it('counts only the held lines for Clear ticked, and holds nothing under All', () => {
    const after = [line('onion', 'done'), line('cheese', 'need'), line('milk', 'have'), line('bread', 'done')]
    const ticked = new Set(['onion', 'cheese'])
    // 'cheese' was tapped back to need, so only 'onion' is held on screen
    expect(heldGroceryLines(after, 'need', ticked).map(i => i.id)).toEqual(['onion'])
    expect(visibleGroceryLines(after, 'all', ticked)).toEqual(after)
    expect(heldGroceryLines(after, 'all', ticked)).toEqual([])
  })
})

describe('cook mode remembers its ticked steps across a kill', () => {
  const now = Date.UTC(2026, 8, 8, 19, 0, 0)

  it('round-trips the ticked steps for the recipe being cooked', () => {
    const raw = serialiseCookSteps('pasta', { 0: true, 2: true, 1: false }, now, 4)
    expect(raw).not.toBeNull()
    expect(parseCookSteps(raw, 'pasta', now + 60_000, 4)).toEqual([0, 2])
  })

  it('clears the record once nothing is ticked', () => {
    expect(serialiseCookSteps('pasta', {}, now, 4)).toBeNull()
    expect(serialiseCookSteps('pasta', { 0: false }, now, 4)).toBeNull()
  })

  it('forgets the ticks when the steps themselves were edited', () => {
    // tick 1 and 3 of four, tap Edit, insert a step at the top, save: the ticks
    // would land on whatever now sits at those indexes, striking through work
    // that has not been done. A different step count is a different list.
    const raw = serialiseCookSteps('pasta', { 0: true, 2: true }, now, 4)
    expect(parseCookSteps(raw, 'pasta', now, 5)).toEqual([])
    expect(parseCookSteps(raw, 'pasta', now, 4)).toEqual([0, 2])
    // a record from before the fingerprint existed is not trusted either
    expect(parseCookSteps(JSON.stringify({ id: 'pasta', at: now, done: [0] }), 'pasta', now, 4)).toEqual([])
    // but it still names its recipe, so only that recipe may clear it
    expect(cookStepsRecipeId(raw)).toBe('pasta')
  })

  it('ignores another recipe, a stale night and junk', () => {
    const raw = serialiseCookSteps('pasta', { 0: true }, now, 4)
    expect(parseCookSteps(raw, 'curry', now, 4)).toEqual([])
    expect(parseCookSteps(raw, 'pasta', now + COOK_STEPS_TTL_MS + 1, 4)).toEqual([])
    // a phone whose clock stepped back a second must not lose the recipe
    expect(parseCookSteps(raw, 'pasta', now - 1_000, 4)).toEqual([0])
    expect(parseCookSteps('not json', 'pasta', now, 4)).toEqual([])
    expect(parseCookSteps(null, 'pasta', now, 4)).toEqual([])
    expect(parseCookSteps(JSON.stringify({ id: 'pasta', at: now, steps: 4, done: ['x', 1] }), 'pasta', now, 4)).toEqual([1])
  })

  it('names the recipe the record belongs to, so a side dish cannot wipe the main', () => {
    // the main is mid-cook; the side dish mounts with nothing ticked and must
    // not clear a record that is not its own
    const raw = serialiseCookSteps('pasta', { 0: true }, now, 4)
    expect(cookStepsRecipeId(raw)).toBe('pasta')
    expect(cookStepsRecipeId(raw) === 'garlic-bread').toBe(false)
    // the TTL is parseCookSteps' business: a stale record still belongs to the
    // recipe that wrote it, and clearing it is still that recipe's call
    expect(cookStepsRecipeId(JSON.stringify({ id: 'pasta', at: now - COOK_STEPS_TTL_MS * 2, done: [0] }))).toBe('pasta')
    expect(cookStepsRecipeId(null)).toBeNull()
    expect(cookStepsRecipeId('not json')).toBeNull()
    expect(cookStepsRecipeId(JSON.stringify({ at: now }))).toBeNull()
    expect(cookStepsRecipeId(JSON.stringify(['pasta']))).toBeNull()
  })
})

describe('a bought meal is planned like any other, but shops and cooks like none', () => {
  const out = (over: Partial<Meal> = {}): Meal => ({
    kind: 'meal',
    id: 'm1',
    date: '2026-09-09',
    slot: 'dinner',
    out: true,
    placeId: 'pl1',
    title: 'Curry house',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  })
  const pasta = recipe({
    id: 'r1',
    name: 'Pasta',
    ingredients: [{ id: 'i1', name: 'Spaghetti', qty: 500, unit: 'g' }],
  })

  it('contributes nothing to the grocery list', () => {
    const list = buildGroceryList('2026-W37', [out()], [pasta], null, '2026-09-01T00:00:00.000Z')
    expect(list.items).toEqual([])
  })

  it('does not hide a cooked meal on another day of the same week', () => {
    const cooked: Meal = { ...out({ id: 'm2', date: '2026-09-10' }), out: undefined, placeId: undefined, recipeId: 'r1', title: 'Pasta' }
    const list = buildGroceryList('2026-W37', [out(), cooked], [pasta], null, '2026-09-01T00:00:00.000Z')
    expect(list.items.map(l => l.name)).toContain('Spaghetti')
  })

  it('reads as where it is coming from, not as a recipe', () => {
    expect(tonightLine([out()], [pasta], '2026-09-09')).toBe('Tonight: out — Curry house')
  })

  it('says just "out" when no place was named', () => {
    expect(tonightLine([out({ placeId: undefined, title: 'Eating out' })], [], '2026-09-09')).toBe('Tonight: out')
  })

  it('still ignores a day with only lunch planned', () => {
    expect(tonightLine([out({ slot: 'lunch' })], [], '2026-09-09')).toBeNull()
  })
})

describe('mealWrites: planning a meal always writes its grocery list too', () => {
  const pasta = recipe({ id: 'r1', name: 'Pasta', ingredients: [{ id: 'i1', name: 'Spaghetti', qty: 500, unit: 'g' }] })
  const meal = (over: Partial<Meal> = {}): Meal => ({
    kind: 'meal',
    id: 'meal~2026-09-09~dinner',
    date: '2026-09-09',
    slot: 'dinner',
    recipeId: 'r1',
    title: 'Pasta',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  })

  it('returns the meal and a rebuilt list, never the meal alone', () => {
    const rows = mealWrites(meal(), null, [], [pasta], [])
    expect(rows.map(r => r.kind)).toEqual(['meal', 'grocery'])
    const list = rows.find(r => r.kind === 'grocery') as GroceryList
    expect(list.items.map(i => i.name)).toEqual(['Spaghetti'])
  })

  it('rebuilds the list when a meal is cleared, so the shop list empties', () => {
    const existing = meal()
    const rows = mealWrites(null, existing.id, [existing], [pasta], [])
    expect(rows.map(r => r.kind)).toEqual(['grocery'])
    expect((rows[0] as GroceryList).items).toEqual([])
  })

  it('a bought meal writes a list with nothing in it', () => {
    const rows = mealWrites(meal({ recipeId: undefined, out: true, placeId: 'pl1', title: 'Nopi' }), null, [], [pasta], [])
    const list = rows.find(r => r.kind === 'grocery') as GroceryList
    expect(list.items).toEqual([])
  })

  it('clearing an id that is not there is a no-op rather than a throw', () => {
    expect(mealWrites(null, 'nope', [], [pasta], [])).toEqual([])
  })
})
