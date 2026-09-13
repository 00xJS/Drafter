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
  JournalEntry,
  Habit,
  Routine,
  RoutineStep,
  RoutineWhen,
  ROUTINE_WHENS,
  CalendarEntry,
  Bill,
  BillKind,
  BILL_KINDS,
  Mood,
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
  GithubProjectSync,
  Note,
} from './types'
import { legacyPostToTask } from '../shared/domain.mjs'
import { SYNC_KINDS } from '../shared/kinds.mjs'
import { isDayKey } from '../shared/weeks.mjs'
import { sanitizeHtml } from './richtext'

// Hand-rolled validation instead of a schema library: JSON backups and pre-v3
// records still live in the database, so the goal is coerce-and-repair, not
// strict rejection. Every entry point into the store goes through sanitizeItem.

export const STORAGE_VERSION = 3

const PLATFORM_SET = new Set<string>(PLATFORMS)
const TASK_STATUS_SET = new Set<string>(TASK_STATUSES)
const PROJECT_STATUS_SET = new Set<string>(PROJECT_STATUSES)
const PRIORITY_SET = new Set<string>(PRIORITIES)
// every frequency the model knows, or a quarterly bill loses its repeat on the first sync
const FREQ_SET = new Set(['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'])
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

/**
 * A local day key and nothing else: YYYY-MM-DD that is a real calendar day.
 * Unlike dateOnly it never turns an instant into a day — an ISO timestamp's
 * date is its UTC date, which is the wrong day for anyone east or west of it.
 */
function dayKeyOnly(v: unknown): string | undefined {
  const s = str(v)?.trim()
  return s && isDayKey(s) ? s : undefined
}

function idOrUndefined(v: unknown): string | undefined {
  const s = str(v)?.trim()
  return s ? s : undefined
}

function urlOrUndefined(v: unknown): string | undefined {
  const s = str(v)?.trim()
  return s && /^https?:/.test(s) ? s : undefined
}

const BILL_KIND_SET = new Set<string>(BILL_KINDS)

/** A task's payment facet, or nothing: an unknown kind is dropped rather than guessed. */
function bill(v: unknown): Bill | undefined {
  if (!v || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>
  if (typeof r.kind !== 'string' || !BILL_KIND_SET.has(r.kind)) return undefined
  const day = Number(r.day)
  return {
    kind: r.kind as BillKind,
    payee: str(r.payee)?.trim() || undefined,
    autopay: r.autopay === true || undefined,
    day: Number.isInteger(day) && day >= 1 && day <= 31 ? day : undefined,
  }
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
    bill: bill(r.bill),
    peopleIds: idList(r.peopleIds),
    placeId: idOrUndefined(r.placeId),
    attachments: attachments(r.attachments),
    estimateCost: money(r.estimateCost),
    actualCost: money(r.actualCost),
    blockedBy: idList(r.blockedBy),
    assigneeId: idOrUndefined(r.assigneeId),
    focusOn: dayKeyOnly(r.focusOn),
    focusBy: idOrUndefined(r.focusBy),
    ownerId: idOrUndefined(r.ownerId),
    deletedAt: isoDate(r.deletedAt),
    purged: r.purged === true || undefined,
  }
}

/**
 * GitHub Projects sync settings: three known keys, everything else dropped.
 * The ids are opaque GitHub node ids, so they are kept as plain trimmed
 * strings (bounded) and never parsed.
 */
function githubProjectSync(raw: unknown): GithubProjectSync | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const node = (v: unknown) => str(v)?.trim().slice(0, 200) || undefined
  const out: GithubProjectSync = {}
  const statusFieldId = node(r.statusFieldId)
  const dateFieldId = node(r.dateFieldId)
  if (statusFieldId) out.statusFieldId = statusFieldId
  if (dateFieldId) out.dateFieldId = dateFieldId
  if (r.columns && typeof r.columns === 'object' && !Array.isArray(r.columns)) {
    const src = r.columns as Record<string, unknown>
    const columns: Partial<Record<TaskStatus, string>> = {}
    for (const s of TASK_STATUSES) {
      const option = node(src[s])
      if (option) columns[s] = option
    }
    if (Object.keys(columns).length > 0) out.columns = columns
  }
  return Object.keys(out).length > 0 ? out : undefined
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
    githubProjectSync: githubProjectSync(r.githubProjectSync),
    notes: str(r.notes) || undefined,
    notesHtml: str(r.notesHtml) || undefined,
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt: isoDate(r.deletedAt),
    purged: r.purged === true || undefined,
  }
}

