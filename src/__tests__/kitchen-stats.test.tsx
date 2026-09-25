import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { useState, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup, renderToString } from 'react-dom/server'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { weekKeyOf, weekKeyStart, weekStartKey } from '../../shared/weeks.mts'
import { Kitchen } from '../components/Kitchen'
import { KitchenStats as StatsView } from '../components/kitchen/KitchenStats'
import { KitchenStats } from '../components/planner/lazy'
import { KITCHEN_TABS, KITCHEN_TAB_KEY, VIEWS, VIEW_TO_KITCHEN, kitchenTabOfView, storedKitchenTab, type KitchenTab } from '../components/planner/routes'
import { useDeepLinks } from '../components/planner/useDeepLinks'
import { useNavigation } from '../components/planner/useNavigation'
import { ChartCard, ListCard, MonthCalendar, Podium } from '../components/stats'
import { cookedIndex, cookedLine, notLately } from '../kitchen'
import {
  dinnerDays,
  dinnerStreaks,
  dishMark,
  firstCooked,
  goesWith,
  kitchenIndex,
  kitchenTiles,
  mealMonths,
  mostBought,
  mostCooked,
  neverCooked,
  notCookedLately,
  slotShares,
} from '../kitchenstats'
import { placeStats } from '../places'
import type { GroceryLine, GroceryList, Meal, Place, Recipe } from '../types'
import { elements, press, propsOf, settled, textOf, type El } from './rendered'
import { sheetSource } from './source'

// Kitchen → Stats: every figure worked out by the Kitchen's own rules, so it
// agrees with the Recipes list, This week and a place's card; the view drawn
// on the server, empty and full, with its switches pressed; the fourth
// segment it lives in; the palette's and a link's way to it; and its chunk.

const noop = () => {}
const html = (node: ReactNode) => renderToStaticMarkup(node as ReactElement).replace(/<!-- -->/g, '')

const STAMP = '2026-01-01T00:00:00.000Z'
/** Monday 14 September 2026, in the evening. */
const NOW = new Date(2026, 8, 14, 18, 0)
const TODAY = '2026-09-14'

const recipe = (id: string, name: string, over: Partial<Recipe> = {}): Recipe => ({ kind: 'recipe', id, name, ingredients: [], tags: [], createdAt: STAMP, updatedAt: STAMP, ...over })
const meal = (date: string, slot: Meal['slot'], over: Partial<Meal> = {}): Meal => ({ kind: 'meal', id: `meal~${date}~${slot}`, date, slot, title: 'Meal', createdAt: STAMP, updatedAt: STAMP, ...over })
const cook = (date: string, slot: Meal['slot'], r: Recipe, over: Partial<Meal> = {}) => meal(date, slot, { recipeId: r.id, title: r.name, ...over })
const place = (id: string, name: string, over: Partial<Place> = {}): Place => ({ kind: 'place', id, name, color: '#0369a1', category: 'cafe', createdAt: STAMP, updatedAt: STAMP, ...over })

const curry = recipe('curry', 'Chicken curry', { emoji: '🍛' })
const rice = recipe('rice', 'Rice', { emoji: '🍚' })
const lasagne = recipe('lasagne', 'Lasagne')
const chilli = recipe('chilli', 'Chilli')
const tacos = recipe('tacos', 'Tacos')
const pho = recipe('pho', 'Pho', { createdAt: '2026-08-01T10:00:00.000Z' })
const stew = recipe('stew', 'Stew')
/** A–Z, as the store sorts them. */
const RECIPES = [chilli, curry, lasagne, pho, rice, stew, tacos]
const cafe = place('cafe', 'Café Nero', { emoji: '☕' })
const PLACES = [cafe]
const withRice = [{ recipeId: 'rice', title: 'Rice' }]

const MEALS: Meal[] = [
  cook('2025-11-01', 'dinner', tacos),
  cook('2026-06-01', 'dinner', chilli),
  meal('2026-08-15', 'lunch', { out: true, placeId: 'cafe', title: 'Café Nero' }),
  // at a place since deleted: bought, as no card counts it
  meal('2026-09-01', 'dinner', { out: true, placeId: 'gone', title: 'Old diner' }),
  cook('2026-09-05', 'dinner', curry, { deletedAt: '2026-09-06T08:00:00.000Z' }),
  // a dish typed with no recipe is still cooked at home
  meal('2026-09-06', 'dinner', { title: 'Beans on toast' }),
  // a household member planned this one: the Kitchen shows it, so it counts
  cook('2026-09-07', 'dinner', curry, { ownerId: 'someone-else' }),
  cook('2026-09-08', 'lunch', lasagne),
  cook('2026-09-08', 'dinner', lasagne),
  cook('2026-09-09', 'dinner', curry, { sides: withRice }),
  cook('2026-09-10', 'lunch', curry),
  meal('2026-09-10', 'dinner', { out: true, title: 'Eating out' }),
  meal('2026-09-11', 'dinner', { out: true, placeId: 'cafe', title: 'Café Nero' }),
  cook('2026-09-12', 'dinner', lasagne),
  cook('2026-09-13', 'dinner', curry, { sides: [...withRice, { title: 'naan' }] }),
  cook('2026-09-14', 'dinner', curry, { sides: withRice }),
  // plans: not a meal had, yet
  cook('2026-09-16', 'dinner', stew),
  meal('2026-09-20', 'dinner', { out: true, placeId: 'cafe', title: 'Café Nero' }),
]

const line = (name: string, state: GroceryLine['state'], over: Partial<GroceryLine> = {}): GroceryLine => ({ id: `g~${name}~${over.unit ?? ''}`, name, state, recipeIds: [], ...over })
const list = (weekKey: string, items: GroceryLine[], over: Partial<GroceryList> = {}): GroceryList => ({ kind: 'grocery', id: `grocery~${weekKey}`, weekKey, items, createdAt: STAMP, updatedAt: STAMP, ...over })
const GROCERIES: GroceryList[] = [
  list('2026-W37', [line('Milk', 'need'), line('Onions', 'done', { unit: 'kg' }), line('onions', 'need'), line('Rice', 'have'), line('Salt', 'need', { removed: true })]),
  list('2026-W36', [line('Milk', 'done'), line('Onions', 'done'), line('Eggs', 'need')]),
  list('2026-W30', [line('Milk', 'done')]),
  // a week still to come, and a list in Trash
  list('2026-W38', [line('Milk', 'need'), line('Bread', 'need')]),
  list('2026-W35', [line('Bread', 'done')], { deletedAt: '2026-09-01T00:00:00.000Z' }),
]

