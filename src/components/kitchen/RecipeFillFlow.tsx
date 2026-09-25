import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { draftRemoved, draftRowsByRecipe, draftSkipped, fillInputFor, fillRecipe, fillRunCurrent, readyDraftOf } from '../../recipefill'
import type { FillInput, FillRun, RecipeDraft } from '../../recipefill'
import type { Recipe, RecipeDraftRecord } from '../../types'
import { aiFailureText } from '../AskSheet'
import { Modal, ModalHead } from '../Modal'

// "Fill them in": the recipes with no ingredients, one at a time, each shown
// with Save · Edit · Skip · Stop. Nothing is saved without a tap on Save (here,
// or in the editor Edit opens).
//
// Most arrive drafted: the nightly job prepares a draft for each bare recipe
// ahead of time (v3.35, netlify/functions/lib/recipedrafts.mjs), and one
// waiting is shown the moment the sheet reaches its recipe. A recipe with none
// is drafted then, while the sheet waits, as it always was — never ahead of the
// sheet, so no call is spent on a recipe nobody looks at. Save puts the draft
// into the recipe and removes the waiting one; Skip keeps it, marked, so it is
// neither offered nor drafted again until it is brought back.

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** "Recipe 3 of 12 · 2 saved · 1 skipped". */
export function fillProgress(run: Pick<FillRun, 'ids' | 'saved' | 'skipped'>, index: number): string {
  const parts = [`Recipe ${index + 1} of ${run.ids.length}`]
  if (run.saved) parts.push(`${run.saved} saved`)
  if (run.skipped) parts.push(`${run.skipped} skipped`)
  return parts.join(' · ')
}

/** The sheet's last word. */
export function fillSummary(run: Pick<FillRun, 'saved' | 'skipped'>): string {
  if (!run.saved && !run.skipped) return 'Every recipe here has ingredients now.'
  const saved = run.saved ? `${count(run.saved, 'recipe')} filled in` : 'Nothing saved'
  const skipped = run.skipped ? `, ${run.skipped} skipped` : ''
  return `${saved}${skipped}.${run.saved ? ' The grocery list uses them from now on.' : ''}`
}

/** Why one recipe was not filled in: the server's own wait when it is busy, and offline said as offline. */
function failure(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return aiFailureText(msg, { unavailable: 'Filling in needs the assistant, which isn’t available here.', failed: 'Couldn’t fill it in' })
}

interface Props {
  run: FillRun
  recipes: Recipe[]
  /** The drafts made ahead of time, as the store holds them: one waiting for the recipe the sheet is on shows at once, with no call. */
  waiting?: readonly RecipeDraftRecord[]
  /** Writes a draft's own row: Save's removal of it, and Skip's mark on it. */
  onDraftRow?(row: RecipeDraftRecord): void
  /** Who is filling in, for Skip's mark. */
  myId?: string | null
  onDraft(id: string, draft: RecipeDraft): void
  onSave(recipe: Recipe, draft: RecipeDraft): void
  onEdit(recipe: Recipe, draft: RecipeDraft): void
  onSkip(recipe: Recipe): void
  /** Stop, Done, Escape and ✕ alike: the run ends where it is. */
  onStop(): void
  /** The ✨ call; replaceable in tests. */
  fill?(input: FillInput): Promise<RecipeDraft>
}

/** No drafts made ahead: outside a store, and the default. */
const NO_ROWS: readonly RecipeDraftRecord[] = []

