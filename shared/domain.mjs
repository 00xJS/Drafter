// Domain rules shared by the web app (src/) and the MCP server (mcp/).
// Dependency-free ESM so the MCP server stays zero-install.

export const PLATFORMS = ['x', 'instagram', 'threads', 'linkedin', 'facebook', 'tiktok', 'youtube']
export const STATUSES = ['idea', 'draft', 'scheduled', 'posted', 'canceled']
export const METRIC_KEYS = ['likes', 'comments', 'shares', 'impressions']

/** likes + comments + shares across every platform of a post. */
export function engagement(post) {
  let sum = 0
  for (const m of Object.values(post.metrics ?? {})) {
    if (!m) continue
    sum += (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0)
  }
  return sum
}

export function impressions(post) {
  let sum = 0
  for (const m of Object.values(post.metrics ?? {})) sum += m?.impressions ?? 0
  return sum
}

/** Keep only known metric fields with finite non-negative numeric values. */
export function cleanMetrics(raw) {
  const out = {}
  for (const key of METRIC_KEYS) {
    const n = Number(raw?.[key])
    if (Number.isFinite(n) && n >= 0) out[key] = Math.round(n)
  }
  return out
}

/**
 * A stamp guaranteed strictly newer than the previous one, so an edit always
 * wins the strictly-newer-wins merge against the copy it was based on — even
 * against clock skew or a bot that wrote a slightly-future timestamp.
 */
export function newerStamp(prevIso) {
  const prev = prevIso ? Date.parse(prevIso) : 0
  return new Date(Math.max(Date.now(), (Number.isFinite(prev) ? prev : 0) + 1)).toISOString()
}

/** The next scheduled occurrence of a recurring post, cloned from the one just completed. */
export function nextOccurrence(post, uidFn) {
  if (!post.recurrence) return null
  const baseIso = post.postedAt ?? post.scheduledFor
  const next = baseIso ? new Date(baseIso) : new Date()
  if (isNaN(next.getTime())) return null
  if (post.recurrence.freq === 'weekly') next.setDate(next.getDate() + 7)
  else if (post.recurrence.freq === 'biweekly') next.setDate(next.getDate() + 14)
  else next.setMonth(next.getMonth() + 1)
  const now = new Date().toISOString()
  return {
    id: uidFn(),
    title: post.title,
    body: post.body,
    platforms: [...post.platforms],
    status: 'scheduled',
    createdAt: now,
    updatedAt: now,
    scheduledFor: next.toISOString(),
    tags: [...(post.tags ?? [])],
    notes: post.notes,
    link: undefined,
    variants: post.variants ? { ...post.variants } : undefined,
    recurrence: { ...post.recurrence },
  }
}
