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
  MealSide,
  MealSlot,
  MEAL_SLOTS,
  GroceryList,
  GroceryLine,
  GroceryState,
  GROCERY_STATES,
  JournalEntry,
  Garment,
  GarmentType,
  GARMENT_TYPES,
  GARMENT_TYPE_META,
  LOOK_NOTE_MAX,
  MAX_PIECES,
  Outfit,
  Season,
  SEASONS,
  Wear,
  Snooze,
  SnoozeTarget,
  Message,
  MESSAGE_MAX,
  ChatTurn,
  Account,
  AccountType,
  ACCOUNT_TYPES,
  BalanceCheck,
  Habit,
  Routine,
  RoutineStep,
  RoutineWhen,
  ROUTINE_WHENS,
  CalendarEntry,
  WorkMode,
  WORK_MODES,
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
import { CHAT_ACTIONS_MAX, CHAT_ACTION_TYPES, type ChatAction, type ChatNameRef, type ChatOutcome, type ChatOutcomeState, type ChatTaskStatus } from './types'
import { legacyPostToTask } from '../shared/domain.mjs'
import { MAX_SIDES } from '../shared/kitchen.mjs'
import { SYNC_KINDS } from '../shared/kinds.mjs'
import { tidyPlaceAddress, tidyPlaceAliases } from '../shared/places.mjs'
import { isDayKey } from '../shared/weeks.mjs'
import { tidyCoords } from './geo'
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
    // whose payday it is, and where the money lands (v3.27)
    forMemberId: idOrUndefined(r.forMemberId),
    accountId: str(r.accountId)?.trim() || undefined,
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
    // This has to survive the whitelist, as a note's does and for a sharper
    // reason: a build that dropped it would push the task back without it, and
    // an absent flag on a task reads as SHARED.
    //
    // BOTH booleans are kept, `true` as much as `false`. Dropping `true` as a
    // tidy-up looked free — the server reads absent and `true` the same way —
    // but it is exactly how the client says "share this again", and silence is
    // what posts_private_flag reads as "keep the stored false". Canonicalising
    // it away meant an overturn survived only until the record was sanitized
    // again: a reload (migrateStored), a three-way merge (itemops norm) or
    // Keep mine would strip it, the still-dirty row would go out with no flag,
    // and the server would put the task back to private while this screen went
    // on saying Shared. Anything that is not a boolean is neither.
    shared: r.shared === true ? true : r.shared === false ? false : undefined,
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
    notesPinned: r.notesPinned === true || undefined,
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
const SNOOZE_TARGETS = new Set<string>(['person', 'place', 'event'])
/** What a message can be about: the record kinds one can point at from the chat. */
const MESSAGE_ABOUT_KINDS = new Set<string>(['task', 'event', 'meal', 'note'])
const ACCOUNT_TYPE_SET = new Set<string>(ACCOUNT_TYPES)
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
  const pin = tidyCoords({ lat: r.lat, lon: r.lon })
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
    // a place saved before these existed has neither, and reads as it did
    address: tidyPlaceAddress(r.address),
    aliases: tidyPlaceAliases(r.aliases, name),
    ...(pin ? { lat: pin.lat, lon: pin.lon } : {}),
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

/**
 * A cooked meal's sides: each a title, with a saved recipe's id where it is one.
 * Nothing usable reads as no field at all, so a meal without sides — every one
 * planned before them — comes out exactly as it went in.
 */
function sanitizeSides(raw: unknown): MealSide[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: MealSide[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const title = str(r.title)?.trim()
    if (!title) continue
    const recipeId = idOrUndefined(r.recipeId)
    out.push(recipeId ? { recipeId, title } : { title })
  }
  return out.length ? out.slice(0, MAX_SIDES) : undefined
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
    // what goes with a cooked main; a bought meal has none
    sides: r.out === true ? undefined : sanitizeSides(r.sides),
    notes: str(r.notes)?.trim() || undefined,
    shared: r.shared === true ? true : r.shared === false ? false : undefined,
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
    work: WORK_MODES.includes(r.work as WorkMode) ? (r.work as WorkMode) : undefined,
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
    // This has to survive the whitelist. A build that dropped it would push the
    // note back without it, and sync_posts overwrites `data` wholesale — so an
    // older client could silently unshare, or reshare, a note nobody touched.
    shared: r.shared === true || undefined,
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt,
    purged: r.purged === true || undefined,
  }
}

