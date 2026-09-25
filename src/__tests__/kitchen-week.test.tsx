import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { isMineTask, newerStamp } from '../../shared/domain.mts'
import { QUICK_PICKS, buildGroceryList, cookedRecipeIds, mealRecipeIds, mealSides, mealWasHad, mealWithMain } from '../../shared/kitchen.mts'
import { outingsAt } from '../../shared/places.mts'
import { FAVOURITE_REST_DAYS, favouritesRotation, proposeWeek, rotationIdeas } from '../../shared/weekplan.mts'
import { weekDayKeys } from '../../shared/weeks.mts'
import { mealPlan } from '../chatactions'
import { mealFromIdea } from '../components/MealIdeasCard'
import { asMeal as planSheetMeal, mealsForPicks } from '../components/MealPlanSheet'
import { weekPlanWrites } from '../components/planner/useFocusActions'
import { useLifeActions } from '../components/planner/useLifeActions'
import { asMeal as weekSheetMeal } from '../components/WeekPlanSheet'
import {
  cookTaskFor,
  cookTaskId,
  cookTaskUpdates,
  cookTaskWithCook,
  cookedIndex,
  mealAdjusted,
  mealCook,
  mealHasCookTask,
  mealPicked,
  mealWho,
  mealWrites,
  mealsForSlot,
  quickMain,
  recipeStarred,
  syncCookTask,
} from '../kitchen'
import { kitchenIndex } from '../kitchenstats'
import { sanitizeItem, sanitizeMeal, sanitizeRecipe, withUnknownFields } from '../schema'
import type { Store } from '../store'
import type { GroceryList, Item, Meal, Place, Recipe, Task } from '../types'

// Kitchen → This week, levelled up: the Favourites rotation behind the day
// cards' ideas, the picker's Cook list and the week plan; the quick picks, each
// written as the meal it is so every count already knows it; who cooks a
// shared dish, whose cook task is theirs; and every meal writer landing in the
// member's own row, never in the household-wide id of a legacy one.

const STAMP = '2026-09-01T12:00:00.000Z'
/** A Thursday: the week on screen is Sunday 20 – Saturday 26 September. */
const TODAY = '2026-09-24'
const WEEK = weekDayKeys(TODAY)
const JOE = 'joe'
const MARIA = 'maria'
const recipe = (id: string, name: string, over: Partial<Recipe> = {}): Recipe => ({ kind: 'recipe', id, name, ingredients: [], tags: [], createdAt: STAMP, updatedAt: STAMP, ...over })
const meal = (date: string, slot: Meal['slot'], over: Partial<Meal> = {}): Meal => ({ kind: 'meal', id: `meal~${date}~${slot}~${over.ownerId ?? JOE}`, date, slot, title: 'Meal', createdAt: STAMP, updatedAt: STAMP, ...over })
const cooked = (r: Recipe, date: string, slot: Meal['slot'] = 'dinner') => meal(date, slot, { recipeId: r.id, title: r.name, id: `m-${r.id}-${date}` })
const place = (id: string, name: string): Place => ({ kind: 'place', id, name, color: '#fff', category: 'restaurant', createdAt: STAMP, updatedAt: STAMP })

// ---- the Favourites rotation ------------------------------------------------------

