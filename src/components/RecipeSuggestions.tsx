import { useId, useRef, useState } from 'react'
import { mealHistory } from '../../shared/weekplan.mjs'
import { RecipeSuggestInput, RecipeSuggestion, recipeSuggestInput, recipeTitleKey, suggestRecipes } from '../ai'
import { newIngredient } from '../kitchen'
import { Meal, Recipe } from '../types'
import { dateKey, uid } from '../utils'
import { aiFailureKind } from './AskSheet'

// Kitchen → Recipes: "✨ Suggest recipes I'd like". The assistant reads the
// collection (names, tags, main ingredients, times cooked) and drafts dishes
// like the ones already cooked. Each waits here — kept on this device — until
// it is accepted (a real recipe, editable like any other) or deleted, which is
// for good: a deleted title is never suggested again.

export const SUGGESTIONS_KEY = 'drafter:recipe-suggestions'
export const DISMISSED_KEY = 'drafter:recipe-suggestions-dismissed'
const PENDING_MAX = 20
const DISMISSED_MAX = 300

/** A suggestion waiting for Accept or Delete. Its references were resolved to recipe ids when it arrived. */
export interface PendingSuggestion {
  id: string
  title: string
  why: string
  /** Ids of the recipes it is like. */
  like: string[]
  tags: string[]
  ingredients: { name: string; qty?: number; unit?: string }[]
  steps: string[]
  at: string
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const strs = (v: unknown, max: number, n: number) => (Array.isArray(v) ? v.map(x => str(x, max)).filter(Boolean).slice(0, n) : [])

/** What is stored, read defensively: anything malformed is dropped rather than shown. */
export function parsePending(raw: string | null): PendingSuggestion[] {
  let list: unknown
  try {
    list = JSON.parse(raw ?? '[]')
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  const out: PendingSuggestion[] = []
  for (const x of list) {
    if (!x || typeof x !== 'object') continue
    const s = x as Record<string, unknown>
    const title = str(s.title, 80)
    const id = str(s.id, 64)
    if (!title || !id) continue
    const ingredients = (Array.isArray(s.ingredients) ? s.ingredients : []).flatMap(i => {
      if (!i || typeof i !== 'object') return []
      const o = i as Record<string, unknown>
      const name = str(o.name, 60)
      if (!name) return []
      const qty = typeof o.qty === 'number' && Number.isFinite(o.qty) && o.qty > 0 ? o.qty : undefined
      const unit = str(o.unit, 16)
      return [{ name, ...(qty !== undefined ? { qty } : {}), ...(unit ? { unit } : {}) }]
    })
    out.push({ id, title, why: str(s.why, 200), like: strs(s.like, 64, 3), tags: strs(s.tags, 24, 6), ingredients: ingredients.slice(0, 20), steps: strs(s.steps, 300, 12), at: str(s.at, 40) })
  }
  return out.slice(-PENDING_MAX)
}

/** The deleted titles, once each by their key. */
export function parseDismissed(raw: string | null): string[] {
  let list: unknown
  try {
    list = JSON.parse(raw ?? '[]')
  } catch {
    return []
  }
  const seen = new Set<string>()
  return (Array.isArray(list) ? list : [])
    .map(t => str(t, 80))
    .filter(t => {
      const key = recipeTitleKey(t)
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(-DISMISSED_MAX)
}

/**
 * The assistant's dishes worth keeping: each title once, and never one that is
 * already a recipe, was deleted before or is already waiting — with the
 * references it was shown turned back into recipe ids.
 */
export function freshSuggestions(
  res: readonly RecipeSuggestion[],
  o: { ids: Record<string, string>; recipes: readonly Recipe[]; dismissed: readonly string[]; pending: readonly PendingSuggestion[]; makeId(): string; at: string },
): PendingSuggestion[] {
  const taken = new Set([
    ...o.recipes.filter(r => !r.deletedAt).map(r => recipeTitleKey(r.name)),
    ...o.dismissed.map(recipeTitleKey),
    ...o.pending.map(p => recipeTitleKey(p.title)),
  ])
  const out: PendingSuggestion[] = []
  for (const s of res) {
    const key = recipeTitleKey(s.title)
    if (!key || taken.has(key)) continue
    taken.add(key)
    const like = s.similarTo.map(ref => o.ids[ref]).filter((id): id is string => !!id)
    out.push({ id: o.makeId(), title: s.title, why: s.why, like, tags: s.tags, ingredients: s.ingredients, steps: s.steps, at: o.at })
  }
  return out
}

/** An accepted suggestion as a recipe: its drafted ingredients and steps, ready to edit like any other. */
export function suggestionRecipe(s: PendingSuggestion, o: { id: string; now: Date }): Recipe {
  const stamp = o.now.toISOString()
  return {
    kind: 'recipe',
    id: o.id,
    name: s.title,
    ingredients: s.ingredients.map(i => ({ ...newIngredient(), name: i.name, ...(i.qty !== undefined ? { qty: i.qty } : {}), ...(i.unit ? { unit: i.unit } : {}) })),
    steps: [...s.steps],
    tags: [...s.tags],
    createdAt: stamp,
    updatedAt: stamp,
  }
}

function read<T>(key: string, parse: (raw: string | null) => T): T {
  try {
    return parse(localStorage.getItem(key))
  } catch {
    return parse(null)
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode or a full quota: they last as long as this screen */
  }
}

interface Props {
  recipes: Recipe[]
  /** For how often each recipe was cooked. */
  meals: Meal[]
  /** Save the accepted suggestion through the Kitchen's own recipe path. */
  onAccept(r: Recipe): void
  /** The ✨ call; defaults to suggestRecipes' one /api/ai request. */
  suggest?(input: RecipeSuggestInput): Promise<RecipeSuggestion[]>
  now?: Date
}

export function RecipeSuggestions({ recipes, meals, onAccept, suggest = suggestRecipes, now }: Props) {
  const [pending, setPending] = useState<PendingSuggestion[]>(() => read(SUGGESTIONS_KEY, parsePending))
  const [dismissed, setDismissed] = useState<string[]>(() => read(DISMISSED_KEY, parseDismissed))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const headId = useId()
  // the answer lands after an await: read what is waiting then, not when it was asked
  const latest = useRef({ pending, dismissed })
  latest.current = { pending, dismissed }

  const mine = recipes.filter(r => !r.deletedAt)
  // a dish since saved by hand is not waiting any more
  const have = new Set(mine.map(r => recipeTitleKey(r.name)))
  const shown = pending.filter(p => !have.has(recipeTitleKey(p.title)))
  const names = new Map(mine.map(r => [r.id, r.name]))

  const savePending = (next: PendingSuggestion[]) => {
    setPending(next)
    write(SUGGESTIONS_KEY, next)
  }

  const ask = async () => {
    setBusy(true)
    setMessage('')
    try {
      const at = now ?? new Date()
      const { input, ids } = recipeSuggestInput({
        recipes: mine,
        history: mealHistory([...mine, ...meals], { dayKey: dateKey(at), now: at }),
        exclude: [...latest.current.dismissed, ...latest.current.pending.map(p => p.title)],
      })
      const res = await suggest(input)
      const { pending: waiting, dismissed: gone } = latest.current
      const fresh = freshSuggestions(res, { ids, recipes: mine, dismissed: gone, pending: waiting, makeId: uid, at: new Date().toISOString() })
      if (fresh.length === 0) setMessage('No new ideas this time — try again another day.')
      else savePending([...waiting, ...fresh].slice(-PENDING_MAX))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const kind = aiFailureKind(msg)
      setMessage(
        kind === 'busy'
          ? 'The assistant is busy — try again in a minute.'
          : kind === 'unavailable'
            ? 'Suggestions need the assistant, which isn’t available here.'
            : `Couldn’t get ideas: ${msg}`,
      )
    } finally {
      setBusy(false)
    }
  }

  const accept = (s: PendingSuggestion) => {
    savePending(latest.current.pending.filter(p => p.id !== s.id))
    onAccept(suggestionRecipe(s, { id: uid(), now: new Date() }))
  }

  const remove = (s: PendingSuggestion) => {
    const next = [...latest.current.dismissed, s.title].slice(-DISMISSED_MAX)
    setDismissed(next)
    write(DISMISSED_KEY, next)
    savePending(latest.current.pending.filter(p => p.id !== s.id))
  }

  if (mine.length === 0 && shown.length === 0) return null

  return (
    <section className="chart-card recipe-suggest" aria-labelledby={headId}>
      <header className="chart-head">
        <div>
          <h3 id={headId}>Recipes you might like</h3>
          <p className="chart-sub">Close cousins of what you already cook. Accept to add one; delete to never see it again.</p>
        </div>
        <button type="button" className="btn" onClick={ask} disabled={busy || mine.length === 0}>
          {busy ? 'Thinking…' : shown.length > 0 ? '✨ More ideas' : '✨ Suggest recipes I’d like'}
        </button>
      </header>
      {message && (
        <p className="ask-note" role="status">
          {message}
        </p>
      )}
      {shown.length > 0 && (
        <ul className="recipe-suggest-list">
          {shown.map(s => {
            const like = s.like.map(id => names.get(id)).filter((n): n is string => !!n)
            return (
              <li key={s.id} className="recipe-suggest-card">
                <div className="dash-main">
                  <span className="dash-title">{s.title}</span>
                  {s.why && <span className="recipe-suggest-why">{s.why}</span>}
                  {like.length > 0 && <span className="recipe-suggest-like">Like your {like.join(' · ')}</span>}
                  <span className="dash-meta">
                    {s.ingredients.length} ingredient{s.ingredients.length === 1 ? '' : 's'} · {s.steps.length} step{s.steps.length === 1 ? '' : 's'}
                    {s.tags.length > 0 && ` · ${s.tags.join(', ')}`}
                  </span>
                  {(s.ingredients.length > 0 || s.steps.length > 0) && (
                    <details className="recipe-suggest-more">
                      <summary>Ingredients and steps</summary>
                      {s.ingredients.length > 0 && (
                        <ul className="recipe-ings">
                          {s.ingredients.map((i, n) => (
                            <li key={n}>
                              {i.qty !== undefined ? `${i.qty}${i.unit ? ' ' + i.unit : ''} ` : ''}
                              {i.name}
                            </li>
                          ))}
                        </ul>
                      )}
                      {s.steps.length > 0 && (
                        <ol className="recipe-suggest-steps">
                          {s.steps.map((step, n) => (
                            <li key={n}>{step}</li>
                          ))}
                        </ol>
                      )}
                    </details>
                  )}
                </div>
                <div className="recipe-suggest-actions">
                  <button type="button" className="btn primary" onClick={() => accept(s)}>
                    Accept
                  </button>
                  <button type="button" className="btn subtle" onClick={() => remove(s)} aria-label={`Delete ${s.title} for good`}>
                    Delete
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
