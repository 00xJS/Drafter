// Drafter's MCP tools: projects and tasks, people and places, the kitchen, the
// journal and the Today overview. Zero dependencies.
//
// Each tool is `run(args, ctx)` with ctx = { db, clock, scopes, userId, newId, rand }:
//   db      mcp/data.mjs — the user's own view on the hosted endpoint, the
//           owner's view in the deprecated local service-key mode
//   clock   shared/clock.mjs in the user's zone, so "today" is their today
//   newId   ids keep the `mcp-` prefix as provenance
// `scope` is what a connection needs to see and call the tool (read, write or
// journal), and `annotations` let the client confirm before writes and deletes.
//
// Every write goes through the sync_posts RPC, so the same last-write-wins
// merge that protects the app protects agent edits too. Pre-v3 rows (legacy
// social posts) are converted to tasks on read, exactly like the app does.
// The tools themselves moved here unchanged from mcp/server.mjs.

import { randomBytes } from 'node:crypto'
import { PRIORITIES, PROJECT_STATUSES, RECURRENCE_FREQS, SOCIAL_PROJECT_ID, TASK_STATUSES, newerStamp, nextOccurrence } from '../shared/domain.mjs'
import { seenStatus, DEFAULT_CADENCE_DAYS } from '../shared/people.mjs'
import { appendEntry, entriesBetween, entryOn, peopleNameMap, peopleNamesOf, streak } from '../shared/journal.mjs'
import { matchPlace, normalisePlaceText, outingsAt, placeCadenceStatus } from '../shared/places.mjs'
import { activeGroceryLines, addGroceryItem, buildGroceryList, groceryId, groceryWeekFor, mealId, mealsInWeekOf } from '../shared/kitchen.mjs'
import { isDayKey, weekDayKeys, weekKeyOf } from '../shared/weeks.mjs'
import { bucketByDue } from '../shared/today.mjs'

const PLACE_CATEGORIES = ['restaurant', 'cafe', 'bar', 'outdoors', 'venue', 'shop', 'home', 'other']
const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner']
const GROCERY_STATES = ['need', 'have', 'done']

const DAY = 86_400_000
const OPEN = ['todo', 'doing', 'blocked']

export const SCOPES = ['read', 'write', 'journal']