describe('the Favourites rotation', () => {
  // the owner's cookbook: Chicken Parm 11 days ago, Beef Stew 14, Spaghetti 16,
  // Enchiladas never, two of them starred; Tacos starred but had last Saturday;
  // Stir Fry on the plan this week; Rice only ever a side
  const parm = recipe('parm', 'Chicken Parm', { favourite: true })
  const stew = recipe('stew', 'Beef Stew')
  const spag = recipe('spag', 'Spaghetti', { favourite: true })
  const ench = recipe('ench', 'Enchiladas')
  const tacos = recipe('tacos', 'Tacos', { favourite: true })
  const stir = recipe('stir', 'Stir Fry')
  const rice = recipe('rice', 'Rice')
  const pancakes = recipe('pancakes', 'Pancakes')
  const recipes = [parm, stew, spag, ench, tacos, stir, rice, pancakes]
  const meals = [
    cooked(parm, '2026-09-13'),
    cooked(stew, '2026-09-10'),
    cooked(spag, '2026-09-08', 'dinner'),
    { ...cooked(stir, '2026-08-01'), sides: [{ recipeId: 'rice', title: 'Rice' }] },
    cooked(tacos, '2026-09-19'),
    cooked(stir, '2026-09-23'),
    cooked(pancakes, '2026-09-06', 'breakfast'),
  ]
  const rows = favouritesRotation([...recipes, ...meals], { dayKey: TODAY, week: WEEK })

  it('puts the ★ favourites not had lately first, longest since first; then never had; then the rest by longest since', () => {
    expect(rows.map(r => [r.recipe.id, r.tier])).toEqual([
      ['spag', 'due'],
      ['parm', 'due'],
      ['ench', 'new'],
      ['rice', 'rest'],
      ['pancakes', 'rest'],
      ['stew', 'rest'],
      // a ★ had in the last week waits its turn among the rest
      ['tacos', 'rest'],
      // already on the plan this week: not offered, and last for a list that shows everything
      ['stir', 'planned'],
    ])
    expect(rows.find(r => r.recipe.id === 'parm')?.lastCooked).toBe('2026-09-13')
    expect(rows.find(r => r.recipe.id === 'ench')?.lastCooked).toBeNull()
    expect(FAVOURITE_REST_DAYS).toBe(7)
  })

  it('offers a day card the first three that suit the meal: never a side, never one planned this week', () => {
    expect(rotationIdeas(rows, 'dinner').map(r => r.recipe.name)).toEqual(['Spaghetti', 'Chicken Parm', 'Enchiladas'])
    // breakfast takes what has been breakfast, or is tagged for it — never an untagged new dish
    expect(rotationIdeas(rows, 'breakfast').map(r => r.recipe.name)).toEqual(['Pancakes'])
    expect(rotationIdeas(rows, 'lunch').map(r => r.recipe.name)).toEqual(['Enchiladas'])
    const tagged = favouritesRotation([...recipes, recipe('soup', 'Soup', { tags: ['lunch'] }), ...meals], { dayKey: TODAY, week: WEEK })
    expect(rotationIdeas(tagged, 'lunch').map(r => r.recipe.name)).toEqual(['Enchiladas', 'Soup'])
    expect(rotationIdeas(tagged, 'dinner').map(r => r.recipe.name)).not.toContain('Soup')
  })

  it('is the same order whatever order the records come in, and a star moves a recipe up', () => {
    expect(favouritesRotation([...meals, ...recipes].reverse(), { dayKey: TODAY, week: WEEK })).toEqual(rows)
    const starred = favouritesRotation([...recipes.map(r => (r.id === 'stew' ? recipeStarred(r, true) : r)), ...meals], { dayKey: TODAY, week: WEEK })
    expect(starred.slice(0, 3).map(r => r.recipe.id)).toEqual(['spag', 'stew', 'parm'])
    // unstarred, a recipe has no favourite field at all
    expect(recipeStarred(parm, false)).not.toHaveProperty('favourite')
  })

  it('is the order the week plan proposes in: a ★ favourite first, even over the recipe cooked most', () => {
    const staple = recipe('staple', 'Staple')
    const fav = recipe('fav', 'Favourite', { favourite: true })
    const history = [...['2026-07-01', '2026-07-15', '2026-07-30', '2026-08-05', '2026-08-15'].map(d => cooked(staple, d)), cooked(fav, '2026-09-01')]
    const plan = proposeWeek([staple, fav, ...history], { todayKey: TODAY, now: new Date(2026, 8, 24, 9) })!
    expect(plan.dinners.map(d => d.recipeId).slice(0, 2)).toEqual(['fav', 'staple'])
    expect(plan.dinners[0].why).toBe('★ Cooked 1× in six months · last 23 days ago')
    // without the star it is the rest's order: the longest since first
    const plain = proposeWeek([staple, { ...fav, favourite: undefined }, ...history], { todayKey: TODAY, now: new Date(2026, 8, 24, 9) })!
    expect(plain.dinners.map(d => d.recipeId).slice(0, 2)).toEqual(['staple', 'fav'])
  })

  it('offers a ★ recipe never cooked as the week’s something new, before the newest saved', () => {
    const old = recipe('old', 'Old idea', { favourite: true, createdAt: '2026-01-01T00:00:00.000Z' })
    const newest = recipe('newest', 'Newest', { createdAt: '2026-09-20T00:00:00.000Z' })
    const plan = proposeWeek([old, newest], { todayKey: TODAY, now: new Date(2026, 8, 24, 9) })!
    expect(plan.dinners.filter(d => d.isNew).map(d => d.recipeId)).toEqual(['old'])
  })
})

