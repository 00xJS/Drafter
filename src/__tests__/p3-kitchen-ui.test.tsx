import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { weekDayKeys } from '../../shared/weeks.mjs'
import type { RecipeSuggestion } from '../ai'
import { Kitchen } from '../components/Kitchen'
import { MealPlanSheet, choiceFromSuggestion, mealsForPicks, proposeMealWeek } from '../components/MealPlanSheet'
import { RecipeSuggestions, SUGGESTIONS_KEY, freshSuggestions, parseDismissed, parsePending, suggestionRecipe } from '../components/RecipeSuggestions'
import type { Meal, Place, Recipe } from '../types'
import { dateKey } from '../utils'

// Kitchen's "Plan this week's meals" and "Recipes you might like": the
// proposal behind the sheet, what an accepted plan becomes, what a suggestion
// becomes, and what each screen shows before any effect. Every AI prop is a
// promise that never settles, so nothing here reaches a model.

const never = () => new Promise<never>(() => {})
const noop = () => {}

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
afterEach(() => vi.unstubAllGlobals())

const STAMP = '2026-01-01T00:00:00.000Z'
const recipe = (id: string, name: string, over: Partial<Recipe> = {}): Recipe => ({ kind: 'recipe', id, name, ingredients: [], tags: [], createdAt: STAMP, updatedAt: STAMP, ...over })
const meal = (date: string, slot: Meal['slot'], over: Partial<Meal>): Meal => ({ kind: 'meal', id: `meal~${date}~${slot}`, date, slot, title: 'Meal', createdAt: STAMP, updatedAt: STAMP, ...over })
const place = (id: string, name: string, category: Place['category']): Place => ({ kind: 'place', id, name, color: '#fff', category, createdAt: STAMP, updatedAt: STAMP })

const TODAY = '2026-09-16' // a Wednesday: "next week" is Sunday 20 – Saturday 26 September
const NOW = new Date(2026, 8, 16, 12, 0)
const kRecipes: Recipe[] = [
  recipe('id-fav', 'Lasagne'),
  recipe('id-mid', 'Curry'),
  recipe('id-soup', 'Soup', { tags: ['lunch'] }),
  recipe('id-e', 'Fajitas'),
  recipe('id-d', 'Chilli'),
  recipe('id-c', 'Pie'),
  recipe('id-b', 'Stew'),
  recipe('id-a', 'Tacos'),
  recipe('id-recent', 'Risotto'),
  recipe('id-new1', 'Bao buns', { createdAt: '2026-03-01T00:00:00.000Z' }),
  recipe('id-new2', 'Pho', { createdAt: '2026-05-01T00:00:00.000Z' }),
]
const cooked = (recipeId: string, ...dates: string[]) => dates.map(d => meal(d, 'dinner', { recipeId, title: recipeId }))
const kMeals: Meal[] = [
  ...cooked('id-fav', '2026-08-20', '2026-07-20', '2026-06-15'),
  ...cooked('id-mid', '2026-08-01', '2026-06-01'),
  meal('2026-08-05', 'lunch', { recipeId: 'id-soup' }),
  meal('2026-07-05', 'lunch', { recipeId: 'id-soup' }),
  ...cooked('id-e', '2026-03-25'),
  ...cooked('id-d', '2026-04-01'),
  ...cooked('id-c', '2026-04-10'),
  ...cooked('id-b', '2026-05-01'),
  ...cooked('id-a', '2026-07-15'),
  ...cooked('id-recent', '2026-09-10'),
  meal('2026-08-10', 'lunch', { out: true, placeId: 'id-cafe', title: 'Café Nero' }),
  meal('2026-07-10', 'lunch', { out: true, placeId: 'id-cafe', title: 'Café Nero' }),
  // next Tuesday is already out
  meal('2026-09-22', 'dinner', { out: true, title: 'Eating out' }),
]
const kPlaces: Place[] = [place('id-cafe', 'Café Nero', 'cafe'), place('id-park', 'The park', 'outdoors')]
const items = [...kRecipes, ...kMeals, ...kPlaces]
const base = { items, todayKey: TODAY, now: NOW, tz: 'UTC' }