/** Coerce arbitrary data into a valid CalendarSource. */
export function sanitizeCalendar(raw: unknown): CalendarSource | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const url = str(r.url)?.trim()
  const deletedAt = isoDate(r.deletedAt)
  // a purge tombstone carries no url; it must still round-trip so peers drop the record
  if (!id || (!url && !deletedAt)) return null
  const now = new Date().toISOString()
  const color = str(r.color)?.trim()
  return {
    kind: 'calendar',
    id,
    name: str(r.name)?.trim() || (deletedAt ? '' : 'Calendar'),
    url: url ?? '',
    color: color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : PROJECT_COLORS[7],
    enabled: r.enabled !== false,
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt: isoDate(r.deletedAt),
    purged: r.purged === true || undefined,
  }
}

const PERSON_GROUP_SET = new Set<string>(PERSON_GROUPS)
const PLACE_CATEGORY_SET = new Set<string>(PLACE_CATEGORIES)
const MEAL_SLOT_SET = new Set<string>(MEAL_SLOTS)
const GROCERY_STATE_SET = new Set<string>(GROCERY_STATES)
const ROUTINE_WHEN_SET = new Set<string>(ROUTINE_WHENS)
/** Every kind sync_posts accepts — one list, in shared/kinds.mjs; a test holds the newest migration to it. */
export const KNOWN_KINDS = SYNC_KINDS

/** Coerce arbitrary data into a valid Person. */
export function sanitizePerson(raw: unknown): Person | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const name = str(r.name)?.trim()
  const deletedAt = isoDate(r.deletedAt)
  if (!id || (!name && !deletedAt)) return null
  const now = new Date().toISOString()
  const color = str(r.color)?.trim()
  const cadence = Number(r.cadenceDays)
  return {
    kind: 'person',
    id,
    name: name ?? '',
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
    purged: r.purged === true || undefined,
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
  const cadence = Number(r.cadenceDays)
  return {
    kind: 'place',
    id,
    name: name || 'Place',
    emoji: str(r.emoji)?.trim() || undefined,
    color: color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : PROJECT_COLORS[0],
    category:
      typeof r.category === 'string' && PLACE_CATEGORY_SET.has(r.category) ? (r.category as PlaceCategory) : 'other',
    cadenceDays: Number.isFinite(cadence) && cadence > 0 ? Math.round(cadence) : undefined,
    notes: str(r.notes)?.trim() || undefined,
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt: isoDate(r.deletedAt),
    purged: r.purged === true || undefined,
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
  const deletedAt = isoDate(r.deletedAt)
  if (!id || (!name && !deletedAt)) return null
  const now = new Date().toISOString()
  const servings = Number(r.servings)
  return {
    kind: 'recipe',
    id,
    name: name ?? '',
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
    purged: r.purged === true || undefined,
  }
}

export function sanitizeMeal(raw: unknown): Meal | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const date = dateOnly(r.date)
  const title = str(r.title)?.trim()
  const deletedAt = isoDate(r.deletedAt)
  if (!id || ((!date || !title) && !deletedAt)) return null
  const now = new Date().toISOString()
  const slot: MealSlot = typeof r.slot === 'string' && MEAL_SLOT_SET.has(r.slot) ? (r.slot as MealSlot) : 'dinner'
  return {
    kind: 'meal',
    id,
    date: date ?? '',
    slot,
    recipeId: idOrUndefined(r.recipeId),
    // a bought meal never carries a recipe, so the grocery list ignores it
    out: r.out === true || undefined,
    placeId: r.out === true ? idOrUndefined(r.placeId) : undefined,
    title: title ?? '',
    notes: str(r.notes)?.trim() || undefined,
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt: isoDate(r.deletedAt),
    purged: r.purged === true || undefined,
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
    // taken off the list by hand, with the recipes that wanted it then; the
    // snapshot means nothing without the flag
    const removed = r.removed === true
    const removedRecipeIds = removed ? strList(r.removedRecipeIds) : []
    out.push({
      id: str(r.id)?.trim() || `g-${out.length + 1}`,
      name,
      qty: Number.isFinite(qty) && qty > 0 ? Math.round(qty * 100) / 100 : undefined,
      unit: str(r.unit)?.trim() || undefined,
      state,
      recipeIds: strList(r.recipeIds),
      manual: r.manual === true || undefined,
      removed: removed || undefined,
      removedRecipeIds: removedRecipeIds.length ? removedRecipeIds : undefined,
    })
  }
  return out
}

