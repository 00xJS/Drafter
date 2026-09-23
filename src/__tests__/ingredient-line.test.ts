import { describe, expect, it } from 'vitest'
import { canonicalUnit, ingredientName, parseIngredientLine, parseQuantity } from '../../shared/recipes.mjs'
import { buildGroceryList } from '../kitchen'
import type { Meal, Recipe } from '../types'

// One reader for an ingredient line, shared by the server's import from a
// link and the app's ✨ Fill in, so "1 1/2 cups flour, sifted" arrives the same
// way from either and adds up with the rest on the grocery list.

describe('parseIngredientLine', () => {
  it.each([
    ['2 large onions, diced', { name: 'onions', qty: 2 }],
    ['1 (14-ounce) can coconut milk', { name: 'coconut milk', qty: 1, unit: 'can' }],
    ['½ tsp salt', { name: 'salt', qty: 0.5, unit: 'tsp' }],
    ['200g flour', { name: 'flour', qty: 200, unit: 'g' }],
    ['1.5kg potatoes', { name: 'potatoes', qty: 1.5, unit: 'kg' }],
    ['1 1/2 cups all-purpose flour, sifted', { name: 'all-purpose flour', qty: 1.5, unit: 'cup' }],
    ['1½ lb. ground beef', { name: 'ground beef', qty: 1.5, unit: 'lb' }],
    ['2-3 tbsp olive oil', { name: 'olive oil', qty: 2, unit: 'tbsp' }],
    ['4 boneless, skinless chicken breasts', { name: 'boneless, skinless chicken breasts', qty: 4 }],
    ['3 cloves garlic, minced', { name: 'garlic', qty: 3, unit: 'clove' }],
    ['4 garlic cloves, minced', { name: 'garlic', qty: 4, unit: 'clove' }],
    ['4 cloves', { name: 'cloves', qty: 4 }],
    ['a pinch of salt', { name: 'salt', qty: 1, unit: 'pinch' }],
    ['1 cup (2 sticks) butter, softened', { name: 'butter', qty: 1, unit: 'cup' }],
    ['2 (15 ounce) cans black beans, rinsed and drained', { name: 'black beans', qty: 2, unit: 'can' }],
    ['1 fl oz lime juice', { name: 'lime juice', qty: 1, unit: 'fl oz' }],
    ['1-inch piece ginger', { name: 'ginger', qty: 1, unit: 'piece' }],
    ['2 tablespoons + 1 teaspoon soy sauce', { name: 'soy sauce', qty: 2, unit: 'tbsp' }],
    ['1 cup sugar plus 2 tbsp for dusting', { name: 'sugar', qty: 1, unit: 'cup' }],
    ['Salt and pepper to taste', { name: 'Salt and pepper' }],
    ['Salt, to taste', { name: 'Salt' }],
    ['1/4 cup fresh parsley (optional)', { name: 'fresh parsley', qty: 0.25, unit: 'cup' }],
    ['• 2 cups milk', { name: 'milk', qty: 2, unit: 'cup' }],
    ['1,5 l water', { name: 'water', qty: 1.5, unit: 'l' }],
    ['Juice of 1 lemon', { name: 'Juice of 1 lemon' }],
    ['Kosher salt', { name: 'Kosher salt' }],
  ])('%s', (line, want) => {
    expect(parseIngredientLine(line)).toEqual(want)
  })

  it('is no ingredient for an empty line or a heading', () => {
    expect(parseIngredientLine('')).toBeNull()
    expect(parseIngredientLine('   ')).toBeNull()
    expect(parseIngredientLine('For the sauce:')).toBeNull()
    expect(parseIngredientLine(null)).toBeNull()
  })

  it('never keeps a quantity a shopping list should not add up', () => {
    expect(parseIngredientLine('0 cups sugar')).toEqual({ name: 'sugar', unit: 'cup' })
    expect(parseIngredientLine('20000 g flour')).toEqual({ name: 'flour', unit: 'g' })
  })
})

describe('the pieces', () => {
  it('reads a quantity, or nothing', () => {
    expect([parseQuantity('1/2'), parseQuantity('1 1/2'), parseQuantity('1½'), parseQuantity('½'), parseQuantity('2-3'), parseQuantity(' 3 '), parseQuantity(2.555)]).toEqual([0.5, 1.5, 1.5, 0.5, 2, 3, 2.56])
    expect([parseQuantity('a pinch'), parseQuantity(0), parseQuantity(-1), parseQuantity('1e5'), parseQuantity(20_000), parseQuantity('1/0'), parseQuantity(null)]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined])
  })

  it('spells a unit the app’s way', () => {
    expect([canonicalUnit('Tablespoons'), canonicalUnit('cups'), canonicalUnit('lbs.'), canonicalUnit('Fluid Ounces'), canonicalUnit('large'), canonicalUnit(''), canonicalUnit('widgets')]).toEqual(['tbsp', 'cup', 'lb', 'fl oz', '', '', null])
  })

  it('names an ingredient as a shop would', () => {
    expect(ingredientName('large onions, finely chopped')).toBe('onions')
    expect(ingredientName('boneless, skinless chicken breasts')).toBe('boneless, skinless chicken breasts')
  })

  it('makes cups and cup one grocery line', () => {
    const at = (name: string, lines: string[]): Recipe => ({
      kind: 'recipe',
      id: name,
      name,
      ingredients: lines.map((l, i) => ({ id: `${name}${i}`, ...parseIngredientLine(l)! })),
      tags: [],
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    })
    const dinner = (date: string, recipeId: string): Meal => ({ kind: 'meal', id: `meal~${date}`, date, slot: 'dinner', recipeId, title: recipeId, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' })
    const list = buildGroceryList('2026-W38', [dinner('2026-09-16', 'a'), dinner('2026-09-17', 'b')], [at('a', ['2 cups rice']), at('b', ['1 cup rice'])])
    expect(list.items.map(i => [i.name, i.qty, i.unit])).toEqual([['rice', 3, 'cup']])
  })
})