describe('proposeMealWeek', () => {
  const rows = proposeMealWeek({ ...base, weekStart: '2026-09-20', lunches: false })

  it('proposes the ranking’s dinner for every empty night, favourites first, one never-cooked dish, nothing twice', () => {
    expect(rows.map(r => [r.date, r.slot, r.choice?.title])).toEqual([
      ['2026-09-20', 'dinner', 'Lasagne'],
      ['2026-09-21', 'dinner', 'Curry'],
      ['2026-09-23', 'dinner', 'Soup'],
      ['2026-09-24', 'dinner', 'Fajitas'],
      ['2026-09-25', 'dinner', 'Chilli'],
      ['2026-09-26', 'dinner', 'Pho'],
    ])
    // told from today, whatever week is on screen
    expect(rows[0].choice?.why).toBe('Cooked 3× in six months · last 4 weeks ago')
    expect(rows[5].choice?.why).toBe('Something new: saved, never cooked')
    // Swap cycles the spares, never another night's pick; cooked last week is not offered
    expect(rows[0].options.map(o => o.title)).toEqual(['Lasagne', 'Pie', 'Stew', 'Tacos'])
    expect(rows.flatMap(r => r.options).some(o => o.title === 'Risotto')).toBe(false)
    const picks = rows.map(r => r.choice?.id)
    for (const r of rows) expect(r.options.slice(1).some(o => picks.includes(o.id))).toBe(false)
  })

  it('plans the rest of this week from today, and nothing in a week gone by', () => {
    const now = proposeMealWeek({ ...base, weekStart: '2026-09-13', lunches: false })
    expect(now.map(r => r.date)).toEqual(['2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19'])
    expect(now.every(r => r.choice)).toBe(true)
    expect(proposeMealWeek({ ...base, weekStart: '2026-09-06', lunches: false })).toEqual([])
  })

  it('fills a young kitchen’s nights with the never-cooked recipes, and leaves the rest to pick', () => {
    const young = proposeMealWeek({ ...base, items: [recipe('id-x', 'Bao buns'), recipe('id-y', 'Pho')], weekStart: '2026-09-20', lunches: false })
    expect(young).toHaveLength(7)
    expect(young.filter(r => r.choice).map(r => r.choice!.title).sort()).toEqual(['Bao buns', 'Pho'])
    expect(young.filter(r => !r.choice)).toHaveLength(5)
  })

  it('adds a lunch for every day when asked, never repeating anything the week already has', () => {
    const withLunch = proposeMealWeek({ ...base, weekStart: '2026-09-20', lunches: true })
    const lunches = withLunch.filter(r => r.slot === 'lunch')
    expect(lunches).toHaveLength(7)
    expect(lunches[0]).toMatchObject({ date: '2026-09-20', choice: { kind: 'place', id: 'id-cafe', title: 'Café Nero' } })
    const picked = withLunch.filter(r => r.choice).map(r => `${r.choice!.kind}:${r.choice!.id}`)
    expect(new Set(picked).size).toBe(picked.length)
    expect(withLunch.filter(r => r.slot === 'dinner').map(r => r.choice?.title)).toEqual(rows.map(r => r.choice?.title))
    expect(withLunch.slice(0, 2).map(r => r.key)).toEqual(['2026-09-20|lunch', '2026-09-20|dinner'])
  })
})

describe('mealsForPicks', () => {
  it('turns picks into meals, never over a slot planned meanwhile, with a new dish reused by name or saved once as a stub', () => {
    const created: Recipe[] = []
    const createRecipe = (name: string) => {
      const r = recipe(`id-stub-${created.length}`, name)
      created.push(r)
      return r
    }
    const res = mealsForPicks(
      [
        { date: '2026-09-20', slot: 'dinner', choice: { kind: 'recipe', id: 'id-fav', title: 'Lasagne' } },
        { date: '2026-09-20', slot: 'lunch', choice: { kind: 'place', id: 'id-cafe', title: 'Café Nero' } },
        { date: '2026-09-21', slot: 'dinner', choice: { kind: 'new', title: 'Thai green curry' } },
        { date: '2026-09-22', slot: 'dinner', choice: { kind: 'recipe', id: 'id-fav', title: 'Lasagne' } },
        { date: '2026-09-23', slot: 'dinner', choice: { kind: 'new', title: 'thai GREEN curry ' } },
        { date: '2026-09-24', slot: 'dinner', choice: { kind: 'new', title: 'lasagne' } },
        { date: '2026-09-25', slot: 'dinner', choice: { kind: 'recipe', id: 'id-gone', title: 'Gone' } },
        { date: '2026-09-26', slot: 'dinner', choice: { kind: 'out', title: 'Eating out' } },
      ],
      { recipes: kRecipes, places: kPlaces, meals: kMeals, createRecipe, now: NOW },
    )
    const stamp = NOW.toISOString()
    expect(created.map(r => r.name)).toEqual(['Thai green curry'])
    expect(res.created).toEqual(created)
    expect(res.meals).toEqual([
      { kind: 'meal', id: 'meal~2026-09-20~dinner', date: '2026-09-20', slot: 'dinner', recipeId: 'id-fav', title: 'Lasagne', createdAt: stamp, updatedAt: stamp },
      { kind: 'meal', id: 'meal~2026-09-20~lunch', date: '2026-09-20', slot: 'lunch', out: true, placeId: 'id-cafe', title: 'Café Nero', createdAt: stamp, updatedAt: stamp },
      { kind: 'meal', id: 'meal~2026-09-21~dinner', date: '2026-09-21', slot: 'dinner', recipeId: 'id-stub-0', title: 'Thai green curry', createdAt: stamp, updatedAt: stamp },
      { kind: 'meal', id: 'meal~2026-09-23~dinner', date: '2026-09-23', slot: 'dinner', recipeId: 'id-stub-0', title: 'Thai green curry', createdAt: stamp, updatedAt: stamp },
      { kind: 'meal', id: 'meal~2026-09-24~dinner', date: '2026-09-24', slot: 'dinner', recipeId: 'id-fav', title: 'Lasagne', createdAt: stamp, updatedAt: stamp },
      { kind: 'meal', id: 'meal~2026-09-26~dinner', date: '2026-09-26', slot: 'dinner', out: true, title: 'Eating out', createdAt: stamp, updatedAt: stamp },
    ])
  })
})

