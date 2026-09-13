import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mealAssistInput } from '../ai'
import { buildCorpus, factsFor, parseQuestion } from '../ask'
import type { AskSources } from '../ask'
import { Kitchen, RecipeCook } from '../components/Kitchen'
import { MealSlotRow } from '../components/MealSlotRow'
import {
  buildGroceryList,
  cookedIndex,
  cookedLine,
  cookedRecipeIds,
  cookedSummary,
  lastCookedShort,
  mealLabel,
  mealRecipeIds,
  mealWithMain,
  mealWithSide,
  mealWithoutSide,
  notLately,
  recipesUsed,
  tonightDinner,
} from '../kitchen'
import { sanitizeItem } from '../schema'
import type { Meal, Recipe } from '../types'
import { MAX_SIDES, tonightLine } from '../../shared/kitchen.mjs'
import { mealHistory, mealIdeasFor, proposeWeek } from '../../shared/weekplan.mjs'

// Sides on a meal, and when a recipe was last cooked. One rule decides what a
// meal cooks (shared/kitchen.mjs): the counts every screen shows, the grocery
// list, the name a meal goes by, the slot row, the recipe list and cook mode
// all follow it. Static renders, like the other sheet tests.

const noop = () => {}
const STAMP = '2026-01-01T00:00:00.000Z'
const TODAY = '2026-09-12' // a Saturday
const recipe = (id: string, name: string, over: Partial<Recipe> = {}): Recipe => ({ kind: 'recipe', id, name, ingredients: [], tags: [], createdAt: STAMP, updatedAt: STAMP, ...over })
const ing = (name: string, qty?: number, unit?: string) => ({ id: `i-${name}`, name, ...(qty !== undefined ? { qty } : {}), ...(unit ? { unit } : {}) })
const meal = (date: string, slot: Meal['slot'], over: Partial<Meal> = {}): Meal => ({ kind: 'meal', id: `meal~${date}~${slot}`, date, slot, title: 'Meal', createdAt: STAMP, updatedAt: STAMP, ...over })

const curry = recipe('curry', 'Chicken curry', { emoji: '🍛', ingredients: [ing('Chicken', 500, 'g'), ing('Onion', 1)] })
const rice = recipe('rice', 'Rice', { emoji: '🍚', ingredients: [ing('Basmati', 300, 'g')] })
const naan = recipe('naan', 'Naan', { ingredients: [ing('Flour', 250, 'g'), ing('Onion', 1)] })
const chilli = recipe('chilli', 'Chilli', { ingredients: [ing('Beans', 1, 'tin')] })
const pho = recipe('pho', 'Pho')
const recipes = [curry, rice, naan, chilli, pho]

const withSides = (date: string, sides: Meal['sides']): Meal => meal(date, 'dinner', { recipeId: 'curry', title: 'Chicken curry', sides })
const meals: Meal[] = [
  withSides('2026-08-20', [{ recipeId: 'rice', title: 'Rice' }, { title: 'garlic bread' }]),
  withSides('2026-09-10', [{ recipeId: 'rice', title: 'Rice' }, { recipeId: 'naan', title: 'Naan' }]),
  meal('2026-08-01', 'dinner', { recipeId: 'chilli', title: 'Chilli' }),
  // none of these is cooking: bought (whatever it carries), deleted, and next week's plan
  meal('2026-09-05', 'dinner', { out: true, title: 'Nopi', recipeId: 'chilli', sides: [{ recipeId: 'rice', title: 'Rice' }] }),
  meal('2026-09-06', 'lunch', { recipeId: 'chilli', title: 'Chilli', deletedAt: STAMP }),
  meal('2026-09-15', 'dinner', { recipeId: 'chilli', title: 'Chilli', sides: [{ recipeId: 'naan', title: 'Naan' }] }),
]
const ix = cookedIndex(recipes, meals, TODAY)

function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  }
}

