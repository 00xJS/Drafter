export type Platform = 'x' | 'instagram' | 'threads' | 'linkedin' | 'facebook' | 'tiktok' | 'youtube'
/** Pre-v3 post statuses; only used by the social "post view" and importers. */
export type PostStatus = 'idea' | 'draft' | 'scheduled' | 'posted' | 'canceled'
export type TaskStatus = 'wishlist' | 'todo' | 'doing' | 'blocked' | 'done' | 'canceled'
export type ProjectStatus = 'active' | 'paused' | 'done' | 'archived'
export type Priority = 'low' | 'normal' | 'high' | 'urgent'
export type RecurrenceFreq = 'daily' | 'weekly' | 'biweekly' | 'monthly'

export interface Metrics {
  likes?: number
  comments?: number
  shares?: number
  impressions?: number
}

export interface Recurrence {
  freq: RecurrenceFreq
}

export interface Comment {
  id: string
  body: string
  createdAt: string
}

export interface ChecklistItem {
  id: string
  text: string
  done: boolean
}

export interface Milestone {
  id: string
  name: string
  dueAt?: string
  done?: boolean
}

/** The social-publishing extension of a task; present only on tasks that are posts. */
export interface Social {
  platforms: Platform[]
  /** Per-platform text overrides; a platform without an entry uses the description. */
  variants?: Partial<Record<Platform, string>>
  metrics?: Partial<Record<Platform, Metrics>>
}

export interface Task {
  kind: 'task'
  id: string
  title: string
  description: string
  status: TaskStatus
  priority: Priority
  projectId?: string
  dueAt?: string
  completedAt?: string
  createdAt: string
  updatedAt: string
  tags: string[]
  notes?: string
  link?: string
  /** A GitHub issue / PR / repo / Projects URL, rendered as a live status card. */
  githubUrl?: string
  checklist?: ChecklistItem[]
  comments?: Comment[]
  /** Ids of images stored in IndexedDB / Supabase Storage. */
  mediaIds?: string[]
  recurrence?: Recurrence
  social?: Social
  /** Tombstone: set instead of hard-deleting so deletes sync and can be undone. */
  deletedAt?: string
}

