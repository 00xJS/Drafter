import {
  Attachment,
  CalendarSource,
  ChecklistItem,
  PERSON_GROUPS,
  Person,
  PersonGroup,
  PLACE_CATEGORIES,
  Place,
  PlaceCategory,
  Recipe,
  RecipeIngredient,
  Review,
  Meal,
  MealSlot,
  MEAL_SLOTS,
  GroceryList,
  GroceryLine,
  GroceryState,
  GROCERY_STATES,
  Template,
  TemplateMilestone,
  TemplateTask,
  Comment,
  Item,
  Metrics,
  Milestone,
  PLATFORMS,
  PRIORITIES,
  PROJECT_COLORS,
  PROJECT_STATUSES,
  Platform,
  Priority,
  Project,
  ProjectStatus,
  RecurrenceFreq,
  TASK_STATUSES,
  Task,
  TaskStatus,
} from './types'
import { legacyPostToTask } from '../shared/domain.mjs'

// Hand-rolled validation instead of a schema library: JSON backups and pre-v3
// records still live in the database, so the goal is coerce-and-repair, not
// strict rejection. Every entry point into the store goes through sanitizeItem.

export const STORAGE_VERSION = 3

const PLATFORM_SET = new Set<string>(PLATFORMS)
const TASK_STATUS_SET = new Set<string>(TASK_STATUSES)
const PROJECT_STATUS_SET = new Set<string>(PROJECT_STATUSES)
const PRIORITY_SET = new Set<string>(PRIORITIES)
const FREQ_SET = new Set(['daily', 'weekly', 'biweekly', 'monthly'])
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

function strList(v: unknown): string[] {
  return Array.isArray(v)
    ? v
        .filter((t): t is string => typeof t === 'string')
        .map(t => t.trim())
        .filter(Boolean)
    : []
}

function idList(v: unknown): string[] | undefined {
  const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  return list.length > 0 ? list : undefined
}

function checklist(v: unknown): ChecklistItem[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: ChecklistItem[] = []
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const id = str(r.id)
    const text = str(r.text)?.trim()
    if (id && text) out.push({ id, text, done: r.done === true })
  }
  return out.length > 0 ? out : undefined
}

function comments(v: unknown): Comment[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: Comment[] = []
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const id = str(r.id)
    const body = str(r.body)?.trim()
    const createdAt = isoDate(r.createdAt)
    if (id && body && createdAt) out.push({ id, body, createdAt })
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return out.length > 0 ? out : undefined
}

function milestones(v: unknown): Milestone[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: Milestone[] = []
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const id = str(r.id)
    const name = str(r.name)?.trim()
    if (id && name) out.push({ id, name, dueAt: isoDate(r.dueAt), done: r.done === true || undefined })
  }
  return out.length > 0 ? out : undefined
}

function social(v: unknown): Task['social'] {
  if (!v || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>
  const platforms = Array.isArray(r.platforms)
    ? (r.platforms.filter(p => typeof p === 'string' && PLATFORM_SET.has(p)) as Platform[])
    : []

  let metrics: Partial<Record<Platform, Metrics>> | undefined
  if (r.metrics && typeof r.metrics === 'object') {
    for (const [k, val] of Object.entries(r.metrics as Record<string, unknown>)) {
      if (!PLATFORM_SET.has(k) || !val || typeof val !== 'object') continue
      const src = val as Record<string, unknown>
      const m: Metrics = {}
      for (const mk of METRIC_KEYS) {
        const n = count(src[mk])
        if (n !== undefined) m[mk] = n
      }
      if (Object.keys(m).length > 0) (metrics ??= {})[k as Platform] = m
    }
  }

  let variants: Partial<Record<Platform, string>> | undefined
  if (r.variants && typeof r.variants === 'object') {
    for (const [k, val] of Object.entries(r.variants as Record<string, unknown>)) {
      if (PLATFORM_SET.has(k) && typeof val === 'string' && val.trim()) (variants ??= {})[k as Platform] = val
    }
  }

  if (platforms.length === 0 && !metrics && !variants) return undefined
  return { platforms, metrics, variants }
}

function attachments(v: unknown): Attachment[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: Attachment[] = []
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const id = str(r.id)
    if (!id) continue
    out.push({ id, name: str(r.name) ?? 'file', type: str(r.type) ?? 'application/octet-stream', size: count(r.size) ?? 0 })
  }
  return out.length > 0 ? out : undefined
}

function money(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v.replace(/[,\s£$€]/g, '')) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined
}

function dateOnly(v: unknown): string | undefined {
  const s = str(v)?.trim()
  if (!s) return undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const iso = isoDate(s)
  return iso ? iso.slice(0, 10) : undefined
}

