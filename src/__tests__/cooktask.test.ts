import { describe, expect, it } from 'vitest'
import { COOK_NOTE_LINE, cookChecklist, cookDescription, cookTaskFor, cookTaskId, cookTaskUpdates, mealId, saveCookToRecipe, syncCookTask } from '../kitchen'
import type { Meal, Recipe, Task } from '../types'

// A shared dinner writes a cook task. It used to say "Planned in Kitchen for
// the household." and nothing else, so the steps were only in cook mode. Now
// the task carries the recipe: its steps to tick off, its ingredients and notes
// to read — and stays in step when the recipe changes.

const STAMP = '2026-09-22T09:00:00.000Z'

const steak: Recipe = {
  kind: 'recipe',
  id: 'r-steak',
  name: 'Steak & veggies',
  servings: 4,
  ingredients: [
    { id: 'i1', name: 'Beef', qty: 1, unit: 'lb' },
    { id: 'i2', name: 'Small red potatoes' },
  ],
  steps: [
    'Broccoli will be in foil packet',
    'Cut smalls potatoes in half',
    'Preheat oven at 400',
    'Cook potatoes first',
    'Coat them in oil throw seasonings (seasoned salt) cook for 25 mins',
    'The. Cook veggies for 25 mins',
    'Cook steak',
  ],
  tags: [],
  notes: 'Broccoli is in foil packet on top shelf\nPotatoes are small red/purple new bag by coffee machine',
  createdAt: STAMP,
  updatedAt: STAMP,
}

const rice: Recipe = { kind: 'recipe', id: 'r-rice', name: 'Rice', ingredients: [{ id: 'i3', name: 'Rice', qty: 2, unit: 'cup' }], steps: ['Cook rice in rice cooker'], tags: [], createdAt: STAMP, updatedAt: STAMP }

const dinner: Meal = {
  kind: 'meal',
  id: mealId('2026-09-22', 'dinner', 'maria'),
  date: '2026-09-22',
  slot: 'dinner',
  title: 'Steak & veggies',
  recipeId: 'r-steak',
  shared: true,
  ownerId: 'maria',
  createdAt: STAMP,
  updatedAt: STAMP,
}

describe('a shared dinner\'s cook task carries its recipe', () => {
  it('lists every step to tick, and the ingredients and notes to read', () => {
    const t = cookTaskFor(dinner, STAMP, [steak])
    expect(t.id).toBe(cookTaskId(dinner.id))
    expect(t.title).toBe('Cook dinner: Steak & veggies')
    expect(t.checklist?.map(i => i.text)).toEqual(steak.steps)
    expect(t.checklist?.every(i => !i.done)).toBe(true)
    expect(t.description).toContain('Planned in Kitchen for the household: Steak & veggies.')
    expect(t.description).toContain('• 1 lb Beef')
    expect(t.description).toContain('• Small red potatoes')
    expect(t.description).toContain('Broccoli is in foil packet on top shelf')
    expect(t.description?.trimEnd().endsWith(COOK_NOTE_LINE)).toBe(true)
  })

  it('adds each side that is a recipe, named', () => {
    const withRice: Meal = { ...dinner, sides: [{ title: 'Rice', recipeId: 'r-rice' }] }
    const t = cookTaskFor(withRice, STAMP, [steak, rice])
    expect(t.checklist?.[t.checklist.length - 1]?.text).toBe('Rice: Cook rice in rice cooker')
    expect(t.description).toContain('Rice: ingredients\n• 2 cup Rice')
  })

  it('says where the steps come from when the recipe has none yet', () => {
    const bare: Recipe = { ...steak, steps: [], ingredients: [], notes: undefined }
    const t = cookTaskFor(dinner, STAMP, [bare])
    expect(t.checklist).toBeUndefined()
    expect(t.description).toMatch(/No steps yet: add them to the recipe in Kitchen/)
  })

  it('gives a meal eaten out no steps and no nagging', () => {
    const out: Meal = { ...dinner, out: true, recipeId: undefined, title: 'Taco Bell' }
    const t = cookTaskFor(out, STAMP, [steak])
    expect(t.title).toBe('Eat dinner: Taco Bell')
    expect(t.checklist).toBeUndefined()
    expect(t.description).not.toMatch(/No steps yet/)
  })
})