describe('choiceFromSuggestion', () => {
  const refs = { R1: { kind: 'recipe', id: 'id-fav' }, L1: { kind: 'place', id: 'id-cafe' }, R2: { kind: 'recipe', id: 'id-gone' } } as const
  const s = { date: '2026-09-20', slot: 'dinner' as const, why: 'Your favourite' }

  it('resolves only the references it was shown, and a new dish by name', () => {
    expect(choiceFromSuggestion({ ...s, recipeRef: 'R1' }, refs, kRecipes, kPlaces)).toEqual({ kind: 'recipe', id: 'id-fav', title: 'Lasagne', why: 'Your favourite', ai: true })
    expect(choiceFromSuggestion({ ...s, placeRef: 'L1' }, refs, kRecipes, kPlaces)).toEqual({ kind: 'place', id: 'id-cafe', title: 'Café Nero', why: 'Your favourite', ai: true })
    expect(choiceFromSuggestion({ ...s, newDish: 'Thai green curry' }, refs, kRecipes, kPlaces)).toEqual({ kind: 'new', title: 'Thai green curry', why: 'Your favourite', ai: true })
    expect(choiceFromSuggestion({ ...s, recipeRef: 'R2' }, refs, kRecipes, kPlaces)).toBeNull()
  })
})

describe('MealPlanSheet', () => {
  it('opens on a ticked proposal per empty dinner, with Swap, Pick…, lunches and the assistant — nothing planned yet', () => {
    const html = renderToStaticMarkup(
      <MealPlanSheet
        week={{ key: '2026-W38', start: new Date(2026, 8, 20), label: 'Sep 20 – Sep 26' }}
        items={items}
        recipes={kRecipes}
        places={kPlaces}
        meals={kMeals}
        onCreatePlace={() => kPlaces[0]}
        onCreateRecipe={name => recipe('id-x', name)}
        onApply={() => {
          throw new Error('nothing is applied on open')
        }}
        onClose={noop}
        suggest={never}
        now={NOW}
        tz="UTC"
      />,
    )
    expect(html).toContain('role="dialog"')
    expect(html).toContain('Plan this week’s meals')
    expect(html).toContain('Include lunches')
    expect(html).toContain('Lasagne')
    expect(html).toContain('Plan 6 meals')
    expect(html).toContain('✨ Ask for ideas')
    expect(html.match(/>Swap</g)).toHaveLength(6)
    expect(html.match(/type="checkbox"[^>]*checked=""/g)).toHaveLength(6)
  })
})

describe('Kitchen', () => {
  const props = {
    recipes: kRecipes,
    meals: [] as Meal[],
    groceries: [],
    places: kPlaces,
    onSave: noop,
    onDelete: noop,
    onSaveMeal: noop,
    onClearMeal: noop,
    onCreatePlace: () => kPlaces[0],
    onCreateRecipe: (name: string) => recipe('id-x', name),
  }

  it('offers recipe ideas on the Recipes screen', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    expect(renderToStaticMarkup(<Kitchen {...props} />)).toContain('✨ Suggest recipes I’d like')
  })

  it('offers to plan a week with empty dinners, and not one that is planned', () => {
    vi.stubGlobal('localStorage', fakeStorage({ 'drafter:kitchen-tab': 'week' }))
    const empty = renderToStaticMarkup(<Kitchen {...props} />)
    expect(empty).toContain('meal-plan-cta')
    expect(empty).toContain('Plan this week’s meals')
    expect(empty).toMatch(/Nothing planned yet|still to plan/)
    const planned = weekDayKeys(dateKey(new Date())).map(d => meal(d, 'dinner', { recipeId: 'id-fav', title: 'Lasagne' }))
    expect(renderToStaticMarkup(<Kitchen {...props} meals={planned} />)).not.toContain('meal-plan-cta')
  })
})