describe('what a meal cooks', () => {
  it('is its main and each side that is a saved recipe, once each — and nothing for a bought meal', () => {
    expect(mealRecipeIds(meals[0])).toEqual(['curry', 'rice'])
    expect(mealRecipeIds(withSides(TODAY, [{ recipeId: 'curry', title: 'Chicken curry' }, { recipeId: 'rice', title: 'Rice' }]))).toEqual(['curry', 'rice'])
    expect(mealRecipeIds(meals[3])).toEqual([])
  })

  it('counts as cooked once its day has come: today yes, tomorrow not yet, never bought or deleted', () => {
    const tonight = withSides(TODAY, [{ recipeId: 'rice', title: 'Rice' }])
    expect(cookedRecipeIds(tonight, TODAY)).toEqual(['curry', 'rice'])
    expect(cookedRecipeIds({ ...tonight, date: '2026-09-13' }, TODAY)).toEqual([])
    expect(cookedRecipeIds({ ...tonight, out: true }, TODAY)).toEqual([])
    expect(cookedRecipeIds({ ...tonight, deletedAt: STAMP }, TODAY)).toEqual([])
    // a side counts as the main does, even beside a main that is only a title
    expect(cookedRecipeIds(meal(TODAY, 'lunch', { title: 'Leftovers', sides: [{ recipeId: 'naan', title: 'Naan' }] }), TODAY)).toEqual(['naan'])
  })
})

describe('when a recipe was last cooked', () => {
  it('counts a side like a main, and leaves out bought, deleted and future meals', () => {
    expect(Object.fromEntries([...ix.byId].map(([id, c]) => [id, [c.timesCooked, c.lastCooked]]))).toEqual({
      curry: [2, '2026-09-10'],
      rice: [2, '2026-09-10'],
      naan: [1, '2026-09-10'],
      chilli: [1, '2026-08-01'],
      pho: [0, null],
    })
  })

  it('is said the way the meal plan and the Places tab say it', () => {
    expect(lastCookedShort(ix, 'curry')).toBe('2 days ago')
    expect(lastCookedShort(ix, 'chilli')).toBe('6 weeks ago')
    expect(lastCookedShort(ix, 'pho')).toBe('new')
    expect(cookedLine(ix, 'rice')).toBe('Last cooked 2 days ago · 2 times')
    expect(cookedLine(ix, 'naan')).toBe('Last cooked 2 days ago · 1 time')
    expect(cookedLine(ix, 'pho')).toBe('Not cooked yet')
    expect(cookedSummary(ix, 'chilli')).toBe('Cooked 1 time · last Sat 1 Aug')
    expect(cookedSummary(ix, 'pho')).toBe('Never cooked yet')
    expect(cookedSummary(cookedIndex([pho], [meal('2025-12-01', 'dinner', { recipeId: 'pho', title: 'Pho' })], TODAY), 'pho')).toBe('Cooked 1 time · last Mon 1 Dec 2025')
  })

  it('"Not lately" is never cooked, or not in a month, longest ago first', () => {
    const at = (id: string, date: string) => meal(date, 'dinner', { recipeId: id, title: id })
    const list = [recipe('a', 'Apple crumble'), recipe('b', 'Burgers'), recipe('c', 'Cassoulet'), recipe('d', 'Dal'), recipe('e', 'Enchiladas')]
    const idx = cookedIndex(list, [at('a', '2026-09-10'), at('b', '2026-08-01'), at('d', '2026-08-13'), at('e', '2026-08-14')], TODAY)
    // Dal is 30 days ago to the day; Enchiladas, 29, is still lately
    expect(notLately(list, idx).map(r => r.name)).toEqual(['Cassoulet', 'Burgers', 'Dal'])
  })

  it('never offers a side as a meal: the week plan, today’s ideas and the assistant leave it out', () => {
    const items = [...recipes, ...meals]
    const history = mealHistory(items, { dayKey: TODAY })
    expect(history.recipes.filter(r => r.sideOnly).map(r => r.id)).toEqual(['naan', 'rice'])
    // cooked often as sides, never as the main: not "something new" for a night either
    const plan = proposeWeek(items, { todayKey: TODAY, now: new Date(2026, 8, 12, 12) })!
    const offered = plan.dinners.flatMap(d => [d.recipeId, ...d.alternatives])
    expect(offered).toEqual(['pho'])
    const ideas = mealIdeasFor(items, { dayKey: TODAY, now: new Date(2026, 8, 12, 9) }).flatMap(s => s.ideas.map(i => i.id))
    expect(ideas).not.toContain('rice')
    const { input } = mealAssistInput({ request: '', weekKey: '2026-W37', dayKey: TODAY, slots: [], planned: [], history })
    expect(input.recipes.map(r => r.name)).toEqual(['Chicken curry', 'Chilli', 'Pho'])
  })
})