const GARMENT_TYPE_SET = new Set<string>(GARMENT_TYPES)
/** A media-store id: a uid, or personal/<user uuid>/<uid>. Never another path in the bucket. */
const MEDIA_ID = /^(?:personal\/[0-9a-f-]{36}\/)?[0-9a-z-]{8,64}$/i
const HEX_COLOR = /^#[0-9a-f]{6}$/i

function mediaId(v: unknown): string | undefined {
  const s = str(v)?.trim()
  return s && MEDIA_ID.test(s) ? s : undefined
}

/** Unique, trimmed string ids in order, capped: an outfit's or a look's pieces. */
function pieceIds(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const ids = v
    .filter((x): x is string => typeof x === 'string')
    .map(x => x.trim())
    .filter(Boolean)
  return [...new Set(ids)].slice(0, MAX_PIECES)
}

/** Most tags a piece keeps, and the longest one. */
const MAX_TAGS = 12
const TAG_LENGTH = 30

/**
 * A piece's tags: trimmed, lowercased, unique, 30 characters and 12 tags at
 * most; undefined when none is left. The piece sheet reads its comma-separated
 * field through this too, so what it saves is what a sync keeps.
 */
export function garmentTags(v: unknown): string[] | undefined {
  const tags = [...new Set(strList(v).map(t => t.toLowerCase().slice(0, TAG_LENGTH).trim()))].filter(Boolean).slice(0, MAX_TAGS)
  return tags.length > 0 ? tags : undefined
}

/** The seasons a piece is for: known ones only, once each, in the year's order; undefined for none, which is any season. */
function seasonList(v: unknown): Season[] | undefined {
  const given = new Set(strList(v))
  const seasons = SEASONS.filter(s => given.has(s))
  return seasons.length > 0 ? seasons : undefined
}

/** What a piece cost, in whole dollars: money() rounded to the dollar. */
function wholePrice(v: unknown): number | undefined {
  const n = money(v)
  return n === undefined ? undefined : Math.round(n)
}

/** Coerce arbitrary data into a Garment. A live piece with no name takes its type's label. */
export function sanitizeGarment(raw: unknown): Garment | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  if (!id) return null
  const deletedAt = isoDate(r.deletedAt)
  // an unknown type is read as the catch-all, which is never an outfit's core
  const type: GarmentType = typeof r.type === 'string' && GARMENT_TYPE_SET.has(r.type) ? (r.type as GarmentType) : 'accessory'
  const name = str(r.name)?.trim().slice(0, 80)
  const color = str(r.color)?.trim()
  const backPhotoId = mediaId(r.backPhotoId)
  const backThumbId = mediaId(r.backThumbId)
  const now = new Date().toISOString()
  return {
    kind: 'garment',
    id,
    name: name || (deletedAt ? '' : GARMENT_TYPE_META[type].label),
    type,
    photoId: mediaId(r.photoId),
    thumbId: mediaId(r.thumbId),
    backPhotoId,
    backThumbId,
    // the back first means nothing without a back to show
    showBack: r.showBack === true && !!(backPhotoId || backThumbId) ? true : undefined,
    occasion: r.occasion === 'work' || r.occasion === 'personal' ? r.occasion : undefined,
    color: color && HEX_COLOR.test(color) ? color.toLowerCase() : undefined,
    notes: str(r.notes)?.trim().slice(0, 500) || undefined,
    favourite: r.favourite === true || undefined,
    tags: garmentTags(r.tags),
    seasons: seasonList(r.seasons),
    price: wholePrice(r.price),
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt,
    archivedAt: isoDate(r.archivedAt),
    purged: r.purged === true || undefined,
  }
}

/** Coerce arbitrary data into an Outfit. A live outfit needs a piece; a tombstone only its id. */
export function sanitizeOutfit(raw: unknown): Outfit | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const garmentIds = pieceIds(r.garmentIds)
  const deletedAt = isoDate(r.deletedAt)
  if (!id || (garmentIds.length === 0 && !deletedAt)) return null
  const now = new Date().toISOString()
  return {
    kind: 'outfit',
    id,
    name: str(r.name)?.trim().slice(0, 80) || undefined,
    garmentIds,
    favourite: r.favourite === true || undefined,
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt,
    purged: r.purged === true || undefined,
  }
}

/**
 * Coerce arbitrary data into a Wear. The day is a local day key and nothing else
 * (dayKeyOnly: an ISO instant is refused, never turned into its UTC date). A purge
 * tombstone has no date, but the day is in the id, as a journal entry's is. An
 * empty look is kept (coerce, don't reject) and counted as nothing, and so is a
 * plan until it is confirmed worn.
 */