export function sanitizeGrocery(raw: unknown): GroceryList | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const weekKey = str(r.weekKey)?.trim()
  const deletedAt = isoDate(r.deletedAt)
  if (!id || (!weekKey && !deletedAt)) return null
  const now = new Date().toISOString()
  return {
    kind: 'grocery',
    id,
    weekKey: weekKey ?? '',
    items: sanitizeGroceryLines(r.items),
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt: isoDate(r.deletedAt),
    purged: r.purged === true || undefined,
  }
}

/** Coerce arbitrary data into a valid JournalEntry. A day with no text but a mood is still an entry. */
export function sanitizeEvent(raw: unknown): CalendarEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const deletedAt = isoDate(r.deletedAt)
  const title = str(r.title)?.trim()
  const allDay = r.allDay === true
  // an all-day entry is a pair of day keys; a timed one a pair of instants
  const start = allDay ? dateOnly(r.start) : isoDate(r.start)
  const rawEnd = allDay ? dateOnly(r.end) : isoDate(r.end)
  if (!id || ((!start || !title) && !deletedAt)) return null
  // An end at or before the start would draw a zero/negative block, so fall
  // back to the app's usual hour rather than storing something unrenderable.
  const end =
    rawEnd && start && (allDay ? rawEnd > start : Date.parse(rawEnd) > Date.parse(start))
      ? rawEnd
      : start
        ? allDay
          ? nextDayKey(start)
          : new Date(Date.parse(start) + 3_600_000).toISOString()
        : ''
  const now = new Date().toISOString()
  return {
    kind: 'event',
    id,
    title: title ?? '',
    start: start ?? '',
    end,
    allDay,
    location: str(r.location)?.trim() || undefined,
    notes: str(r.notes)?.trim() || undefined,
    work: r.work === 'home' || r.work === 'office' ? r.work : undefined,
    taskId: idOrUndefined(r.taskId),
    projectId: idOrUndefined(r.projectId),
    peopleIds: idList(r.peopleIds),
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt: isoDate(r.deletedAt),
    purged: r.purged === true || undefined,
  }
}

/** The day after a YYYY-MM-DD key. Stepped in UTC: a date key carries no time, so no DST applies. */
function nextDayKey(key: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return key
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

export function sanitizeJournal(raw: unknown): JournalEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const deletedAt = isoDate(r.deletedAt)
  // a purge tombstone has no date, but the day is in the id
  const date = dateOnly(r.date) ?? (id ? /^journal~(\d{4}-\d{2}-\d{2})~/.exec(id)?.[1] : undefined)
  if (!id || (!date && !deletedAt)) return null
  const now = new Date().toISOString()
  const moodN = Number(r.mood)
  return {
    kind: 'journal',
    id,
    date: date ?? '',
    body: str(r.body) ?? '',
    mood: Number.isInteger(moodN) && moodN >= 1 && moodN <= 5 ? (moodN as Mood) : undefined,
    peopleIds: idList(r.peopleIds),
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt: isoDate(r.deletedAt),
    purged: r.purged === true || undefined,
  }
}

/** Coerce arbitrary data into a valid Habit. Completions are de-duped, sorted
 *  day keys; unknown weekdays are dropped. */
export function sanitizeHabit(raw: unknown): Habit | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  if (!id) return null
  const now = new Date().toISOString()
  const days = Array.isArray(r.days)
    ? [...new Set(r.days.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b)
    : undefined
  const done = Array.isArray(r.done) ? [...new Set(r.done.map(v => dateOnly(v)).filter((d): d is string => !!d))].sort() : []
  const orderN = Number(r.order)
  return {
    kind: 'habit',
    id,
    name: str(r.name) ?? '',
    emoji: str(r.emoji) || undefined,
    color: str(r.color) || undefined,
    days: days && days.length ? days : undefined,
    done,
    order: Number.isFinite(orderN) ? orderN : undefined,
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt: isoDate(r.deletedAt),
    archivedAt: isoDate(r.archivedAt),
    purged: r.purged === true || undefined,
  }
}