describe('sides on the grocery list', () => {
  it('adds each side recipe’s ingredients, merged with the main’s; a typed side and a bought meal add nothing', () => {
    const list = buildGroceryList('2026-W37', [meals[1], meals[3]], recipes, null, STAMP)
    expect(list.items.map(i => [i.name, i.qty ?? null, i.unit ?? null, i.recipeIds])).toEqual([
      ['Basmati', 300, 'g', ['rice']],
      ['Chicken', 500, 'g', ['curry']],
      ['Flour', 250, 'g', ['naan']],
      ['Onion', 2, null, ['curry', 'naan']],
    ])
    expect(recipesUsed([meals[0]], recipes).map(r => r.id)).toEqual(['curry', 'rice'])
  })
})

describe('a meal named with its sides', () => {
  it('reads "main with a, b and c" — and a meal with none exactly as before', () => {
    expect(mealLabel(meal(TODAY, 'dinner', { title: 'Chilli' }))).toBe('Chilli')
    expect(mealLabel(withSides(TODAY, [{ recipeId: 'rice', title: 'Rice' }]))).toBe('Chicken curry with Rice')
    expect(mealLabel(withSides(TODAY, [{ title: 'rice' }, { title: 'naan' }]))).toBe('Chicken curry with rice and naan')
    expect(mealLabel(withSides(TODAY, [{ title: 'rice' }, { title: 'naan' }, { title: 'raita' }]))).toBe('Chicken curry with rice, naan and raita')
    expect(mealLabel(meals[3])).toBe('Nopi')
  })

  it('is what the digest and Today say for tonight, the sides’ ingredients counted', () => {
    const tonight = withSides(TODAY, [{ recipeId: 'rice', title: 'Rice' }, { title: 'garlic bread' }])
    expect(tonightLine([tonight], recipes, TODAY)).toBe('Tonight: Chicken curry with Rice and garlic bread (3 ingredients)')
    expect(tonightDinner([tonight], recipes, new Date(2026, 8, 12, 18))?.sides.map(r => r.id)).toEqual(['rice'])
    expect(tonightLine([meal(TODAY, 'dinner', { recipeId: 'curry', title: 'Chicken curry' })], recipes, TODAY)).toBe('Tonight: Chicken curry (2 ingredients)')
  })
})

describe('changing the main', () => {
  const at = { date: TODAY, slot: 'dinner' as const }
  const planned: Meal = { ...withSides(TODAY, [{ recipeId: 'rice', title: 'Rice' }, { recipeId: 'chilli', title: 'Chilli' }]), notes: 'Double it', updatedAt: '2026-09-12T08:00:00.000Z' }

  it('keeps the sides while the meal is still cooked, less the new main, and keeps its notes', () => {
    const next = mealWithMain(planned, at, { recipeId: 'chilli', title: 'Chilli' }, '2026-09-12T09:00:00.000Z')
    expect(next).toMatchObject({ id: planned.id, recipeId: 'chilli', title: 'Chilli', notes: 'Double it', sides: [{ recipeId: 'rice', title: 'Rice' }], createdAt: planned.createdAt })
    expect(next.updatedAt > planned.updatedAt).toBe(true)
  })

  it('drops them when it becomes a bought meal', () => {
    const out = mealWithMain(planned, at, { out: true, placeId: 'nopi', title: 'Nopi' }, '2026-09-12T09:00:00.000Z')
    expect(out).toMatchObject({ out: true, placeId: 'nopi', title: 'Nopi', notes: 'Double it' })
    expect(out).not.toHaveProperty('sides')
    expect(out).not.toHaveProperty('recipeId')
  })

  it('never builds on a cleared slot — its sides went with it — though it is stamped past it', () => {
    const tomb: Meal = { ...planned, deletedAt: '2026-09-12T08:30:00.000Z' }
    const next = mealWithMain(tomb, at, { recipeId: 'curry', title: 'Chicken curry' }, '2026-09-12T09:00:00.000Z')
    expect(next).not.toHaveProperty('sides')
    expect(next).not.toHaveProperty('deletedAt')
    expect(next).not.toHaveProperty('notes')
    expect(next.updatedAt > tomb.updatedAt).toBe(true)
  })

  it('adds a side once and never the main, and taking the last one off leaves no sides field', () => {
    const one = mealWithSide(withSides(TODAY, undefined), { recipeId: 'rice', title: 'Rice' })!
    expect(one.sides).toEqual([{ recipeId: 'rice', title: 'Rice' }])
    expect(mealWithSide(one, { recipeId: 'rice', title: 'Rice' })).toBeNull()
    expect(mealWithSide(one, { recipeId: 'curry', title: 'Chicken curry' })).toBeNull()
    const two = mealWithSide(one, { title: ' Garlic bread ' })!
    expect(two.sides).toEqual([{ recipeId: 'rice', title: 'Rice' }, { title: 'Garlic bread' }])
    expect(mealWithSide(two, { title: 'garlic  BREAD' })).toBeNull()
    expect(mealWithSide({ ...two, out: true }, { title: 'Salad' })).toBeNull()
    const none = mealWithoutSide(mealWithoutSide(two, 0), 0)
    expect(none).not.toHaveProperty('sides')
    expect(none.updatedAt > two.updatedAt).toBe(true)
  })
})