const ix = kitchenIndex(RECIPES, MEALS, PLACES, NOW)
const names = (rows: { recipe: Recipe; count: number }[]) => rows.map(r => [r.recipe.name, r.count])

describe('the kitchen, counted by its own rules', () => {
  it('counts a recipe’s days as the Recipes list counts its cooking: main or side, its day come, never deleted or bought', () => {
    expect(ix.dayKey).toBe(TODAY)
    expect(ix.days.get('curry')).toEqual(['2026-09-14', '2026-09-13', '2026-09-10', '2026-09-09', '2026-09-07'])
    expect(ix.days.get('rice')).toEqual(['2026-09-14', '2026-09-13', '2026-09-09'])
    expect(ix.days.get('lasagne')).toEqual(['2026-09-12', '2026-09-08'])
    expect(ix.days.has('stew')).toBe(false)
    const way = (date: string, slot: Meal['slot'] = 'dinner') => ix.ways.get(`meal~${date}~${slot}`)
    expect([way('2026-09-06'), way('2026-09-10', 'lunch'), way('2026-09-11'), way('2026-09-10'), way('2026-09-01')]).toEqual(['cooked', 'cooked', 'out', 'bought', 'bought'])
    expect([way('2026-09-05'), way('2026-09-16'), way('2026-09-20')]).toEqual([undefined, undefined, undefined])
  })

  it('agrees with the Recipes list: its tile is All, Not lately comes in its two halves, and its index is the list’s own', () => {
    const shown = cookedIndex(RECIPES, MEALS, TODAY)
    for (const r of RECIPES) expect(ix.cooked.byId.get(r.id)).toEqual(shown.byId.get(r.id))
    expect(kitchenTiles(ix).recipes).toBe(RECIPES.length)
    expect(kitchenTiles(ix).notLately).toBe(notLately(RECIPES, shown).length)
    expect(neverCooked(ix).map(r => r.name)).toEqual(['Pho'])
    expect(notCookedLately(ix).map(r => r.name)).toEqual(['Tacos', 'Chilli'])
    expect([...neverCooked(ix), ...notCookedLately(ix)]).toEqual(notLately(RECIPES, shown))
    // Stew has never been cooked, but it is on for Wednesday
    expect(neverCooked(ix)).not.toContain(stew)
  })

  it('ranks by days, most first, over 30 days, 12 months or all time, where the Recipes list’s times count meals', () => {
    expect(names(mostCooked(ix, 30))).toEqual([['Chicken curry', 5], ['Rice', 3], ['Lasagne', 2]])
    expect(names(mostCooked(ix, 365))).toEqual([['Chicken curry', 5], ['Rice', 3], ['Lasagne', 2], ['Chilli', 1], ['Tacos', 1]])
    expect(names(mostCooked(ix, 'all'))).toEqual(names(mostCooked(ix, 365)))
    expect(names(mostCooked(ix, 'all', 3))).toEqual([['Chicken curry', 5], ['Rice', 3], ['Lasagne', 2]])
    const shown = cookedIndex(RECIPES, MEALS, TODAY)
    // one day a meal: the same figure
    expect(shown.byId.get('curry')?.timesCooked).toBe(5)
    // lunch and dinner on 8 September: two meals, one day
    expect(shown.byId.get('lasagne')?.timesCooked).toBe(3)
  })

  it('breaks a tie for the one cooked last, then A–Z, and ranks nobody a window never reached', () => {
    const [a, b, c] = [recipe('a', 'Apple pie'), recipe('b', 'Banana bread'), recipe('c', 'Crumble')]
    const tied = kitchenIndex([c, b, a], [cook('2026-09-01', 'dinner', b), cook('2026-09-01', 'lunch', a), cook('2026-09-10', 'dinner', c)], [], NOW)
    expect(names(mostCooked(tied, 'all'))).toEqual([['Crumble', 1], ['Apple pie', 1], ['Banana bread', 1]])
    // Chilli and Tacos: one day each, Chilli the later
    expect(names(mostCooked(ix, 'all')).slice(3)).toEqual([['Chilli', 1], ['Tacos', 1]])
    expect(mostCooked(kitchenIndex(RECIPES, [cook('2026-01-02', 'dinner', curry)], [], NOW), 30)).toEqual([])
  })

  it('fills the tiles for the month so far', () => {
    expect(kitchenTiles(ix)).toEqual({ recipes: 7, notLately: 3, newThisYear: 4, cookedDays: 8, daysThisMonth: 14, eatenOut: 1, bought: 2 })
    expect(firstCooked(ix, 'tacos')).toBe('2025-11-01')
    expect(firstCooked(ix, 'curry')).toBe('2026-09-07')
    expect(firstCooked(ix, 'pho')).toBeNull()
  })

  it('counts a meal eaten out as the place’s card does, and a booking still to come nowhere', () => {
    const card = placeStats(cafe, [], [], NOW, MEALS)
    expect(card.eatenOut).toBe(MEALS.filter(m => m.placeId === 'cafe' && ix.ways.get(m.id) === 'out').length)
    expect(card.eatenOut).toBe(2)
    expect(card.eatenOut365).toBe(slotShares(ix, 'lunch', 365).out + slotShares(ix, 'dinner', 365).out)
  })

  it('keeps a streak of home-cooked dinners in which tonight waits rather than breaks it', () => {
    expect(dinnerStreaks(ix)).toEqual({ current: 3, best: 4, today: true })
    const notYet = kitchenIndex(RECIPES, MEALS.filter(m => m.date !== TODAY), PLACES, NOW)
    expect(dinnerStreaks(notYet)).toEqual({ current: 2, best: 4, today: false })
    expect(dinnerStreaks(kitchenIndex([], [], [], NOW))).toEqual({ current: 0, best: 0, today: false })
  })

  it('draws each day’s dinner up to today as it was had', () => {
    const days = dinnerDays(ix)
    expect(days.get('2026-09-11')).toMatchObject({ way: 'out', place: cafe })
    expect(days.get('2026-09-10')?.way).toBe('bought')
    expect(days.get('2026-09-01')).toMatchObject({ way: 'bought', place: undefined })
    expect(days.get('2026-09-06')?.way).toBe('cooked')
    expect(days.has('2026-09-05')).toBe(false)
    expect(days.has('2026-09-16')).toBe(false)
  })

  it('counts a year by month: meals each way, and the days cooked at home with their trend', () => {
    const y = mealMonths(ix, 2026)
    expect(y.cooked).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 9, 0, 0, 0])
    expect(y.out).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0])
    expect(y.bought).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0])
    // eight days in September, as the tile says; the last 90 days against the 90 before
    expect(y.homeDays).toEqual({ months: [0, 0, 0, 0, 0, 1, 0, 0, 8, 0, 0, 0], total: 9, trend: 7 })
    expect(mealMonths(ix, 2025)).toMatchObject({ cooked: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0], homeDays: { total: 1, trend: 7 } })
  })

  it('shares out lunch and dinner by how each was had, in the window', () => {
    expect(slotShares(ix, 'dinner', 30)).toEqual({ cooked: 7, out: 1, bought: 2, total: 10 })
    expect(slotShares(ix, 'lunch', 30)).toEqual({ cooked: 2, out: 0, bought: 0, total: 2 })
    expect(slotShares(ix, 'lunch', 365)).toEqual({ cooked: 2, out: 1, bought: 0, total: 3 })
    expect(slotShares(ix, 'dinner', 'all')).toEqual({ cooked: 9, out: 1, bought: 2, total: 12 })
  })

  it('pairs each main cooked most with its sides, a saved one by its recipe and a typed one by its name', () => {
    expect(goesWith(ix)).toEqual([
      {
        main: curry,
        meals: 5,
        sides: [
          { key: 'r:rice', name: 'Rice', count: 3 },
          { key: 't:naan', name: 'naan', count: 1 },
        ],
      },
    ])
    expect(goesWith(ix, 5, 1)[0].sides.map(s => s.name)).toEqual(['Rice'])
  })

  it('counts a side typed as a saved recipe is named as that recipe, and ranks two recipes of one name by id', () => {
    // recipeByName's rule: case and spaces aside, " RICE " is the saved Rice
    const typed = kitchenIndex(RECIPES, [...MEALS, cook('2026-09-03', 'dinner', curry, { sides: [{ title: ' RICE ' }, { title: 'chicken  CURRY' }] })], PLACES, NOW)
    expect(goesWith(typed)).toEqual([
      {
        main: curry,
        meals: 6,
        sides: [
          { key: 'r:rice', name: 'Rice', count: 4 },
          { key: 't:naan', name: 'naan', count: 1 },
        ],
      },
    ])
    // two Soups cooked last on one day: by id, whichever order the store has them in
    const [b, a] = [recipe('b-soup', 'Soup'), recipe('a-soup', 'Soup')]
    const soups = (list: Recipe[]) => mostCooked(kitchenIndex(list, [cook('2026-09-12', 'dinner', b), cook('2026-09-12', 'lunch', a)], [], NOW), 'all').map(r => r.recipe.id)
    expect(soups([b, a])).toEqual(['a-soup', 'b-soup'])
    expect(soups([a, b])).toEqual(['a-soup', 'b-soup'])
  })

  it('ranks the grocery items on the most weekly lists, never one taken off or already had, and no week to come', () => {
    const rank = (window: 30 | 365 | 'all') => mostBought(GROCERIES, TODAY, window).map(r => [r.name, r.count])
    expect(rank(30)).toEqual([['Milk', 2], ['Onions', 2], ['Eggs', 1]])
    expect(rank('all')).toEqual([['Milk', 3], ['Onions', 2], ['Eggs', 1]])
    expect(mostBought(GROCERIES, TODAY, 'all', 1).map(r => r.name)).toEqual(['Milk'])
    expect(mostBought([], TODAY, 'all')).toEqual([])
  })

  it('draws a dish as its emoji, or its first letters', () => {
    expect(dishMark('Chicken curry', '🍛')).toBe('🍛')
    expect(dishMark('Chicken curry')).toBe('CC')
    expect(dishMark('Lasagne', ' ')).toBe('La')
    expect(dishMark('  beans   on toast ')).toBe('BO')
    expect(dishMark('éclair')).toBe('Éc')
    expect(dishMark('(?)')).toBe('🍽️')
  })

  it('counts nothing in an empty kitchen, and one dinner cooked tonight as one of everything', () => {
    const none = kitchenIndex([], [], [], NOW)
    expect(kitchenTiles(none)).toEqual({ recipes: 0, notLately: 0, newThisYear: 0, cookedDays: 0, daysThisMonth: 14, eatenOut: 0, bought: 0 })
    expect([mostCooked(none, 'all'), notCookedLately(none), neverCooked(none), goesWith(none)]).toEqual([[], [], [], []])
    expect(mealMonths(none, 2026)).toEqual({ cooked: Array(12).fill(0), out: Array(12).fill(0), bought: Array(12).fill(0), homeDays: { months: Array(12).fill(0), total: 0, trend: 0 } })
    expect(slotShares(none, 'dinner', 'all')).toEqual({ cooked: 0, out: 0, bought: 0, total: 0 })
    const one = kitchenIndex([pho], [cook(TODAY, 'dinner', pho)], [], NOW)
    expect(kitchenTiles(one)).toEqual({ recipes: 1, notLately: 0, newThisYear: 1, cookedDays: 1, daysThisMonth: 14, eatenOut: 0, bought: 0 })
    expect(names(mostCooked(one, 30))).toEqual([['Pho', 1]])
    expect(dinnerStreaks(one)).toEqual({ current: 1, best: 1, today: true })
    expect(mealMonths(one, 2026).homeDays).toMatchObject({ total: 1, trend: 1 })
  })

  it('has no Mine: whoever planned a meal, it counts as the Kitchen shows it', () => {
    const theirs = kitchenIndex(RECIPES.map(r => ({ ...r, ownerId: 'someone-else' })), MEALS.map(m => ({ ...m, ownerId: 'someone-else' })), PLACES, NOW)
    expect(kitchenTiles(theirs)).toEqual(kitchenTiles(ix))
    expect(names(mostCooked(theirs, 'all'))).toEqual(names(mostCooked(ix, 'all')))
    expect(dinnerStreaks(theirs)).toEqual(dinnerStreaks(ix))
    expect(mealMonths(theirs, 2026)).toEqual(mealMonths(ix, 2026))
    expect(goesWith(theirs).map(p => p.meals)).toEqual(goesWith(ix).map(p => p.meals))
  })

  it('reads no personal kind: a journal day, a look or a habit handed in counts for nothing', () => {
    const personal = [
      { kind: 'journal', id: 'j1', date: TODAY, text: 'Cooked curry' },
      { kind: 'wear', id: 'w1', date: TODAY, slot: 'dinner', garmentIds: [] },
      { kind: 'habit', id: 'h1', name: 'Cook at home', date: TODAY, slot: 'dinner' },
    ]
    const mixed = kitchenIndex([...RECIPES, ...(personal as unknown as Recipe[])], [...MEALS, ...(personal as unknown as Meal[])], [...PLACES, ...(personal as unknown as Place[])], NOW)
    expect(kitchenTiles(mixed)).toEqual(kitchenTiles(ix))
    expect(dinnerStreaks(mixed)).toEqual(dinnerStreaks(ix))
    expect(slotShares(mixed, 'dinner', 'all')).toEqual(slotShares(ix, 'dinner', 'all'))
    expect(mostBought([...GROCERIES, ...(personal as unknown as GroceryList[])], TODAY, 'all')).toEqual(mostBought(GROCERIES, TODAY, 'all'))
  })
})

