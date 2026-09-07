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
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

export type Item = Task | Project

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
  x: { label: 'X (Twitter)', short: 'X', color: '#111827', charLimit: 280 },
  instagram: { label: 'Instagram', short: 'IG', color: '#d6336c', charLimit: 2200 },
  threads: { label: 'Threads', short: 'TH', color: '#374151', charLimit: 500 },
  linkedin: { label: 'LinkedIn', short: 'LI', color: '#0a66c2', charLimit: 3000 },
  facebook: { label: 'Facebook', short: 'FB', color: '#1877f2', charLimit: 63206 },
  tiktok: { label: 'TikTok', short: 'TT', color: '#0f172a', charLimit: 2200 },
  youtube: { label: 'YouTube', short: 'YT', color: '#dc2626', charLimit: 5000 },
}

export const TASK_STATUSES: TaskStatus[] = ['wishlist', 'todo', 'doing', 'blocked', 'done', 'canceled']

export const STATUS_META: Record<TaskStatus, { label: string; color: string; bg: string }> = {
  wishlist: { label: 'Wishlist', color: '#7c3aed', bg: '#f3eefe' },
  todo: { label: 'To do', color: '#b45309', bg: '#fdf1dc' },
  doing: { label: 'Doing', color: '#0369a1', bg: '#e3f2fc' },
  blocked: { label: 'Blocked', color: '#be123c', bg: '#fde7ec' },
  done: { label: 'Done', color: '#15803d', bg: '#e2f7e9' },
  canceled: { label: 'Canceled', color: '#6b7280', bg: '#f1f2f4' },
}

/** Statuses that still need work — the "open" set every due-date view cares about. */
export const OPEN_STATUSES: TaskStatus[] = ['todo', 'doing', 'blocked']

export const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent']

export const PRIORITY_META: Record<Priority, { label: string; color: string; glyph: string; rank: number }> = {
  low: { label: 'Low', color: '#6b7280', glyph: '▽', rank: 0 },
  normal: { label: 'Normal', color: '#52514e', glyph: '—', rank: 1 },
  high: { label: 'High', color: '#c2410c', glyph: '▲', rank: 2 },
  urgent: { label: 'Urgent', color: '#b91c1c', glyph: '‼', rank: 3 },
}

export const PROJECT_STATUSES: ProjectStatus[] = ['active', 'paused', 'done', 'archived']

export const PROJECT_STATUS_META: Record<ProjectStatus, { label: string; color: string; bg: string }> = {
  active: { label: 'Active', color: '#0369a1', bg: '#e3f2fc' },
  paused: { label: 'Paused', color: '#b45309', bg: '#fdf1dc' },
  done: { label: 'Done', color: '#15803d', bg: '#e2f7e9' },
  archived: { label: 'Archived', color: '#6b7280', bg: '#f1f2f4' },
}

export const PROJECT_COLORS = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#dc2626', '#db2777', '#7c3aed', '#475569']

export { engagement, impressions, SOCIAL_PROJECT_ID } from '../shared/domain.mjs'

/** Progress of a project's tasks: done vs everything that isn't canceled. */
export function projectProgress(tasks: Task[]): { done: number; total: number; pct: number } {
  const live = tasks.filter(t => t.status !== 'canceled')
  const done = live.filter(t => t.status === 'done').length
  return { done, total: live.length, pct: live.length === 0 ? 0 : Math.round((done / live.length) * 100) }
}