describe('stored meals', () => {
  const legacy = { kind: 'meal', id: 'meal~2026-09-01~dinner', date: '2026-09-01', slot: 'dinner', recipeId: 'curry', title: 'Chicken curry', createdAt: STAMP, updatedAt: STAMP }

  it('read a meal from before sides exactly as it was', () => {
    expect(JSON.parse(JSON.stringify(sanitizeItem(legacy)))).toEqual(legacy)
  })

  it('keep their sides, drop junk, cap the list, and never give a bought meal any', () => {
    const raw = { ...legacy, sides: [{ recipeId: 'rice', title: ' Rice ' }, { title: 'garlic bread', recipeId: '' }, { title: '' }, 'naan', null, { recipeId: 'x' }] }
    expect((sanitizeItem(raw) as Meal).sides).toEqual([{ recipeId: 'rice', title: 'Rice' }, { title: 'garlic bread' }])
    expect((sanitizeItem({ ...raw, sides: Array.from({ length: 12 }, (_, i) => ({ title: `Side ${i}` })) }) as Meal).sides).toHaveLength(MAX_SIDES)
    expect((sanitizeItem({ ...raw, out: true }) as Meal).sides).toBeUndefined()
    expect((sanitizeItem({ ...raw, sides: [] }) as Meal).sides).toBeUndefined()
  })
})

describe('the meal slot row', () => {
  const DAY = '2026-09-17'
  const row = (over: Partial<ComponentProps<typeof MealSlotRow>> = {}) =>
    renderToStaticMarkup(
      <MealSlotRow
        date={DAY}
        slot="dinner"
        recipes={recipes}
        places={[]}
        cooked={ix}
        onSave={noop}
        onClear={noop}
        onCreatePlace={() => {
          throw new Error('not in a render')
        }}
        onOpenRecipe={noop}
        {...over}
      />,
    )

  it('says beside each recipe when it was last cooked — but not beside the one chosen', () => {
    const html = row({ meal: withSides(DAY, undefined) })
    expect(html).toContain('<option value="r:curry" selected="">🍛 Chicken curry</option>')
    expect(html).toContain('<option value="r:rice">🍚 Rice · 2 days ago</option>')
    expect(html).toContain('<option value="r:chilli">Chilli · 6 weeks ago</option>')
    expect(html).toContain('<option value="r:pho">Pho · new</option>')
    // without the history it reads names only, as it always did
    expect(row({ cooked: undefined })).toContain('<option value="r:rice">🍚 Rice</option>')
  })

  it('offers + Side on a cooked dinner, and shows each side under the main with a way to take it off', () => {
    const html = row({ meal: withSides(DAY, [{ recipeId: 'rice', title: 'Rice' }, { title: 'garlic bread' }]) })
    expect(html).toContain('aria-label="Add a side to dinner on 2026-09-17"')
    expect(html).toContain('>+ Side</button>')
    expect(html).toContain('aria-label="Sides with dinner on 2026-09-17"')
    expect(html).toContain('<span class="meal-side-name">🍚 Rice</span>')
    expect(html).toContain('<span class="meal-side-name">garlic bread</span>')
    expect(html).toContain('aria-label="Remove Rice"')
    expect(html).toContain('aria-label="Remove garlic bread"')
    expect(html.indexOf('class="meal-sides"')).toBeGreaterThan(html.indexOf('</select>'))
    expect(row({ slot: 'lunch', meal: meal(DAY, 'lunch', { recipeId: 'pho', title: 'Pho' }) })).toContain('>+ Side</button>')
  })

  it('offers no side on a breakfast, a bought meal, an empty slot or a planning sheet’s Pick…', () => {
    expect(row({ slot: 'breakfast', meal: meal(DAY, 'breakfast', { recipeId: 'pho', title: 'Pho' }) })).not.toContain('+ Side')
    const bought = row({ meal: meal(DAY, 'dinner', { out: true, title: 'Eating out', sides: [{ title: 'Chips' }] }) })
    expect(bought).not.toContain('+ Side')
    expect(bought).not.toContain('Chips')
    expect(row()).not.toContain('+ Side')
    const pick = row({ mainOnly: true, meal: withSides(DAY, [{ title: 'garlic bread' }]) })
    expect(pick).not.toContain('+ Side')
    expect(pick).not.toContain('garlic bread')
  })
})