describe('weekKeyStart', () => {
  it('finds the Sunday a week key starts on: weekKeyOf, backwards', () => {
    expect(weekKeyStart('2026-W37')).toBe('2026-09-13')
    expect(weekKeyStart('2026-W30')).toBe('2026-07-26')
    // a year that starts on a Sunday, and the 53rd week it ends with
    expect(weekKeyStart('2023-W01')).toBe('2023-01-01')
    expect(weekKeyStart('2023-W53')).toBe('2023-12-31')
    expect(weekKeyStart('2034-W01')).toBe('2034-01-01')
    // across New Years that start on a Thursday and a Friday, a Sunday, and after a 53-week year
    for (const [from, to] of [
      [Date.UTC(2025, 11, 20), Date.UTC(2027, 0, 10)],
      [Date.UTC(2022, 11, 20), Date.UTC(2024, 0, 20)],
      [Date.UTC(2033, 11, 20), Date.UTC(2034, 0, 20)],
    ]) {
      for (let t = from; t <= to; t += 86_400_000) {
        const day = new Date(t).toISOString().slice(0, 10)
        expect(weekKeyStart(weekKeyOf(day)!), day).toBe(weekStartKey(day))
      }
    }
    for (const junk of ['2026-W00', '2026-W53', '2026-W54', '2023-W54', '2026-37', 'W37', '']) expect(weekKeyStart(junk), junk).toBeNull()
  })
})