// ---- quick picks ------------------------------------------------------------------

describe('a quick pick is written as the meal it is, so every count already knows it', () => {
  const luna = place('luna', "Luna's Pizza")
  const steak = recipe('steak', 'Steak', { ingredients: [{ id: 'i1', name: 'Steak', qty: 2 }] })
  const week = [
    meal('2026-09-20', 'dinner', { recipeId: 'steak', title: 'Steak' }),
    meal('2026-09-21', 'dinner', { ...quickMain('takeout') }),
    meal('2026-09-22', 'lunch', { ...quickMain('leftovers'), sides: [{ recipeId: 'steak', title: 'Steak' }] }),
    meal('2026-09-23', 'dinner', { ...quickMain('fend') }),
    meal('2026-09-19', 'dinner', { out: true, placeId: 'luna', title: "Luna's Pizza" }),
  ]
  const [cookedDinner, takeout, leftovers, fend, out] = week

  it('takeout is bought: out with no place; leftovers and fend are neither out nor a recipe', () => {
    expect(quickMain('takeout')).toEqual({ quick: 'takeout', title: 'Takeout', out: true })
    expect(quickMain('leftovers')).toEqual({ quick: 'leftovers', title: 'Leftovers' })
    expect(quickMain('fend')).toEqual({ quick: 'fend', title: 'Fend for yourself' })
    expect(QUICK_PICKS).toEqual(['leftovers', 'fend', 'takeout'])
  })

  it('cooks no recipe and has no sides, whatever its row carries — so no grocery line and no "last cooked"', () => {
    for (const m of [takeout, leftovers, fend]) {
      expect(mealRecipeIds(m)).toEqual([])
      expect(mealSides(m)).toEqual([])
      expect(cookedRecipeIds(m, TODAY)).toEqual([])
    }
    const list = buildGroceryList('2026-W39', week, [steak], null, STAMP)
    expect(list.items.map(i => [i.name, i.recipeIds])).toEqual([['Steak', ['steak']]])
    // leftovers of the steak did not cook the steak again
    expect(cookedIndex([steak], week, TODAY).byId.get('steak')).toMatchObject({ timesCooked: 1, lastCooked: '2026-09-20' })
  })

  it('counts in Kitchen Stats as its meal: takeout bought, leftovers eaten in, and only a meal at a place an outing', () => {
    const ix = kitchenIndex([steak], week, [luna], new Date(2026, 8, 24, 20))
    expect(ix.ways.get(takeout.id)).toBe('bought')
    expect(ix.ways.get(leftovers.id)).toBe('cooked')
    expect(ix.ways.get(cookedDinner.id)).toBe('cooked')
    expect(ix.ways.get(out.id)).toBe('out')
    // leftovers are a meal at home, not a recipe cooked
    expect(ix.days.get('steak')).toEqual(['2026-09-20'])
    expect(outingsAt('luna', [], week, new Date(2026, 8, 24, 20)).map(o => (o.kind === 'meal' ? o.meal.id : ''))).toEqual([out.id])
  })

  it('Fend for yourself is no meal had: the rule a count asks (mealWasHad) leaves it out of every way', () => {
    expect(week.map(mealWasHad)).toEqual([true, true, true, false, true])
    // what Kitchen Stats counts once it asks: the night is in no way at all
    const ix = kitchenIndex([steak], week.filter(mealWasHad), [luna], new Date(2026, 8, 24, 20))
    expect(ix.ways.has(fend.id)).toBe(false)
    expect([...ix.ways.values()].sort()).toEqual(['bought', 'cooked', 'cooked', 'out'])
  })

  it('answers the night: the week plan leaves a night with a quick pick alone', () => {
    const next = ['2026-09-27', '2026-09-28'].map(d => meal(d, 'dinner', { ...quickMain(d === '2026-09-27' ? 'fend' : 'leftovers') }))
    const plan = proposeWeek([steak, cooked(steak, '2026-08-01'), ...next], { todayKey: TODAY, now: new Date(2026, 8, 24, 9) })!
    expect(plan.dinners.map(d => d.date)).not.toContain('2026-09-27')
    expect(plan.dinners.map(d => d.date)).not.toContain('2026-09-28')
  })

  it('writes no cook task, and a new main takes the pick off the meal', () => {
    for (const k of QUICK_PICKS) expect(mealHasCookTask({ ...meal(TODAY, 'dinner', quickMain(k)), shared: true })).toBe(false)
    expect(mealHasCookTask({ ...cookedDinner, shared: true })).toBe(true)
    const back = mealWithMain(takeout, { date: takeout.date, slot: 'dinner' }, { recipeId: 'steak', title: 'Steak' }, '2026-09-21T20:00:00.000Z')
    expect(back).not.toHaveProperty('quick')
    expect(back).not.toHaveProperty('out')
    expect(back).toMatchObject({ id: takeout.id, recipeId: 'steak' })
  })
})