describe('the recipe list', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 12, 12))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  const props = {
    recipes,
    meals,
    groceries: [],
    places: [],
    onSave: noop,
    onDelete: noop,
    onSaveMeal: noop,
    onClearMeal: noop,
    onCreatePlace: () => {
      throw new Error('not in a render')
    },
    onCreateRecipe: (name: string) => recipe('x', name),
  }

  it('says on each recipe when it was last cooked and how often', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    const html = renderToStaticMarkup(<Kitchen {...props} />)
    expect(html).toContain('<span class="recipe-cooked">Last cooked 2 days ago · 2 times</span>')
    expect(html).toContain('<span class="recipe-cooked">Last cooked 6 weeks ago · 1 time</span>')
    expect(html).toContain('<span class="recipe-cooked">Not cooked yet</span>')
    expect(html).toContain('aria-pressed="true">All 5</button>')
    expect(html).toContain('aria-pressed="false">Not lately 2</button>')
  })

  it('"Not lately" lists only what has not been cooked in a month, longest ago first', () => {
    vi.stubGlobal('localStorage', fakeStorage({ 'drafter:kitchen-recipes': 'lately' }))
    const html = renderToStaticMarkup(<Kitchen {...props} />)
    expect([...html.matchAll(/<span class="dash-title">([^<]+)<\/span>/g)].map(m => m[1])).toEqual(['Pho', 'Chilli'])
    expect(html).toContain('aria-pressed="true">Not lately 2</button>')
    expect(html).toContain('Not cooked in a month, longest ago first')
    expect(html).not.toContain('Recipes you might like')
  })
})

describe('cook mode', () => {
  it('says how often and when the recipe was cooked, and offers the meal’s sides', () => {
    const html = renderToStaticMarkup(
      <RecipeCook recipe={curry} cooked={ix} sides={[{ recipeId: 'rice', title: 'Rice' }, { title: 'garlic bread' }]} recipes={recipes} onOpenSide={noop} onEdit={noop} onClose={noop} />,
    )
    expect(html).toContain('<p class="recipe-cook-history">Cooked 2 times · last Thu 10 Sep</p>')
    expect(html).toContain('aria-label="Open Rice"')
    expect(html).toContain('<span class="cook-side-dish">garlic bread</span>')
    expect(html).toContain('>Done</button>')
  })

  it('a side opened from it goes back to the main; a recipe opened on its own has no sides', () => {
    const html = renderToStaticMarkup(<RecipeCook recipe={pho} cooked={ix} backTo="Chicken curry" onEdit={noop} onClose={noop} />)
    expect(html).toContain('Never cooked yet')
    expect(html).toContain('>Back to Chicken curry</button>')
    expect(html).not.toContain('cook-sides')
  })
})

describe('Ask Drafter', () => {
  const now = new Date(2026, 8, 12, 12)
  const src: AskSources = { tasks: [], projects: [], people: [], places: [], recipes, meals, entries: [], feedEvents: [], journal: [] }

  it('names a meal with its sides, and links the side recipes', () => {
    const doc = buildCorpus(src, { now, includeJournal: false, includeAmounts: false }).find(d => d.id === meals[1].id)!
    expect(doc.title).toBe('Chicken curry with Rice and Naan')
    expect(doc.links).toEqual(expect.arrayContaining(['curry', 'rice', 'naan']))
  })

  it('states when a recipe it names was last cooked, a side counting', () => {
    const pq = parseQuestion('When did we last have rice?', src, now)
    expect(pq.recipeIds).toEqual(['rice'])
    expect(factsFor(pq, src, now, 'UTC')).toContain('Rice: last cooked 2026-09-10 (2 days ago); cooked 2 times.')
  })
})
