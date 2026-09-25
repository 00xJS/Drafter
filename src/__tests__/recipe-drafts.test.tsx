import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { purgeTombstone } from '../../shared/tombstone.mts'
import { draftRowState, recipeDraftId, recipeIdOfDraft, usableDraft } from '../../shared/recipefill.mts'
import { RecipeFillFlow } from '../components/kitchen/RecipeFillFlow'
import { inTrash } from '../itemops'
import { drawLists } from '../kindlists'
import { draftCleared, draftRemoved, draftSkipped, draftsBack, fillButtonLabel, fillPlan, newFillRun, readyDraftOf } from '../recipefill'
import type { RecipeDraft } from '../recipefill'
import { sanitizeItem, sanitizeRecipeDraft } from '../schema'
import { groupByKind } from '../syncengine'
import type { Item, Recipe, RecipeDraftRecord } from '../types'
import { elements, rendered, textOf } from './rendered'

// Drafts made ahead of time (v3.35), as the app holds them: the record and
// its sanitizer, which recipes Fill them in offers and in what order, what its
// button says, and what Save and Skip write to a draft's own row. The sheet
// itself, pressed through Kitchen in a document, is recipe-drafts.dom.test.tsx.

const T0 = '2026-09-20T10:00:00.000Z'
const recipe = (id: string, name: string, over: Partial<Recipe> = {}): Recipe => ({ kind: 'recipe', id, name, ingredients: [], tags: [], createdAt: T0, updatedAt: T0, ...over })
const row = (recipeId: string, over: Partial<RecipeDraftRecord> = {}): RecipeDraftRecord => ({
  kind: 'recipedraft',
  id: recipeDraftId(recipeId),
  recipeId,
  ingredients: [
    { name: 'chicken thighs', qty: 1.5, unit: 'lb' },
    { name: 'onion', qty: 1 },
  ],
  steps: ['Brown the chicken.', 'Simmer it.'],
  servings: 4,
  draftedAt: T0,
  model: 'nvidia/nemotron-3-super-120b-a12b',
  triedAt: T0,
  ownerId: 'maria',
  createdAt: T0,
  updatedAt: T0,
  ...over,
})