// ---- the sanitizers ---------------------------------------------------------------

describe('cookId, quick and favourite through the sanitizers', () => {
  const rawMeal = { kind: 'meal', id: 'm1', date: TODAY, slot: 'dinner', title: 'Hot Dogs', recipeId: 'dogs', shared: true, cookId: ' maria ', createdAt: STAMP, updatedAt: STAMP }
  const rawRecipe = { kind: 'recipe', id: 'r1', name: 'Hot Dogs', ingredients: [], tags: [], favourite: true, createdAt: STAMP, updatedAt: STAMP }

  it('keeps a member id as who cooks, a quick pick by name, and a star only when it is true', () => {
    expect(sanitizeMeal(rawMeal)?.cookId).toBe('maria')
    for (const junk of ['', '   ', null, {}, ['maria']]) expect(sanitizeMeal({ ...rawMeal, cookId: junk })?.cookId).toBeUndefined()
    expect(sanitizeMeal({ ...rawMeal, quick: 'fend' })?.quick).toBe('fend')
    expect(sanitizeMeal({ ...rawMeal, quick: 'pizza' })?.quick).toBeUndefined()
    expect(sanitizeRecipe(rawRecipe)?.favourite).toBe(true)
    for (const junk of ['yes', 1, false, null]) expect(sanitizeRecipe({ ...rawRecipe, favourite: junk })?.favourite).toBeUndefined()
  })

  it('round-trips: what is stored reads back the same', () => {
    for (const raw of [{ ...rawMeal, quick: 'leftovers' }, rawRecipe]) {
      const once = sanitizeItem(raw)
      expect(sanitizeItem(JSON.parse(JSON.stringify(once)))).toEqual(once)
    }
  })

  it('survives a phone on an older build: its sanitizer knew none of them, and they ride along to its next edit', () => {
    // the older build's own answer: the kind's fields it knew, and not these
    const older = <T extends Item>(clean: T, drop: string[]) => {
      const out = { ...clean } as Record<string, unknown>
      for (const k of drop) delete out[k]
      return out as unknown as T
    }
    const raw = { ...rawMeal, quick: 'leftovers' }
    const pulled = withUnknownFields(older(sanitizeMeal(raw)!, ['cookId', 'quick']), raw)
    expect(pulled).toMatchObject({ cookId: ' maria ', quick: 'leftovers' })
    const edited = { ...pulled, notes: 'Buns in the freezer', updatedAt: newerStamp(pulled.updatedAt) }
    // back on this build, as it was
    expect(sanitizeItem(edited)).toMatchObject({ cookId: 'maria', quick: 'leftovers', notes: 'Buns in the freezer' })
    const star = withUnknownFields(older(sanitizeRecipe(rawRecipe)!, ['favourite']), rawRecipe)
    expect(sanitizeItem({ ...star, updatedAt: newerStamp(star.updatedAt) })).toMatchObject({ favourite: true })
  })
})