describe('the Stats view', () => {
  const onOpenRecipe = vi.fn()
  const onGoDay = vi.fn()
  const full = { recipes: RECIPES, meals: MEALS, groceries: GROCERIES, places: PLACES, onOpenRecipe, onGoDay, now: NOW }
  const empty = { ...full, recipes: [], meals: [], groceries: [], places: [] }
  /** The markup between one card's title and the next's. */
  const card = (out: string, title: string) => out.slice(out.indexOf(`<h3>${title}</h3>`), out.indexOf('<h3>', out.indexOf(`<h3>${title}</h3>`) + 1))
  const cardEl = (tree: ReactNode, title: string) => elements(tree).find(e => e.type === ChartCard && e.props.title === title)!
  afterEach(() => {
    onOpenRecipe.mockReset()
    onGoDay.mockReset()
  })

  it('says, empty, what each card will show, and stands nobody on a podium', () => {
    const out = html(<StatsView {...empty} />)
    // a tile is drawn only for something there is: an empty kitchen has no
    // "Recipes 0", no "0 of 14" and no "Streak 0 dinners" — the cards below say what they wait for
    expect(out).not.toContain('kitchen-tiles')
    expect(out).not.toContain('class="stat-tile"')
    expect(out).toContain('aria-label="Mon 14 Sep: no dinner planned"')
    expect(out).toContain('Each day’s dinner · 0 dinners cooked at home')
    expect(out).not.toContain('Top three')
    expect(out).not.toContain('class="podium"')
    for (const words of [
      'Cook from your recipes and the ones you cook most show here.',
      'Everything you’ve cooked was had this month, or is on the plan.',
      'Every recipe has been cooked, or is on the plan.',
      'Add sides to a cooked dinner and what goes with what shows here.',
      'Build a grocery list or two and what you buy most shows here.',
    ])
      expect(out).toContain(`<p class="empty">${words}</p>`)
    expect(out).toContain('<p class="stats-month-total">0 home-cooked days in 2026 <small class="muted">steady</small></p>')
    expect(out.match(/none in this window/g)).toHaveLength(2)
    expect(out).not.toContain('<rect class="kitchen-way')
  })

  it('draws the kitchen full: the tiles, the dinners, the podium and bars in days, and Not lately’s two halves', () => {
    const out = html(<StatsView {...full} />)
    expect(out).toContain('<div class="stat-label">Recipes</div><div class="stat-value">7</div><div class="stat-sub">3 not lately</div>')
    expect(out).toContain('<div class="stat-label">New recipes</div><div class="stat-value">4</div><div class="stat-sub">first cooked in 2026</div>')
    expect(out).toContain('<div class="stat-label">Cooked at home</div><div class="stat-value">8 of 14</div>')
    expect(out).toMatch(/<div class="stat-label">Eaten out<\/div><div class="stat-value">1<\/div><div class="stat-trend">.*?<\/div><div class="stat-sub">at a place this month · 2 bought, no place<\/div>/)
    // the month so far, each set against last month's same days
    expect(out).toMatch(/<div class="stat-label">Cooked at home<\/div><div class="stat-value">8 of 14<\/div><div class="stat-trend"><span class="delta-line">/)
    expect(out).toContain('<div class="stat-value">3 dinners</div><div class="stat-sub">cooked at home in a row, tonight too</div>')
    expect(out).toContain('<div class="stat-label">Best streak</div><div class="stat-value">4 dinners</div><div class="stat-sub">cooked at home in a row</div>')

    expect(out).toContain('Each day’s dinner · 7 dinners cooked at home')
    expect(out).toContain('<li class="photo-cal-cell dinner-cooked today"><button type="button" class="photo-cal-day" aria-label="Mon 14 Sep: Chicken curry with Rice"><span class="kitchen-cal-dish" aria-hidden="true">🍛</span>')
    expect(out).toContain('<li class="photo-cal-cell dinner-out"><button type="button" class="photo-cal-day" aria-label="Fri 11 Sep: eaten out at Café Nero"><span class="kitchen-cal-dish" aria-hidden="true">☕</span>')
    expect(out).toContain('aria-label="Thu 10 Sep: bought, no place named"><span class="kitchen-cal-dish" aria-hidden="true">🥡</span>')
    expect(out).toContain('aria-label="Tue 1 Sep: bought: Old diner"')
    expect(out).toContain('aria-label="Sun 6 Sep: Beans on toast"><span class="kitchen-cal-dish" aria-hidden="true">BO</span>')
    expect(out).toContain('aria-label="Tue 8 Sep: Lasagne"><span class="kitchen-cal-dish" aria-hidden="true">La</span>')
    expect(out).toContain('aria-label="Sat 5 Sep: no dinner planned"')

    expect([...out.matchAll(/class="podium-piece" aria-label="([^"]+)"/g)].map(m => m[1])).toEqual(['First: Chicken curry, 5 days', 'Second: Rice, 3 days', 'Third: Lasagne, 2 days'])
    expect(out).toContain('<span class="kitchen-dish podium-photo" aria-hidden="true">🍛</span>')
    const bars = card(out, 'Most cooked')
    expect([...bars.matchAll(/<span class="stats-hbar-name">([^<]+)<\/span>/g)].map(m => m[1])).toEqual(['Chicken curry', 'Rice', 'Lasagne'])
    expect([...bars.matchAll(/<span class="hbar-value">(\d+)<\/span>/g)].map(m => m[1])).toEqual(['5', '3', '2'])

    const lately = card(out, 'Not cooked lately')
    expect([...lately.matchAll(/<span class="stats-list-name">([^<]+)<\/span><small class="muted">([^<]+)<\/small>/g)].map(m => [m[1], m[2]])).toEqual([
      ['Tacos', cookedLine(ix.cooked, 'tacos')],
      ['Chilli', cookedLine(ix.cooked, 'chilli')],
    ])
    expect(card(out, 'Never cooked')).toContain('<span class="stats-list-name">Pho</span><small class="muted">Added 6 weeks ago</small>')
    expect(card(out, 'Never cooked')).not.toContain('Stew')
  })

  it('draws the year’s meals stacked cooked, eaten out and bought, with its key, its trend and its table', () => {
    const out = html(<StatsView {...full} />)
    const year = card(out, 'Meals by month')
    expect(year).toContain('Sep 9 cooked, 1 eaten out, 2 bought')
    expect(year).toContain('Aug 0 cooked, 1 eaten out, 0 bought')
    const sep = /<g><title>Sep: 9 cooked, 1 eaten out, 2 bought<\/title>(.*?)<\/g>/.exec(year)![1]
    expect([...sep.matchAll(/<rect class="(kitchen-way-\w+)"/g)].map(m => m[1])).toEqual(['kitchen-way-cooked', 'kitchen-way-out', 'kitchen-way-bought'])
    expect(sep).toContain('<text class="tick-label now"')
    expect(year).toContain('Cooked<strong>10</strong>')
    expect(year).toContain('Eaten out<strong>2</strong>')
    expect(year).toContain('Bought<strong>2</strong>')
    expect(year).toContain('<p class="stats-month-total">9 home-cooked days in 2026 <span class="badge"')
    expect(year).toContain('<tr><td>Sep</td><td class="num">9</td><td class="num">1</td><td class="num">2</td><td class="num">8</td></tr>')
    // ‹ year › stops at this year, as the wardrobe's, People's and Places' do
    expect(year).toContain('aria-label="Next year" disabled=""')

    const shares = card(out, 'Lunch and dinner')
    expect(shares).toContain('<strong>Dinner</strong><small class="muted">10 dinners · 70% cooked</small>')
    expect(shares).toContain('aria-label="Dinner: 7 cooked, 1 eaten out, 2 bought"')
    expect(shares).toContain('<span class="kitchen-way-cooked" style="flex-grow:7" title="Cooked: 7 of 10, 70%"></span>')
    expect(shares).toContain('<small class="kitchen-share-line">7 cooked · 1 eaten out · 2 bought</small>')
    expect(shares).toContain('<strong>Lunch</strong><small class="muted">2 lunches · 100% cooked</small>')

    expect(card(out, 'Goes with')).toContain('<span class="stats-list-name">Chicken curry</span><small class="muted">with Rice ×3, naan ×1 · 5 times as the main</small>')
    const bought = out.slice(out.indexOf('<h3>Most bought</h3>'))
    expect([...bought.matchAll(/<span class="stats-hbar-name">([^<]+)<\/span>/g)].map(m => m[1])).toEqual(['Milk', 'Onions', 'Eggs'])
  })

  it('paints only theme tokens', () => {
    const styles = (out: string) => [...out.matchAll(/style="([^"]*)"/g)].map(m => m[1])
    // the bars and the share of each way are the only inline colours; empty, there are none
    expect(styles(html(<StatsView {...full} />)).length).toBeGreaterThan(0)
    for (const style of [...styles(html(<StatsView {...full} />)), ...styles(html(<StatsView {...empty} />))]) expect(style).not.toMatch(/#|rgb|hsl/)
  })

  it('steps the year back, and switches lunch and dinner to all time', () => {
    const back = settled(StatsView, full, t => ((cardEl(t, 'Meals by month').props.aside as El).props.onStep as (d: number) => void)(-1))
    const year = html(back)
    expect(year).toContain('<button type="button" class="seg on">2025</button>')
    expect(year).toContain('Nov 1 cooked, 0 eaten out, 0 bought')
    expect(year).toContain('1 home-cooked day in 2025')
    expect(year).not.toContain('aria-label="Next year" disabled=""')
    const all = html(settled(StatsView, full, t => ((cardEl(t, 'Lunch and dinner').props.aside as El).props.onChange as (w: 'all') => void)('all')))
    expect(all).toContain('<strong>Dinner</strong><small class="muted">12 dinners · 75% cooked</small>')
    expect(all).toContain('<strong>Lunch</strong><small class="muted">3 lunches · 67% cooked</small>')
  })

  it('opens a recipe from the podium and from what goes with it, and a day of the calendar on This week', () => {
    const tree = settled(StatsView, full)
    const podium = propsOf(tree, Podium<{ key: string; name: string; count: number; recipe: Recipe }>)
    podium.onOpen!(podium.top[0])
    expect(onOpenRecipe).toHaveBeenLastCalledWith(curry)
    const pairs = elements(tree).find(e => e.type === ListCard && e.props.title === 'Goes with')!
    const row = (pairs.props.row as (item: unknown) => El)((pairs.props.items as unknown[])[0])
    ;(row.props.onOpen as () => void)()
    expect(onOpenRecipe).toHaveBeenCalledTimes(2)
    propsOf(tree, MonthCalendar).onOpen!('2026-09-11')
    expect(onGoDay).toHaveBeenCalledWith('2026-09-11')
  })

  it('draws tonight’s dinner out as a plan until its outing comes, as the tiles and the place’s card count it', () => {
    const tz = process.env.TZ
    process.env.TZ = 'Pacific/Auckland'
    try {
      // 7pm on Monday 14 September in New Zealand: midday UTC on the 14th is midnight here
      const evening = new Date(2026, 8, 14, 19, 0)
      const tonight = meal(TODAY, 'dinner', { out: true, placeId: 'cafe', title: 'Café Nero' })
      const meals = [...MEALS.filter(m => m.date !== TODAY), tonight]
      const early = kitchenIndex(RECIPES, meals, PLACES, evening)
      expect(early.dayKey).toBe(TODAY)
      expect(early.ways.has(tonight.id)).toBe(false)
      expect(dinnerDays(early).get(TODAY)).toMatchObject({ way: undefined, place: cafe })
      expect(kitchenTiles(early)).toMatchObject({ eatenOut: 1, bought: 2 })
      expect(placeStats(cafe, [], [], evening, [tonight]).eatenOut).toBe(0)
      expect(slotShares(early, 'dinner', 30).out).toBe(1)
      const out = html(<StatsView {...full} meals={meals} now={evening} />)
      expect(out).toContain('<li class="photo-cal-cell dinner-planned today"><button type="button" class="photo-cal-day" aria-label="Mon 14 Sep: eating out at Café Nero, still to come"><span class="kitchen-cal-dish" aria-hidden="true">☕</span>')
      // two cooked before a night out: tonight asks for no cooking
      expect(out).toContain('<div class="stat-label">Streak</div><div class="stat-value">2 dinners</div><div class="stat-sub">eating out tonight</div>')
      // half past midnight, it is an outing: on the calendar, in the tiles and on the card alike
      const late = new Date(2026, 8, 15, 0, 30)
      const after = kitchenIndex(RECIPES, meals, PLACES, late)
      expect(dinnerDays(after).get(TODAY)?.way).toBe('out')
      expect(kitchenTiles(after).eatenOut).toBe(2)
      expect(placeStats(cafe, [], [], late, [tonight]).eatenOut).toBe(1)
    } finally {
      if (tz === undefined) delete process.env.TZ
      else process.env.TZ = tz
    }
  })
})

function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: vi.fn((k: string, v: string) => void map.set(k, String(v))),
    removeItem: (k: string) => void map.delete(k),
  }
}