function idOrUndefined(v: unknown): string | undefined {
  const s = str(v)?.trim()
  return s ? s : undefined
}

function urlOrUndefined(v: unknown): string | undefined {
  const s = str(v)?.trim()
  return s && /^https?:/.test(s) ? s : undefined
}

/** Coerce arbitrary data into a valid Task, repairing what it can. */
export function sanitizeTask(raw: unknown): Task | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  if (!id) return null

  const dueAt = isoDate(r.dueAt)
  let completedAt = isoDate(r.completedAt)
  const status: TaskStatus =
    typeof r.status === 'string' && TASK_STATUS_SET.has(r.status) ? (r.status as TaskStatus) : completedAt ? 'done' : 'todo'
  const now = new Date().toISOString()
  if (status === 'done') completedAt = completedAt ?? dueAt ?? now
  else completedAt = undefined

  const rawFreq = r.recurrence && typeof r.recurrence === 'object' ? (r.recurrence as { freq?: unknown }).freq : undefined
  const recurrence = typeof rawFreq === 'string' && FREQ_SET.has(rawFreq) ? { freq: rawFreq as RecurrenceFreq } : undefined

  return {
    kind: 'task',
    id,
    title: str(r.title) ?? '',
    description: str(r.description) ?? str(r.body) ?? '',
    status,
    priority: typeof r.priority === 'string' && PRIORITY_SET.has(r.priority) ? (r.priority as Priority) : 'normal',
    projectId: idOrUndefined(r.projectId),
    dueAt,
    completedAt,
    createdAt: isoDate(r.createdAt) ?? completedAt ?? now,
    updatedAt: isoDate(r.updatedAt) ?? completedAt ?? now,
    tags: strList(r.tags),
    notes: str(r.notes)?.trim() || undefined,
    link: urlOrUndefined(r.link),
    githubUrl: urlOrUndefined(r.githubUrl),
    checklist: checklist(r.checklist),
    comments: comments(r.comments),
    mediaIds: idList(r.mediaIds),
    recurrence,
    social: social(r.social),
    peopleIds: idList(r.peopleIds),
    placeId: idOrUndefined(r.placeId),
    attachments: attachments(r.attachments),
    estimateCost: money(r.estimateCost),
    actualCost: money(r.actualCost),
    blockedBy: idList(r.blockedBy),
    assigneeId: idOrUndefined(r.assigneeId),
    ownerId: idOrUndefined(r.ownerId),
    deletedAt: isoDate(r.deletedAt),
  }
}

/** Coerce arbitrary data into a valid Project. */
export function sanitizeProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  if (!id) return null
  const now = new Date().toISOString()
  const color = str(r.color)?.trim()
  return {
    kind: 'project',
    id,
    name: str(r.name)?.trim() || 'Untitled project',
    description: str(r.description)?.trim() || undefined,
    color: color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : PROJECT_COLORS[0],
    emoji: str(r.emoji)?.trim() || undefined,
    status:
      typeof r.status === 'string' && PROJECT_STATUS_SET.has(r.status) ? (r.status as ProjectStatus) : 'active',
    startAt: isoDate(r.startAt),
    targetAt: isoDate(r.targetAt),
    milestones: milestones(r.milestones),
    githubUrl: urlOrUndefined(r.githubUrl),
    notes: str(r.notes) || undefined,
    notesHtml: str(r.notesHtml) || undefined,
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt: isoDate(r.deletedAt),
  }
}

/** Coerce arbitrary data into a valid CalendarSource. */
export function sanitizeCalendar(raw: unknown): CalendarSource | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const url = str(r.url)?.trim()
  if (!id || !url) return null
  const now = new Date().toISOString()
  const color = str(r.color)?.trim()
  return {
    kind: 'calendar',
    id,
    name: str(r.name)?.trim() || 'Calendar',
    url,
    color: color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : PROJECT_COLORS[7],
    enabled: r.enabled !== false,
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt: isoDate(r.deletedAt),
  }
}

const PERSON_GROUP_SET = new Set<string>(PERSON_GROUPS)
const PLACE_CATEGORY_SET = new Set<string>(PLACE_CATEGORIES)
const MEAL_SLOT_SET = new Set<string>(MEAL_SLOTS)
const GROCERY_STATE_SET = new Set<string>(GROCERY_STATES)
const KNOWN_KINDS = new Set(['task', 'project', 'calendar', 'person', 'place', 'review', 'template', 'recipe', 'meal', 'grocery'])