export function sanitizeWear(raw: unknown): Wear | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const deletedAt = isoDate(r.deletedAt)
  const date = dayKeyOnly(r.date) ?? (id ? dayKeyOnly(/^wear~(\d{4}-\d{2}-\d{2})~/.exec(id)?.[1]) : undefined)
  if (!id || (!date && !deletedAt)) return null
  const now = new Date().toISOString()
  return {
    kind: 'wear',
    id,
    date: date ?? '',
    garmentIds: pieceIds(r.garmentIds),
    note: str(r.note)?.trim().slice(0, LOOK_NOTE_MAX) || undefined,
    planned: r.planned === true || undefined,
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt,
    purged: r.purged === true || undefined,
  }
}

/**
 * An account and its balance check-ins. One check-in per day: re-typing a day
 * replaces it rather than doubling it, and the list is kept oldest-first so
 * "the latest" is always the last of it, whatever order a device wrote them.
 */
export function sanitizeAccount(raw: unknown): Account | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const deletedAt = isoDate(r.deletedAt)
  const name = str(r.name)?.trim()
  if (!id || (!name && !deletedAt)) return null
  const now = new Date().toISOString()
  const byDay = new Map<string, BalanceCheck>()
  for (const row of Array.isArray(r.balances) ? r.balances : []) {
    const b = row as Record<string, unknown>
    const on = dayKeyOnly(b?.on)
    const amount = Number(b?.amount)
    if (on && Number.isFinite(amount)) byDay.set(on, { on, amount: Math.round(amount * 100) / 100 })
  }
  return {
    kind: 'account',
    id,
    name: name ?? '',
    type: typeof r.type === 'string' && ACCOUNT_TYPE_SET.has(r.type) ? (r.type as AccountType) : 'checking',
    memberId: idOrUndefined(r.memberId),
    balances: [...byDay.values()].sort((a, b) => a.on.localeCompare(b.on)).slice(-400),
    archivedAt: isoDate(r.archivedAt),
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt,
    purged: r.purged === true || undefined,
  }
}

/**
 * One message in the household's chat. A row with nothing said and no
 * tombstone is nothing at all; the body is capped so one paste cannot fill a
 * sync exchange.
 */
export function sanitizeMessage(raw: unknown): Message | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const deletedAt = isoDate(r.deletedAt)
  const body = str(r.body)?.slice(0, MESSAGE_MAX) ?? ''
  if (!id || (!body.trim() && !deletedAt)) return null
  const now = new Date().toISOString()
  const about = r.about && typeof r.about === 'object' ? (r.about as Record<string, unknown>) : null
  const aboutKind = typeof about?.kind === 'string' && MESSAGE_ABOUT_KINDS.has(about.kind) ? (about.kind as 'task' | 'event' | 'meal' | 'note') : null
  const aboutId = str(about?.id)
  return {
    kind: 'message',
    id,
    body,
    about: aboutKind && aboutId ? { kind: aboutKind, id: aboutId, label: str(about?.label)?.slice(0, 120) ?? '' } : undefined,
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt,
    purged: r.purged === true || undefined,
  }
}

/**
 * How long each part of an assistant's suggestion may be. The model is held to
 * these as its answer is read (src/chatactions.ts), and every copy that syncs
 * is held to them here, so one answer cannot fill a sync exchange.
 */
export const CHAT_LIMITS = {
  title: 200,
  notes: 1000,
  text: MESSAGE_MAX,
  name: 80,
  /** A visit's note: what you did. */
  note: 200,
  item: 80,
  items: 20,
  tag: 40,
  tags: 8,
  people: 8,
  id: 200,
  /** Records one outcome can name: an apply writes one, or a meal and its recipe. */
  ids: 12,
} as const

const CHAT_ACTION_TYPE_SET = new Set<string>(CHAT_ACTION_TYPES)
const CHAT_STATUS_SET = new Set<string>(['todo', 'done', 'canceled'])
const CHAT_OUTCOME_SET = new Set<string>(['applied', 'skipped', 'undone'])
const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** One line of text, capped; undefined when there is none. */
function chatLine(v: unknown, max: number): string | undefined {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max).trim() : ''
  return s || undefined
}

/** A paragraph or more: line breaks kept, capped. */
function chatText(v: unknown, max: number): string | undefined {
  const s = typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max).trim() : ''
  return s || undefined
}

const chatDay = (v: unknown): string | undefined => (typeof v === 'string' && isDayKey(v) ? v : undefined)
const chatClock = (v: unknown): string | undefined => (typeof v === 'string' && CLOCK_RE.test(v) ? v : undefined)