/**
 * `settled`, pressed more than once: each act runs on the tree the one before
 * it left, inside the same server render, and the last tree comes back.
 */
function afterActs<P>(Component: (props: P) => ReactNode, props: P, acts: ((tree: ReactNode) => void)[]): ReactNode {
  let last: ReactNode = null
  function Probe() {
    const [step, setStep] = useState(0)
    last = Component(props)
    if (step < acts.length) {
      acts[step](last)
      setStep(step + 1)
    }
    return null
  }
  renderToStaticMarkup(<Probe />)
  return last
}

describe('Kitchen’s fourth segment', () => {
  const props = {
    recipes: RECIPES,
    meals: MEALS,
    groceries: GROCERIES,
    places: PLACES,
    onSave: noop,
    onDelete: noop,
    onSaveMeal: noop,
    onClearMeal: noop,
    onCreatePlace: () => cafe,
    onCreateRecipe: (name: string) => recipe('new', name),
  }
  /** Kitchen's own row of segments, the one pressed in brackets: its group alone, not the Recipes list's All / Not lately. */
  const segments = (out: string) =>
    [...(out.match(/aria-label="Kitchen view">([\s\S]*?)<\/span>/)?.[1] ?? '').matchAll(/<button[^>]*class="seg( on)?"[^>]*>([^<]+)<\/button>/g)].map(m => (m[1] ? `[${m[2]}]` : m[2]))
  /** The segment on in a tree Kitchen returned: its row's buttons only, not the Recipes list's All / Not lately. */
  const on = (tree: ReactNode) =>
    elements(tree)
      .filter(e => e.type === 'button' && e.props.className === 'seg on')
      .map(e => textOf(e.props.children))
      .filter(label => KITCHEN_TABS.some(t => t.label === label))
  /** This week's plan in a tree Kitchen returned. */
  const plan = (tree: ReactNode) => elements(tree).find(e => (e.props as { week?: unknown }).week)!
  beforeAll(async () => {
    await KitchenStats.preload()
  })
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reads Recipes, This week, Grocery, Stats, and opens on Stats once Stats was chosen', () => {
    vi.stubGlobal('localStorage', fakeStorage({ [KITCHEN_TAB_KEY]: 'stats' }))
    const out = html(<Kitchen {...props} />)
    expect(segments(out)).toEqual(['Recipes', 'This week', 'Grocery', '[Stats]'])
    // the row a phone narrows and caps, as it does Home's four
    expect(out).toContain('<div class="people-tab-seg kitchen-seg"><span class="segmented" role="group" aria-label="Kitchen view">')
    expect(out).toContain('<h3>Most cooked</h3>')
    expect(out).toContain('Each day’s dinner · 7 dinners cooked at home')
  })

  it('opens on the segment a way in names, without remembering it', () => {
    const storage = fakeStorage({ [KITCHEN_TAB_KEY]: 'week' })
    vi.stubGlobal('localStorage', storage)
    expect(segments(html(<Kitchen {...props} openTab="stats" />))).toEqual(['Recipes', 'This week', 'Grocery', '[Stats]'])
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('remembers the segment chosen with its button, Stats as the other three', () => {
    for (const [label, key] of [['Stats', 'stats'], ['Grocery', 'grocery'], ['Recipes', 'recipes']] as const) {
      const storage = fakeStorage({ [KITCHEN_TAB_KEY]: key === 'recipes' ? 'week' : 'recipes' })
      vi.stubGlobal('localStorage', storage)
      const tree = settled(Kitchen, props, t => press(t, label))
      expect(storage.setItem, label).toHaveBeenCalledWith(KITCHEN_TAB_KEY, key)
      expect(on(tree)).toEqual([label])
      // and opens there next time
      expect(segments(html(<Kitchen {...props} />))).toContain(`[${label}]`)
    }
  })

  it('moves to the segment a way in names while Kitchen is on screen, writing nothing, and lets the hand-off go', () => {
    const storage = fakeStorage({ [KITCHEN_TAB_KEY]: 'recipes' })
    vi.stubGlobal('localStorage', storage)
    const trees: ReactNode[] = []
    // Kitchen on screen on Recipes; then the palette's Kitchen stats hands it Stats
    function Shell() {
      const [openTab, setOpenTab] = useState<KitchenTab | null>(null)
      trees.push(Kitchen({ ...props, openTab, onOpenTabConsumed: noop }))
      if (trees.length === 1) setOpenTab('stats')
      return null
    }
    renderToStaticMarkup(<Shell />)
    expect(on(trees[0])).toEqual(['Recipes'])
    expect(on(trees[trees.length - 1])).toEqual(['Stats'])
    expect(storage.setItem).not.toHaveBeenCalled()
    // seen, it is let go of: Kitchen tells the shell, which clears it, so the same way in works twice
    const kitchen = readFileSync(fileURLToPath(new URL('../components/Kitchen.tsx', import.meta.url)), 'utf8')
    expect(kitchen).toMatch(/const openTabUsed = useEffectEvent\(\(\) => onOpenTabConsumed\?\.\(\)\)\s*useEffect\(\(\) => \{\s*if \(openTab\) openTabUsed\(\)\s*\}, \[openTab\]\)/)
    const screen = readFileSync(fileURLToPath(new URL('../components/planner/KitchenScreen.tsx', import.meta.url)), 'utf8')
    expect(screen).toContain('onOpenTabConsumed={() => setKitchenOpen(null)}')
  })

  it('opens This week on a day of the dinner calendar, for this visit only', () => {
    const storage = fakeStorage({ [KITCHEN_TAB_KEY]: 'stats' })
    vi.stubGlobal('localStorage', storage)
    const tree = settled(Kitchen, props, t => propsOf(t, KitchenStats).onGoDay('2026-09-01'))
    expect(on(tree)).toEqual(['This week'])
    const week = plan(tree).props.week as { key: string }
    expect(week.key).toBe(weekKeyOf('2026-09-01'))
    expect(storage.setItem).not.toHaveBeenCalled()
    // that day only: the strip is the week, the pickers are the open letter
    expect(plan(tree).props.focusDay).toBe('2026-09-01')
    const out = html(tree)
    expect(out).toContain('<li id="meal-day-2026-09-01" class="meal-day picked">')
    expect(out.match(/<li id="meal-day-[^"]+"/g)).toHaveLength(1)
    // moving off the week, or off the segment, lets it go
    const goDay = (t: ReactNode) => propsOf(t, KitchenStats).onGoDay('2026-09-01')
    const shifted = afterActs(Kitchen, props, [goDay, t => (plan(t).props.onShift as (d: number) => void)(1)])
    expect(plan(shifted).props.focusDay).toBeNull()
    const again = afterActs(Kitchen, props, [goDay, t => press(t, 'Recipes'), t => press(t, 'This week')])
    expect(plan(again).props.focusDay).toBeNull()
  })

  it('hands Stats the Kitchen’s own lists, the ones KitchenScreen takes from the store, and nothing else', () => {
    vi.stubGlobal('localStorage', fakeStorage({ [KITCHEN_TAB_KEY]: 'stats' }))
    const stats = propsOf(settled(Kitchen, props), KitchenStats)
    expect(Object.keys(stats).sort()).toEqual(['groceries', 'meals', 'onGoDay', 'onOpenRecipe', 'places', 'recipes'])
    expect([stats.recipes, stats.meals, stats.groceries, stats.places]).toEqual([RECIPES, MEALS, GROCERIES, PLACES])
    const screen = readFileSync(fileURLToPath(new URL('../components/planner/KitchenScreen.tsx', import.meta.url)), 'utf8')
    for (const kind of ['recipes', 'meals', 'groceries', 'places']) expect(screen).toContain(`${kind}={store.${kind}}`)
    expect(screen).not.toMatch(/filteredTasks|mineOnly/)
  })
})

describe('the ways to it', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('names the four segments, remembers the one chosen, and links to Stats by a name no view has', () => {
    expect(KITCHEN_TABS.map(t => [t.key, t.label])).toEqual([
      ['recipes', 'Recipes'],
      ['week', 'This week'],
      ['grocery', 'Grocery'],
      ['stats', 'Stats'],
    ])
    for (const [saved, tab] of [['stats', 'stats'], ['grocery', 'grocery'], ['nonsense', 'week'], [null, 'week']] as const) {
      vi.stubGlobal('localStorage', { getItem: (k: string) => (k === KITCHEN_TAB_KEY ? saved : null) })
      expect(storedKitchenTab()).toBe(tab)
    }
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
    })
    expect(storedKitchenTab()).toBe('week')
    expect(VIEW_TO_KITCHEN).toEqual({ 'kitchen-stats': 'stats' })
    for (const name of Object.keys(VIEW_TO_KITCHEN)) expect(VIEWS as string[]).not.toContain(name)
    expect(kitchenTabOfView('kitchen-stats')).toBe('stats')
    for (const view of ['kitchen', 'stats', 'constructor', '__proto__', 'toString', undefined]) expect(kitchenTabOfView(view), String(view)).toBeNull()
  })

  it('opens Kitchen on Stats from ?view=kitchen-stats, writes nothing, and leaves ?view=kitchen as it was', () => {
    const calls: string[] = []
    const log = (name: string) => vi.fn((...args: unknown[]) => void calls.push(`${name} ${JSON.stringify(args)}`))
    const deps = {
      store: { loaded: true, journal: [], tasks: [], people: [], places: [], upsert: log('upsert'), remove: log('remove'), restore: log('restore') },
      showToast: log('toast'),
      setSettingsNonce: log('settingsNonce'),
      setSettingsOpen: log('settings'),
      setAdminOpen: log('admin'),
      setEditor: log('editor'),
      newTask: log('newTask'),
      openSheet: log('openSheet'),
      goTasksTab: log('tasksTab'),
      goKeepTab: log('keepTab'),
      setHomeTab: log('homeTab'),
      setView: log('view'),
      openJournal: log('journal'),
      openReview: log('review'),
      openPlace: log('place'),
      openPerson: log('person'),
      openKitchen: log('kitchen'),
      changeStatus: log('changeStatus'),
      defer: log('defer'),
    } as unknown as Parameters<typeof useDeepLinks>[0]
    let apply: (raw: string) => void = () => {}
    function Shell() {
      const { applyLinkRef } = useDeepLinks(deps)
      apply = raw => applyLinkRef.current(raw)
      return null
    }
    renderToString(<Shell />)
    apply('/?view=kitchen-stats')
    expect(calls).toEqual(['kitchen ["stats"]'])
    calls.length = 0
    apply('drafter://open?view=kitchen-stats')
    expect(calls).toEqual(['kitchen ["stats"]'])
    calls.length = 0
    apply('/?view=kitchen')
    // ?view=kitchen names Keep's Kitchen segment since v3.29, on whatever
    // segment the Kitchen itself remembers — so it goes through openKitchen
    expect(calls).toEqual(['kitchen []'])
  })

  it('goes back to the segment last chosen when the Kitchen tab is tapped after a way in moved it', () => {
    vi.stubGlobal('localStorage', fakeStorage({ [KITCHEN_TAB_KEY]: 'recipes' }))
    const handed: (KitchenTab | null)[] = []
    // the shell's own navigation: Kitchen stats from the palette, then a tap on the Kitchen tab
    function Shell() {
      const nav = useNavigation()
      const [step, setStep] = useState(0)
      handed.push(nav.kitchenOpen)
      if (step === 0) nav.openKitchen('stats')
      if (step === 1) nav.goView('keep')
      if (step < 2) setStep(step + 1)
      return null
    }
    renderToStaticMarkup(<Shell />)
    expect(handed).toEqual([null, 'stats', 'recipes'])
  })
})

