// Domain rules shared by the web app (src/) and the MCP server (mcp/).
// Dependency-free ESM so the MCP server stays zero-install.

export const PLATFORMS = ['x', 'instagram', 'threads', 'linkedin', 'facebook', 'tiktok', 'youtube']
export const METRIC_KEYS = ['likes', 'comments', 'shares', 'impressions']

/** Legacy (pre-v3) post statuses — still accepted on input, converted on read. */
export const POST_STATUSES = ['idea', 'draft', 'scheduled', 'posted', 'canceled']
export const TASK_STATUSES = ['wishlist', 'todo', 'doing', 'blocked', 'done', 'canceled']
export const PROJECT_STATUSES = ['active', 'paused', 'done', 'archived']
export const PRIORITIES = ['low', 'normal', 'high', 'urgent']
export const RECURRENCE_FREQS = ['daily', 'weekly', 'biweekly', 'monthly']

/** The project every migrated social post lands in (deterministic so all devices agree). */
export const SOCIAL_PROJECT_ID = 'project-social'

/** likes + comments + shares across every platform of a post/task. */
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

const LEGACY_STATUS = { idea: 'wishlist', draft: 'todo', scheduled: 'todo', posted: 'done', canceled: 'canceled' }

/** True for records written before v3 (social posts without a `kind`). */
export function isLegacyPost(raw) {
  return !!raw && typeof raw === 'object' && raw.kind === undefined
}

/**
 * Convert a pre-v3 post into a task. Pure and idempotent on already-converted
 * input (returns it untouched), so every reader can call it defensively.
 * Rows in the database are never rewritten just for shape: the conversion
 * runs on read, in the app and in the MCP server alike.
 */
export function legacyPostToTask(raw) {
  if (!isLegacyPost(raw)) return raw
  const platforms = Array.isArray(raw.platforms) ? raw.platforms.filter(p => PLATFORMS.includes(p)) : []
  const social = platforms.length > 0 || raw.metrics || raw.variants
  const task = {
    kind: 'task',
    id: raw.id,
    ownerId: raw.ownerId,
    title: raw.title ?? '',
    description: raw.body ?? '',
    status: LEGACY_STATUS[raw.status] ?? (raw.postedAt ? 'done' : 'todo'),
    priority: 'normal',
    projectId: social ? SOCIAL_PROJECT_ID : raw.projectId,
    dueAt: raw.scheduledFor,
    completedAt: raw.postedAt,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    deletedAt: raw.deletedAt,
    tags: raw.tags ?? [],
    notes: raw.notes,
    link: raw.link,
    mediaIds: raw.mediaIds,
    recurrence: raw.recurrence,
  }
  if (social) task.social = { platforms, variants: raw.variants, metrics: raw.metrics }
  return task
}

/** The next occurrence of a recurring task, cloned from the one just completed. */
export function nextOccurrence(task, uidFn) {
  if (!task.recurrence) return null
  const baseIso = task.completedAt ?? task.dueAt
  const next = baseIso ? new Date(baseIso) : new Date()
  if (isNaN(next.getTime())) return null
  const freq = task.recurrence.freq
  if (freq === 'daily') next.setDate(next.getDate() + 1)
  else if (freq === 'weekly') next.setDate(next.getDate() + 7)
  else if (freq === 'biweekly') next.setDate(next.getDate() + 14)
  else next.setMonth(next.getMonth() + 1)
  const now = new Date().toISOString()
  return {
    kind: 'task',
    id: uidFn(),
    title: task.title,
    description: task.description,
    status: 'todo',
    priority: task.priority ?? 'normal',
    projectId: task.projectId,
    createdAt: now,
    updatedAt: now,
    dueAt: next.toISOString(),
    tags: [...(task.tags ?? [])],
    notes: task.notes,
    checklist: task.checklist ? task.checklist.map(c => ({ ...c, done: false })) : undefined,
    social: task.social
      ? { platforms: [...task.social.platforms], variants: task.social.variants ? { ...task.social.variants } : undefined }
      : undefined,
    recurrence: { ...task.recurrence },
  }
}
