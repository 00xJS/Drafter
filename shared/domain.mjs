// Domain rules shared by the web app (src/) and the MCP server (mcp/).
// Dependency-free ESM so the MCP server stays zero-install.

export const PLATFORMS = ['x', 'instagram', 'threads', 'linkedin', 'facebook', 'tiktok', 'youtube']
export const METRIC_KEYS = ['likes', 'comments', 'shares', 'impressions']

/** Legacy (pre-v3) post statuses — still accepted on input, converted on read. */
export const POST_STATUSES = ['idea', 'draft', 'scheduled', 'posted', 'canceled']
export const TASK_STATUSES = ['wishlist', 'todo', 'doing', 'blocked', 'done', 'canceled']
export const PROJECT_STATUSES = ['active', 'paused', 'done', 'archived']
export const PRIORITIES = ['low', 'normal', 'high', 'urgent']
export const RECURRENCE_FREQS = ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']

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

/**
 * Wall-clock date (YYYY-MM-DD) of an instant in `tz` (IANA). Falls back to the
 * runtime's local zone when tz is missing/invalid.
 */
export function localDate(iso, tz) {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date(ms))
        .map(p => [p.type, p.value]),
    )
    if (parts.year && parts.month && parts.day) return `${parts.year}-${parts.month}-${parts.day}`
  } catch {
    /* bad tz — fall through */
  }
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * True when the instant is "date only" in `tz`: local midnight (no meaningful
 * wall-clock time). Used so untimed tasks mirror as all-day events.
 */
export function isUntimed(iso, tz) {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return false
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz || undefined,
        hourCycle: 'h23',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
        .formatToParts(new Date(ms))
        .map(p => [p.type, p.value]),
    )
    return Number(parts.hour) === 0 && Number(parts.minute) === 0 && Number(parts.second || 0) === 0
  } catch {
    const d = new Date(ms)
    return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0
  }
}

/** Local-midnight ISO for a YYYY-MM-DD calendar day in the runtime's local zone. */
export function localMidnightIso(dateKey) {
  const m = String(dateKey ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).toISOString()
}

/** Deterministic id for the next occurrence of a recurring task. */
export function spawnId(taskId, freq, nextDueIso) {
  const day = (nextDueIso ?? '').slice(0, 10)
  return `${taskId}~${freq}~${day}`
}

/** The next occurrence of a recurring task, cloned from the one just completed. */
const MONTH_STEPS = { monthly: 1, quarterly: 3, yearly: 12 }

/** Whole months later in local time, on `day` clamped to that month's length. */
function addMonthsOnDay(date, months, day) {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1, date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds())
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  target.setDate(Math.min(day, last))
  return target
}

export function nextOccurrence(task, uidFn) {
  if (!task.recurrence) return null
  const bill = task.bill && typeof task.bill === 'object' ? task.bill : null
  // A bill falls due on its own day however early or late it was paid; a chore
  // comes round again from when it was last done. Anchoring a bill on its
  // completion made it drift: due on the 15th, paid on the 12th, and the next
  // one was due on the 12th.
  const baseIso = bill ? (task.dueAt ?? task.completedAt) : (task.completedAt ?? task.dueAt)
  let next = baseIso ? new Date(baseIso) : new Date()
  if (isNaN(next.getTime())) return null
  const freq = task.recurrence.freq
  let billDay
  if (freq === 'daily') next.setDate(next.getDate() + 1)
  else if (freq === 'weekly') next.setDate(next.getDate() + 7)
  else if (freq === 'biweekly') next.setDate(next.getDate() + 14)
  else {
    // Monthly, quarterly and yearly land on a clamped day: setMonth used to roll
    // 31 January into 3 March. A bill also remembers its intended day, so one due
    // on the 31st goes 31 Jan -> 28 Feb -> 31 Mar instead of settling on the 28th;
    // if the owner has moved the date since, the new day wins.
    const baseDay = next.getDate()
    const monthLen = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()
    const stored = bill && Number.isInteger(bill.day) ? bill.day : undefined
    const day = stored !== undefined && Math.min(stored, monthLen) === baseDay ? stored : baseDay
    if (bill) billDay = day
    next = addMonthsOnDay(next, MONTH_STEPS[freq] ?? 1, day)
  }
  const now = new Date().toISOString()
  const dueAt = next.toISOString()
  // uidFn kept for call-site compatibility; id is deterministic so two devices agree
  void uidFn
  return {
    kind: 'task',
    id: spawnId(task.id, freq, dueAt),
    title: task.title,
    description: task.description,
    status: 'todo',
    priority: task.priority ?? 'normal',
    projectId: task.projectId,
    createdAt: now,
    updatedAt: now,
    dueAt,
    tags: [...(task.tags ?? [])],
    notes: task.notes,
    // carry the context forward, or a recurring "Sunday lunch with Mum" records
    // exactly one visit ever and her last-seen date freezes on the first one
    peopleIds: task.peopleIds ? [...task.peopleIds] : undefined,
    placeId: task.placeId,
    link: task.link,
    githubUrl: task.githubUrl,
    estimateCost: task.estimateCost,
    bill: bill ? { ...bill, ...(billDay !== undefined ? { day: billDay } : {}) } : undefined,
    checklist: task.checklist ? task.checklist.map(c => ({ ...c, done: false })) : undefined,
    social: task.social
      ? { platforms: [...task.social.platforms], variants: task.social.variants ? { ...task.social.variants } : undefined }
      : undefined,
    recurrence: { ...task.recurrence },
    spawnedFrom: task.id,
  }
}

/**
 * Tasks that belong on *my* calendar mirror / ICS feed. Household peers' chores
 * must not land in the owner's Google/Outlook. Unowned rows (local-only /
 * pre-household) count as mine. Assignees win when set.
 */
export function isMineTask(task, myId) {
  if (!task || task.kind !== 'task') return false
  if (!myId) return true
  if (task.assigneeId) return task.assigneeId === myId
  if (task.ownerId) return task.ownerId === myId
  return true
}
