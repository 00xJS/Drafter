import { useState } from 'react'
import { RECIPE_TEXT_HINT, readRecipe } from '../../ai'
import type { ReadRecipe } from '../../ai'
import { safeHttpUrl } from '../../links'
import { fillRecipe, splitDraft } from '../../recipefill'
import type { FillInput, RecipeDraft } from '../../recipefill'
import { importRecipeLink } from '../../recipeimport'
import type { LinkRecipe } from '../../recipeimport'
import { aiFailureText } from '../AskSheet'

// The top of the recipe editor: the three ways to fill it without typing a
// shop's worth of rows. ✨ Fill in drafts the dish from its name; Paste reads a
// recipe's text; Import from a link has Drafter's server fetch the page. Each
// only fills the fields below — the cook reads them, and Save saves.

export type CaptureMode = 'paste' | 'link'

/** "allrecipes.com" for a link to it. */
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** What the capture area says after a paste or an import filled the fields. */
export function foundNote(found: Pick<ReadRecipe, 'ingredients' | 'steps'>, from?: Pick<LinkRecipe, 'sourceUrl' | 'via'>): string {
  const what = `${count(found.ingredients.length, 'ingredient')} and ${count(found.steps.length, 'step')}`
  if (!from) return `${what}. Check them, then Save.`
  const host = linkHost(from.sourceUrl)
  return from.via === 'page' ? `${what} from ${host}. Check them, then Save.` : `${what}, read from the page at ${host}. Check them, then Save.`
}

/** What it says after ✨ Fill in: what was drafted, and where the parts that would have replaced something went. */
export function draftNote(has: { ingredients: boolean; steps: boolean }, draft: RecipeDraft): string {
  const { fill, spare } = splitDraft(has, draft)
  const filled = [fill.ingredients && count(fill.ingredients.length, 'ingredient'), fill.steps && count(fill.steps.length, 'step')].filter(Boolean).join(' and ')
  const kept = [spare.ingredients && 'ingredients', spare.steps && 'steps'].filter(Boolean).join(' and ')
  if (filled && kept) return `Drafted ${filled} for an ordinary home version. Your ${kept} are kept — the draft’s are below if you want them. Check it all, then Save.`
  if (filled) return `Drafted ${filled} for an ordinary home version. Check them, then Save.`
  return `Your ${kept} are kept — the draft’s are below if you want them instead.`
}

/** An AI failure the cook can act on: the server's own wait when it is busy, and offline said as offline. */
function aiMessage(e: unknown, doing: string): string {
  const msg = e instanceof Error ? e.message : String(e)
  return aiFailureText(msg, { unavailable: `${doing} needs the assistant, which isn’t available here.`, failed: `${doing} didn’t work` })
}

interface Props {
  /** The name typed so far: Fill in drafts from it. */
  name: string
  /** Whether the fields already hold ingredients and steps: Fill in is the first thing to do when neither does. */
  has: { ingredients: boolean; steps: boolean }
  /** Everything the drafter is told about the dish. */
  hints: FillInput
  /** Open on Paste or on the link, when that is the door the editor came in by. */
  openOn?: CaptureMode
  /** Said on opening: a draft the review sheet handed over. */
  note?: string
  onFound(found: ReadRecipe & { sourceUrl?: string }): void
  onDraft(draft: RecipeDraft): void
  /** The three calls, replaceable in tests. */
  read?(text: string): Promise<ReadRecipe>
  importLink?(url: string): Promise<LinkRecipe>
  fill?(input: FillInput): Promise<RecipeDraft>
}