export interface Project {
  kind: 'project'
  id: string
  name: string
  description?: string
  color: string
  emoji?: string
  status: ProjectStatus
  startAt?: string
  targetAt?: string
  milestones?: Milestone[]
  githubUrl?: string
  /** Legacy Markdown notes (pre rich text); converted into notesHtml on first open. */
  notes?: string
  /** Rich-text notes as a sanitized HTML subset; photos reference the media store by id. */
  notesHtml?: string
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

/** A subscribed external calendar (Google secret address, iCloud share link, any ICS feed). */
export interface CalendarSource {
  kind: 'calendar'
  id: string
  name: string
  url: string
  color: string
  enabled: boolean
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

/** One concrete occurrence of an external event, as returned by /api/calendars. */
export interface CalendarEvent {
  id: string
  sourceId: string
  title: string
  /** ISO datetime, or YYYY-MM-DD for all-day events. */
  start: string
  /** Exclusive end: ISO datetime, or YYYY-MM-DD for all-day events. */
  end: string
  allDay: boolean
  location?: string
}

export type Item = Task | Project | CalendarSource

/**
 * The legacy post shape. Still the lingua franca of the importers, the
 * Insights charts and the AI analysis: `toPost` projects a social task into it.
 */
export interface Post {
  id: string
  title: string
  body: string
  platforms: Platform[]
  status: PostStatus
  createdAt: string
  updatedAt: string
  scheduledFor?: string
  postedAt?: string
  tags: string[]
  notes?: string
  link?: string
  metrics?: Partial<Record<Platform, Metrics>>
  variants?: Partial<Record<Platform, string>>
  mediaIds?: string[]
  recurrence?: Recurrence
  deletedAt?: string
}

const TASK_TO_POST_STATUS: Record<TaskStatus, PostStatus> = {
  wishlist: 'idea',
  todo: 'draft',
  doing: 'draft',
  blocked: 'draft',
  done: 'posted',
  canceled: 'canceled',
}

/** Social view of a task, or null when the task is not a post. */
export function toPost(t: Task): Post | null {
  if (!t.social) return null
  const status = t.status === 'todo' && t.dueAt ? 'scheduled' : TASK_TO_POST_STATUS[t.status]
  return {
    id: t.id,
    title: t.title,
    body: t.description,
    platforms: t.social.platforms,
    status,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    scheduledFor: t.dueAt,
    postedAt: t.completedAt,
    tags: t.tags,
    notes: t.notes,
    link: t.link,
    metrics: t.social.metrics,
    variants: t.social.variants,
    mediaIds: t.mediaIds,
    recurrence: t.recurrence,
    deletedAt: t.deletedAt,
  }
}

/** Effective text for a platform: its variant if set, else the description. */
export function bodyFor(t: { description: string; social?: Social }, pl: Platform): string {
  const v = t.social?.variants?.[pl]
  return v && v.trim() ? v : t.description
}

export const RECURRENCE_META: Record<RecurrenceFreq, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
}

export const PLATFORMS: Platform[] = ['x', 'instagram', 'threads', 'linkedin', 'facebook', 'tiktok', 'youtube']

export const PLATFORM_META: Record<Platform, { label: string; short: string; color: string; charLimit: number }> = {
  x: { label: 'X (Twitter)', short: 'X', color: '#52525b', charLimit: 280 },
  instagram: { label: 'Instagram', short: 'IG', color: '#db2777', charLimit: 2200 },
  threads: { label: 'Threads', short: 'TH', color: '#6b7280', charLimit: 500 },
  linkedin: { label: 'LinkedIn', short: 'LI', color: '#0a66c2', charLimit: 3000 },
  facebook: { label: 'Facebook', short: 'FB', color: '#1877f2', charLimit: 63206 },
  tiktok: { label: 'TikTok', short: 'TT', color: '#475569', charLimit: 2200 },
  youtube: { label: 'YouTube', short: 'YT', color: '#dc2626', charLimit: 5000 },
}

export const TASK_STATUSES: TaskStatus[] = ['wishlist', 'todo', 'doing', 'blocked', 'done', 'canceled']

export const STATUS_META: Record<TaskStatus, { label: string; color: string; bg: string }> = {
  wishlist: { label: 'Wishlist', color: '#c4b5fd', bg: 'rgba(139, 92, 246, 0.2)' },
  todo: { label: 'To do', color: '#fcd34d', bg: 'rgba(245, 158, 11, 0.18)' },
  doing: { label: 'Doing', color: '#7dd3fc', bg: 'rgba(14, 165, 233, 0.2)' },
  blocked: { label: 'Blocked', color: '#fda4af', bg: 'rgba(244, 63, 94, 0.2)' },
  done: { label: 'Done', color: '#86efac', bg: 'rgba(34, 197, 94, 0.18)' },
  canceled: { label: 'Canceled', color: '#9ca3af', bg: 'rgba(148, 163, 184, 0.16)' },
}

/** Statuses that still need work — the "open" set every due-date view cares about. */
export const OPEN_STATUSES: TaskStatus[] = ['todo', 'doing', 'blocked']

export const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent']

export const PRIORITY_META: Record<Priority, { label: string; color: string; glyph: string; rank: number }> = {
  low: { label: 'Low', color: '#9ca3af', glyph: '▽', rank: 0 },
  normal: { label: 'Normal', color: '#b3b8c4', glyph: '—', rank: 1 },
  high: { label: 'High', color: '#fb923c', glyph: '▲', rank: 2 },
  urgent: { label: 'Urgent', color: '#f87171', glyph: '‼', rank: 3 },
}

export const PROJECT_STATUSES: ProjectStatus[] = ['active', 'paused', 'done', 'archived']

export const PROJECT_STATUS_META: Record<ProjectStatus, { label: string; color: string; bg: string }> = {
  active: { label: 'Active', color: '#7dd3fc', bg: 'rgba(14, 165, 233, 0.2)' },
  paused: { label: 'Paused', color: '#fcd34d', bg: 'rgba(245, 158, 11, 0.18)' },
  done: { label: 'Done', color: '#86efac', bg: 'rgba(34, 197, 94, 0.18)' },
  archived: { label: 'Archived', color: '#9ca3af', bg: 'rgba(148, 163, 184, 0.16)' },
}

export const PROJECT_COLORS = ['#f97316', '#fbbf24', '#34d399', '#22d3ee', '#818cf8', '#f472b6', '#f87171', '#94a3b8']

export { engagement, impressions, SOCIAL_PROJECT_ID } from '../shared/domain.mjs'

/** Progress of a project's tasks: done vs everything that isn't canceled. */
export function projectProgress(tasks: Task[]): { done: number; total: number; pct: number } {
  const live = tasks.filter(t => t.status !== 'canceled')
  const done = live.filter(t => t.status === 'done').length
  return { done, total: live.length, pct: live.length === 0 ? 0 : Math.round((done / live.length) * 100) }
}
