import { useEffect, useRef, useState } from 'react'
import { fillInputFor, fillRecipe, fillRunCurrent } from '../../recipefill'
import type { FillInput, FillRun, RecipeDraft } from '../../recipefill'
import type { Recipe } from '../../types'
import { aiFailureKind } from '../AskSheet'
import { Modal, ModalHead } from '../Modal'

// "Fill them in": the recipes with no ingredients, one at a time. Each is
// drafted when the sheet reaches it — never ahead, so no call is spent on a
// recipe nobody looks at — and shown with Save · Edit · Skip · Stop. Nothing is
// saved without a tap on Save (here, or in the editor Edit opens).

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

function failure(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const kind = aiFailureKind(msg)
  if (kind === 'busy') return 'The assistant is busy — try again in a minute.'
  if (kind === 'unavailable') return 'Filling in needs the assistant, which isn’t available here.'
  return msg
}

interface Props {
  run: FillRun
  recipes: Recipe[]
  onDraft(id: string, draft: RecipeDraft): void
  onSave(recipe: Recipe, draft: RecipeDraft): void
  onEdit(recipe: Recipe, draft: RecipeDraft): void
  onSkip(recipe: Recipe): void
  /** Stop, Done, Escape and ✕ alike: the run ends where it is. */
  onStop(): void
  /** The ✨ call; replaceable in tests. */
  fill?(input: FillInput): Promise<RecipeDraft>
}

export function RecipeFillFlow({ run, recipes, onDraft, onSave, onEdit, onSkip, onStop, fill = fillRecipe }: Props) {
  const current = fillRunCurrent(run, recipes)
  const recipe = current?.recipe ?? null
  const draft = recipe ? run.drafts[recipe.id] : undefined
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  // one request per recipe and attempt, kept across StrictMode's second run of
  // the effect below and across the editor opening in this sheet's place
  const asked = useRef(new Map<string, Promise<RecipeDraft>>())
  const latest = useRef({ onDraft, fill })
  latest.current = { onDraft, fill }

  const id = recipe?.id ?? null
  const needsDraft = !!recipe && !draft
  useEffect(() => {
    if (!recipe || !needsDraft) return
    let live = true
    const key = `${recipe.id}#${attempt}`
    let pending = asked.current.get(key)
    if (!pending) {
      pending = latest.current.fill(fillInputFor(recipe))
      asked.current.set(key, pending)
    }
    setFailed(null)
    pending.then(
      d => {
        if (live) latest.current.onDraft(recipe.id, d)
      },
      e => {
        if (live) setFailed({ id: recipe.id, message: failure(e) })
      },
    )
    return () => {
      live = false
    }
    // a new recipe, a new attempt, or a draft let go of: the recipe's own edits do not ask again
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        <button type="button" className="btn" onClick={() => onSkip(recipe)}>
          Skip
        </button>
        <button type="button" className="btn" disabled={!draft} onClick={() => draft && onEdit(recipe, draft)}>
          Edit
        </button>
        <button type="button" className="btn primary" disabled={!draft} onClick={() => draft && onSave(recipe, draft)}>
          Save
        </button>
      </footer>
    </Modal>
  )
}
