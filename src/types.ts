export type Platform = 'x' | 'instagram' | 'threads' | 'linkedin' | 'facebook' | 'tiktok' | 'youtube'
export type Status = 'idea' | 'draft' | 'scheduled' | 'posted'

export interface Metrics {
  likes?: number
  comments?: number
  shares?: number
  impressions?: number
}

export type RecurrenceFreq = 'weekly' | 'biweekly' | 'monthly'

export interface Recurrence {
  freq: RecurrenceFreq
}

export interface Post {
  id: string
  title: string
  body: string
  platforms: Platform[]
  status: Status
  createdAt: string
  updatedAt: string
  scheduledFor?: string
  postedAt?: string
  tags: string[]
  notes?: string
  link?: string
  metrics?: Partial<Record<Platform, Metrics>>
  /** Per-platform text overrides; a platform without an entry uses `body`. */
  variants?: Partial<Record<Platform, string>>
  /** Ids of images stored in IndexedDB. */
  mediaIds?: string[]
  recurrence?: Recurrence
  /** Tombstone: set instead of hard-deleting so deletes sync and can be undone. */
  deletedAt?: string
  /** When a due-post reminder was shown, to avoid repeats. */
  notifiedAt?: string
  sample?: boolean
}

export const RECURRENCE_META: Record<RecurrenceFreq, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
}

/** Effective text for a platform: its variant if set, else the main body. */
export function bodyFor(p: { body: string; variants?: Partial<Record<Platform, string>> }, pl: Platform): string {
  const v = p.variants?.[pl]
  return v && v.trim() ? v : p.body
}

export const PLATFORMS: Platform[] = ['x', 'instagram', 'threads', 'linkedin', 'facebook', 'tiktok', 'youtube']

export const PLATFORM_META: Record<Platform, { label: string; short: string; color: string; charLimit: number }> = {
  x: { label: 'X (Twitter)', short: 'X', color: '#111827', charLimit: 280 },
  instagram: { label: 'Instagram', short: 'IG', color: '#d6336c', charLimit: 2200 },
  threads: { label: 'Threads', short: 'TH', color: '#374151', charLimit: 500 },
  linkedin: { label: 'LinkedIn', short: 'LI', color: '#0a66c2', charLimit: 3000 },
  facebook: { label: 'Facebook', short: 'FB', color: '#1877f2', charLimit: 63206 },
  tiktok: { label: 'TikTok', short: 'TT', color: '#0f172a', charLimit: 2200 },
  youtube: { label: 'YouTube', short: 'YT', color: '#dc2626', charLimit: 5000 },
}

export const STATUSES: Status[] = ['idea', 'draft', 'scheduled', 'posted']

export const STATUS_META: Record<Status, { label: string; color: string; bg: string }> = {
  idea: { label: 'Idea', color: '#7c3aed', bg: '#f3eefe' },
  draft: { label: 'Draft', color: '#b45309', bg: '#fdf1dc' },
  scheduled: { label: 'Scheduled', color: '#0369a1', bg: '#e3f2fc' },
  posted: { label: 'Posted', color: '#15803d', bg: '#e2f7e9' },
}

export function engagement(p: Post): number {
  if (!p.metrics) return 0
  let sum = 0
  for (const m of Object.values(p.metrics)) {
    if (!m) continue
    sum += (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0)
  }
  return sum
}

export function impressions(p: Post): number {
  if (!p.metrics) return 0
  let sum = 0
  for (const m of Object.values(p.metrics)) sum += m?.impressions ?? 0
  return sum
}