export function RecipeFillFlow({ run, recipes, waiting = NO_ROWS, onDraftRow, myId = null, onDraft, onSave, onEdit, onSkip, onStop, fill = fillRecipe }: Props) {
  const current = fillRunCurrent(run, recipes)
  const recipe = current?.recipe ?? null
  // the recipe's own draft row, if it has one; what this sheet drafted while
  // it waited; and otherwise what the row has waiting, shown at once
  const row = recipe ? draftRowsByRecipe(waiting).get(recipe.id) : undefined
  const live = recipe ? run.drafts[recipe.id] : undefined
  const ahead = live ? undefined : readyDraftOf(row)
  const draft = live ?? ahead
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  // one request per recipe and attempt, kept across StrictMode's second run of
  // the effect below and across the editor opening in this sheet's place
  const asked = useRef(new Map<string, Promise<RecipeDraft>>())
  const latest = useRef({ onDraft, fill })
  useLayoutEffect(() => {
    latest.current = { onDraft, fill }
  })

  const id = recipe?.id ?? null
  const needsDraft = !!recipe && !draft
  // what the drafter is told, from the recipe as it is when the ask goes out;
  // an effect event, so the recipe's own edits do not ask again
  const inputNow = useEffectEvent(() => (recipe ? fillInputFor(recipe) : null))
  // a new recipe, a new attempt, or a draft let go of: one ask
  useEffect(() => {
    const input = needsDraft ? inputNow() : null
    if (!id || !input) return
    let live = true
    const key = `${id}#${attempt}`
    let pending = asked.current.get(key)
    if (!pending) {
      pending = latest.current.fill(input)
      asked.current.set(key, pending)
    }
    // a failure is shown only for the recipe it was for (`error` below), and Retry clears its own
    pending.then(
      d => {
        if (live) latest.current.onDraft(id, d)
      },
      e => {
        if (live) setFailed({ id, message: failure(e) })
      },
    )
    return () => {
      live = false
    }
  }, [id, needsDraft, attempt])

  const error = failed && failed.id === id ? failed.message : ''
  const retry = () => {
    if (id) asked.current.delete(`${id}#${attempt}`)
    setFailed(null)
    setAttempt(a => a + 1)
  }

  if (!recipe || !current) {
    return (
      <Modal onClose={onStop} className="modal recipe-fill">
        <ModalHead title="Fill in recipes" />
        <div className="modal-body">
          <p className="recipe-fill-done" role="status">
            {fillSummary(run)}
          </p>
          {run.skipped > 0 && onDraftRow && <p className="field-hint">Skipped ones stay aside. Once nothing else is left to fill in, Recipes offers to bring them back.</p>}
        </div>
        <footer className="modal-foot">
          <span className="spacer" />
          <button type="button" className="btn primary" onClick={onStop}>
            Done
          </button>
        </footer>
      </Modal>
    )
  }

  const ownSteps = (recipe.steps ?? []).filter(s => s.trim())
  return (
    <Modal onClose={onStop} className="modal recipe-fill">
      <ModalHead title="Fill in recipes" />
      <div className="modal-body">
        <p className="recipe-fill-progress" role="status">
          {fillProgress(run, current.index)}
        </p>
        <h3 className="recipe-fill-name">
          {recipe.emoji ? `${recipe.emoji} ` : ''}
          {recipe.name}
        </h3>
        {recipe.notes && <p className="recipe-notes">Your notes: {recipe.notes}</p>}
        {error ? (
          <div className="recipe-fill-failed">
            <p className="warn">{error}</p>
            <button type="button" className="btn" onClick={retry}>
              Try again
            </button>
          </div>
        ) : !draft ? (
          <p className="muted recipe-fill-busy" aria-busy="true">
            ✨ Drafting an ordinary home version…
          </p>
        ) : (
          <>
            {ahead && <p className="field-hint recipe-fill-ahead">Drafted ahead of time — nothing is saved until you tap Save.</p>}
            <p className="recipe-cook-meta">
              {[
                (recipe.servings ?? draft.servings) ? `Serves ${recipe.servings ?? draft.servings}` : '',
                count(draft.ingredients.length, 'ingredient'),
                ownSteps.length ? `your ${count(ownSteps.length, 'step')}` : count(draft.steps.length, 'step'),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {draft.ingredients.length > 0 && (
              <div className="field">
                <span>Ingredients</span>
                <ul className="recipe-ings">
                  {draft.ingredients.map((i, n) => (
                    <li key={n}>
                      {i.qty !== undefined ? `${i.qty}${i.unit ? ' ' + i.unit : ''} ` : ''}
                      {i.name}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {ownSteps.length > 0 ? (
              <div className="field">
                <span>Steps — yours, kept as they are</span>
                <ol className="recipe-fill-steps">
                  {ownSteps.map((s, n) => (
                    <li key={n}>{s}</li>
                  ))}
                </ol>
              </div>
            ) : (
              draft.steps.length > 0 && (
                <div className="field">
                  <span>Steps</span>
                  <ol className="recipe-fill-steps">
                    {draft.steps.map((s, n) => (
                      <li key={n}>{s}</li>
                    ))}
                  </ol>
                </div>
              )
            )}
          </>
        )}
      </div>
      <footer className="modal-foot recipe-fill-foot">
        <button type="button" className="btn subtle" onClick={onStop}>
          Stop
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="btn"
          onClick={() => {
            // kept, marked: neither this sheet nor the nightly job offers it again until it is brought back
            onDraftRow?.(draftSkipped({ row, recipeId: recipe.id, live, by: myId }))
            onSkip(recipe)
          }}
        >
          Skip
        </button>
        <button type="button" className="btn" disabled={!draft} onClick={() => draft && onEdit(recipe, draft)}>
          Edit
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!draft}
          onClick={() => {
            if (!draft) return
            onSave(recipe, draft)
            // in the recipe now: the draft that waited for it has done its work
            if (row) onDraftRow?.(draftRemoved(row))
          }}
        >
          Save
        </button>
      </footer>
    </Modal>
  )
}