// ---- who cooks --------------------------------------------------------------------

describe('who cooks a shared dish, and the cook task that is theirs', () => {
  const dogs = recipe('dogs', 'Hot Dogs', { steps: ['Grill the dogs'] })
  const dinner = meal(TODAY, 'dinner', { recipeId: 'dogs', title: 'Hot Dogs', shared: true, cookId: MARIA })

  it('counts a cook only on a shared dish: not out, not a quick pick, not Just me', () => {
    expect(mealCook(dinner)).toBe(MARIA)
    expect(mealCook({ ...dinner, shared: false })).toBeUndefined()
    expect(mealCook({ ...dinner, shared: undefined })).toBeUndefined()
    expect(mealCook({ ...dinner, out: true })).toBeUndefined()
    expect(mealCook({ ...dinner, quick: 'leftovers' })).toBeUndefined()
    // Just me takes the cook with it; a meal out keeps none
    expect(mealAdjusted(dinner, { shared: false })).not.toHaveProperty('cookId')
    expect(mealWithMain(dinner, { date: TODAY, slot: 'dinner' }, { out: true, title: 'Nopi' }, '2026-09-24T19:00:00.000Z')).not.toHaveProperty('cookId')
  })

  it('hands the cook task to the cook, so its reminder rings on their phone alone', () => {
    const task = cookTaskFor(dinner, STAMP, [dogs])
    expect(task).toMatchObject({ id: cookTaskId(dinner.id), assigneeId: MARIA, shared: true })
    expect(isMineTask({ ...task, ownerId: JOE }, MARIA)).toBe(true)
    expect(isMineTask({ ...task, ownerId: JOE }, JOE)).toBe(false)
    // nobody cooking is the cook task as it always was: its owner's
    const nobody = cookTaskFor({ ...dinner, cookId: undefined }, STAMP, [dogs])
    expect(nobody).not.toHaveProperty('assigneeId')
    expect(isMineTask({ ...nobody, ownerId: JOE }, JOE)).toBe(true)
  })

  it('keeps an open cook task with its meal’s cook, and takes it back off them only while it is the meal’s', () => {
    const task = { ...cookTaskFor({ ...dinner, cookId: undefined }, STAMP, [dogs]), ownerId: JOE }
    expect(syncCookTask(task, dinner, [dogs])?.assigneeId).toBe(MARIA)
    // what useCookTaskSync writes back on either phone: the task, handed to her
    expect(cookTaskUpdates([task], [dinner], [dogs]).map(t => t.assigneeId)).toEqual([MARIA])
    expect(syncCookTask({ ...task, assigneeId: MARIA }, dinner, [dogs])).toBeNull()
    expect(cookTaskWithCook(task, undefined, MARIA, JOE)).toMatchObject({ assigneeId: MARIA, assignedBy: JOE })
    expect(cookTaskWithCook({ ...task, assigneeId: MARIA }, MARIA, undefined, JOE)).not.toHaveProperty('assigneeId')
    // handed to Joe on the task itself: not the meal's to take back
    expect(cookTaskWithCook({ ...task, assigneeId: JOE }, MARIA, undefined, JOE).assigneeId).toBe(JOE)
  })

  it('says who is cooking on the card', () => {
    const nameOf = (id: string | undefined) => (id === MARIA ? 'Maria' : id === JOE ? 'Joe' : null)
    const o = { mine: true, myId: JOE, inHousehold: true, nameOf }
    expect(mealWho(dinner, o)).toBe('Both of you · Maria cooks')
    expect(mealWho({ ...dinner, cookId: JOE }, o)).toBe('Both of you · you cook')
    expect(mealWho({ ...dinner, shared: false }, o)).toBe('Just you')
    expect(mealWho({ ...dinner, out: true, cookId: undefined }, o)).toBe('Eat out · both of you')
    expect(mealWho({ ...dinner, ownerId: MARIA }, { ...o, mine: false })).toBe('Maria planned · Maria cooks')
    expect(mealWho(meal(TODAY, 'dinner', { ...quickMain('fend'), shared: true }), o)).toBe('No shared meal')
    expect(mealWho(dinner, { ...o, inHousehold: false })).toBe('')
  })

  /** The planner's own meal path (useLifeActions) over an in-memory store, as Joe in a household. */
  function planner(seed: Item[]) {
    let items: Item[] = seed
    const live = (kind: Item['kind']) => items.filter(i => i.kind === kind && !i.deletedAt)
    const store = {
      myId: JOE,
      get meals() {
        return live('meal') as Meal[]
      },
      get recipes() {
        return live('recipe') as Recipe[]
      },
      get groceries() {
        return live('grocery') as GroceryList[]
      },
      get tasks() {
        return live('task') as Task[]
      },
      people: [],
      places: [],
      upsert: vi.fn((item: Item) => void (items = [...items.filter(i => i.id !== item.id), item])),
      remove: vi.fn((id: string) => void (items = items.map(i => (i.id === id ? { ...i, deletedAt: '2026-09-24T20:00:00.000Z' } : i)))),
    }
    let life!: ReturnType<typeof useLifeActions>
    function Shell() {
      life = useLifeActions({ store: store as unknown as Store, showToast: () => {}, newTask: () => {}, inHousehold: true })
      return null
    }
    renderToString(<Shell />)
    return { life, task: (id: string) => items.find(i => i.id === cookTaskId(id)) as Task | undefined }
  }

  it('is written that way through the planner’s save path: handed over, handed back, and gone with a quick pick', () => {
    const p = planner([dogs])
    p.life.saveMeal(dinner)
    expect(p.task(dinner.id)).toMatchObject({ assigneeId: MARIA, assignedBy: JOE, status: 'todo' })
    p.life.saveMeal(mealAdjusted(dinner, { cookId: JOE }))
    expect(p.task(dinner.id)).toMatchObject({ assigneeId: JOE })
    p.life.saveMeal(mealAdjusted(dinner, { cookId: '' }))
    expect(p.task(dinner.id)).not.toHaveProperty('assigneeId')
    // leftovers have nothing to cook: the open task goes
    p.life.saveMeal(mealPicked(dinner, { date: TODAY, slot: 'dinner' }, quickMain('leftovers'), { userId: JOE, now: '2026-09-24T21:00:00.000Z' }))
    expect(p.task(dinner.id)?.deletedAt).toBeTruthy()
  })
})