// ---- recipes you might like -------------------------------------------------------

const pendingJSON = JSON.stringify([
  {
    id: 's1',
    title: 'Beef ragù',
    why: 'Like your lasagne',
    like: ['id-fav', 'id-nope'],
    tags: ['pasta'],
    ingredients: [{ name: 'Beef mince', qty: 500, unit: 'g' }, { name: 'Salt', qty: -2 }, { name: '' }],
    steps: ['Brown the mince'],
    at: STAMP,
  },
  { title: 'no id' },
  'junk',
  { id: 's2', title: 'Lasagne', why: 'already saved by hand' },
])

describe('recipe suggestions', () => {
  it('reads what is stored defensively', () => {
    const list = parsePending(pendingJSON)
    expect(list.map(s => s.id)).toEqual(['s1', 's2'])
    expect(list[0].ingredients).toEqual([{ name: 'Beef mince', qty: 500, unit: 'g' }, { name: 'Salt' }])
    expect(parsePending('not json')).toEqual([])
    expect(parsePending('{}')).toEqual([])
    expect(parseDismissed(JSON.stringify(['Beef stew', 'beef STEW', 'Tacos', 3]))).toEqual(['Beef stew', 'Tacos'])
  })

  it('keeps an answer’s new dishes only: never one already a recipe, deleted before or waiting', () => {
    const dish = (title: string, similarTo: string[] = []): RecipeSuggestion => ({ title, why: 'x', similarTo, tags: [], ingredients: [], steps: [] })
    let n = 0
    // Lasagne and Pho are kRecipes already
    const out = freshSuggestions([dish('Beef ragù', ['R1', 'R2']), dish('LASAGNE'), dish('pho'), dish('beef stew'), dish('Beef Ragu'), dish('Pad thai'), dish('Bibimbap')], {
      ids: { R1: 'id-fav' },
      recipes: kRecipes,
      dismissed: ['Beef stew'],
      pending: parsePending(JSON.stringify([{ id: 'p1', title: 'Pad Thai' }])),
      makeId: () => `s${++n}`,
      at: STAMP,
    })
    expect(out.map(s => [s.id, s.title, s.like])).toEqual([
      ['s1', 'Beef ragù', ['id-fav']],
      ['s2', 'Bibimbap', []],
    ])
  })

  it('accepts a suggestion as a recipe with its drafted ingredients and steps', () => {
    const r = suggestionRecipe(parsePending(pendingJSON)[0], { id: 'id-new', now: new Date('2026-09-12T10:00:00.000Z') })
    expect(r).toMatchObject({ kind: 'recipe', id: 'id-new', name: 'Beef ragù', steps: ['Brown the mince'], tags: ['pasta'], createdAt: '2026-09-12T10:00:00.000Z', updatedAt: '2026-09-12T10:00:00.000Z' })
    expect(r.ingredients.map(({ name, qty, unit }) => ({ name, qty, unit }))).toEqual([
      { name: 'Beef mince', qty: 500, unit: 'g' },
      { name: 'Salt', qty: undefined, unit: undefined },
    ])
    expect(new Set(r.ingredients.map(i => i.id)).size).toBe(2)
  })

  it('shows what is waiting with why and what it is like, Accept and Delete — and nothing with no recipes', () => {
    vi.stubGlobal('localStorage', fakeStorage({ [SUGGESTIONS_KEY]: pendingJSON }))
    const html = renderToStaticMarkup(<RecipeSuggestions recipes={kRecipes} meals={kMeals} onAccept={noop} suggest={never} />)
    expect(html).toContain('Recipes you might like')
    expect(html).toContain('Beef ragù')
    expect(html).toContain('Like your Lasagne')
    // saved by hand since: not waiting any more
    expect(html).not.toContain('already saved by hand')
    expect(html).toContain('>Accept</button>')
    expect(html).toContain('aria-label="Delete Beef ragù for good"')
    expect(html).toContain('✨ More ideas')
    vi.stubGlobal('localStorage', fakeStorage())
    expect(renderToStaticMarkup(<RecipeSuggestions recipes={kRecipes} meals={[]} onAccept={noop} />)).toContain('✨ Suggest recipes I’d like')
    expect(renderToStaticMarkup(<RecipeSuggestions recipes={[]} meals={[]} onAccept={noop} />)).toBe('')
  })
})
