import { apiFetch } from './api'
import { readRecipe } from './ai'
import type { ReadRecipe } from './ai'
import { safeHttpUrl } from './links'
import { recipeSourceUrl } from './schema'
import { isSupabaseConfigured } from './supabase'

// Kitchen → "Import from a link". Drafter's server fetches the page
// (/api/recipe-import, netlify/functions/lib/recipeimport.mjs) and hands back
// the recipe the page describes, or its readable text, which is read here with
// ✨ exactly as a paste is. Either way it only fills the editor: nothing is
// saved until Save.

/** A recipe read from a link, ready for the editor, with the page it came from. */
export interface LinkRecipe extends ReadRecipe {
  sourceUrl: string
  /** 'page' when the site described its recipe itself; 'text' when ✨ read the page's words. */
  via: 'page' | 'text'
}

/** Said whenever the server is not there to ask: a copy running on its own, or no connection. */
export const NEEDS_SERVER = 'Importing from a link needs Drafter’s server, which this copy can’t reach. Paste the recipe’s text instead.'

export class ImportLinkError extends Error {
  /** True when the server was not there to ask, rather than a page that would not import. */
  readonly noServer: boolean
  constructor(message: string, noServer = false) {
    super(message)
    this.noServer = noServer
  }
}

const oneLine = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max).trim() : '')

/** What the server sent, in the editor's shape and no bigger than it should be: the app does not take the server's word for it. */
function fromServer(raw: unknown): ReadRecipe {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const ingredients: ReadRecipe['ingredients'] = []
  for (const x of Array.isArray(o.ingredients) ? o.ingredients : []) {
    if (ingredients.length >= 60) break
    const i = x && typeof x === 'object' ? (x as Record<string, unknown>) : {}
    const name = oneLine(i.name, 80)
    if (!name) continue
    const qty = typeof i.qty === 'number' && Number.isFinite(i.qty) && i.qty > 0 && i.qty <= 10_000 ? Math.round(i.qty * 100) / 100 : undefined
    const unit = oneLine(i.unit, 16)
    ingredients.push({ name, ...(qty !== undefined ? { qty } : {}), ...(unit ? { unit } : {}) })
  }
  const steps = (Array.isArray(o.steps) ? o.steps : [])
    .map(s => oneLine(s, 600))
    .filter(Boolean)
    .slice(0, 40)
  const n = typeof o.servings === 'number' ? Math.round(o.servings) : NaN
  return { name: oneLine(o.name, 120), servings: n >= 1 && n <= 64 ? n : undefined, ingredients, steps }
}

/**
 * Import the recipe at a link. Throws an ImportLinkError whose message says
 * what to do: a link that is not one, a page that would not import (the
 * server's own words), or — with `noServer` — no server to ask, which is what
 * a copy of the app running on its own gets.
 */
export async function importRecipeLink(
  raw: string,
  deps: { fetch?: typeof apiFetch; read?: (text: string) => Promise<ReadRecipe>; local?: boolean } = {},
): Promise<LinkRecipe> {
  const url = safeHttpUrl(String(raw ?? '').trim())
  if (!url) throw new ImportLinkError('That isn’t a web address — it should start with https://.')
  const local = deps.local ?? !isSupabaseConfigured()
  let res: Response
  try {
    res = await (deps.fetch ?? apiFetch)('/api/recipe-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
      timeoutMs: 20_000,
    })
  } catch {
    throw new ImportLinkError(NEEDS_SERVER, true)
  }
  const body: unknown = await res.json().catch(() => null)
  const error = body && typeof body === 'object' ? oneLine((body as { error?: unknown }).error, 300) : ''
  // no function answered: a page came back, or a not-found from a host without one
  if (!body || typeof body !== 'object' || res.status === 404 || res.status === 405) throw new ImportLinkError(NEEDS_SERVER, true)
  // a copy with no accounts has nobody the server would sign in
  if (local && (res.status === 401 || res.status === 503)) throw new ImportLinkError(NEEDS_SERVER, true)
  if (res.status === 401) throw new ImportLinkError('Your session has expired — sign in again, then import the link.')
  if (!res.ok) throw new ImportLinkError(error || `Couldn’t import that link (HTTP ${res.status}).`)
  const o = body as Record<string, unknown>
  const sourceUrl = recipeSourceUrl(o.sourceUrl) ?? url
  if (o.recipe && typeof o.recipe === 'object') {
    const recipe = fromServer(o.recipe)
    if (recipe.ingredients.length || recipe.steps.length) return { ...recipe, sourceUrl, via: 'page' }
  }
  const text = typeof o.text === 'string' ? o.text.trim() : ''
  if (!text) throw new ImportLinkError('Nothing on that page reads like a recipe.')
  const found = await (deps.read ?? readRecipe)(text)
  if (!found.ingredients.length && !found.steps.length) throw new ImportLinkError('Nothing on that page reads like a recipe — try pasting the part that does.')
  return { ...found, name: found.name || oneLine(o.title, 120), sourceUrl, via: 'text' }
}