function chatName(v: unknown): ChatNameRef | undefined {
  if (!v || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>
  const name = chatLine(r.name, CHAT_LIMITS.name)
  if (!name) return undefined
  const id = chatLine(r.id, CHAT_LIMITS.id)
  return id ? { name, id } : { name }
}

const chatNames = (v: unknown, max: number): ChatNameRef[] => (Array.isArray(v) ? v.map(chatName).filter((n): n is ChatNameRef => !!n).slice(0, max) : [])

/**
 * One suggestion, as a turn stores it. Anything that is not one of the seven
 * shapes, or is missing what its shape needs, is dropped: a card that cannot
 * say what it would do must not offer to do it.
 */
export function sanitizeChatAction(raw: unknown): ChatAction | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.type !== 'string' || !CHAT_ACTION_TYPE_SET.has(r.type)) return null
  const date = chatDay(r.date)
  const priority = typeof r.priority === 'string' && PRIORITY_SET.has(r.priority) ? (r.priority as Priority) : undefined
  switch (r.type) {
    case 'create_task': {
      const title = chatLine(r.title, CHAT_LIMITS.title)
      if (!title) return null
      const time = date ? chatClock(r.time) : undefined
      const tags = Array.isArray(r.tags)
        ? [...new Set(r.tags.map(t => chatLine(t, CHAT_LIMITS.tag)?.toLowerCase()).filter((t): t is string => !!t))].slice(0, CHAT_LIMITS.tags)
        : []
      const people = chatNames(r.people, CHAT_LIMITS.people)
      const notes = chatText(r.notes, CHAT_LIMITS.notes)
      return {
        type: 'create_task',
        title,
        ...(date ? { date } : {}),
        ...(time ? { time } : {}),
        ...(priority ? { priority } : {}),
        ...(tags.length ? { tags } : {}),
        ...(people.length ? { people } : {}),
        ...(notes ? { notes } : {}),
      }
    }
    case 'update_task': {
      const taskId = chatLine(r.taskId, CHAT_LIMITS.id)
      const status = typeof r.status === 'string' && CHAT_STATUS_SET.has(r.status) ? (r.status as ChatTaskStatus) : undefined
      const time = date ? chatClock(r.time) : undefined
      if (!taskId || (!date && !status && !priority)) return null
      return {
        type: 'update_task',
        taskId,
        title: chatLine(r.title, CHAT_LIMITS.title) ?? '',
        ...(date ? { date } : {}),
        ...(time ? { time } : {}),
        ...(status ? { status } : {}),
        ...(priority ? { priority } : {}),
      }
    }
    case 'add_grocery': {
      const items: string[] = []
      for (const v of Array.isArray(r.items) ? r.items : []) {
        const item = chatLine(v, CHAT_LIMITS.item)
        if (item && !items.some(x => x.toLowerCase() === item.toLowerCase())) items.push(item)
      }
      if (!items.length) return null
      return { type: 'add_grocery', items: items.slice(0, CHAT_LIMITS.items), ...(date ? { date } : {}) }
    }
    case 'plan_meal': {
      const slot = typeof r.slot === 'string' && MEAL_SLOT_SET.has(r.slot) ? (r.slot as MealSlot) : undefined
      if (!date || !slot) return null
      if (r.out === true) {
        const place = chatName(r.place)
        const title = chatLine(r.title, CHAT_LIMITS.title)
        return { type: 'plan_meal', date, slot, out: true, ...(place ? { place } : {}), ...(title ? { title } : {}) }
      }
      const dish = chatName(r.dish)
      if (!dish) return null
      return { type: 'plan_meal', date, slot, dish, ...(r.newDish === true && !dish.id ? { newDish: true } : {}) }
    }
    case 'log_visit': {
      const people = chatNames(r.people, CHAT_LIMITS.people)
      if (!date || !people.length) return null
      const place = chatName(r.place)
      const note = chatLine(r.note, CHAT_LIMITS.note)
      return { type: 'log_visit', people, date, ...(place ? { place } : {}), ...(note ? { note } : {}) }
    }
    case 'create_note': {
      const title = chatLine(r.title, CHAT_LIMITS.title) ?? ''
      const text = chatText(r.text, CHAT_LIMITS.text) ?? ''
      if (!title && !text) return null
      return { type: 'create_note', title, text }
    }
    case 'create_event': {
      const title = chatLine(r.title, CHAT_LIMITS.title)
      if (!title || !date) return null
      const start = chatClock(r.start)
      // zero-padded HH:MM compares correctly as text
      const end = start ? chatClock(r.end) : undefined
      return { type: 'create_event', title, date, ...(start ? { start } : {}), ...(end && end > start! ? { end } : {}) }
    }
  }
  return null
}