// ---- meal ids ---------------------------------------------------------------------

describe('every meal writer uses the member’s own id for a new meal', () => {
  // Maria's private lunch from before members had rows of their own: the
  // household-wide id, and not Joe's to write — RLS refuses it, or worse
  const hers: Meal = { kind: 'meal', id: `meal~${TODAY}~lunch`, date: TODAY, slot: 'lunch', title: 'CFA NOT COOKING', shared: false, ownerId: MARIA, createdAt: STAMP, updatedAt: STAMP }
  const soup = recipe('soup', 'Soup', { ingredients: [{ id: 'i1', name: 'Leeks' }] })
  const at = { date: TODAY, slot: 'lunch' as const }
  const now = '2026-09-24T11:00:00.000Z'

  it('Joe planning his lunch the day Maria has a private legacy-id one makes a new row of his, and never touches hers', () => {
    const meals = [hers]
    const { mine, theirs } = mealsForSlot(meals, TODAY, 'lunch', JOE)
    expect(mine).toBeUndefined()
    // hers is private: not even named
    expect(theirs).toEqual([])
    const next = mealPicked(mine, at, { recipeId: 'soup', title: 'Soup' }, { userId: JOE, now, shared: false })
    expect(next).toMatchObject({ id: `meal~${TODAY}~lunch~${JOE}`, recipeId: 'soup', shared: false })
    // …and the week's grocery list it rebuilds is his own row too: never her
    // list under the household-wide id, which he is not to rebuild with his meals
    const herList: GroceryList = { kind: 'grocery', id: 'grocery~2026-W38', weekKey: '2026-W38', ownerId: MARIA, items: [{ id: 'g1', name: 'Milk', state: 'need', recipeIds: [], manual: true }], createdAt: STAMP, updatedAt: STAMP }
    const writes = mealWrites(next, null, meals, [soup], [herList], JOE)
    expect(writes.map(w => w.id)).toEqual([next.id, `grocery~2026-W38~${JOE}`])
    expect(writes.some(w => w.id === hers.id || w.id === herList.id)).toBe(false)
    expect(meals).toEqual([hers])
    // handed her row by mistake, the pick still builds a row of his own
    expect(mealPicked(hers, at, { recipeId: 'soup', title: 'Soup' }, { userId: JOE, now }).id).toBe(`meal~${TODAY}~lunch~${JOE}`)
    // …while a legacy row of his own is his to edit, id and all
    const his = { ...hers, ownerId: JOE, title: 'Toast' }
    expect(mealPicked(his, at, { recipeId: 'soup', title: 'Soup' }, { userId: JOE, now }).id).toBe(hers.id)
  })

  it('Today’s ideas and Plan my day (mealFromIdea)', () => {
    const idea = { key: 'k', kind: 'recipe' as const, id: 'soup', title: 'Soup', why: '' }
    expect(mealFromIdea(TODAY, 'lunch', idea, undefined, new Date(2026, 8, 24, 11), JOE).id).toBe(`meal~${TODAY}~lunch~${JOE}`)
    expect(mealFromIdea(TODAY, 'lunch', idea, hers, new Date(2026, 8, 24, 11), JOE).id).toBe(`meal~${TODAY}~lunch~${JOE}`)
  })

  it('the planning sheets’ picks: their stand-in meals, and what Plan this week’s meals writes', () => {
    expect(planSheetMeal(TODAY, 'lunch', { kind: 'recipe', id: 'soup', title: 'Soup' }, JOE)?.id).toBe(`meal~${TODAY}~lunch~${JOE}`)
    expect(weekSheetMeal(TODAY, { recipeId: 'soup', title: 'Soup' }, JOE)?.id).toBe(`meal~${TODAY}~dinner~${JOE}`)
    const out = mealsForPicks([{ date: TODAY, slot: 'dinner', choice: { kind: 'recipe', id: 'soup', title: 'Soup' } }], {
      recipes: [soup],
      places: [],
      meals: [],
      createRecipe: () => soup,
      now: new Date(2026, 8, 24, 11),
      myId: JOE,
    })
    expect(out.meals.map(m => m.id)).toEqual([`meal~${TODAY}~dinner~${JOE}`])
  })

  it('Plan next week and the assistant’s plan_meal card', () => {
    const hersDinner = { ...hers, id: `meal~2026-09-27~dinner`, date: '2026-09-27', slot: 'dinner' as const, shared: true }
    const plan = { week: { startKey: '2026-09-27', dayKeys: weekDayKeys('2026-09-27'), weekKey: '2026-W40', prevWeekKey: '2026-W39' }, dinners: [], people: [], overdue: [], bills: [], top3: [] }
    const accepted = { dinners: [{ date: '2026-09-28', recipeId: 'soup', title: 'Soup' }], people: [], resched: [], wishlist: [], top3: [], dismissed: [] }
    const w = weekPlanWrites({ tasks: [], items: [hersDinner], reviews: [] }, plan, accepted, { myId: JOE, now: new Date(2026, 8, 24, 9), newId: () => 'x' })
    expect(w.meals.map(m => m.id)).toEqual([`meal~2026-09-28~dinner~${JOE}`])
    const chat = mealPlan({ type: 'plan_meal', date: TODAY, slot: 'lunch', dish: { name: 'Soup', id: 'soup' } }, { mealRows: [hers], places: [], myId: JOE, inHousehold: true }, { now: new Date(2026, 8, 24, 9), recipe: soup })
    expect(chat?.meal.id).toBe(`meal~${TODAY}~lunch~${JOE}`)
    expect(chat?.before).toBeNull()
  })
})