/** Coerce arbitrary data into a valid Routine. Steps need an id and text and
 *  are de-duped by id; ticks must be 'YYYY-MM-DD|stepId' and are de-duped and
 *  sorted. A tick whose step is gone is kept — an edit on another device may
 *  land before the steps do, and an orphan costs nothing. Only the id is
 *  required, so a purge tombstone survives. */
export function sanitizeRoutine(raw: unknown): Routine | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  if (!id) return null
  const now = new Date().toISOString()
  const steps: RoutineStep[] = []
  const seen = new Set<string>()
  if (Array.isArray(r.steps)) {
    for (const rawStep of r.steps) {
      if (!rawStep || typeof rawStep !== 'object') continue
      const s = rawStep as Record<string, unknown>
      const stepId = str(s.id)
      const text = str(s.text)?.trim()
      if (stepId && text && !seen.has(stepId)) {
        seen.add(stepId)
        steps.push({ id: stepId, text })
      }
    }
  }
  const ticks = Array.isArray(r.ticks)
    ? [...new Set(r.ticks.filter((t): t is string => typeof t === 'string' && /^\d{4}-\d{2}-\d{2}\|.+$/.test(t)))].sort()
    : []
  const when = str(r.when)
  const orderN = Number(r.order)
  return {
    kind: 'routine',
    id,
    name: str(r.name) ?? '',
    when: when && ROUTINE_WHEN_SET.has(when) ? (when as RoutineWhen) : 'anytime',
    steps,
    ticks,
    order: Number.isFinite(orderN) ? orderN : undefined,
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt: isoDate(r.deletedAt),
    archivedAt: isoDate(r.archivedAt),
    purged: r.purged === true || undefined,
  }
}

/**
 * Coerce arbitrary data into a valid Note. The body goes through sanitizeHtml —
 * the rules RichNotes applies to a project pad on every change and render — so
 * whatever wrote it (an import, another device, an agent), the store only ever
 * holds that HTML subset, photos as <img data-media="id">. A live note needs a
 * title or some body; a tombstone (deletedAt) needs only its id, so a "Delete
 * forever" with an empty title still reaches every device.
 */
export function sanitizeNote(raw: unknown): Note | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const title = str(r.title)?.trim() ?? ''
  const body = sanitizeHtml(str(r.body) ?? '')
  const deletedAt = isoDate(r.deletedAt)
  if (!id || (!title && !body.trim() && !deletedAt)) return null
  const now = new Date().toISOString()
  return {
    kind: 'note',
    id,
    title,
    body,
    projectId: idOrUndefined(r.projectId),
    pinned: r.pinned === true || undefined,
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt,
    purged: r.purged === true || undefined,
  }
}

/** Coerce arbitrary data into a valid Review. */
export function sanitizeReview(raw: unknown): Review | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const key = str(r.key)
  const deletedAt = isoDate(r.deletedAt)
  if (!id || (!key && !deletedAt)) return null
  const now = new Date().toISOString()
  return {
    kind: 'review',
    id,
    period: r.period === 'month' ? 'month' : 'week',
    key: key ?? '',
    top: strList(r.top).slice(0, 5),
    topDone: Array.isArray(r.topDone) ? r.topDone.map(Boolean).slice(0, 5) : undefined,
    reflections: str(r.reflections)?.trim() || undefined,
    summary: str(r.summary)?.trim() || undefined,
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt: isoDate(r.deletedAt),
    purged: r.purged === true || undefined,
  }
}

/** Coerce arbitrary data into a valid Template. */
export function sanitizeTemplate(raw: unknown): Template | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const name = str(r.name)?.trim()
  const deletedAt = isoDate(r.deletedAt)
  if (!id || (!name && !deletedAt)) return null
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
    name: name ?? '',
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
    purged: r.purged === true || undefined,
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
  if (converted.kind === 'journal') return sanitizeJournal(converted)
  if (converted.kind === 'habit') return sanitizeHabit(converted)
  if (converted.kind === 'routine') return sanitizeRoutine(converted)
  if (converted.kind === 'event') return sanitizeEvent(converted)
  if (converted.kind === 'review') return sanitizeReview(converted)
  if (converted.kind === 'template') return sanitizeTemplate(converted)
  if (converted.kind === 'note') return sanitizeNote(converted)
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