describe('the checklist stays in step with the recipe', () => {
  it('keeps a tick while the step\'s words stay the same, and drops a step the recipe lost', () => {
    const first = cookChecklist(dinner, [steak])
    const ticked = first.map((i, n) => (n < 2 ? { ...i, done: true } : i))
    // the recipe is edited: step 2 reworded, the last step removed
    const edited: Recipe = { ...steak, steps: [steak.steps![0], 'Cut small potatoes in half', ...steak.steps!.slice(2, 6)] }
    const next = cookChecklist(dinner, [edited], ticked)
    expect(next.map(i => i.text)).toEqual(edited.steps)
    expect(next[0].done).toBe(true) // unchanged words: still ticked
    expect(next[1].done).toBe(false) // reworded: a new step
    expect(next.some(i => i.text === 'Cook steak')).toBe(false)
  })

  it('keeps the items the person added by hand, after the recipe\'s', () => {
    const own = { id: 'mine-1', text: 'Set the table', done: true }
    const next = cookChecklist(dinner, [steak], [...cookChecklist(dinner, [steak]), own])
    expect(next[next.length - 1]).toEqual(own)
    expect(next).toHaveLength(steak.steps!.length + 1)
  })

  it('gives the same words twice two steps, each with its own tick', () => {
    const twice: Recipe = { ...steak, steps: ['Stir', 'Wait 5 mins', 'Stir'] }
    const list = cookChecklist(dinner, [twice])
    expect(new Set(list.map(i => i.id)).size).toBe(3)
    const next = cookChecklist(dinner, [twice], list.map((i, n) => (n === 2 ? { ...i, done: true } : i)))
    expect(next.map(i => i.done)).toEqual([false, false, true])
  })
})

describe('the description keeps the person\'s own notes', () => {
  it('rewrites Kitchen\'s part and keeps what was written below its line', () => {
    const before = `${cookDescription(dinner, [steak])}\n\nBuy foil if we're out`
    const moreNotes: Recipe = { ...steak, notes: 'Broccoli is in the freezer now' }
    const after = cookDescription(dinner, [moreNotes], before)
    expect(after).toContain('Broccoli is in the freezer now')
    expect(after).not.toContain('top shelf')
    expect(after.endsWith(`${COOK_NOTE_LINE}\n\nBuy foil if we're out`)).toBe(true)
  })

  it('turns the old one-line description into the new one, and keeps a hand-written one', () => {
    expect(cookDescription(dinner, [steak], 'Planned in Kitchen for the household.').endsWith(COOK_NOTE_LINE)).toBe(true)
    expect(cookDescription(dinner, [steak], 'Use the cast iron').endsWith(`${COOK_NOTE_LINE}\n\nUse the cast iron`)).toBe(true)
  })
})

describe('syncCookTask and cookTaskUpdates', () => {
  // the task as it was written before this change: one line, no steps
  const legacy: Task = {
    kind: 'task',
    id: cookTaskId(dinner.id),
    title: 'Cook dinner: Steak & veggies',
    description: 'Planned in Kitchen for the household.',
    status: 'todo',
    priority: 'normal',
    dueAt: '2026-09-23T01:00:00.000Z',
    tags: ['meal'],
    shared: true,
    createdAt: STAMP,
    updatedAt: STAMP,
  }

  it('fills in a cook task written before it carried its recipe', () => {
    const [next] = cookTaskUpdates([legacy], [dinner], [steak])
    expect(next.checklist).toHaveLength(7)
    expect(next.description).toContain('• 1 lb Beef')
    expect(next.updatedAt > legacy.updatedAt).toBe(true)
  })

  it('writes nothing when the task is already in step, so the planner does not loop', () => {
    const [next] = cookTaskUpdates([legacy], [dinner], [steak])
    expect(syncCookTask(next, dinner, [steak])).toBeNull()
    expect(cookTaskUpdates([next], [dinner], [steak])).toEqual([])
  })

  it('leaves a finished or cancelled cook task as it was, and ignores other tasks', () => {
    expect(syncCookTask({ ...legacy, status: 'done' }, dinner, [steak])).toBeNull()
    expect(syncCookTask({ ...legacy, status: 'canceled' }, dinner, [steak])).toBeNull()
    expect(cookTaskUpdates([{ ...legacy, id: 'plain-task' }], [dinner], [steak])).toEqual([])
    // a cook task whose meal is gone is not rewritten
    expect(cookTaskUpdates([legacy], [], [steak])).toEqual([])
  })

  it('follows a recipe that was filled in after the dinner was planned', () => {
    const bare: Recipe = { ...steak, steps: [], ingredients: [], notes: undefined }
    const [planned] = cookTaskUpdates([legacy], [dinner], [bare])
    expect(planned.checklist ?? []).toHaveLength(0)
    const [filled] = cookTaskUpdates([planned], [dinner], [steak])
    expect(filled.checklist).toHaveLength(7)
    expect(filled.description).not.toMatch(/No steps yet/)
  })
})