export function RecipeCapture({ name, has, hints, openOn, note: initialNote = '', onFound, onDraft, read = readRecipe, importLink = importRecipeLink, fill = fillRecipe }: Props) {
  const [mode, setMode] = useState<CaptureMode | null>(openOn ?? null)
  const [paste, setPaste] = useState('')
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState<'fill' | CaptureMode | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState(initialNote)

  const named = name.trim() !== ''
  // the first thing to do with a bare name: never louder than that
  const prominent = named && !has.ingredients && !has.steps
  // a paste that is nothing but a link is a link
  const pastedLink = /^\S+$/.test(paste.trim()) ? safeHttpUrl(paste.trim()) : undefined

  const start = (what: 'fill' | CaptureMode) => {
    setBusy(what)
    setError('')
    setNote('')
  }
  const close = () => {
    setMode(null)
    setError('')
  }
  const switchTo = (next: CaptureMode) => {
    setMode(next)
    setError('')
  }

  const fillIn = async () => {
    start('fill')
    try {
      const draft = await fill({ ...hints, name: name.trim() })
      onDraft(draft)
      setNote(draftNote(has, draft))
    } catch (e) {
      setError(aiMessage(e, 'Filling in'))
    } finally {
      setBusy(null)
    }
  }

  const importFrom = async (url: string) => {
    start('link')
    try {
      const found = await importLink(url)
      onFound(found)
      setNote(foundNote(found, found))
      setMode(null)
      setLink('')
      setPaste('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const readPaste = async () => {
    if (pastedLink) return importFrom(pastedLink)
    start('paste')
    try {
      const found = await read(paste)
      if (!found.ingredients.length && !found.steps.length) {
        setError('Nothing in there reads like a recipe — check the text and try again.')
        return
      }
      onFound(found)
      setNote(foundNote(found))
      setMode(null)
      setPaste('')
    } catch (e) {
      setError(aiMessage(e, 'Reading a recipe'))
    } finally {
      setBusy(null)
    }
  }

  return (
    // First, because typing a shop's worth of rows one at a time is the
    // reason recipes end up as bare names — and a bare name can never put a
    // line on the grocery list.
    <div className="recipe-paste recipe-capture">
      {mode === 'paste' ? (
        <>
          <label className="field">
            <span>Paste a recipe</span>
            <textarea rows={6} value={paste} onChange={e => setPaste(e.target.value)} placeholder={RECIPE_TEXT_HINT} autoFocus />
          </label>
          <div className="recipe-paste-foot">
            <button type="button" className="btn primary" disabled={busy !== null || !paste.trim()} onClick={readPaste}>
              {busy ? 'Reading…' : pastedLink ? '🔗 Import the link' : '✨ Read it'}
            </button>
            <button type="button" className="btn subtle" disabled={busy !== null} onClick={close}>
              Cancel
            </button>
            <button type="button" className="btn subtle" disabled={busy !== null} onClick={() => switchTo('link')}>
              🔗 A link instead
            </button>
          </div>
        </>
      ) : mode === 'link' ? (
        <>
          <label className="field">
            <span>Recipe link</span>
            <input
              type="url"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              value={link}
              onChange={e => setLink(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && link.trim() && busy === null) {
                  e.preventDefault()
                  void importFrom(link)
                }
              }}
              placeholder="https://…"
              autoFocus
            />
            <small className="field-hint">Drafter’s server opens the page and reads the recipe on it.</small>
          </label>
          <div className="recipe-paste-foot">
            <button type="button" className="btn primary" disabled={busy !== null || !link.trim()} onClick={() => void importFrom(link)}>
              {busy ? 'Importing…' : 'Import'}
            </button>
            <button type="button" className="btn subtle" disabled={busy !== null} onClick={close}>
              Cancel
            </button>
            <button type="button" className="btn subtle" disabled={busy !== null} onClick={() => switchTo('paste')}>
              Paste instead
            </button>
          </div>
        </>
      ) : (
        <div className="recipe-capture-row">
          <button
            type="button"
            className={`btn ${prominent ? 'primary' : 'subtle'} recipe-fill-btn`}
            disabled={!named || busy !== null}
            onClick={fillIn}
          >
            {busy === 'fill' ? 'Drafting…' : named ? '✨ Fill in ingredients & steps' : '✨ Fill in from the name'}
          </button>
          <button type="button" className="btn subtle" disabled={busy !== null} onClick={() => setMode('paste')}>
            ✨ Paste a recipe
          </button>
          <button type="button" className="btn subtle" disabled={busy !== null} onClick={() => setMode('link')}>
            🔗 Import from a link
          </button>
        </div>
      )}
      {error && <p className="warn">{error}</p>}
      {note && !error && (
        <p className="chart-sub" role="status">
          {note}
        </p>
      )}
    </div>
  )
}