describe('the record', () => {
  it('is named by its recipe, and an id that names none is no draft', () => {
    expect(recipeDraftId('r1')).toBe('recipedraft~r1')
    expect(recipeIdOfDraft('recipedraft~r1')).toBe('r1')
    for (const id of ['recipedraft~', 'recipe~r1', 'r1', 42, null]) expect(recipeIdOfDraft(id), String(id)).toBeNull()
    expect(sanitizeItem({ kind: 'recipedraft', id: 'r1', recipeId: 'r1' })).toBeNull()
    // its recipe is the one its id names, whatever else it says
    expect(sanitizeRecipeDraft({ kind: 'recipedraft', id: 'recipedraft~r1', recipeId: 'r2', createdAt: T0, updatedAt: T0 })?.recipeId).toBe('r1')
  })

  it('keeps no more than Fill in itself keeps, and each part only when it is sound', () => {
    const out = sanitizeRecipeDraft({
      kind: 'recipedraft',
      id: 'recipedraft~r1',
      servings: 400,
      ingredients: [{ name: '  Rice ', qty: '2', unit: ' cup ' }, { name: '' }, { qty: 1 }, 'flour', { name: 'x'.repeat(200), qty: -1, unit: 'y'.repeat(40) }, ...Array.from({ length: 40 }, (_, i) => ({ name: `thing ${i}` }))],
      steps: ['  Rinse the rice. ', 7, '', ...Array.from({ length: 30 }, (_, i) => `step ${i}`)],
      draftedAt: 'not a date',
      skippedAt: T0,
      skippedBy: ' maria ',
      tries: 1000,
      model: 'm'.repeat(300),
      createdAt: T0,
      updatedAt: T0,
    })!
    expect(out.servings).toBeUndefined()
    expect(out.ingredients[0]).toEqual({ name: 'Rice', qty: 2, unit: 'cup' })
    expect(out.ingredients[1]).toEqual({ name: 'x'.repeat(80), unit: 'y'.repeat(16) })
    expect(out.ingredients).toHaveLength(30)
    expect(out.steps[0]).toBe('Rinse the rice.')
    expect(out.steps).toHaveLength(15)
    expect(out).toMatchObject({ draftedAt: undefined, skippedAt: T0, skippedBy: 'maria', tries: 99 })
    expect(out.model).toHaveLength(120)
  })

  it('keeps "Delete forever"’s tombstone as one, the nightly clean-up’s and Save’s alike', () => {
    const night = sanitizeItem(purgeTombstone('recipedraft', 'recipedraft~r1', T0)) as RecipeDraftRecord
    expect(night).toMatchObject({ kind: 'recipedraft', id: 'recipedraft~r1', recipeId: 'r1', ingredients: [], steps: [], deletedAt: T0, purged: true })
    const saved = draftRemoved(row('r1'))
    // Save's is the same shape, stamped newer than the row, and says who it was for
    const { ownerId, ...rest } = saved
    expect(ownerId).toBe('maria')
    expect(sanitizeItem(rest)).toEqual({ ...night, createdAt: saved.createdAt, updatedAt: saved.updatedAt, deletedAt: saved.deletedAt })
    expect(saved.updatedAt > T0).toBe(true)
    expect(draftRowState(saved)).toBe('removed')
  })

  it('is never in the Trash, and the store lists the live ones', () => {
    expect(inTrash(row('r1', { deletedAt: T0 }))).toBe(false)
    expect(inTrash(draftRemoved(row('r1')))).toBe(false)
    const items: Item[] = [row('r1'), row('r2', { deletedAt: T0 }), recipe('r1', 'Curry')]
    expect(drawLists(groupByKind(items, null), 'joe').lists.recipeDrafts.map(d => d.id)).toEqual(['recipedraft~r1'])
  })
})

describe('where a stored draft stands', () => {
  it('waiting, skipped, tried or removed', () => {
    expect(draftRowState(row('r1'))).toBe('waiting')
    expect(draftRowState(row('r1', { ingredients: [] }))).toBe('waiting')
    expect(draftRowState(row('r1', { skippedAt: T0 }))).toBe('skipped')
    expect(draftRowState(row('r1', { ingredients: [], steps: [], tries: 1 }))).toBe('tried')
    expect(draftRowState(row('r1', { deletedAt: T0 }))).toBe('removed')
    expect(readyDraftOf(row('r1'))).toEqual({ servings: 4, ingredients: row('r1').ingredients, steps: row('r1').steps })
    for (const r of [row('r1', { skippedAt: T0 }), row('r1', { ingredients: [], steps: [] }), row('r1', { deletedAt: T0 }), undefined]) expect(readyDraftOf(r)).toBeUndefined()
  })

  it('a reply is a draft only with something in it', () => {
    expect(usableDraft('{"":""}')).toBeNull()
    expect(usableDraft('{"ingredients":[],"steps":[]}')).toBeNull()
    expect(usableDraft('Sorry, I can’t help with that.')).toBeNull()
    expect(usableDraft('<think>{a}</think>{"steps":["Boil it."]}')).toEqual({ ingredients: [], steps: ['Boil it.'] })
  })
})

