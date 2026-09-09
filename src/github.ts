import { apiFetch } from './api'

// GitHub link cards. The URL is parsed locally for an instant badge; the live
// state comes from the session-gated /api/github proxy and is cached briefly.

export type GithubRefType = 'issue' | 'pr' | 'repo' | 'project'
export type GithubState = 'open' | 'closed' | 'merged' | 'draft'

export interface GithubRef {
  type: GithubRefType
  owner: string
  repo?: string
  number?: number
}

export interface GithubCard {
  type: GithubRefType
  repo: string
  number?: number
  title: string
  state: GithubState
  url: string
  labels: { name: string; color?: string }[]
  assignees: string[]
  comments?: number
  openIssues?: number
  stars?: number
  items?: number
  description?: string
  milestone?: string
  updatedAt?: string
  /** The host has a token that can close / create issues. */
  canWrite?: boolean
}

async function post<T>(body: Record<string, unknown>): Promise<T> {
  const res = await apiFetch('/api/github', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok || !data) throw new Error(data?.error ?? `GitHub write failed (HTTP ${res.status}).`)
  return data
}

export function setIssueState(url: string, action: 'close' | 'reopen'): Promise<{ state: string }> {
  cache.delete(url.trim())
  return post({ action, url })
}

export function createIssue(repoUrl: string, title: string, body: string): Promise<{ url: string; number: number }> {
  return post({ action: 'create', repoUrl, title, body })
}

// ---- Projects v2 (two-way sync) ---------------------------------------------

export interface GithubFieldOption {
  id: string
  name: string
}

export interface GithubProjectField {
  id: string
  name: string
  options?: GithubFieldOption[]
}

export interface GithubProjectFields {
  projectId: string
  title?: string
  /** The single-select field the board calls Status (or the first one it has). */
  statusField?: Required<GithubProjectField>
  selectFields: Required<GithubProjectField>[]
  dateFields: GithubProjectField[]
}

/** One row of a Projects board, reduced to what a task cares about. */
export interface GithubProjectItem {
  itemId: string
  updatedAt: string
  contentUrl?: string
  statusFieldId?: string
  statusOptionId?: string
  statusName?: string
  dateFieldId?: string
  /** YYYY-MM-DD as GitHub stores it — a date field has no time. */
  date?: string
}

/** The board's Status options and Date fields, so the project editor can offer a mapping. */
export function fetchProjectFields(url: string): Promise<GithubProjectFields> {
  return post({ action: 'project-fields', url })
}

/** The board row for one issue / PR (null when the issue is not on the board). */
export function fetchProjectItem(
  url: string,
  contentUrl: string,
  fields: { statusFieldId?: string; dateFieldId?: string } = {},
): Promise<{ projectId?: string; item: GithubProjectItem | null }> {
  return post({ action: 'project-item', url, contentUrl, ...fields })
}

/**
 * Every row on the board, for the periodic pull — up to 300, and `truncated` is
 * true when the board has more than that. Rows past the cap are invisible to
 * the reconciler, so their tasks silently stop pulling; the caller says so once
 * rather than letting the board look merely quiet.
 */
export function fetchProjectItems(
  url: string,
  fields: { statusFieldId?: string; dateFieldId?: string } = {},
): Promise<{ projectId?: string; items: GithubProjectItem[]; truncated?: boolean }> {
  return post({ action: 'project-items', url, ...fields })
}

/** Write a board row's Status option and/or Date field. `date: null` clears it. */
export function setProjectItemFields(input: {
  projectId: string
  itemId: string
  statusFieldId?: string
  optionId?: string
  dateFieldId?: string
  date?: string | null
}): Promise<{ ok: true; wrote: number }> {
  return post({ action: 'project-set', ...input })
}

export function parseGithubUrl(input: string | undefined): GithubRef | null {
  if (!input) return null
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    return null
  }
  if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return null
  const parts = u.pathname.split('/').filter(Boolean)
  if (parts.length >= 4 && (parts[0] === 'orgs' || parts[0] === 'users') && parts[2] === 'projects') {
    return { type: 'project', owner: parts[1], number: Number(parts[3]) }
  }
  if (parts.length >= 4 && parts[2] === 'issues' && /^\d+$/.test(parts[3])) {
    return { type: 'issue', owner: parts[0], repo: parts[1], number: Number(parts[3]) }
  }
  if (parts.length >= 4 && parts[2] === 'pull' && /^\d+$/.test(parts[3])) {
    return { type: 'pr', owner: parts[0], repo: parts[1], number: Number(parts[3]) }
  }
  if (parts.length >= 2) return { type: 'repo', owner: parts[0], repo: parts[1] }
  return null
}

/** Short human label for a ref, e.g. "owner/repo#12" or "owner/repo". */
export function githubLabel(ref: GithubRef): string {
  if (ref.type === 'project') return `${ref.owner} · project #${ref.number}`
  const base = `${ref.owner}/${ref.repo}`
  return ref.number ? `${base}#${ref.number}` : base
}

const TTL_MS = 5 * 60_000
const cache = new Map<string, { at: number; card: GithubCard }>()
const inflight = new Map<string, Promise<GithubCard>>()

export async function fetchGithubCard(url: string, force = false): Promise<GithubCard> {
  const key = url.trim()
  const hit = cache.get(key)
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.card
  const pending = inflight.get(key)
  if (pending) return pending
  const p = (async () => {
    try {
      const res = await apiFetch(`/api/github?url=${encodeURIComponent(key)}`)
      const body = (await res.json().catch(() => null)) as (GithubCard & { error?: string }) | null
      if (!res.ok) throw new Error(body?.error ?? `GitHub lookup failed (HTTP ${res.status}).`)
      if (!body) throw new Error('GitHub lookup returned nothing.')
      cache.set(key, { at: Date.now(), card: body })
      return body
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, p)
  return p
}

export const GITHUB_STATE_META: Record<GithubState, { label: string; color: string; bg: string }> = {
  open: { label: 'Open', color: '#86efac', bg: 'rgba(34, 197, 94, 0.18)' },
  closed: { label: 'Closed', color: '#c4b5fd', bg: 'rgba(139, 92, 246, 0.2)' },
  merged: { label: 'Merged', color: '#c4b5fd', bg: 'rgba(139, 92, 246, 0.2)' },
  draft: { label: 'Draft', color: '#9ca3af', bg: 'rgba(148, 163, 184, 0.16)' },
}