describe('Save to recipe keeps what was written on a cook task for next time', () => {
  const now = '2026-09-22T20:00:00.000Z'
  const newId = () => 'r-new'

  it('adds the steps and notes written on the task to the recipe, and the task keeps its ticks', () => {
    const base = cookTaskFor(dinner, STAMP, [steak])
    const withMine: Task = {
      ...base,
      checklist: [...(base.checklist ?? []).map((i, n) => (n === 0 ? { ...i, done: true } : i)), { id: 'own-1', text: 'Let the steak rest 5 mins', done: true }],
      description: `${base.description}\n\nUse the cast iron`,
    }
    const saved = saveCookToRecipe(withMine, dinner, [steak], { now, newId })!
    expect(saved.created).toBe(false)
    expect(saved.recipe.steps).toEqual([...steak.steps!, 'Let the steak rest 5 mins'])
    expect(saved.recipe.notes).toContain('Broccoli is in foil packet on top shelf')
    expect(saved.recipe.notes).toContain('Use the cast iron')
    expect(saved.recipe.updatedAt > steak.updatedAt).toBe(true)
    // the moved step is now the recipe's, listed once and still ticked; the first step keeps its tick
    const moved = saved.task.checklist!.filter(i => i.text === 'Let the steak rest 5 mins')
    expect(moved).toHaveLength(1)
    expect(moved[0]).toMatchObject({ done: true })
    expect(moved[0].id.startsWith('cook~')).toBe(true)
    expect(saved.task.checklist![0].done).toBe(true)
    // the notes read from the recipe now, and nothing is left below Kitchen's line
    expect(saved.task.description).toContain('Use the cast iron')
    expect(saved.task.description!.endsWith(COOK_NOTE_LINE)).toBe(true)
    // and the planner's own sync finds nothing more to do
    expect(syncCookTask(saved.task, dinner, [saved.recipe])).toBeNull()
  })

  it('has nothing to save when the task holds only what the recipe has', () => {
    expect(saveCookToRecipe(cookTaskFor(dinner, STAMP, [steak]), dinner, [steak], { now, newId })).toBeNull()
  })

  it('makes a meal that is not a recipe into one, and links the meal to it', () => {
    const typed: Meal = { ...dinner, recipeId: undefined, title: "Grandma's chili", notes: 'Double the beans' }
    const base = cookTaskFor(typed, STAMP, [])
    const withMine: Task = {
      ...base,
      checklist: [
        { id: 'own-1', text: 'Brown the beef', done: false },
        { id: 'own-2', text: 'Simmer 2 hours', done: false },
      ],
    }
    const saved = saveCookToRecipe(withMine, typed, [], { now, newId })!
    expect(saved.created).toBe(true)
    expect(saved.recipe).toMatchObject({ kind: 'recipe', id: 'r-new', name: "Grandma's chili", steps: ['Brown the beef', 'Simmer 2 hours'], notes: 'Double the beans' })
    expect(saved.meal?.recipeId).toBe('r-new')
    expect(saved.task.checklist!.map(i => i.text)).toEqual(['Brown the beef', 'Simmer 2 hours'])
    expect(saved.task.description).not.toMatch(/No steps yet/)
    expect(syncCookTask(saved.task, saved.meal!, [saved.recipe])).toBeNull()
  })

  it('leaves a meal eaten out alone', () => {
    const out: Meal = { ...dinner, out: true, recipeId: undefined, title: 'Taco Bell' }
    expect(saveCookToRecipe(cookTaskFor(out, STAMP, []), out, [], { now, newId })).toBeNull()
  })
})