describe('Fill them in, from Recipes', () => {
  const bare = [recipe('a', 'Apple pie'), recipe('b', 'Beef stew'), recipe('c', 'Chili'), recipe('d', 'Dal'), recipe('e', 'Eggs')]

  it('goes through the ready ones first, then the rest, each in the queue’s order, and leaves the skipped ones out', () => {
    const rows = [row('c'), row('a'), row('b', { skippedAt: T0 }), row('e', { ingredients: [], steps: [], tries: 1 }), row('d', { deletedAt: T0 })]
    const plan = fillPlan(bare, rows)
    expect(plan.queue.map(r => r.id)).toEqual(['a', 'c', 'd', 'e'])
    expect(plan.ready).toBe(2)
    expect(plan.skipped.map(r => r.id)).toEqual(['b'])
    expect(fillButtonLabel(plan)).toBe('Fill them in · 2 ready')
  })

  it('says how many are ready, and offers the skipped back once only they are left', () => {
    expect(fillButtonLabel(fillPlan(bare, []))).toBe('Fill them in')
    expect(fillButtonLabel(fillPlan(bare.slice(0, 1), []))).toBe('Fill it in')
    expect(fillButtonLabel(fillPlan(bare.slice(0, 1), [row('a')]))).toBe('Fill it in · 1 ready')
    expect(fillButtonLabel(fillPlan(bare, bare.map(r => row(r.id))))).toBe('Fill them in · 5 ready')
    expect(fillButtonLabel(fillPlan(bare.slice(0, 3), [row('a', { skippedAt: T0 }), row('b', { skippedAt: T0 }), row('c', { skippedAt: T0 })]))).toBe('Bring back 3 skipped')
  })

  it('brings the skipped back: offered again as they were, and one with nothing in it drafted again', () => {
    const rows = [row('a', { skippedAt: T0, skippedBy: 'joe' }), row('b', { skippedAt: T0, ingredients: [], steps: [] }), row('c', { skippedAt: T0 })]
    const back = draftsBack(rows, ['a', 'b'])
    expect(back.map(r => r.id)).toEqual(['recipedraft~a', 'recipedraft~b'])
    expect(back.every(r => r.skippedAt === undefined && r.skippedBy === undefined && r.updatedAt > T0)).toBe(true)
    expect(back.map(draftRowState)).toEqual(['waiting', 'tried'])
    expect(back[0].ingredients).toEqual(rows[0].ingredients)
  })
})

describe('what Save and Skip write to the draft', () => {
  const live: RecipeDraft = { servings: 2, ingredients: [{ name: 'lentils', qty: 1, unit: 'cup' }], steps: ['Simmer the lentils.'] }

  it('Skip keeps the draft waiting, marked, by whoever skipped it', () => {
    const skipped = draftSkipped({ row: row('a'), recipeId: 'a', by: 'joe' })
    expect(skipped).toMatchObject({ id: 'recipedraft~a', ingredients: row('a').ingredients, steps: row('a').steps, model: row('a').model, skippedBy: 'joe', ownerId: 'maria' })
    expect(skipped.skippedAt! > T0 && skipped.updatedAt === skipped.skippedAt).toBe(true)
    expect(draftRowState(skipped)).toBe('skipped')
  })

  it('keeps what the sheet drafted while it waited, or the mark alone with nothing drafted', () => {
    const kept = draftSkipped({ recipeId: 'd', live, by: 'joe' })
    expect(kept).toMatchObject({ kind: 'recipedraft', id: 'recipedraft~d', recipeId: 'd', servings: 2, ingredients: live.ingredients, steps: live.steps, skippedBy: 'joe' })
    expect(kept.draftedAt).toBe(kept.skippedAt)
    // over a row the job noted as tried, the sheet's own draft stands, and the note goes
    const over = draftSkipped({ row: row('e', { ingredients: [], steps: [], tries: 2 }), recipeId: 'e', live })
    expect(over).toMatchObject({ ingredients: live.ingredients, tries: undefined, model: undefined })
    const mark = draftSkipped({ recipeId: 'f', by: null })
    expect(mark).toMatchObject({ ingredients: [], steps: [], skippedBy: undefined })
    expect(draftRowState(mark)).toBe('skipped')
    // each is a record the app keeps as it wrote it
    for (const r of [kept, over, mark]) expect(sanitizeItem(JSON.parse(JSON.stringify(r)))).toMatchObject({ kind: 'recipedraft', skippedAt: r.skippedAt })
  })

  it('a recipe saved from the editor clears its draft; one with none has nothing to clear', () => {
    expect(draftCleared([row('a'), row('b')], 'b')).toMatchObject({ id: 'recipedraft~b', purged: true })
    expect(draftCleared([row('a', { deletedAt: T0 })], 'a')).toBeNull()
    expect(draftCleared([], 'a')).toBeNull()
  })
})

