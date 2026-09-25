// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from './dom'
import { useState } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', async importOriginal => ({ ...(await importOriginal<typeof import('../api')>()), apiFetch: vi.fn() }))
import { apiFetch } from '../api'
import { Kitchen, preloadKitchenSheets } from '../components/Kitchen'
import { recipeDraftId } from '../../shared/recipefill.mts'
import type { Item, Recipe, RecipeDraftRecord } from '../types'

// Kitchen → Recipes → Fill them in, with drafts made overnight (v3.35), as a
// thumb goes through it: the button counts the ready ones, a waiting draft is
// on screen the moment the sheet reaches its recipe — no call — and Save puts
// it into the recipe and removes it, Skip keeps it marked, a recipe with
// nothing waiting is drafted live as before, and the skipped come back only
// when brought back. Every write lands in a store of the test's own.

const T0 = '2026-09-20T10:00:00.000Z'
const JOE = 'joe'
const MARIA = 'maria'
const mock = vi.mocked(apiFetch)
const reply = (text: string) => ({ ok: true, status: 200, json: async () => ({ text }) }) as unknown as Response

const recipe = (id: string, name: string, over: Partial<Recipe> = {}): Recipe => ({ kind: 'recipe', id, name, ingredients: [], tags: [], ownerId: MARIA, createdAt: T0, updatedAt: T0, ...over })
const waiting = (recipeId: string, ingredient: string, over: Partial<RecipeDraftRecord> = {}): RecipeDraftRecord => ({
  kind: 'recipedraft',
  id: recipeDraftId(recipeId),
  recipeId,
  servings: 4,
  ingredients: [
    { name: ingredient, qty: 2, unit: 'lb' },
    { name: 'onion', qty: 1 },
  ],
  steps: [`Brown the ${ingredient}.`, 'Simmer it.'],
  draftedAt: T0,
  model: 'nvidia/nemotron-3-super-120b-a12b',
  triedAt: T0,
  ownerId: MARIA,
  createdAt: T0,
  updatedAt: T0,
  ...over,
})

// The fill sheet loads from a chunk of its own on its first tap; here it is
// loaded before anything is drawn, so a tap draws it at once.
beforeAll(async () => {
  await preloadKitchenSheets()
})

beforeEach(() => {
  mock.mockReset()
  mock.mockRejectedValue(new Error('no assistant call was expected here'))
  localStorage.setItem('drafter:kitchen-tab', 'recipes')
})
afterEach(() => {
  vi.restoreAllMocks()
})

/** The Kitchen over a store of its own, as Joe: what it saves lands, and the drafts it is handed are the live ones, as the store's are. */
function openKitchen(items: Item[]) {
  const saved: Item[] = []
  const store: { rows: Item[] } = { rows: items }
  function Shell() {
    const [rows, setRows] = useState<Item[]>(items)
    store.rows = rows
    const live = <K extends Item['kind']>(kind: K) => rows.filter((i): i is Extract<Item, { kind: K }> => i.kind === kind && !i.deletedAt)
    return (
      <Kitchen
        myId={JOE}
        recipes={live('recipe')}
        recipeDrafts={live('recipedraft')}
        meals={[]}
        groceries={[]}
        places={[]}
        onSave={item => {
          saved.push(item)
          setRows(list => [...list.filter(x => x.id !== item.id), item])
        }}
        onDelete={() => {}}
        onSaveMeal={() => {}}
        onClearMeal={() => {}}
        onCreatePlace={() => {
          throw new Error('not here')
        }}
        onCreateRecipe={() => {
          throw new Error('not here')
        }}
      />
    )
  }
  render(<Shell />)
  const row = (id: string) => store.rows.find(i => i.id === id)
  return { saved, row }
}