/** Coerce arbitrary data into a valid Person. */
export function sanitizePerson(raw: unknown): Person | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const name = str(r.name)?.trim()
  if (!id || !name) return null
  const now = new Date().toISOString()
  const color = str(r.color)?.trim()
  const cadence = Number(r.cadenceDays)
  return {
    kind: 'person',
    id,
    name,
    emoji: str(r.emoji)?.trim() || undefined,
    color: color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : PROJECT_COLORS[5],
    group: typeof r.group === 'string' && PERSON_GROUP_SET.has(r.group) ? (r.group as PersonGroup) : 'family',
    cadenceDays: Number.isFinite(cadence) && cadence > 0 ? Math.round(cadence) : undefined,
    notes: str(r.notes)?.trim() || undefined,
    birthday: dateOnly(r.birthday),
    anniversary: dateOnly(r.anniversary),
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt: isoDate(r.deletedAt),
  }
}

/** Coerce arbitrary data into a valid Place. */
export function sanitizePlace(raw: unknown): Place | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const name = str(r.name)?.trim()
  const deletedAt = isoDate(r.deletedAt)
  if (!id || (!name && !deletedAt)) return null
  const now = new Date().toISOString()
  const color = str(r.color)?.trim()
  return {
    kind: 'place',
    id,
    name: name || 'Place',
    emoji: str(r.emoji)?.trim() || undefined,
    color: color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : PROJECT_COLORS[0],
    category:
      typeof r.category === 'string' && PLACE_CATEGORY_SET.has(r.category) ? (r.category as PlaceCategory) : 'other',
    notes: str(r.notes)?.trim() || undefined,
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt: isoDate(r.deletedAt),
  }
}

function sanitizeIngredients(raw: unknown): RecipeIngredient[] {
  if (!Array.isArray(raw)) return []
  const out: RecipeIngredient[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const name = str(r.name)?.trim()
    if (!name) continue
    const qty = Number(r.qty)
    out.push({
      id: str(r.id)?.trim() || `ing-${out.length + 1}`,
      name,
      qty: Number.isFinite(qty) && qty > 0 ? Math.round(qty * 100) / 100 : undefined,
      unit: str(r.unit)?.trim() || undefined,
    })
  }
  return out
}

export function sanitizeRecipe(raw: unknown): Recipe | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const name = str(r.name)?.trim()
  if (!id || !name) return null
  const now = new Date().toISOString()
  const servings = Number(r.servings)
  return {
    kind: 'recipe',
    id,
    name,
    emoji: str(r.emoji)?.trim() || undefined,
    servings: Number.isFinite(servings) && servings > 0 ? Math.round(servings) : undefined,
    ingredients: sanitizeIngredients(r.ingredients),
    steps: strList(r.steps).length ? strList(r.steps) : undefined,
    tags: strList(r.tags),
    notes: str(r.notes)?.trim() || undefined,
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt: isoDate(r.deletedAt),
  }
}

export function sanitizeMeal(raw: unknown): Meal | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const date = dateOnly(r.date)
  const title = str(r.title)?.trim()
  if (!id || !date || !title) return null
  const now = new Date().toISOString()
  const slot: MealSlot = typeof r.slot === 'string' && MEAL_SLOT_SET.has(r.slot) ? (r.slot as MealSlot) : 'dinner'
  return {
    kind: 'meal',
    id,
    date,
    slot,
    recipeId: idOrUndefined(r.recipeId),
    title,
    notes: str(r.notes)?.trim() || undefined,
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt: isoDate(r.deletedAt),
  }
}

function sanitizeGroceryLines(raw: unknown): GroceryLine[] {
  if (!Array.isArray(raw)) return []
  const out: GroceryLine[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const name = str(r.name)?.trim()
    if (!name) continue
    const qty = Number(r.qty)
    const state: GroceryState = typeof r.state === 'string' && GROCERY_STATE_SET.has(r.state) ? (r.state as GroceryState) : 'need'
    out.push({
      id: str(r.id)?.trim() || `g-${out.length + 1}`,
      name,
      qty: Number.isFinite(qty) && qty > 0 ? Math.round(qty * 100) / 100 : undefined,
      unit: str(r.unit)?.trim() || undefined,
      state,
      recipeIds: strList(r.recipeIds),
      manual: r.manual === true || undefined,
    })
  }
  return out
}

export function sanitizeGrocery(raw: unknown): GroceryList | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const weekKey = str(r.weekKey)?.trim()
  if (!id || !weekKey) return null
  const now = new Date().toISOString()
  return {
    kind: 'grocery',
    id,
    weekKey,
    items: sanitizeGroceryLines(r.items),
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt: isoDate(r.deletedAt),
  }
}