export function defaultNewId() {
  return `mcp-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

export function defaultRand() {
  return randomBytes(4).toString('hex')
}

/** A tool context with the id and randomness defaults filled in. */
export function createContext({ db, clock, scopes = SCOPES, userId = null, newId = defaultNewId, rand = defaultRand }) {
  return { db, clock, scopes: [...scopes], userId, newId, rand }
}

// ---------------------------------------------------------------------------
// Validators and summaries (mirror the app's rules)
// ---------------------------------------------------------------------------

/** A real calendar day, not just the right shape: 2026-02-30 is refused. */
export function assertDayKey(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day ?? ''))) throw new Error('date must be YYYY-MM-DD')
  if (!isDayKey(day)) throw new Error(`"${day}" is not a real calendar date`)
  return day
}

function isoOrThrow(value, field) {
  const d = new Date(value)
  if (isNaN(d.getTime())) throw new Error(`"${field}" is not a valid date: ${value}`)
  return d.toISOString()
}

function oneOf(value, list, field) {
  if (!list.includes(value)) throw new Error(`Invalid ${field} "${value}". Valid: ${list.join(', ')}`)
  return value
}

function applyStatus(task, status, stamp) {
  task.status = oneOf(status, TASK_STATUSES, 'status')
  if (status === 'done') task.completedAt = task.completedAt ?? stamp
  else delete task.completedAt
}

export function summarizeTask(t) {
  return {
    id: t.id,
    title: t.title || null,
    description: (t.description ?? '').length > 120 ? t.description.slice(0, 120) + '…' : t.description,
    status: t.status,
    priority: t.priority ?? 'normal',
    projectId: t.projectId ?? null,
    dueAt: t.dueAt ?? null,
    completedAt: t.completedAt ?? null,
    tags: t.tags ?? [],
    checklist: t.checklist ? `${t.checklist.filter(c => c.done).length}/${t.checklist.length}` : null,
    comments: t.comments?.length ?? 0,
    githubUrl: t.githubUrl ?? null,
    recurrence: t.recurrence?.freq ?? null,
    peopleIds: t.peopleIds ?? [],
    placeId: t.placeId ?? null,
  }
}

/** Resolve people ids and a place id/name against live records; throws on anything unknown. */
export function resolveContext(all, { peopleIds, placeId, placeName }) {
  const out = {}
  if (peopleIds !== undefined) {
    const ids = Array.isArray(peopleIds) ? peopleIds.map(String).filter(Boolean) : []
    const people = all.filter(i => i.kind === 'person')
    for (const id of ids) if (!people.some(p => p.id === id)) throw new Error(`No person with id "${id}". Use list_people.`)
    out.peopleIds = ids.length ? [...new Set(ids)] : undefined
  }
  if (placeId !== undefined || placeName !== undefined) {
    const places = all.filter(i => i.kind === 'place')
    if (placeId) {
      if (!places.some(p => p.id === placeId)) throw new Error(`No place with id "${placeId}". Use list_places.`)
      out.placeId = String(placeId)
    } else if (placeName) {
      const hit = matchPlace(placeName, places)
      if (!hit) throw new Error(`No saved place matches "${placeName}". Use list_places, or create_place first.`)
      out.placeId = hit.id
    } else {
      out.placeId = undefined
    }
  }
  return out
}

export function summarizePlace(p, tasks = [], people = [], meals = [], nowMs = Date.now()) {
  // one rule, in shared/places.mjs: done tasks here plus past meals eaten here
  const outings = outingsAt(p.id, tasks, meals, new Date(nowMs))
  const last = outings[0]?.at ?? null
  const companions = new Map()
  for (const o of outings) {
    if (o.kind !== 'task') continue // a meal records the place, not the company
    for (const id of o.task.peopleIds ?? []) companions.set(id, (companions.get(id) ?? 0) + 1)
  }
  // opt-in rhythm: status is 'none' unless the user set one — never a nag by default
  const cadence = placeCadenceStatus(p, tasks, new Date(nowMs), meals)
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    emoji: p.emoji ?? null,
    notes: p.notes ?? null,
    cadenceDays: p.cadenceDays ?? null,
    status: cadence.status,
    statusReason: cadence.reason || null,
    lastWent: last,
    daysSince: last ? Math.floor((nowMs - Date.parse(last)) / DAY) : null,
    outingsLast365Days: outings.filter(o => nowMs - Date.parse(o.at) < 365 * DAY).length,
    outingsAllTime: outings.length,
    /** How often they ate here rather than merely went — the takeaway count. */
    mealsHereLast365Days: outings.filter(o => o.kind === 'meal' && nowMs - Date.parse(o.at) < 365 * DAY).length,
    mealsHereAllTime: outings.filter(o => o.kind === 'meal').length,
    usuallyWith: [...companions.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, count]) => ({ personId: id, name: people.find(x => x.id === id)?.name ?? null, count })),
  }
}

function summarizeProject(p, tasks = []) {
  const live = tasks.filter(t => t.status !== 'canceled')
  const done = live.filter(t => t.status === 'done').length
  return {
    id: p.id,
    name: p.name,
    emoji: p.emoji ?? null,
    status: p.status,
    description: p.description ?? null,
    startAt: p.startAt ?? null,
    targetAt: p.targetAt ?? null,
    milestones: p.milestones ?? [],
    githubUrl: p.githubUrl ?? null,
    notes: p.notes ? (p.notes.length > 200 ? p.notes.slice(0, 200) + '…' : p.notes) : null,
    tasks: { total: live.length, done, open: live.filter(t => OPEN.includes(t.status)).length },
  }
}

/** Confirm every item of a multi-item write won the merge. */
function assertStored(stored, writes) {
  for (const w of writes) {
    const check = stored.find(p => p.id === w.id)
    if (!check || check.updatedAt !== w.updatedAt) {
      throw new Error(`Write of ${w.kind} ${w.id} was rejected by the last-write-wins merge (a newer copy exists). Re-read and retry.`)
    }
  }
}

// ---------------------------------------------------------------------------
// Annotations: hints for the client, never a substitute for the scope check
// ---------------------------------------------------------------------------

/** Looks things up; changes nothing. */
const READS = { readOnlyHint: true, openWorldHint: false }
/** Adds a record or a line; never removes or overwrites one. */
const ADDS = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
/** Edits in place — clients keep the MCP default and may confirm first. */
const EDITS = { readOnlyHint: false, openWorldHint: false }

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const TOOLS = [
  {
    name: 'list_projects',
    scope: 'read',
    annotations: READS,
    description: 'List projects with task counts. Includes archived ones only when includeArchived is true.',
    inputSchema: { type: 'object', properties: { includeArchived: { type: 'boolean' } } },
    async run({ includeArchived } = {}, { db }) {
      const all = await db.fetchAll({ kinds: ['project', 'task'] })
      const tasks = all.filter(i => i.kind === 'task')
      const projects = all.filter(i => i.kind === 'project' && (includeArchived || i.status !== 'archived'))
      return { count: projects.length, projects: projects.map(p => summarizeProject(p, tasks.filter(t => t.projectId === p.id))) }
    },
  },
  {
    name: 'create_project',
    scope: 'write',
    annotations: ADDS,
    description: 'Create a project (a container for tasks, shown on the roadmap). Dates are ISO; color is a hex string.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        emoji: { type: 'string' },
        color: { type: 'string', description: 'Hex color, e.g. #4f46e5' },
        startAt: { type: 'string' },
        targetAt: { type: 'string' },
        githubUrl: { type: 'string', description: 'Repo or GitHub Projects URL' },
        milestones: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, dueAt: { type: 'string' } }, required: ['name'] } },
      },
      required: ['name'],
    },
    async run({ name, description, emoji, color, startAt, targetAt, githubUrl, milestones } = {}, { db, clock, newId }) {
      if (!name || !String(name).trim()) throw new Error('name must not be empty')
      const stamp = clock.iso()
      const project = {
        kind: 'project',
        id: newId(),
        name: String(name).trim(),
        description: description ? String(description) : undefined,
        emoji: emoji ? String(emoji) : undefined,
        color: color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : '#4f46e5',
        status: 'active',
        startAt: startAt ? isoOrThrow(startAt, 'startAt') : undefined,
        targetAt: targetAt ? isoOrThrow(targetAt, 'targetAt') : undefined,
        githubUrl: githubUrl ? String(githubUrl) : undefined,
        milestones: Array.isArray(milestones)
          ? milestones.filter(m => m && m.name).map(m => ({ id: newId(), name: String(m.name), dueAt: m.dueAt ? isoOrThrow(m.dueAt, 'milestone.dueAt') : undefined }))
          : undefined,
        createdAt: stamp,
        updatedAt: stamp,
      }
      await db.writeItem(project)
      return { created: summarizeProject(project) }
    },
  },
  {
    name: 'update_project',
    scope: 'write',
    annotations: EDITS,
    description: 'Edit a project: name, description, status (active|paused|done|archived), dates, GitHub URL, Markdown notes (replace or append), or add a milestone.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: PROJECT_STATUSES },
        startAt: { type: 'string' },
        targetAt: { type: 'string' },
        githubUrl: { type: 'string' },
        notes: { type: 'string', description: 'Replace the project notes (plain text; blank lines separate paragraphs)' },
        appendNotes: { type: 'string', description: 'Append a paragraph to the project notes' },
        addMilestone: { type: 'object', properties: { name: { type: 'string' }, dueAt: { type: 'string' } }, required: ['name'] },
        completeMilestone: { type: 'string', description: 'Name (or id) of a milestone to mark reached' },
      },
      required: ['id'],
    },
    async run({ id, name, description, status, startAt, targetAt, githubUrl, notes, appendNotes, addMilestone, completeMilestone } = {}, { db, newId }) {
      const project = await db.fetchItem(id, 'project')
      if (name !== undefined) project.name = String(name).trim() || project.name
      if (description !== undefined) project.description = String(description) || undefined
      if (status !== undefined) project.status = oneOf(status, PROJECT_STATUSES, 'status')
      if (startAt !== undefined) project.startAt = startAt ? isoOrThrow(startAt, 'startAt') : undefined
      if (targetAt !== undefined) project.targetAt = targetAt ? isoOrThrow(targetAt, 'targetAt') : undefined
      if (githubUrl !== undefined) project.githubUrl = String(githubUrl) || undefined
      const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const toHtml = text => String(text).split(/\n{2,}/).map(par => `<p>${escapeHtml(par).replace(/\n/g, '<br>')}</p>`).join('')
      if (notes !== undefined) {
        project.notes = String(notes) || undefined
        project.notesHtml = notes ? toHtml(notes) : ''
      }
      if (appendNotes) {
        project.notes = [project.notes, String(appendNotes)].filter(Boolean).join('\n\n')
        project.notesHtml = (project.notesHtml ?? '') + toHtml(appendNotes)
      }
      if (addMilestone?.name) {
        project.milestones = [...(project.milestones ?? []), { id: newId(), name: String(addMilestone.name), dueAt: addMilestone.dueAt ? isoOrThrow(addMilestone.dueAt, 'dueAt') : undefined }]
      }
      if (completeMilestone) {
        const m = (project.milestones ?? []).find(x => x.id === completeMilestone || x.name.toLowerCase() === String(completeMilestone).toLowerCase())
        if (!m) throw new Error(`No milestone "${completeMilestone}" on this project.`)
        m.done = true
      }
      project.updatedAt = newerStamp(project.updatedAt)
      await db.writeItem(project)
      return { updated: summarizeProject(project) }
    },
  },
  {
    name: 'list_tasks',
    scope: 'read',
    annotations: READS,
    description:
      'List tasks, most urgent first (overdue → due soon → priority). Filters: status (wishlist|todo|doing|blocked|done|canceled, or "open" for todo+doing+blocked), projectId, dueBefore (ISO), search term (title, description, tags). Returns compact summaries; use get_task for full detail.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...TASK_STATUSES, 'open'] },
        projectId: { type: 'string' },
        dueBefore: { type: 'string', description: 'Only tasks due before this ISO datetime' },
        search: { type: 'string' },
        limit: { type: 'number', description: 'Max results (default 25, max 200)' },
      },
    },
    async run({ status, projectId, dueBefore, search, limit } = {}, { db }) {
      let tasks = (await db.fetchAll({ kinds: ['task'] })).filter(i => i.kind === 'task')
      if (status) {
        oneOf(status, [...TASK_STATUSES, 'open'], 'status')
        tasks = tasks.filter(t => (status === 'open' ? OPEN.includes(t.status) : t.status === status))
      }
      if (projectId) tasks = tasks.filter(t => t.projectId === projectId)
      if (dueBefore) {
        const cutoff = isoOrThrow(dueBefore, 'dueBefore')
        tasks = tasks.filter(t => t.dueAt && t.dueAt < cutoff)
      }
      if (search) {
        const needle = String(search).toLowerCase()
        tasks = tasks.filter(t => `${t.title ?? ''} ${t.description ?? ''} ${(t.tags ?? []).join(' ')}`.toLowerCase().includes(needle))
      }
      const rank = { urgent: 3, high: 2, normal: 1, low: 0 }
      tasks.sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') || (rank[b.priority] ?? 1) - (rank[a.priority] ?? 1) || b.updatedAt.localeCompare(a.updatedAt))
      const cap = Math.min(Math.max(Number(limit) || 25, 1), 200)
      return { count: tasks.length, showing: Math.min(cap, tasks.length), tasks: tasks.slice(0, cap).map(summarizeTask) }
    },
  },
  {
    name: 'get_task',
    scope: 'read',
    annotations: READS,
    description: 'Fetch one task in full (description, checklist, comments, everything) by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async run({ id } = {}, { db }) {
      return db.fetchItem(id, 'task')
    },
  },
  {
    name: 'create_task',
    scope: 'write',
    annotations: ADDS,
    description:
      'Create a task. Defaults: status "todo" (or "wishlist" if you say so), priority "normal". Give it a projectId from list_projects when it belongs somewhere.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        projectId: { type: 'string' },
        status: { type: 'string', enum: TASK_STATUSES },
        priority: { type: 'string', enum: PRIORITIES },
        dueAt: { type: 'string', description: 'ISO datetime' },
        tags: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
        link: { type: 'string' },
        githubUrl: { type: 'string', description: 'GitHub issue / PR / repo / project URL to link' },
        checklist: { type: 'array', items: { type: 'string' }, description: 'Initial checklist steps' },
        recurrence: { type: 'string', enum: RECURRENCE_FREQS },
        peopleIds: { type: 'array', items: { type: 'string' }, description: 'People this involves (ids from list_people); when done it counts as seeing them' },
        placeId: { type: 'string', description: 'Where this happens (id from list_places); when done it counts as an outing there' },
        placeName: { type: 'string', description: 'Alternative to placeId: the name of a saved place' },
      },
      required: ['title'],
    },
    async run({ title, description, projectId, status, priority, dueAt, tags, notes, link, githubUrl, checklist, recurrence, peopleIds, placeId, placeName } = {}, { db, clock, newId }) {
      if (!title || !String(title).trim()) throw new Error('title must not be empty')
      const stamp = clock.iso()
      const needsLookup = projectId || peopleIds !== undefined || placeId !== undefined || placeName !== undefined
      const all = needsLookup ? await db.fetchAll({ kinds: ['project', 'person', 'place'] }) : []
      const ctx = resolveContext(all, { peopleIds, placeId, placeName })
      const task = {
        kind: 'task',
        id: newId(),
        title: String(title).trim(),
        description: description ? String(description) : '',
        status: status ? oneOf(status, TASK_STATUSES, 'status') : 'todo',
        priority: priority ? oneOf(priority, PRIORITIES, 'priority') : 'normal',
        projectId: projectId ? String(projectId) : undefined,
        dueAt: dueAt ? isoOrThrow(dueAt, 'dueAt') : undefined,
        createdAt: stamp,
        updatedAt: stamp,
        tags: Array.isArray(tags) ? tags.map(String) : [],
        notes: notes ? String(notes) : undefined,
        link: link ? String(link) : undefined,
        githubUrl: githubUrl ? String(githubUrl) : undefined,
        checklist: Array.isArray(checklist) && checklist.length > 0 ? checklist.map(text => ({ id: newId(), text: String(text), done: false })) : undefined,
        recurrence: recurrence ? { freq: oneOf(recurrence, RECURRENCE_FREQS, 'recurrence') } : undefined,
        peopleIds: ctx.peopleIds,
        placeId: ctx.placeId,
      }
      if (task.status === 'done') task.completedAt = stamp
      if (task.projectId) {
        const projects = all.filter(i => i.kind === 'project')
        if (!projects.some(p => p.id === task.projectId) && task.projectId !== SOCIAL_PROJECT_ID) {
          throw new Error(`No project with id "${task.projectId}". Use list_projects.`)
        }
      }
      await db.writeItem(task)
      return { created: summarizeTask(task) }
    },
  },
  {
    name: 'update_task',
    scope: 'write',
    annotations: EDITS,
    description:
      'Edit a task. Any field you pass replaces the old value (status changes to "done" stamp completedAt and spawn the next occurrence of a repeating task). Reads the latest copy first, so edits are merge-safe.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        projectId: { type: 'string', description: 'Empty string removes the task from its project' },
        status: { type: 'string', enum: TASK_STATUSES },
        priority: { type: 'string', enum: PRIORITIES },
        dueAt: { type: 'string', description: 'ISO datetime; empty string clears it' },
        tags: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
        link: { type: 'string' },
        githubUrl: { type: 'string' },
        addChecklist: { type: 'array', items: { type: 'string' }, description: 'Steps to append' },
        tickChecklist: { type: 'array', items: { type: 'string' }, description: 'Checklist item texts (or ids) to mark done' },
        peopleIds: { type: 'array', items: { type: 'string' }, description: 'Replace the people attached (empty array clears)' },
        placeId: { type: 'string', description: 'Where this happens; empty string clears it' },
        placeName: { type: 'string', description: 'Alternative to placeId: the name of a saved place' },
      },
      required: ['id'],
    },
    async run({ id, title, description, projectId, status, priority, dueAt, tags, notes, link, githubUrl, addChecklist, tickChecklist, peopleIds, placeId, placeName } = {}, { db, clock, newId }) {
      const task = await db.fetchItem(id, 'task')
      const wasDone = task.status === 'done'
      if (peopleIds !== undefined || placeId !== undefined || placeName !== undefined) {
        const ctx = resolveContext(await db.fetchAll({ kinds: ['person', 'place'] }), { peopleIds, placeId, placeName })
        if (peopleIds !== undefined) task.peopleIds = ctx.peopleIds
        if (placeId !== undefined || placeName !== undefined) task.placeId = ctx.placeId
      }
      if (title !== undefined) task.title = String(title)
      if (description !== undefined) task.description = String(description)
      if (projectId !== undefined) task.projectId = String(projectId) || undefined
      if (priority !== undefined) task.priority = oneOf(priority, PRIORITIES, 'priority')
      if (dueAt !== undefined) task.dueAt = dueAt ? isoOrThrow(dueAt, 'dueAt') : undefined
      if (tags !== undefined) task.tags = Array.isArray(tags) ? tags.map(String) : task.tags
      if (notes !== undefined) task.notes = String(notes) || undefined
      if (link !== undefined) task.link = String(link) || undefined
      if (githubUrl !== undefined) task.githubUrl = String(githubUrl) || undefined
      if (Array.isArray(addChecklist) && addChecklist.length > 0) {
        task.checklist = [...(task.checklist ?? []), ...addChecklist.map(text => ({ id: newId(), text: String(text), done: false }))]
      }
      if (Array.isArray(tickChecklist) && tickChecklist.length > 0) {
        const wanted = tickChecklist.map(x => String(x).toLowerCase())
        for (const c of task.checklist ?? []) {
          if (wanted.includes(c.id) || wanted.includes(c.text.toLowerCase())) c.done = true
        }
      }
      if (status !== undefined) applyStatus(task, status, clock.iso())
      task.updatedAt = newerStamp(task.updatedAt)
      const writes = [task]
      let spawned = null
      if (!wasDone && task.status === 'done' && task.recurrence) {
        spawned = nextOccurrence(task, newId)
        delete task.recurrence
        if (spawned) writes.push(spawned)
      }
      const stored = await db.syncWrite(writes)
      const mine = stored.find(p => p.id === task.id)
      if (!mine || mine.updatedAt !== task.updatedAt) {
        throw new Error('Write was rejected by the last-write-wins merge (a newer copy exists). Re-read the task and retry.')
      }
      return { updated: summarizeTask(task), nextOccurrence: spawned ? summarizeTask(spawned) : null }
    },
  },
  {
    name: 'complete_task',
    scope: 'write',
    annotations: EDITS,
    description: 'Mark a task done (optionally with a closing comment). Repeating tasks spawn their next occurrence.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        comment: { type: 'string', description: 'Closing note appended to the comment trail' },
        completedAt: { type: 'string', description: 'ISO datetime (default: now)' },
      },
      required: ['id'],
    },
    async run({ id, comment, completedAt } = {}, { db, clock, newId }) {
      const task = await db.fetchItem(id, 'task')
      const wasDone = task.status === 'done'
      const stamp = clock.iso()
      task.status = 'done'
      task.completedAt = completedAt ? isoOrThrow(completedAt, 'completedAt') : (task.completedAt ?? stamp)
      if (comment) task.comments = [...(task.comments ?? []), { id: newId(), body: String(comment), createdAt: stamp }]
      task.updatedAt = newerStamp(task.updatedAt)
      const writes = [task]
      let spawned = null
      if (!wasDone && task.recurrence) {
        spawned = nextOccurrence(task, newId)
        delete task.recurrence
        if (spawned) writes.push(spawned)
      }
      const stored = await db.syncWrite(writes)
      const mine = stored.find(p => p.id === task.id)
      if (!mine || mine.updatedAt !== task.updatedAt) {
        throw new Error('Write was rejected by the last-write-wins merge (a newer copy exists). Re-read the task and retry.')
      }
      return { completed: summarizeTask(task), nextOccurrence: spawned ? summarizeTask(spawned) : null }
    },
  },
  {
    name: 'add_comment',
    scope: 'write',
    annotations: ADDS,
    description: 'Append a comment to a task’s trail: progress notes, decisions, blockers, links. Comments are timestamped and never overwrite each other.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, body: { type: 'string' } }, required: ['id', 'body'] },
    async run({ id, body } = {}, { db, clock, newId }) {
      if (!body || !String(body).trim()) throw new Error('body must not be empty')
      const task = await db.fetchItem(id, 'task')
      const comment = { id: newId(), body: String(body).trim(), createdAt: clock.iso() }
      task.comments = [...(task.comments ?? []), comment]
      task.updatedAt = newerStamp(task.updatedAt)
      await db.writeItem(task)
      return { added: comment, commentCount: task.comments.length }
    },
  },
  {
    name: 'delete_task',
    scope: 'write',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    description: 'Soft-delete a task (tombstone). Reserved for true junk — to drop something on purpose set status "canceled" with update_task instead.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async run({ id } = {}, { db, clock }) {
      const task = await db.fetchItem(id, 'task')
      task.deletedAt = clock.iso()
      task.updatedAt = newerStamp(task.updatedAt)
      await db.writeItem(task)
      return { deleted: id }
    },
  },
  {
    name: 'list_people',
    scope: 'read',
    annotations: READS,
    description: 'People you track visits with: last seen, visits in the last 30/90 days, target rhythm, and whether they are overdue a catch-up or being seen a lot.',
    inputSchema: { type: 'object', properties: {} },
    async run(_args, { db, clock }) {
      const all = await db.fetchAll({ kinds: ['person', 'task'] })
      const tasks = all.filter(i => i.kind === 'task')
      const nowMs = clock.now().getTime()
      return {
        people: all
          .filter(i => i.kind === 'person')
          .map(p => {
            const s = seenStatus(p, tasks, new Date(nowMs))
            return {
              id: p.id,
              name: p.name,
              group: p.group,
              cadenceDays: p.cadenceDays ?? null,
              effectiveCadenceDays: s.effectiveCadenceDays ?? DEFAULT_CADENCE_DAYS,
              lastSeen: s.lastSeen ?? null,
              daysSince: s.daysSince ?? null,
              visitsLast30Days: s.visits.filter(v => nowMs - Date.parse(v.at) < 30 * DAY).length,
              visitsLast90Days: s.visits.filter(v => nowMs - Date.parse(v.at) < 90 * DAY).length,
              status: s.status,
              notes: p.notes ?? null,
            }
          }),
      }
    },
  },
  {
    name: 'list_places',
    scope: 'read',
    annotations: READS,
    description:
      'Places the user goes (restaurants, parks, venues…): when they last went, how often, who they usually go with, and — only for places with a cadenceDays rhythm — whether they are due/overdue a return (status is "none" otherwise).',
    inputSchema: { type: 'object', properties: { category: { type: 'string', enum: PLACE_CATEGORIES } } },
    async run({ category } = {}, { db, clock }) {
      const all = await db.fetchAll({ kinds: ['place', 'task', 'person', 'meal'] })
      const tasks = all.filter(i => i.kind === 'task')
      const people = all.filter(i => i.kind === 'person')
      const places = all.filter(i => i.kind === 'place' && (!category || i.category === category))
      const meals = all.filter(i => i.kind === 'meal')
      const nowMs = clock.now().getTime()
      return { count: places.length, places: places.map(p => summarizePlace(p, tasks, people, meals, nowMs)).sort((a, b) => (b.lastWent ?? '').localeCompare(a.lastWent ?? '')) }
    },
  },
  {
    name: 'create_place',
    scope: 'write',
    annotations: ADDS,
    description:
      'Save a place so outings can be logged there. category: restaurant|cafe|bar|outdoors|venue|shop|home|other. cadenceDays (optional) sets a return rhythm; without it the place is tracked but never flagged as due.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        category: { type: 'string', enum: PLACE_CATEGORIES },
        emoji: { type: 'string' },
        cadenceDays: { type: 'integer', minimum: 1, description: 'Target days between outings, e.g. 30 for monthly. Omit for no target.' },
        notes: { type: 'string', description: 'Best table, what to order, booking tip…' },
      },
      required: ['name'],
    },
    async run({ name, category, emoji, cadenceDays, notes } = {}, { db, clock, newId }) {
      const clean = String(name ?? '').trim()
      if (!clean) throw new Error('name must not be empty')
      let cadence
      if (cadenceDays !== undefined && cadenceDays !== null) {
        cadence = Number(cadenceDays)
        if (!Number.isInteger(cadence) || cadence <= 0) throw new Error('cadenceDays must be a positive integer')
      }
      const all = await db.fetchAll({ kinds: ['place'] })
      const dup = matchPlace(clean, all.filter(i => i.kind === 'place'))
      if (dup && normalisePlaceText(dup.name) === normalisePlaceText(clean)) throw new Error(`"${dup.name}" already exists (id ${dup.id}).`)
      const stamp = clock.iso()
      const place = {
        kind: 'place',
        id: newId(),
        name: clean,
        category: category ? oneOf(category, PLACE_CATEGORIES, 'category') : 'other',
        emoji: emoji ? String(emoji).trim() || undefined : undefined,
        color: '#f97316',
        cadenceDays: cadence,
        notes: notes ? String(notes).trim() || undefined : undefined,
        createdAt: stamp,
        updatedAt: stamp,
      }
      await db.writeItem(place)
      return { created: summarizePlace(place, [], [], [], clock.now().getTime()) }
    },
  },
  {
    name: 'log_visit',
    scope: 'write',
    annotations: ADDS,
    description:
      'Record that the user saw someone and/or went somewhere: a completed "visit" task attached to the person (personId from list_people) and/or the place (placeId from list_places, or placeName). At least one of them is required; a solo outing is fine.',
    inputSchema: {
      type: 'object',
      properties: {
        personId: { type: 'string' },
        peopleIds: { type: 'array', items: { type: 'string' }, description: 'Several people at once' },
        placeId: { type: 'string' },
        placeName: { type: 'string', description: 'Name of a saved place (must already exist)' },
        at: { type: 'string', description: 'ISO date/datetime (default: now)' },
        note: { type: 'string', description: 'What you did, e.g. "Sunday lunch"' },
      },
    },
    async run({ personId, peopleIds, placeId, placeName, at, note } = {}, { db, clock, newId }) {
      const all = await db.fetchAll({ kinds: ['person', 'place'] })
      const ids = [...(personId ? [String(personId)] : []), ...(Array.isArray(peopleIds) ? peopleIds.map(String) : [])]
      const ctx = resolveContext(all, {
        peopleIds: ids.length ? ids : undefined,
        placeId: placeId !== undefined ? placeId : undefined,
        placeName: placeName !== undefined ? placeName : undefined,
      })
      if (!ctx.peopleIds && !ctx.placeId) throw new Error('Give a personId / peopleIds, a placeId, or a placeName.')
      const people = all.filter(i => i.kind === 'person' && (ctx.peopleIds ?? []).includes(i.id))
      const place = ctx.placeId ? all.find(i => i.kind === 'place' && i.id === ctx.placeId) : null
      const who = people.map(p => p.name).join(', ')
      const stamp = clock.iso()
      const task = {
        kind: 'task',
        id: newId(),
        title: note ? String(note) : who && place ? `${who} at ${place.name}` : who ? `Saw ${who}` : `Went to ${place.name}`,
        description: '',
        status: 'done',
        priority: 'normal',
        completedAt: at ? isoOrThrow(at, 'at') : stamp,
        createdAt: stamp,
        updatedAt: stamp,
        tags: ['visit'],
        peopleIds: ctx.peopleIds,
        placeId: ctx.placeId,
      }
      await db.writeItem(task)
      return { logged: summarizeTask(task) }
    },
  },
  {
    name: 'list_recipes',
    scope: 'read',
    annotations: READS,
    description: 'Recipes the household cooks: ingredients, steps, tags, servings. Use the id with plan_meal.',
    inputSchema: { type: 'object', properties: { search: { type: 'string', description: 'Match on name, tag or ingredient' } } },
    async run({ search } = {}, { db }) {
      let recipes = (await db.fetchAll({ kinds: ['recipe'] })).filter(i => i.kind === 'recipe')
      if (search) {
        const needle = String(search).toLowerCase()
        recipes = recipes.filter(r => `${r.name} ${(r.tags ?? []).join(' ')} ${(r.ingredients ?? []).map(i => i.name).join(' ')}`.toLowerCase().includes(needle))
      }
      return {
        count: recipes.length,
        recipes: recipes
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(r => ({ id: r.id, name: r.name, emoji: r.emoji ?? null, servings: r.servings ?? null, tags: r.tags ?? [], ingredients: r.ingredients ?? [], steps: r.steps ?? [], notes: r.notes ?? null })),
      }
    },
  },
  {
    name: 'get_week_meals',
    scope: 'read',
    annotations: READS,
    description:
      'The meal plan for the Sunday-start week containing a date (default today): every planned breakfast/lunch/dinner and the grocery list for that week (lines taken off the list by hand are left out).',
    inputSchema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD, default today' } } },
    async run({ date } = {}, { db, clock }) {
      const day = date ? String(date).trim() : clock.todayKey()
      assertDayKey(day)
      const all = await db.fetchAll({ kinds: ['meal', 'grocery'] })
      const meals = mealsInWeekOf(all.filter(i => i.kind === 'meal'), day)
      const weekKey = weekKeyOf(day)
      const grocery = all.find(i => i.kind === 'grocery' && i.weekKey === weekKey) ?? null
      return {
        weekKey,
        days: weekDayKeys(day),
        meals: meals.map(m => ({ id: m.id, date: m.date, slot: m.slot, title: m.title, recipeId: m.recipeId ?? null, notes: m.notes ?? null })),
        grocery: grocery ? { id: grocery.id, items: activeGroceryLines(grocery.items) } : null,
      }
    },
  },
  {
    name: 'plan_meal',
    scope: 'write',
    annotations: EDITS,
    description:
      'Plan a meal on a day: a recipe (recipeId or recipeName from list_recipes), a free-text title such as "Leftovers", or a meal you are buying rather than cooking (out: true, optionally placeName from list_places). Replaces whatever was in that slot and rebuilds the week\'s grocery list from every planned recipe, keeping Have / Got it ticks, hand-added lines and lines taken off the list (one comes back only when a newly planned recipe needs it). A bought meal adds nothing to the list, and once its day has passed it counts as an outing at that place.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        slot: { type: 'string', enum: MEAL_SLOTS, description: 'default dinner' },
        recipeId: { type: 'string' },
        recipeName: { type: 'string' },
        title: { type: 'string', description: 'Free text when no recipe' },
        out: { type: 'boolean', description: 'Bought rather than cooked: takeaway, delivery, or a meal out' },
        placeName: { type: 'string', description: 'Where a bought meal came from; must match a place from list_places' },
        notes: { type: 'string' },
      },
      required: ['date'],
    },
    async run({ date, slot, recipeId, recipeName, title, out, placeName, notes } = {}, { db, clock }) {
      const day = String(date ?? '').trim()
      assertDayKey(day)
      const when = slot ? oneOf(slot, MEAL_SLOTS, 'slot') : 'dinner'
      const all = await db.fetchAll({ kinds: ['recipe', 'place', 'meal', 'grocery'] })
      const recipes = all.filter(i => i.kind === 'recipe')
      let recipe = null
      if (recipeId) {
        recipe = recipes.find(r => r.id === recipeId)
        if (!recipe) throw new Error(`No recipe with id "${recipeId}". Use list_recipes.`)
      } else if (recipeName) {
        const needle = String(recipeName).trim().toLowerCase()
        recipe = recipes.find(r => r.name.toLowerCase() === needle) ?? recipes.find(r => r.name.toLowerCase().includes(needle))
        if (!recipe) throw new Error(`No recipe named "${recipeName}". Use list_recipes.`)
      }
      // eating out is the other way to answer "what are we eating": no recipe,
      // nothing to shop for, and a place that makes it an outing once it passes
      let place = null
      const eatingOut = out === true || (!recipe && !!placeName)
      if (placeName) {
        const needle = String(placeName).trim().toLowerCase()
        const places = all.filter(i => i.kind === 'place' && !i.deletedAt)
        place = places.find(p => (p.name ?? '').toLowerCase() === needle) ?? places.find(p => (p.name ?? '').toLowerCase().includes(needle))
        if (!place) throw new Error(`No place named "${placeName}". Use list_places, or create_place first.`)
      }
      if (eatingOut && recipe) throw new Error('A meal is either cooked from a recipe or bought, not both.')
      const label = recipe ? recipe.name : String(title ?? '').trim() || (place ? place.name : eatingOut ? 'Eating out' : '')
      if (!label) throw new Error('Give a recipeId / recipeName, a title, or out: true.')
      const id = mealId(day, when)
      const existing = all.find(i => i.kind === 'meal' && i.id === id)
      const stamp = clock.iso()
      const meal = {
        kind: 'meal',
        id,
        date: day,
        slot: when,
        recipeId: recipe?.id,
        out: eatingOut || undefined,
        placeId: eatingOut ? place?.id : undefined,
        title: label,
        notes: notes ? String(notes).trim() || undefined : existing?.notes,
        createdAt: existing?.createdAt ?? stamp,
        updatedAt: newerStamp(existing?.updatedAt),
      }
      // planning a meal writes the grocery list in the same round, or the shop list never leaves this device
      const weekKey = groceryWeekFor(day)
      const weekMeals = [...mealsInWeekOf(all.filter(i => i.kind === 'meal' && i.id !== id), day), meal]
      const prev = all.find(i => i.kind === 'grocery' && i.weekKey === weekKey) ?? null
      const grocery = buildGroceryList(weekKey, weekMeals, recipes, prev, newerStamp(prev?.updatedAt))
      assertStored(await db.syncWrite([meal, grocery]), [meal, grocery])
      return {
        planned: { id: meal.id, date: meal.date, slot: meal.slot, title: meal.title, recipeId: meal.recipeId ?? null, out: !!meal.out, placeId: meal.placeId ?? null },
        groceryItems: activeGroceryLines(grocery.items).length,
        weekKey,
      }
    },
  },
  {
    name: 'get_grocery_list',
    scope: 'read',
    annotations: READS,
    description:
      'The grocery list for the week containing a date (default today): each line with qty/unit, state (need|have|done) and the recipes it came from. Lines taken off the list by hand are left out; add_grocery_item puts one back.',
    inputSchema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD, default today' }, state: { type: 'string', enum: GROCERY_STATES } } },
    async run({ date, state } = {}, { db, clock }) {
      const day = date ? String(date).trim() : clock.todayKey()
      assertDayKey(day)
      const weekKey = weekKeyOf(day)
      const all = await db.fetchAll({ kinds: ['grocery', 'meal', 'recipe'] })
      const list = all.find(i => i.kind === 'grocery' && i.weekKey === weekKey) ?? buildGroceryList(weekKey, mealsInWeekOf(all.filter(i => i.kind === 'meal'), day), all.filter(i => i.kind === 'recipe'), null)
      const lines = activeGroceryLines(list.items)
      const items = state ? lines.filter(i => i.state === oneOf(state, GROCERY_STATES, 'state')) : lines
      return { weekKey, count: items.length, items }
    },
  },
  {
    name: 'add_grocery_item',
    scope: 'write',
    annotations: ADDS,
    description:
      'Add a line by hand to the week\'s grocery list ("milk", "2 kg potatoes"). Hand-added lines survive when the list is rebuilt from the meal plan. A name already on the list goes back to need instead of being added twice, and a line that was taken off the list is restored rather than duplicated (without a unit or qty, the name alone matches).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        qty: { type: 'number' },
        unit: { type: 'string' },
        date: { type: 'string', description: 'Any day in the week (default today)' },
      },
      required: ['name'],
    },
    async run({ name, qty, unit, date } = {}, { db, clock, newId }) {
      const clean = String(name ?? '').trim()
      if (!clean) throw new Error('name must not be empty')
      const day = date ? String(date).trim() : clock.todayKey()
      assertDayKey(day)
      const weekKey = weekKeyOf(day)
      const all = await db.fetchAll({ kinds: ['grocery', 'meal', 'recipe'] })
      const prev = all.find(i => i.kind === 'grocery' && i.weekKey === weekKey) ?? null
      const list = prev ?? buildGroceryList(weekKey, mealsInWeekOf(all.filter(i => i.kind === 'meal'), day), all.filter(i => i.kind === 'recipe'), null, clock.iso())
      // the Kitchen tab's add box runs the same rule: never twice, and a removed line comes back
      const { items, outcome } = addGroceryItem(list.items ?? [], { name: clean, qty, unit }, newId)
      list.items = items
      list.id = groceryId(weekKey)
      list.updatedAt = newerStamp(prev?.updatedAt)
      await db.writeItem(list)
      const added = outcome === 'merged' ? 'merged into an existing line' : outcome === 'restored' ? 'restored a line that had been taken off the list' : clean
      return { weekKey, added, count: activeGroceryLines(list.items).length }
    },
  },
  {
    name: 'set_grocery_state',
    scope: 'write',
    annotations: { ...EDITS, idempotentHint: true },
    description: 'Tick a grocery line: need (buying), have (already in the house) or done (in the cart). Match by line id or by name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        id: { type: 'string' },
        state: { type: 'string', enum: GROCERY_STATES },
        date: { type: 'string', description: 'Any day in the week (default today)' },
      },
      required: ['state'],
    },
    async run({ name, id, state, date } = {}, { db, clock }) {
      const day = date ? String(date).trim() : clock.todayKey()
      assertDayKey(day)
      const next = oneOf(state, GROCERY_STATES, 'state')
      const weekKey = weekKeyOf(day)
      const all = await db.fetchAll({ kinds: ['grocery'] })
      const list = all.find(i => i.kind === 'grocery' && i.weekKey === weekKey)
      if (!list) throw new Error(`No grocery list for week ${weekKey} yet. Plan a meal or add an item first.`)
      const needle = String(name ?? '').trim().toLowerCase()
      const find = lines => lines.find(l => (id && l.id === id) || (needle && l.name.toLowerCase() === needle)) ?? (needle ? lines.find(l => l.name.toLowerCase().includes(needle)) : null)
      // a line taken off the list is not on it: ticking one must not quietly bring it back
      const line = find(activeGroceryLines(list.items))
      if (!line) {
        const off = find((list.items ?? []).filter(l => l && l.removed))
        if (off) throw new Error(`"${off.name}" was taken off this week's list. add_grocery_item puts it back.`)
        throw new Error(`No line matches ${id ? `id "${id}"` : `"${name}"`} on this week's list.`)
      }
      line.state = next
      list.updatedAt = newerStamp(list.updatedAt)
      await db.writeItem(list)
      return { weekKey, line }
    },
  },
  {
    name: 'list_journal',
    scope: 'journal',
    annotations: READS,
    description:
      'Journal entries — one per day of free text plus an optional mood 1 (rough) to 5 (great) — newest first. days defaults to 14; search filters by text. This is personal writing: summarise or quote it only when the user asks about their journal.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How many days back from today (default 14, max 366)' },
        search: { type: 'string' },
      },
    },
    async run({ days, search } = {}, { db, clock }) {
      const [all, journal] = await Promise.all([db.fetchAll({ kinds: ['person'] }), db.fetchJournal()])
      const names = peopleNameMap(all.filter(i => i.kind === 'person'))
      const today = clock.todayKey()
      const span = Math.min(Math.max(Number(days) || 14, 1), 366)
      let entries = entriesBetween(journal, clock.shiftDay(today, -(span - 1)), clock.shiftDay(today, 1))
      if (search) {
        const needle = String(search).toLowerCase()
        entries = entries.filter(
          e => String(e.body ?? '').toLowerCase().includes(needle) || peopleNamesOf(e, names).some(n => n.toLowerCase().includes(needle)),
        )
      }
      return {
        count: entries.length,
        streak: streak(journal, today),
        entries: entries.map(e => ({
          id: e.id,
          date: e.date,
          mood: e.mood ?? null,
          peopleIds: e.peopleIds ?? [],
          people: peopleNamesOf(e, names),
          body: e.body ?? '',
        })),
      }
    },
  },
  {
    name: 'add_journal_entry',
    scope: 'journal',
    annotations: ADDS,
    description:
      'Append a line to the journal for a day (default today). Never overwrites what is already written; creates the day when it is empty. mood is optional, 1 (rough) to 5 (great). peopleIds / peopleNames tag who the day was about (added to anyone already on the day; this is not a visit — use log_visit for that).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD (default: today)' },
        mood: { type: 'number', description: '1–5' },
        peopleIds: { type: 'array', items: { type: 'string' }, description: 'People this day was about (ids from list_people)' },
        peopleNames: { type: 'array', items: { type: 'string' }, description: 'The same by exact name (case-insensitive); an unknown name is an error' },
      },
      required: ['text'],
    },
    async run({ text, date, mood, peopleIds, peopleNames } = {}, { db, clock, rand }) {
      if (!text || !String(text).trim()) throw new Error('text must not be empty')
      const day = date ? String(date).trim() : clock.todayKey()
      assertDayKey(day)
      const m = mood === undefined || mood === null || mood === '' ? undefined : Number(mood)
      if (m !== undefined && !(Number.isInteger(m) && m >= 1 && m <= 5)) throw new Error('mood must be a whole number from 1 to 5')
      const [all, journal] = await Promise.all([db.fetchAll({ kinds: ['person'] }), db.fetchJournal()])
      const people = all.filter(i => i.kind === 'person')
      const ids = peopleIds !== undefined ? (resolveContext(all, { peopleIds }).peopleIds ?? []) : []
      for (const raw of Array.isArray(peopleNames) ? peopleNames : []) {
        const name = String(raw ?? '').trim().toLowerCase()
        if (!name) continue
        const hit = people.find(p => String(p.name ?? '').trim().toLowerCase() === name)
        if (!hit) throw new Error(`No person named "${raw}". Use list_people for the exact names and ids.`)
        ids.push(hit.id)
      }
      const existing = entryOn(journal, day)
      const next = appendEntry(existing, day, String(text), { mood: m, now: clock.iso(), rand: rand(), peopleIds: ids })
      await db.writeItem(next)
      const names = peopleNameMap(people)
      return {
        created: !existing,
        entry: { id: next.id, date: next.date, mood: next.mood ?? null, peopleIds: next.peopleIds ?? [], people: peopleNamesOf(next, names), body: next.body },
      }
    },
  },
  {
    name: 'get_overview',
    scope: 'read',
    annotations: READS,
    description:
      'The Today page as data, in the user\'s time zone: counts by status, overdue / due today / due this week, blocked items, per-project progress, what was completed in the last 7 days, and — on a connection with journal access — whether today has a journal entry.',
    inputSchema: { type: 'object', properties: {} },
    async run(_args, { db, clock, scopes }) {
      const withJournal = Array.isArray(scopes) && scopes.includes('journal')
      const [all, journal] = await Promise.all([db.fetchAll({ kinds: ['task', 'project'] }), withJournal ? db.fetchJournal() : null])
      const tasks = all.filter(i => i.kind === 'task')
      const projects = all.filter(i => i.kind === 'project' && i.status !== 'archived')
      const nowMs = clock.now().getTime()
      const today = clock.todayKey()
      const weekEnd = clock.shiftDay(today, 7)
      const { open, overdue, dueToday, dueSoon } = bucketByDue(tasks, { today, dayKey: iso => clock.dayKeyOf(iso) })
      const at = iso => (iso ? new Date(iso).getTime() : NaN)
      return {
        today,
        timeZone: clock.tz,
        counts: Object.fromEntries(TASK_STATUSES.map(s => [s, tasks.filter(t => t.status === s).length])),
        journal: journal ? { writtenToday: !!entryOn(journal, today), streak: streak(journal, today) } : null,
        overdue: overdue.map(summarizeTask),
        dueToday: dueToday.map(summarizeTask),
        dueThisWeek: dueSoon.filter(t => (clock.dayKeyOf(t.dueAt) ?? '') <= weekEnd).map(summarizeTask),
        blocked: open.filter(t => t.status === 'blocked').map(summarizeTask),
        projects: projects.map(p => summarizeProject(p, tasks.filter(t => t.projectId === p.id))),
        completedLast7Days: tasks.filter(t => t.status === 'done' && t.completedAt && nowMs - at(t.completedAt) < 7 * DAY).length,
      }
    },
  },
]

/** The tools a connection with these scopes may see and call. */
export function toolsFor(scopes, tools = TOOLS) {
  const have = new Set(Array.isArray(scopes) ? scopes : [])
  return tools.filter(t => have.has(t.scope))
}
