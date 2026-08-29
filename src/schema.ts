import { Metrics, PLATFORMS, Platform, Post, STATUSES, Status } from './types'

// Hand-rolled validation instead of a schema library: imports come from messy
// real-world files (archives, CSVs, old backups), so the goal is coerce-and-repair,
// not strict rejection. Every entry point into the store goes through sanitizePost.

export const STORAGE_VERSION = 2

const PLATFORM_SET = new Set<string>(PLATFORMS)
const STATUS_SET = new Set<string>(STATUSES)
const FREQ_SET = new Set(['weekly', 'biweekly', 'monthly'])
const METRIC_KEYS = ['likes', 'comments', 'shares', 'impressions'] as const

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return undefined
}

function isoDate(v: unknown): string | undefined {
  const s = str(v)
  if (!s) return undefined
  const t = new Date(s)
  return isNaN(t.getTime()) ? undefined : t.toISOString()
}

function count(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v.replace(/[,\s]/g, '')) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined
}

/** Coerce arbitrary data into a valid Post, repairing what it can. Returns null if unusable. */
export function sanitizePost(raw: unknown): Post | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  if (!id) return null

  const platforms = Array.isArray(r.platforms)
    ? (r.platforms.filter(p => typeof p === 'string' && PLATFORM_SET.has(p)) as Platform[])
    : []
  const scheduledFor = isoDate(r.scheduledFor)
  let postedAt = isoDate(r.postedAt)
  const status: Status =
    typeof r.status === 'string' && STATUS_SET.has(r.status)
      ? (r.status as Status)
      : postedAt
        ? 'posted'
        : scheduledFor
          ? 'scheduled'
          : 'draft'
  const now = new Date().toISOString()
  if (status === 'posted') postedAt = postedAt ?? scheduledFor ?? now
  else postedAt = undefined

  let metrics: Post['metrics']
  if (r.metrics && typeof r.metrics === 'object') {
    for (const [k, v] of Object.entries(r.metrics as Record<string, unknown>)) {
      if (!PLATFORM_SET.has(k) || !v || typeof v !== 'object') continue
      const src = v as Record<string, unknown>
      const m: Metrics = {}
      for (const mk of METRIC_KEYS) {
        const n = count(src[mk])
        if (n !== undefined) m[mk] = n
      }
      if (Object.keys(m).length > 0) (metrics ??= {})[k as Platform] = m
    }
  }

  let variants: Post['variants']
  if (r.variants && typeof r.variants === 'object') {
    for (const [k, v] of Object.entries(r.variants as Record<string, unknown>)) {
      if (PLATFORM_SET.has(k) && typeof v === 'string' && v.trim()) (variants ??= {})[k as Platform] = v
    }
  }

  const tags = Array.isArray(r.tags)
    ? r.tags
        .filter((t): t is string => typeof t === 'string')
        .map(t => t.trim())
        .filter(Boolean)
    : []

  const mediaIds = Array.isArray(r.mediaIds) ? r.mediaIds.filter((x): x is string => typeof x === 'string') : []

  const rawFreq = r.recurrence && typeof r.recurrence === 'object' ? (r.recurrence as { freq?: unknown }).freq : undefined
  const recurrence =
    typeof rawFreq === 'string' && FREQ_SET.has(rawFreq)
      ? { freq: rawFreq as 'weekly' | 'biweekly' | 'monthly' }
      : undefined

  return {
    id,
    title: str(r.title) ?? '',
    body: str(r.body) ?? '',
    platforms,
    status,
    createdAt: isoDate(r.createdAt) ?? postedAt ?? now,
    updatedAt: isoDate(r.updatedAt) ?? postedAt ?? now,
    scheduledFor,
    postedAt,
    tags,
    notes: str(r.notes)?.trim() || undefined,
    link: str(r.link)?.trim() || undefined,
    metrics,
    variants,
    mediaIds: mediaIds.length > 0 ? mediaIds : undefined,
    recurrence,
    deletedAt: isoDate(r.deletedAt),
  }
}

/**
 * Parse any stored/exported payload into posts. Accepts the v1 bare array and
 * the v2 `{ version, posts }` wrapper. Returns null if the shape is unrecognized.
 */
export function migrateStored(data: unknown): Post[] | null {
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { posts?: unknown }).posts)
      ? ((data as { posts: unknown[] }).posts)
      : null
  if (!list) return null
  return list.map(sanitizePost).filter((p): p is Post => p !== null)
}