describe('the sheet, with a draft waiting', () => {
  const list = [recipe('a', 'Chicken curry', { notes: 'The mild paste' }), recipe('b', 'Beef stew')]
  const noop = () => {}
  const never = vi.fn(() => new Promise<RecipeDraft>(() => {}))

  it('shows it at once, says it was drafted ahead, and asks for nothing', () => {
    const html = renderToStaticMarkup(<RecipeFillFlow run={newFillRun(['a', 'b'])} recipes={list} waiting={[row('a')]} fill={never} onDraft={noop} onSave={noop} onEdit={noop} onSkip={noop} onStop={noop} />)
    expect(html).toContain('Drafted ahead of time — nothing is saved until you tap Save.')
    expect(html).toContain('1.5 lb chicken thighs')
    expect(html).toContain('Serves 4 · 2 ingredients · 2 steps')
    expect(html).not.toContain('Drafting an ordinary home version')
    expect(html).toMatch(/<button type="button" class="btn primary">Save<\/button>/)
    expect(never).not.toHaveBeenCalled()
  })

  it('drafts live, as before, for a recipe with nothing waiting — a skipped draft is not offered', () => {
    const html = renderToStaticMarkup(<RecipeFillFlow run={newFillRun(['a'])} recipes={list} waiting={[row('a', { skippedAt: T0 })]} fill={never} onDraft={noop} onSave={noop} onEdit={noop} onSkip={noop} onStop={noop} />)
    expect(html).toContain('Drafting an ordinary home version')
    expect(html).not.toContain('Drafted ahead of time')
  })

  it('Save hands the recipe its draft and removes the waiting one; Skip marks it; Edit hands it on', () => {
    const onSave = vi.fn()
    const onSkip = vi.fn()
    const onEdit = vi.fn()
    const onDraftRow = vi.fn()
    const trees = rendered(RecipeFillFlow, { run: newFillRun(['a']), recipes: list, waiting: [row('a')], myId: 'joe', fill: never, onDraft: noop, onDraftRow, onSave, onEdit, onSkip, onStop: noop })
    const buttons = elements(trees[trees.length - 1]).filter(e => e.type === 'button')
    const press = (label: string) => (buttons.find(b => textOf(b) === label)!.props.onClick as () => void)()
    press('Save')
    expect(onSave).toHaveBeenCalledWith(list[0], readyDraftOf(row('a')))
    expect(onDraftRow).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'recipedraft~a', purged: true, deletedAt: expect.any(String), ownerId: 'maria' }))
    press('Skip')
    expect(onSkip).toHaveBeenCalledWith(list[0])
    expect(onDraftRow).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'recipedraft~a', skippedBy: 'joe', skippedAt: expect.any(String), ingredients: row('a').ingredients }))
    press('Edit')
    expect(onEdit).toHaveBeenCalledWith(list[0], readyDraftOf(row('a')))
    // Edit writes nothing: the editor's own Save does
    expect(onDraftRow).toHaveBeenCalledTimes(2)
  })

  it('says, at the end, that what was skipped stays aside', () => {
    const done = { ...newFillRun(['a']), at: 1, skipped: 1 }
    const html = renderToStaticMarkup(<RecipeFillFlow run={done} recipes={list} waiting={[]} onDraftRow={noop} fill={never} onDraft={noop} onSave={noop} onEdit={noop} onSkip={noop} onStop={noop} />)
    expect(html).toContain('Nothing saved, 1 skipped.')
    expect(html).toContain('Skipped ones stay aside. Once nothing else is left to fill in, Recipes offers to bring them back.')
  })
})