/** What became of one suggestion: which answer and which of its cards, and what an apply wrote. */
export function sanitizeChatOutcome(raw: unknown): ChatOutcome | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const turnId = chatLine(r.turnId, CHAT_LIMITS.id)
  const index = typeof r.index === 'number' && Number.isInteger(r.index) && r.index >= 0 && r.index < CHAT_ACTIONS_MAX ? r.index : null
  const state = typeof r.state === 'string' && CHAT_OUTCOME_SET.has(r.state) ? (r.state as ChatOutcomeState) : null
  if (!turnId || index === null || !state) return null
  const ids = Array.isArray(r.ids) ? r.ids.map(v => chatLine(v, CHAT_LIMITS.id)).filter((v): v is string => !!v).slice(0, CHAT_LIMITS.ids) : []
  return { turnId, index, state, ...(ids.length ? { ids } : {}) }
}

/**
 * One turn of the assistant conversation. `role` decides which side of the
 * thread it is drawn on, so a row whose role cannot be read is dropped rather
 * than guessed at and put in the wrong voice. Suggestions and outcomes are the
 * assistant's side only: a line you typed never carries either.
 */
export function sanitizeChatTurn(raw: unknown): ChatTurn | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const deletedAt = isoDate(r.deletedAt)
  const role = r.role === 'drafter' ? 'drafter' : r.role === 'you' ? 'you' : null
  const text = str(r.text)?.slice(0, MESSAGE_MAX) ?? ''
  if (!id || !role || (!text.trim() && !deletedAt)) return null
  const now = new Date().toISOString()
  const cites = Array.isArray(r.cites) ? r.cites.map(c => str(c)).filter((c): c is string => !!c).slice(0, 12) : undefined
  const actions = role === 'drafter' && Array.isArray(r.actions) ? r.actions.map(sanitizeChatAction).filter((a): a is ChatAction => !!a).slice(0, CHAT_ACTIONS_MAX) : []
  const outcomes = role === 'drafter' && Array.isArray(r.outcomes) ? r.outcomes.map(sanitizeChatOutcome).filter((o): o is ChatOutcome => !!o).slice(0, CHAT_ACTIONS_MAX * 2) : []
  return {
    kind: 'chat',
    id,
    role,
    text,
    cites: cites?.length ? cites : undefined,
    actions: actions.length ? actions : undefined,
    outcomes: outcomes.length ? outcomes : undefined,
    ownerId: idOrUndefined(r.ownerId),
    createdAt: isoDate(r.createdAt) ?? now,
    updatedAt: isoDate(r.updatedAt) ?? now,
    deletedAt,
    purged: r.purged === true || undefined,
  }
}

/**
 * A nudge put off. The id carries the target (`snooze~person~<id>`), so a
 * second snooze on the same thing overwrites the first; `until` is what the
 * row is for, and a row with no usable instant is nothing at all.
 */
export function sanitizeSnooze(raw: unknown): Snooze | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const deletedAt = isoDate(r.deletedAt)
  const fromId = id ? /^snooze~(person|place|event)~(.+)$/.exec(id) : null
  const target = typeof r.target === 'string' && SNOOZE_TARGETS.has(r.target) ? (r.target as SnoozeTarget) : (fromId?.[1] as SnoozeTarget | undefined)
  const targetId = str(r.targetId)?.trim() || fromId?.[2]
  const until = isoDate(r.until)
  if (!id || !target || !targetId || (!until && !deletedAt)) return null
  const now = new Date().toISOString()
  return {
    kind: 'snooze',
    id,
    target,
    targetId,
    until: until ?? now,
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
    // kept so a device's save of this review never lets Sunday's draft try the week again
    draftedAt: isoDate(r.draftedAt),
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
  if (converted.kind === 'garment') return sanitizeGarment(converted)
  if (converted.kind === 'outfit') return sanitizeOutfit(converted)
  if (converted.kind === 'wear') return sanitizeWear(converted)
  if (converted.kind === 'snooze') return sanitizeSnooze(converted)
  if (converted.kind === 'message') return sanitizeMessage(converted)
  if (converted.kind === 'chat') return sanitizeChatTurn(converted)
  if (converted.kind === 'account') return sanitizeAccount(converted)
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