/** Coerce arbitrary data into a valid Review. */
export function sanitizeReview(raw: unknown): Review | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const key = str(r.key)
  if (!id || !key) return null
  const now = new Date().toISOString()
  return {
    kind: 'review',
    id,
    period: r.period === 'month' ? 'month' : 'week',
    key,
    top: strList(r.top).slice(0, 5),
    topDone: Array.isArray(r.topDone) ? r.topDone.map(Boolean).slice(0, 5) : undefined,
    reflections: str(r.reflections)?.trim() || undefined,
    summary: str(r.summary)?.trim() || undefined,
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt: isoDate(r.deletedAt),
  }
}

/** Coerce arbitrary data into a valid Template. */
export function sanitizeTemplate(raw: unknown): Template | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const name = str(r.name)?.trim()
  if (!id || !name) return null
  const now = new Date().toISOString()
  const color = str(r.color)?.trim()
  const tasks: TemplateTask[] = []
  if (Array.isArray(r.tasks)) {
    for (const raw of r.tasks) {
      if (!raw || typeof raw !== 'object') continue
      const t = raw as Record<string, unknown>
      const title = str(t.title)?.trim()
      if (!title) continue
      const offset = Number(t.offsetDays)
      tasks.push({
        title,
        description: str(t.description)?.trim() || undefined,
        offsetDays: Number.isFinite(offset) ? Math.round(offset) : undefined,
        priority: typeof t.priority === 'string' && PRIORITY_SET.has(t.priority) ? (t.priority as Priority) : undefined,
        checklist: strList(t.checklist).length ? strList(t.checklist) : undefined,
        tags: strList(t.tags).length ? strList(t.tags) : undefined,
      })
    }
  }
  const milestones: TemplateMilestone[] = []
  if (Array.isArray(r.milestones)) {
    for (const raw of r.milestones) {
      if (!raw || typeof raw !== 'object') continue
      const m = raw as Record<string, unknown>
      const name = str(m.name)?.trim()
      const offset = Number(m.offsetDays)
      if (name && Number.isFinite(offset)) milestones.push({ name, offsetDays: Math.round(offset) })
    }
  }
  const duration = Number(r.durationDays)
  return {
    kind: 'template',
    id,
    name,
    emoji: str(r.emoji)?.trim() || undefined,
    color: color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : PROJECT_COLORS[0],
    description: str(r.description)?.trim() || undefined,
    tasks,
    milestones: milestones.length ? milestones : undefined,
    notesHtml: str(r.notesHtml) || undefined,
    durationDays: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : undefined,
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt: isoDate(r.deletedAt),
  }
}

/**
 * Coerce any record — task, project, calendar, person, place, review, template, or a pre-v3 post — into a valid Item.
 * Returns null if unusable. Unknown string kinds return null so a stale client never
 * rewrites a newer kind (e.g. place) into a blank task and LWW-destroys it.
 */
export function sanitizeItem(raw: unknown): Item | null {
  if (!raw || typeof raw !== 'object') return null
  const converted = legacyPostToTask(raw) as Record<string, unknown>
  if (converted.kind === 'project') return sanitizeProject(converted)
  if (converted.kind === 'calendar') return sanitizeCalendar(converted)
  if (converted.kind === 'person') return sanitizePerson(converted)
  if (converted.kind === 'place') return sanitizePlace(converted)
  if (converted.kind === 'recipe') return sanitizeRecipe(converted)
  if (converted.kind === 'meal') return sanitizeMeal(converted)
  if (converted.kind === 'grocery') return sanitizeGrocery(converted)
  if (converted.kind === 'review') return sanitizeReview(converted)
  if (converted.kind === 'template') return sanitizeTemplate(converted)
  if (typeof converted.kind === 'string' && converted.kind !== '' && !KNOWN_KINDS.has(converted.kind)) return null
  return sanitizeTask(converted)
}

/**
 * Parse any stored/exported payload into items. Accepts the v1 bare array,
 * the v2 `{ version, posts }` wrapper and the v3 `{ version, items }` wrapper.
 * Returns null if the shape is unrecognized.
 */
export function migrateStored(data: unknown): Item[] | null {
  let list: unknown[] | null = null
  if (Array.isArray(data)) list = data
  else if (data && typeof data === 'object') {
    const d = data as { items?: unknown; posts?: unknown }
    if (Array.isArray(d.items)) list = d.items
    else if (Array.isArray(d.posts)) list = d.posts
  }
  if (!list) return null
  return list.map(sanitizeItem).filter((p): p is Item => p !== null)
}