describe('its chunk and its styles', () => {
  const SRC = fileURLToPath(new URL('../', import.meta.url))
  /** Static edges only: `import type` and import() are not followed (lazyload.test.ts's walk). */
  const reach = (entries: string[]) => {
    const seen = new Set<string>()
    const todo = [...entries]
    while (todo.length) {
      const file = todo.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      const code = readFileSync(file, 'utf8')
      for (const m of code.matchAll(/^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm)) {
        const base = resolve(dirname(file), m[1])
        const hit = [base, `${base}.ts`, `${base}.tsx`].find(p => existsSync(p) && statSync(p).isFile())
        if (hit && /\.(tsx?|mts|mjs)$/.test(hit)) todo.push(hit)
      }
    }
    return seen
  }

  it('loads through the Stats registry lazy.ts re-exports, warmed with the Kitchen tab, and no static import of the Kitchen reaches it or the kit', () => {
    // the four areas' Stats sit in a registry of their own (lazystats.ts), which
    // the Kitchen imports instead of lazy.ts: lazy.ts names every lazy chunk
    const lazy = readFileSync(resolve(SRC, 'components/planner/lazy.ts'), 'utf8')
    expect(readFileSync(resolve(SRC, 'components/planner/lazystats.ts'), 'utf8')).toContain("import('../kitchen/KitchenStats')")
    expect(lazy).toContain("from './lazystats'")
    expect(lazy).toContain('Kitchen.preload, KitchenStats.preload')
    const kitchen = reach([resolve(SRC, 'components/Kitchen.tsx')])
    const heavy = [resolve(SRC, 'components/kitchen/KitchenStats.tsx'), resolve(SRC, 'kitchenstats.ts'), ...['index.ts', 'ChartCard.tsx', 'RankedBars.tsx', 'Podium.tsx', 'MonthCalendar.tsx', 'ListCard.tsx'].map(f => resolve(SRC, 'components/stats', f))]
    expect(heavy.filter(f => kitchen.has(f)).map(f => f.slice(SRC.length))).toEqual([])
    expect(readFileSync(resolve(SRC, 'components/kitchen/KitchenStats.tsx'), 'utf8')).toMatch(/from '\.\.\/stats'/)
  })

  it('draws the three ways in theme tokens, and gives the table’s disclosure the 44pt floor on a touch screen', () => {
    const css = sheetSource()
    expect(css).toMatch(/\.kitchen-way-cooked \{\s*fill: var\(--viz-series-1\);\s*background: var\(--viz-series-1\);/)
    expect(css).toMatch(/\.kitchen-way-out \{\s*fill: var\(--cal-meal-out\);\s*background: var\(--cal-meal-out\);/)
    // bought in the Calendar's own colour for it, so a takeaway is one colour on both
    expect(css).toMatch(/\.kitchen-way-bought \{\s*fill: var\(--cal-meal-bought\);\s*background: var\(--cal-meal-bought\);/)
    expect(css).toMatch(/\.photo-cal-cell\.dinner-bought \.photo-cal-day::after \{\s*background: var\(--cal-meal-bought\);/)
    expect(css).toMatch(/\.photo-cal-cell\.dinner-out \.photo-cal-day::after \{\s*background: var\(--cal-meal-out\);/)
    expect(css).toMatch(/@media \(pointer: coarse\) \{\s*\.kitchen-by-month summary \{[^}]*min-height: 44px/)
    // a keyboard sees the app's own ring on it, as on a button
    expect(css).toMatch(/\.kitchen-by-month summary:focus-visible \{\s*outline: 2px solid var\(--focus-ring\);/)
    // tonight's dinner out, not counted yet: dashed like a day to come, and given no bar
    expect(css).toMatch(/\.photo-cal-cell\.dinner-planned \.photo-cal-day \{\s*border-style: dashed;\s*\}/)
    expect(css).not.toMatch(/dinner-planned \.photo-cal-day::after/)
  })

  it('narrows the thumbs and caps the labels of Kitchen’s four segments on a phone, as Home’s are', () => {
    const bare = sheetSource().replace(/\/\*[\s\S]*?\*\//g, '')
    const body = (at: number) => {
      const open = bare.indexOf('{', at)
      let depth = 0
      for (let i = open; i < bare.length; i++) {
        if (bare[i] === '{') depth++
        else if (bare[i] === '}' && --depth === 0) return bare.slice(open + 1, i)
      }
      return ''
    }
    const narrow = [...bare.matchAll(/@media\s*\(max-width:\s*640px\)/g)].map(m => body(m.index))
    // the native track's 10px sides are 6px here, outranking the shared rule as Home's does
    expect(narrow.some(b => /(^|\})\s*\.native \.people-tab-seg\.kitchen-seg \.segmented \.seg \{\s*padding-inline: 6px;\s*\}/.test(b))).toBe(true)
    // the labels grow with Dynamic Type only so far, and the desktop row keeps its size
    expect(narrow.some(b => /(^|\})\s*\.kitchen-seg \.seg \{\s*font-size: calc\(13px \* min\(1\.15, var\(--type-scale\)\)\);\s*\}/.test(b))).toBe(true)
    expect(bare.match(/\.kitchen-seg \.seg\s*\{/g)).toHaveLength(1)
    expect(bare.match(/\.kitchen-seg \.segmented \.seg\s*\{/g)).toHaveLength(1)
  })
})
