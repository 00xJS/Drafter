import { complete } from './ai'
import { newerStamp } from '../shared/domain.mts'
import { FILL_MAX_TOKENS, buildFillPrompt, draftRowState, recipeDraftId, usableDraft } from '../shared/recipefill.mts'
import type { DraftIngredient, FillInput, RecipeDraft } from '../shared/recipefill.mts'
import { newIngredient, recipeHasIngredients } from './kitchen'
import type { Recipe, RecipeDraftRecord } from './types'

// "✨ Fill in ingredients & steps": a recipe saved as a bare name drafted
// into an ordinary home version of the dish, from its name and whatever the
// household already wrote about it. Forty recipes were saved, thirty-nine of
// them with no ingredients, and the grocery list is built from ingredients
// (buildGroceryList in shared/kitchen.mts) — so it stayed empty and never said
// why. A draft is only ever a proposal: it lands in the editor, or in the
// review sheet one recipe at a time, and nothing is saved until Save.
//
// The prompt and the reader of the answer are shared/recipefill.mts, so the
// drafts the nightly job prepares ahead of time (v3.35) are asked for, and
// read, exactly as the ones drafted here while someone waits.

export { FILL_MAX_TOKENS, buildFillPrompt, fillInputFor, parseRecipeFill, usableDraft } from '../shared/recipefill.mts'
export type { DraftIngredient, FillInput, RecipeDraft } from '../shared/recipefill.mts'

/**
 * One /api/ai call: the dish drafted from its name and the household's own
 * words. Room for a model that reasons first; a reply that holds no draft is
 * asked for once more, as the nightly job asks, and a second with nothing in
 * it is an error the cook can act on rather than an empty draft.
 */
export async function fillRecipe(input: FillInput): Promise<RecipeDraft> {
  const { system, prompt } = buildFillPrompt(input)
  // an ordinary home version needs no thought first, and the thinking was most of a minute's wait
  const draft = usableDraft(await complete(system, prompt, FILL_MAX_TOKENS, true, { reasoning: 'off', accept: text => usableDraft(text) !== null }))
  if (!draft) throw new Error('The assistant didn’t draft anything for that dish — try again, or add a word about it to its notes.')
  return draft
}

// ---- where a draft goes ------------------------------------------------------------

/** A draft's parts: the ones that fill empty fields, and the ones that would replace what is there and so wait to be chosen. */
export interface DraftSplit {
  fill: { ingredients?: DraftIngredient[]; steps?: string[] }
  spare: { ingredients?: DraftIngredient[]; steps?: string[] }
}

/**
 * Where each part of a draft goes. An empty field is filled; a field that
 * already holds something keeps it, and the draft's version waits beside it
 * for the cook to choose — a draft never overwrites anything unseen.
 */
export function splitDraft(has: { ingredients: boolean; steps: boolean }, draft: RecipeDraft): DraftSplit {
  const out: DraftSplit = { fill: {}, spare: {} }
  if (draft.ingredients.length) out[has.ingredients ? 'spare' : 'fill'].ingredients = draft.ingredients
  if (draft.steps.length) out[has.steps ? 'spare' : 'fill'].steps = draft.steps
  return out
}

/**
 * A recipe with its draft saved in: its empty parts filled, everything it
 * already had kept (its own steps, servings, notes and source included), and
 * updatedAt stamped newer than the row it edits.
 */
export function recipeWithDraft(recipe: Recipe, draft: RecipeDraft, makeId: () => string = () => newIngredient().id): Recipe {
  const hasSteps = (recipe.steps ?? []).some(s => s.trim())
  return {
    ...recipe,
    servings: recipe.servings ?? draft.servings,
    ingredients: recipeHasIngredients(recipe)
      ? recipe.ingredients
      : draft.ingredients.map(i => ({ id: makeId(), name: i.name, ...(i.qty !== undefined ? { qty: i.qty } : {}), ...(i.unit ? { unit: i.unit } : {}) })),
    steps: hasSteps || !draft.steps.length ? recipe.steps : [...draft.steps],
    updatedAt: newerStamp(recipe.updatedAt),
  }
}

// ---- filling many, one at a time ---------------------------------------------------

/**
 * "Fill them in": a queue of recipes, the one the sheet is on, what was saved
 * and skipped, and the drafts made so far. Kept by the Kitchen rather than the
 * sheet, so Edit can open the recipe editor in its place and Cancel comes back
 * to the same draft without asking for another.
 */
export interface FillRun {
  ids: string[]
  /** Where in `ids` the sheet has got to: everything before it is done with. */
  at: number
  saved: number
  skipped: number
  drafts: Readonly<Record<string, RecipeDraft>>
}

export function newFillRun(ids: readonly string[]): FillRun {
  return { ids: [...new Set(ids)], at: 0, saved: 0, skipped: 0, drafts: {} }
}

/**
 * The recipe the run is on: the first from `at` that still exists and still
 * has no ingredients. One filled in meanwhile — by the other person, on another
 * device — is passed over rather than drafted again. Null when the run is done.
 */
export function fillRunCurrent(run: FillRun, recipes: readonly Recipe[]): { recipe: Recipe; index: number } | null {
  const byId = new Map(recipes.map(r => [r.id, r]))
  for (let i = run.at; i < run.ids.length; i++) {
    const recipe = byId.get(run.ids[i])
    if (recipe && !recipe.deletedAt && !recipeHasIngredients(recipe)) return { recipe, index: i }
  }
  return null
}

