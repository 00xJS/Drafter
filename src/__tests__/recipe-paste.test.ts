import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '../api'
import { buildReadRecipePrompt, parseReadRecipe, readRecipe } from '../ai'
import { buildGroceryList } from '../kitchen'
import type { Meal, Recipe } from '../types'

// Thirty recipes were saved as bare names, because the only way to fill one in
// was "+ Ingredient", one row at a time. A recipe with no ingredients can never
// put a line on the grocery list (groceryFromRecipes in shared/kitchen.mjs), so
// the list was always empty and nobody could see why. Reading a pasted recipe
// is the way in; these hold it to what the app stores.

const reply = (text: string) => ({ ok: true, status: 200, json: async () => ({ text }) }) as unknown as Response
const mock = vi.mocked(apiFetch)

beforeEach(() => mock.mockReset())

describe('parseReadRecipe', () => {
  it('reads the shape the editor fills in', () => {
    const found = parseReadRecipe(
      JSON.stringify({
        name: 'Chicken Parm',
        servings: 4,
        ingredients: [{ name: 'chicken breasts', qty: 2 }, { name: 'passata', qty: 400, unit: 'g' }, 'parmesan'],
        steps: ['1. Heat the oven to 200C', '2) Flatten the chicken'],
      }),
    )
    expect(found).toEqual({
      name: 'Chicken Parm',
      servings: 4,
      ingredients: [{ name: 'chicken breasts', qty: 2 }, { name: 'passata', qty: 400, unit: 'g' }, { name: 'parmesan' }],
      steps: ['Heat the oven to 200C', 'Flatten the chicken'],
    })
  })

  it('drops a quantity it cannot trust rather than guessing one', () => {
    // a wrong qty quietly doubles a grocery line, which is worse than none
    const { ingredients } = parseReadRecipe(
      JSON.stringify({ ingredients: [{ name: 'salt', qty: 'a pinch' }, { name: 'flour', qty: -1 }, { name: 'rice', qty: '2' }] }),
    )
    expect(ingredients).toEqual([{ name: 'salt' }, { name: 'flour' }, { name: 'rice', qty: 2 }])
  })

  it('omits servings it cannot trust, so the editor keeps what is there', () => {
    expect(parseReadRecipe(JSON.stringify({ servings: 0 })).servings).toBeUndefined()
    expect(parseReadRecipe(JSON.stringify({ servings: 900 })).servings).toBeUndefined()
    expect(parseReadRecipe(JSON.stringify({ servings: '6' })).servings).toBe(6)
  })

  it('throws away an ingredient with no name, and caps the lists', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `thing ${i}` }))
    const found = parseReadRecipe(JSON.stringify({ ingredients: [{ qty: 2 }, ...many], steps: Array.from({ length: 30 }, (_, i) => `step ${i}`) }))
    expect(found.ingredients).toHaveLength(20)
    expect(found.ingredients[0]).toEqual({ name: 'thing 0' })
    expect(found.steps).toHaveLength(12)
  })

  it('survives a reply that is not the object asked for', () => {
    expect(parseReadRecipe('["onion"]')).toEqual({ name: '', servings: undefined, ingredients: [], steps: [] })
    expect(() => parseReadRecipe('sorry, I could not read that')).toThrow()
  })
})

describe('the prompt', () => {
  it('asks for a name a shop would know, and forbids scaling or inventing', () => {
    const { system } = buildReadRecipePrompt('2 large onions, diced')
    expect(system).toContain('look for in a shop')
    expect(system).toContain('Halve nothing and scale nothing')
    expect(system).toContain('never invent an ingredient')
  })

  it('sends a bounded amount of text, so a whole web page cannot run the budget out', () => {
    const { prompt } = buildReadRecipePrompt('x'.repeat(50_000))
    expect(prompt.length).toBeLessThan(8200)
  })
})

describe('readRecipe', () => {
  it('asks for JSON, with room for a model that reasons first', async () => {
    mock.mockResolvedValueOnce(reply('{"name":"Spaghetti","ingredients":[{"name":"mince","qty":500,"unit":"g"}],"steps":["Brown the mince"]}'))
    await expect(readRecipe('Spaghetti\n500g mince\nBrown the mince')).resolves.toMatchObject({ name: 'Spaghetti' })
    const sent = JSON.parse(String(mock.mock.calls[0][1]?.body))
    expect(sent.json).toBe(true)
    expect(sent.maxTokens).toBeGreaterThanOrEqual(2048)
  })
})

describe('what it unblocks', () => {
  const recipe = (name: string, ingredients: Recipe['ingredients']): Recipe => ({
    kind: 'recipe',
    id: name,
    name,
    ingredients,
    tags: [],
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
  })
  const meal = (date: string, recipeId: string): Meal => ({
    kind: 'meal',
    id: `meal~${date}~dinner`,
    date,
    slot: 'dinner',
    title: recipeId,
    recipeId,
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
  })

  it('a recipe with no ingredients puts nothing on the grocery list; a read one does', () => {
    const bare = recipe('Spaghetti', [])
    const meals = [meal('2026-09-17', 'Spaghetti')]
    expect(buildGroceryList('2026-W38', meals, [bare]).items).toHaveLength(0)

    const read = parseReadRecipe(JSON.stringify({ ingredients: [{ name: 'mince', qty: 500, unit: 'g' }, { name: 'passata' }] }))
    const filled = recipe('Spaghetti', read.ingredients.map((i, n) => ({ ...i, id: `i${n}` })))
    expect(buildGroceryList('2026-W38', meals, [filled]).items.map(i => i.name)).toEqual(['mince', 'passata'])
  })
})
