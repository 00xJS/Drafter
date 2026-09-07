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