/** The run past one recipe, counted as saved or skipped (a recipe deleted from the editor is neither). */
export function fillRunDone(run: FillRun, id: string, outcome: 'saved' | 'skipped' | 'gone'): FillRun {
  const at = run.ids.indexOf(id)
  if (at === -1 || at < run.at) return run
  const drafts = { ...run.drafts }
  delete drafts[id]
  return {
    ...run,
    at: at + 1,
    drafts,
    saved: run.saved + (outcome === 'saved' ? 1 : 0),
    skipped: run.skipped + (outcome === 'skipped' ? 1 : 0),
  }
}

export function fillRunWithDraft(run: FillRun, id: string, draft: RecipeDraft): FillRun {
  return { ...run, drafts: { ...run.drafts, [id]: draft } }
}

// ---- drafts made ahead of time (v3.35) --------------------------------------------------

/** The live draft rows, by the recipe each drafts. */
export function draftRowsByRecipe(rows: readonly RecipeDraftRecord[]): Map<string, RecipeDraftRecord> {
  const out = new Map<string, RecipeDraftRecord>()
  for (const row of rows) if (!row.deletedAt) out.set(row.recipeId, row)
  return out
}

/** What a waiting row drafted, or undefined: a row passed over, or one with nothing in it, offers nothing. */
export function readyDraftOf(row: RecipeDraftRecord | undefined): RecipeDraft | undefined {
  if (!row || draftRowState(row) !== 'waiting') return undefined
  return { ...(row.servings ? { servings: row.servings } : {}), ingredients: row.ingredients, steps: row.steps }
}

/**
 * Fill them in, from Recipes: the recipes it goes through — those with a
 * draft waiting first, then the rest, each in `bare`'s order — how many of
 * them are ready, and the ones a member passed over, which it leaves out
 * until they are brought back.
 */
export interface FillPlan {
  queue: Recipe[]
  ready: number
  skipped: Recipe[]
}

export function fillPlan(bare: readonly Recipe[], rows: readonly RecipeDraftRecord[]): FillPlan {
  const byRecipe = draftRowsByRecipe(rows)
  const ready: Recipe[] = []
  const rest: Recipe[] = []
  const skipped: Recipe[] = []
  for (const recipe of bare) {
    const row = byRecipe.get(recipe.id)
    const state = row ? draftRowState(row) : null
    if (state === 'skipped') skipped.push(recipe)
    else if (state === 'waiting') ready.push(recipe)
    else rest.push(recipe)
  }
  return { queue: [...ready, ...rest], ready: ready.length, skipped }
}

/** Its button: "Fill them in · 6 ready", "Fill it in", or, once only passed-over ones are left, "Bring back 3 skipped". */
export function fillButtonLabel(plan: FillPlan): string {
  if (!plan.queue.length) return plan.skipped.length ? `Bring back ${plan.skipped.length} skipped` : ''
  const verb = plan.queue.length === 1 ? 'Fill it in' : 'Fill them in'
  return plan.ready ? `${verb} · ${plan.ready} ready` : verb
}

/**
 * Save's removal of a draft: nothing left of it but its id and who it was
 * for, stamped newer than the row — "Delete forever"'s tombstone, the shape
 * shared/tombstone.mts gives every kind and the nightly clean-up writes too.
 */
export function draftRemoved(row: RecipeDraftRecord): RecipeDraftRecord {
  const stamp = newerStamp(row.updatedAt)
  return { kind: 'recipedraft', id: row.id, recipeId: row.recipeId, ingredients: [], steps: [], ownerId: row.ownerId, createdAt: stamp, updatedAt: stamp, deletedAt: stamp, purged: true }
}

/** The draft of a recipe just saved from the editor, removed as Save in the sheet removes it; null when it has none. */
export function draftCleared(rows: readonly RecipeDraftRecord[], recipeId: string): RecipeDraftRecord | null {
  const row = rows.find(r => r.recipeId === recipeId && !r.deletedAt)
  return row ? draftRemoved(row) : null
}

/**
 * Skip's mark: the recipe's draft kept, marked passed over (by `by`), so
 * neither Fill them in nor the nightly job offers it again until it is
 * brought back. What the sheet drafted while it waited (`live`) is what is
 * kept; with nothing drafted yet, the mark is kept on its own.
 */
export function draftSkipped(o: { row?: RecipeDraftRecord; recipeId: string; live?: RecipeDraft; by?: string | null }): RecipeDraftRecord {
  const stamp = newerStamp(o.row?.updatedAt)
  const kept: RecipeDraftRecord = o.row ?? { kind: 'recipedraft', id: recipeDraftId(o.recipeId), recipeId: o.recipeId, ingredients: [], steps: [], createdAt: stamp, updatedAt: stamp }
  const drafted = o.live ? { servings: o.live.servings, ingredients: o.live.ingredients, steps: o.live.steps, draftedAt: stamp, model: undefined, triedAt: undefined, tries: undefined } : {}
  return { ...kept, ...drafted, skippedAt: stamp, skippedBy: o.by ?? undefined, updatedAt: stamp }
}

/** Bring back: these recipes' passed-over drafts offered again — and one with nothing in it drafted again, here or overnight. */
export function draftsBack(rows: readonly RecipeDraftRecord[], recipeIds: readonly string[]): RecipeDraftRecord[] {
  const ids = new Set(recipeIds)
  return rows.filter(r => !r.deletedAt && r.skippedAt && ids.has(r.recipeId)).map(r => ({ ...r, skippedAt: undefined, skippedBy: undefined, updatedAt: newerStamp(r.updatedAt) }))
}