describe('Fill them in, with drafts made ahead of time', () => {
  it('shows each waiting draft at once; Save fills the recipe and removes it; Skip keeps it marked; the rest are drafted live', async () => {
    const { saved, row } = openKitchen([
      recipe('curry', 'Chicken curry', { updatedAt: '2026-09-21T00:00:00.000Z' }),
      recipe('stew', 'Beef stew'),
      recipe('dal', 'Dal'),
      recipe('pie', 'Apple pie', { ingredients: [{ id: 'i1', name: 'apples', qty: 6 }] }),
      waiting('curry', 'chicken thighs'),
      waiting('stew', 'beef chuck'),
    ])
    // three recipes have nothing to shop for; two are ready
    expect(screen.getByText('3 recipes have no ingredients — the grocery list can’t use them.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Fill them in · 2 ready' }))

    // the ready ones first, in the queue's order (by name, with nothing planned or cooked): the stew, on screen at once
    const sheet = () => within(screen.getByRole('dialog', { name: 'Fill in recipes' }))
    expect(sheet().getByText('Recipe 1 of 3')).toBeTruthy()
    expect(sheet().getByRole('heading', { name: 'Beef stew' })).toBeTruthy()
    expect(sheet().getByText('Drafted ahead of time — nothing is saved until you tap Save.')).toBeTruthy()
    expect(sheet().getByText('2 lb beef chuck')).toBeTruthy()
    expect(mock).not.toHaveBeenCalled()

    // Save: the recipe gets the draft, and the waiting draft is removed
    fireEvent.click(sheet().getByRole('button', { name: 'Save' }))
    const filled = row('stew') as Recipe
    expect(filled.ingredients.map(i => [i.qty, i.unit, i.name])).toEqual([
      [2, 'lb', 'beef chuck'],
      [1, undefined, 'onion'],
    ])
    expect(filled.steps).toEqual(['Brown the beef chuck.', 'Simmer it.'])
    expect(row(recipeDraftId('stew'))).toMatchObject({ kind: 'recipedraft', purged: true, deletedAt: expect.any(String), ingredients: [], ownerId: MARIA })

    // the curry, at once too; Skip keeps it, marked by Joe
    expect(sheet().getByText('Recipe 2 of 3 · 1 saved')).toBeTruthy()
    expect(sheet().getByRole('heading', { name: 'Chicken curry' })).toBeTruthy()
    expect(sheet().getByText('Drafted ahead of time — nothing is saved until you tap Save.')).toBeTruthy()
    expect(mock).not.toHaveBeenCalled()
    // (the dal, next, has nothing waiting: the sheet asks for it the moment it gets there)
    mock.mockResolvedValueOnce(reply('{"servings":2,"ingredients":[{"name":"red lentils","qty":1,"unit":"cup"}],"steps":["Simmer the lentils."]}'))
    fireEvent.click(sheet().getByRole('button', { name: 'Skip' }))
    expect(row(recipeDraftId('curry'))).toMatchObject({ skippedBy: JOE, skippedAt: expect.any(String), ingredients: waiting('curry', 'chicken thighs').ingredients, ownerId: MARIA })
    expect((row('curry') as Recipe).ingredients).toEqual([])

    // the dal: drafted live, as before
    expect(sheet().getByText('Recipe 3 of 3 · 1 saved · 1 skipped')).toBeTruthy()
    await waitFor(() => expect(sheet().getByText('1 cup red lentils')).toBeTruthy())
    expect(mock).toHaveBeenCalledTimes(1)
    expect(sheet().queryByText(/Drafted ahead of time/)).toBeNull()
    // skipped, its live draft is kept for next time
    fireEvent.click(sheet().getByRole('button', { name: 'Skip' }))
    expect(row(recipeDraftId('dal'))).toMatchObject({ recipeId: 'dal', ingredients: [{ name: 'red lentils', qty: 1, unit: 'cup' }], skippedBy: JOE })

    expect(sheet().getByText('1 recipe filled in, 2 skipped. The grocery list uses them from now on.')).toBeTruthy()
    expect(sheet().getByText(/Skipped ones stay aside/)).toBeTruthy()
    fireEvent.click(sheet().getByRole('button', { name: 'Done' }))

    // nothing but Save touched a recipe
    expect(saved.filter(i => i.kind === 'recipe').map(i => i.id)).toEqual(['stew'])

    // back on Recipes: only skipped ones left, so the button brings them back
    expect(screen.getByText('2 recipes have no ingredients — the grocery list can’t use them.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Bring back 2 skipped' }))
    expect(row(recipeDraftId('curry'))).toMatchObject({ skippedAt: undefined })
    expect(row(recipeDraftId('dal'))).toMatchObject({ skippedAt: undefined })
    // …and both are offered at once, with no call
    expect(sheet().getByText('Recipe 1 of 2')).toBeTruthy()
    expect(sheet().getByText('Drafted ahead of time — nothing is saved until you tap Save.')).toBeTruthy()
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('a recipe saved from the editor through Edit clears its draft too', () => {
    const { row } = openKitchen([recipe('curry', 'Chicken curry'), waiting('curry', 'chicken thighs')])
    fireEvent.click(screen.getByRole('button', { name: 'Fill it in · 1 ready' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Fill in recipes' })).getByRole('button', { name: 'Edit' }))
    const form = screen.getByRole('dialog', { name: 'Edit Chicken curry' })
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    expect((row('curry') as Recipe).ingredients.map(i => i.name)).toEqual(['chicken thighs', 'onion'])
    expect(row(recipeDraftId('curry'))).toMatchObject({ purged: true, deletedAt: expect.any(String) })
  })

  it('Stop leaves a waiting draft waiting', () => {
    const { row } = openKitchen([recipe('curry', 'Chicken curry'), waiting('curry', 'chicken thighs')])
    fireEvent.click(screen.getByRole('button', { name: 'Fill it in · 1 ready' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Fill in recipes' })).getByRole('button', { name: 'Stop' }))
    expect(row(recipeDraftId('curry'))).toEqual(waiting('curry', 'chicken thighs'))
    expect(screen.getByRole('button', { name: 'Fill it in · 1 ready' })).toBeTruthy()
  })
})
