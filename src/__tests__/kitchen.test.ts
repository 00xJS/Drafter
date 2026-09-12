import { describe, expect, it } from 'vitest'
import {
  mealWrites,
  COOK_STEPS_TTL_MS,
  activeGroceryLines,
  addGroceryItem,
  buildGroceryList,
  cookStepsRecipeId,
  groceriesForMealDates,
  groceryCounts,
  heldGroceryLines,
  ingredientKey,
  mealId,
  mealsByDay,
  mergeIngredients,
  parseCookSteps,
  removeGroceryLine,
  removedGroceryLines,
  restoreGroceryLine,
  serialiseCookSteps,
  visibleGroceryLines,
} from '../kitchen'
import { GroceryLine, GroceryList, Meal, Recipe } from '../types'
import { sanitizeGrocery } from '../schema'
import { weekRange } from '../review'
import { dateKey } from '../utils'
import { weekDayKeys, weekKeyOf, weekStartKey } from '../../shared/weeks.mjs'
import { mealsInWeekOf, tonightLine } from '../../shared/kitchen.mjs'
import { mergeRecord } from '../../shared/merge.mjs'

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

describe('a grocery line taken off the list', () => {
  const AT = '2026-09-07T12:00:00.000Z'
  const WEEK = '2026-W37'
  const pasta = recipe({
    id: 'pasta',
    name: 'Pasta',
    ingredients: [
      { id: '1', name: 'Spaghetti', qty: 400, unit: 'g' },
      { id: '2', name: 'Salt', qty: 1, unit: 'tsp' },
    ],
  })
  const soup = recipe({
    id: 'soup',
    name: 'Soup',
    ingredients: [
      { id: '3', name: 'salt', qty: 1, unit: 'tsp' },
      { id: '4', name: 'Leek', qty: 2 },
    ],
  })
  const dinner = (date: string, recipeId: string): Meal => ({
    kind: 'meal',
    id: mealId(date, 'dinner'),
    date,
    slot: 'dinner',
    recipeId,
    title: recipeId,
    createdAt: AT,
    updatedAt: AT,
  })
  const named = (list: GroceryList, name: string) => list.items.find(i => i.name.toLowerCase() === name.toLowerCase())
  const without = (list: GroceryList, name: string): GroceryList => ({
    ...list,
    items: list.items.map(i => (i.name.toLowerCase() === name.toLowerCase() ? removeGroceryLine(i) : i)),
  })
  const pastaWeek = () => buildGroceryList(WEEK, [dinner('2026-09-08', 'pasta')], [pasta, soup], null, AT)

  it('is a flag with the recipes that wanted it, and Restore puts it back exactly as it was', () => {
    const list = pastaWeek()
    const ticked = { ...list, items: list.items.map(i => (i.name === 'Salt' ? { ...i, state: 'have' as const } : i)) }
    const off = named(without(ticked, 'Salt'), 'Salt')!
    expect(off).toMatchObject({ removed: true, removedRecipeIds: ['pasta'], recipeIds: ['pasta'], state: 'have' })
    const back = restoreGroceryLine(off)
    expect(back).toEqual(named(ticked, 'Salt'))
    expect('removed' in back || 'removedRecipeIds' in back).toBe(false)
  })

  it('stays removed when the same plan is rebuilt', () => {
    const off = without(pastaWeek(), 'Salt')
    const again = buildGroceryList(WEEK, [dinner('2026-09-08', 'pasta')], [pasta, soup], off, '2026-09-07T13:00:00.000Z')
    expect(named(again, 'Salt')).toMatchObject({ id: named(off, 'Salt')!.id, removed: true, removedRecipeIds: ['pasta'] })
    expect(activeGroceryLines(again.items).map(i => i.name)).toEqual(['Spaghetti'])
  })

  it('stays removed when that dish is cleared and planned again, or moved to another night', () => {
    const off = without(pastaWeek(), 'Salt')
    // cleared: nothing wants salt now, but the line is kept, flag and all
    const cleared = buildGroceryList(WEEK, [], [pasta, soup], off, '2026-09-07T13:00:00.000Z')
    expect(cleared.items).toHaveLength(1)
    expect(cleared.items[0]).toMatchObject({ name: 'Salt', removed: true, recipeIds: [], removedRecipeIds: ['pasta'] })
    // planned again on Thursday: still the same recipe, so still off the list
    const moved = buildGroceryList(WEEK, [dinner('2026-09-10', 'pasta')], [pasta, soup], cleared, '2026-09-07T14:00:00.000Z')
    expect(named(moved, 'Salt')).toMatchObject({ removed: true, recipeIds: ['pasta'] })
    expect(activeGroceryLines(moved.items).map(i => i.name)).toEqual(['Spaghetti'])
  })

  it('comes back to Need, flag cleared, when a newly planned recipe needs it', () => {
    const off = without(pastaWeek(), 'Salt')
    const withSoup = buildGroceryList(WEEK, [dinner('2026-09-08', 'pasta'), dinner('2026-09-09', 'soup')], [pasta, soup], off, '2026-09-07T13:00:00.000Z')
    const salt = named(withSoup, 'Salt')!
    expect(salt).toMatchObject({ id: named(off, 'Salt')!.id, state: 'need', qty: 2, recipeIds: ['pasta', 'soup'] })
    expect(salt.removed).toBeUndefined()
    expect(salt.removedRecipeIds).toBeUndefined()
  })

  it('a removed hand-added line stays removed through rebuilds until it is restored', () => {
    const list = pastaWeek()
    list.items.push({ id: 'hand', name: 'Paper towels', state: 'need', recipeIds: [], manual: true })
    const off = without(list, 'Paper towels')
    const again = buildGroceryList(WEEK, [dinner('2026-09-08', 'pasta'), dinner('2026-09-09', 'soup')], [pasta, soup], off, '2026-09-07T13:00:00.000Z')
    expect(named(again, 'Paper towels')).toMatchObject({ id: 'hand', manual: true, removed: true })
    const restored = { ...again, items: again.items.map(i => (i.id === 'hand' ? restoreGroceryLine(i) : i)) }
    const later = buildGroceryList(WEEK, [dinner('2026-09-08', 'pasta')], [pasta, soup], restored, '2026-09-07T14:00:00.000Z')
    expect(named(later, 'Paper towels')).toEqual({ id: 'hand', name: 'Paper towels', state: 'need', recipeIds: [], manual: true })
  })

  it('restoring a line no planned recipe needs any more keeps it on the list as hand-added', () => {
    const cleared = buildGroceryList(WEEK, [], [pasta, soup], without(pastaWeek(), 'Salt'), '2026-09-07T13:00:00.000Z')
    const back = { ...cleared, items: cleared.items.map(restoreGroceryLine) }
    expect(back.items[0]).toMatchObject({ name: 'Salt', manual: true })
    // otherwise the next rebuild would drop it as a leftover nobody asked for
    expect(buildGroceryList(WEEK, [], [pasta, soup], back, '2026-09-07T14:00:00.000Z').items.map(i => i.name)).toEqual(['Salt'])
  })

  it('adding it by name restores that line instead of adding a second one', () => {
    const off = without(pastaWeek(), 'Salt')
    const id = () => 'new-id'
    // the add box has no unit: the name alone finds "1 tsp Salt"
    const typed = addGroceryItem(off.items, { name: '  SALT ' }, id)
    expect(typed.outcome).toBe('restored')
    expect(typed.items).toHaveLength(off.items.length)
    expect(typed.items.filter(i => ingredientKey(i.name) === ingredientKey('salt'))).toHaveLength(1)
    expect(typed.line).toMatchObject({ id: named(off, 'Salt')!.id, name: 'Salt', qty: 1, unit: 'tsp', state: 'need' })
    expect(typed.line.removed).toBeUndefined()
    // the MCP server's exact name + unit does the same; a quantity asked for now replaces the recipes' one
    const exact = addGroceryItem(off.items, { name: 'salt', qty: 2, unit: 'tsp' }, id)
    expect(exact).toMatchObject({ outcome: 'restored', line: { qty: 2, unit: 'tsp' } })
    expect(exact.items).toHaveLength(off.items.length)
  })

  it('adding a name that is already on the list sends that line back to Need, once', () => {
    const list = pastaWeek()
    const got = list.items.map(i => (i.name === 'Salt' ? { ...i, state: 'done' as const } : i))
    const again = addGroceryItem(got, { name: 'salt' }, () => 'x')
    expect(again).toMatchObject({ outcome: 'merged', line: { name: 'Salt', state: 'need', qty: 1 } })
    expect(again.items).toHaveLength(got.length)
    // a quantity in the same unit adds up
    expect(addGroceryItem(got, { name: 'Spaghetti', qty: 100, unit: 'g' }, () => 'x').line.qty).toBe(500)
    // a new name is a hand-added line
    const milk = addGroceryItem(got, { name: 'Milk' }, () => 'm1')
    expect(milk).toMatchObject({ outcome: 'added', line: { id: 'm1', name: 'Milk', state: 'need', recipeIds: [], manual: true } })
    expect(milk.items).toHaveLength(got.length + 1)
    // a different unit is a different line, whatever the name
    expect(addGroceryItem(got, { name: 'Salt', qty: 1, unit: 'kg' }, () => 'k').outcome).toBe('added')
  })

  it('is left out of the list, every count and Clear ticked, and listed under Removed', () => {
    const line = (id: string, state: GroceryLine['state'], removed = false): GroceryLine => ({ id, name: id, state, recipeIds: [], ...(removed ? { removed: true } : {}) })
    const items = [line('onion', 'need'), line('salt', 'need', true), line('milk', 'have'), line('oil', 'done', true)]
    expect(groceryCounts(items)).toEqual({ need: 1, have: 1, done: 0, all: 2 })
    expect(visibleGroceryLines(items, 'need', new Set()).map(i => i.id)).toEqual(['onion'])
    expect(visibleGroceryLines(items, 'all', new Set()).map(i => i.id)).toEqual(['onion', 'milk'])
    // ticked and then removed: not held, not counted by Clear ticked
    const ticked = new Set(['oil', 'milk'])
    expect(visibleGroceryLines(items, 'need', ticked).map(i => i.id)).toEqual(['onion', 'milk'])
    expect(heldGroceryLines(items, 'need', ticked).map(i => i.id)).toEqual(['milk'])
    expect(removedGroceryLines(items).map(i => i.id)).toEqual(['salt', 'oil'])
    expect(activeGroceryLines(items).map(i => i.id)).toEqual(['onion', 'milk'])
  })

  it('keeps its slot while the pane that removed it is open, so nothing jumps under the thumb', () => {
    const line = (id: string, removed = false): GroceryLine => ({ id, name: id, state: 'need', recipeIds: [], ...(removed ? { removed: true } : {}) })
    const items = [line('onion'), line('salt', true), line('leek')]
    expect(visibleGroceryLines(items, 'need', new Set(), new Set(['salt'])).map(i => i.id)).toEqual(['onion', 'salt', 'leek'])
    expect(visibleGroceryLines(items, 'all', new Set(), new Set(['salt'])).map(i => i.id)).toEqual(['onion', 'salt', 'leek'])
    // a slot kept for a line that is back on the list is just the line
    expect(visibleGroceryLines([line('onion'), line('salt'), line('leek')], 'need', new Set(), new Set(['salt'])).map(i => i.id)).toEqual(['onion', 'salt', 'leek'])
    // and it still counts nowhere
    expect(groceryCounts(items).all).toBe(2)
  })

  it('round-trips the flag and the recipes through the sanitizer, and drops a snapshot with no flag', () => {
    const list = without(pastaWeek(), 'Salt')
    const back = sanitizeGrocery(JSON.parse(JSON.stringify(list)))!
    expect(named(back, 'Salt')).toMatchObject({ removed: true, removedRecipeIds: ['pasta'] })
    expect(named(back, 'Spaghetti')!.removed).toBeUndefined()
    const junk = sanitizeGrocery({ ...list, items: [{ name: 'Leek', state: 'need', removed: 'yes', removedRecipeIds: ['soup'] }] })!
    expect(junk.items[0].removed).toBeUndefined()
    expect(junk.items[0].removedRecipeIds).toBeUndefined()
  })

  it('a removal on one device and a tick on another both survive a sync', () => {
    const base = pastaWeek()
    const local = without(base, 'Salt')
    const remote = { ...base, items: base.items.map(i => (i.name === 'Spaghetti' ? { ...i, state: 'done' as const } : i)) }
    const { merged, conflicts } = mergeRecord(base, local, remote)
    expect(conflicts).toEqual([])
    expect(named(merged, 'Salt')).toMatchObject({ removed: true, removedRecipeIds: ['pasta'] })
    expect(named(merged, 'Spaghetti')!.state).toBe('done')
  })
})
