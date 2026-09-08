#!/usr/bin/env node
// Drafter MCP server — purpose-built tools for AI agents to manage the planner:
// projects, tasks (due dates, priorities, checklists, comments).
//
// Zero dependencies: speaks MCP's stdio transport (newline-delimited JSON-RPC 2.0)
// directly, and talks to the Supabase backend with fetch. Node 18+.
//
// Usage (see BOTS.md for the registration one-liner):
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SUPABASE_SERVICE_KEY=<service_role key> \
//   node mcp/server.mjs
//
// Every write goes through the sync_posts RPC, so the same last-write-wins
// merge that protects the app protects agent edits too. Pre-v3 rows (legacy
// social posts) are converted to tasks on read, exactly like the app does.

import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  PRIORITIES,
  PROJECT_STATUSES,
  RECURRENCE_FREQS,
  SOCIAL_PROJECT_ID,
  TASK_STATUSES,
  legacyPostToTask,
  newerStamp,
  nextOccurrence,
} from '../shared/domain.mjs'
import { seenStatus, DEFAULT_CADENCE_DAYS } from '../shared/people.mjs'
import { appendEntry, entriesBetween, entryOn, localDayKey, peopleNameMap, peopleNamesOf, shiftDayKey, streak } from '../shared/journal.mjs'
import { matchPlace, normalisePlaceText, placeCadenceStatus } from '../shared/places.mjs'
import { buildGroceryList, groceryId, groceryWeekFor, ingredientKey, mealId, mealsInWeekOf } from '../shared/kitchen.mjs'
import { isDayKey, weekDayKeys, weekKeyOf } from '../shared/weeks.mjs'

const PLACE_CATEGORIES = ['restaurant', 'cafe', 'bar', 'outdoors', 'venue', 'shop', 'home', 'other']
const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner']
const GROCERY_STATES = ['need', 'have', 'done']

const BASE = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
// 2025-03-26 is deliberately absent: that revision mandates JSON-RPC batch
// support, which this server does not implement.
const PROTOCOL_VERSIONS = ['2025-06-18', '2024-11-05']

const DAY = 86_400_000
const OPEN = ['todo', 'doing', 'blocked']

// ---------------------------------------------------------------------------
// Supabase access
// ---------------------------------------------------------------------------

function requireConfig() {
  if (!BASE || !KEY) {
    throw new Error('Server is not configured: set SUPABASE_URL and SUPABASE_SERVICE_KEY in the MCP server environment.')
  }
}

async function api(path, init = {}) {
  requireConfig()
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      apikey: KEY,
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

/**
 * Write items through the LWW merge; returns the full current item list
 * (normalized). sync_posts has returned { items, rejected } since the
 * synced_at migration; the bare-array shape is kept for an older database.
 */
async function syncWrite(items) {
  const res = await api('/rest/v1/rpc/sync_posts', { method: 'POST', body: JSON.stringify({ incoming: items }) })
  const list = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : []
  const rejected = Array.isArray(res?.rejected) ? res.rejected : []
  const mine = items.map(i => i.id).filter(id => rejected.includes(id))
  if (mine.length) throw new Error(`The server refused to store ${mine.join(', ')} (unknown kind or invalid record — is the newest migration applied?).`)
  return list.map(legacyPostToTask)
}

/** All live rows, normalized to v3 shape. */
async function fetchAll() {
  const rows = await api('/rest/v1/posts?select=data&deleted=is.false&order=updated_at.desc')
  return rows.map(r => legacyPostToTask(r.data))
}

let ownerIdCache
/** The account this server writes as (sync_posts falls back to owner_user_id() under the service key). */
async function ownerId() {
  if (ownerIdCache === undefined) ownerIdCache = (await api('/rest/v1/rpc/owner_user_id', { method: 'POST', body: '{}' })) ?? null
  return ownerIdCache
}

/**
 * Journal rows are personal. The service key bypasses every policy, so this
 * server reads only the owner's entries (and legacy unowned rows) — never a
 * household peer's diary — and appends only into those.
 */
async function fetchJournal() {
  const [rows, owner] = await Promise.all([api('/rest/v1/posts?select=data,user_id&deleted=is.false&kind=eq.journal'), ownerId()])
  return rows.filter(r => r.user_id === null || r.user_id === owner).map(r => legacyPostToTask(r.data))
}

/** A real calendar day, not just the right shape: 2026-02-30 is refused. */
function assertDayKey(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day ?? ''))) throw new Error('date must be YYYY-MM-DD')
  if (!isDayKey(day)) throw new Error(`"${day}" is not a real calendar date`)
  return day
}

async function fetchItem(id, kind) {
  const rows = await api(`/rest/v1/posts?id=eq.${encodeURIComponent(id)}&select=data`)
  const item = rows?.[0]?.data ? legacyPostToTask(rows[0].data) : null
  if (!item) throw new Error(`No ${kind} with id "${id}".`)
  if (item.deletedAt) throw new Error(`${kind} "${id}" is deleted.`)
  if (item.kind !== kind) throw new Error(`"${id}" is a ${item.kind}, not a ${kind}.`)
  return item
}
const fetchTask = id => fetchItem(id, 'task')
const fetchProject = id => fetchItem(id, 'project')

/** Persist one edited item and confirm the write won the merge. */
async function writeItem(item) {
  const all = await syncWrite([item])
  const stored = all.find(p => p.id === item.id)
  if (!stored || stored.updatedAt !== item.updatedAt) {
    throw new Error('Write was rejected by the last-write-wins merge (a newer copy exists). Re-read the item and retry.')
  }
  return stored
}

// ---------------------------------------------------------------------------
// Domain helpers (mirror the app's rules)
// ---------------------------------------------------------------------------

const now = () => new Date().toISOString()

function newId() {
  return `mcp-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
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

function applyStatus(task, status) {
  task.status = oneOf(status, TASK_STATUSES, 'status')
  if (status === 'done') task.completedAt = task.completedAt ?? now()
  else delete task.completedAt
}

function summarizeTask(t) {
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
function resolveContext(all, { peopleIds, placeId, placeName }) {
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

function summarizePlace(p, tasks = [], people = []) {
  const outings = tasks
    .filter(t => t.status === 'done' && t.completedAt && t.placeId === p.id)
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
  const nowMs = Date.now()
  const last = outings[0]?.completedAt ?? null
  const companions = new Map()
  for (const t of outings) for (const id of t.peopleIds ?? []) companions.set(id, (companions.get(id) ?? 0) + 1)
  // opt-in rhythm: status is 'none' unless the user set one — never a nag by default
  const cadence = placeCadenceStatus(p, tasks, new Date(nowMs))
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
    outingsLast365Days: outings.filter(t => nowMs - Date.parse(t.completedAt) < 365 * DAY).length,
    outingsAllTime: outings.length,
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

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'list_projects',
    description: 'List projects with task counts. Includes archived ones only when includeArchived is true.',
    inputSchema: { type: 'object', properties: { includeArchived: { type: 'boolean' } } },
    async run({ includeArchived }) {
      const all = await fetchAll()
      const tasks = all.filter(i => i.kind === 'task')
      const projects = all.filter(i => i.kind === 'project' && (includeArchived || i.status !== 'archived'))
      return { count: projects.length, projects: projects.map(p => summarizeProject(p, tasks.filter(t => t.projectId === p.id))) }
    },
  },
  {
    name: 'create_project',
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
    async run({ name, description, emoji, color, startAt, targetAt, githubUrl, milestones }) {
      if (!name || !String(name).trim()) throw new Error('name must not be empty')
      const stamp = now()
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
      await writeItem(project)
      return { created: summarizeProject(project) }
    },
  },
  {
    name: 'update_project',
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
    async run({ id, name, description, status, startAt, targetAt, githubUrl, notes, appendNotes, addMilestone, completeMilestone }) {
      const project = await fetchProject(id)
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
      await writeItem(project)
      return { updated: summarizeProject(project) }
    },
  },
  {
    name: 'list_tasks',
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
    async run({ status, projectId, dueBefore, search, limit }) {
      let tasks = (await fetchAll()).filter(i => i.kind === 'task')
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
    description: 'Fetch one task in full (description, checklist, comments, everything) by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async run({ id }) {
      return fetchTask(id)
    },
  },
  {
    name: 'create_task',
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
    async run({ title, description, projectId, status, priority, dueAt, tags, notes, link, githubUrl, checklist, recurrence, peopleIds, placeId, placeName }) {
      if (!title || !String(title).trim()) throw new Error('title must not be empty')
      const stamp = now()
      const needsLookup = projectId || peopleIds !== undefined || placeId !== undefined || placeName !== undefined
      const all = needsLookup ? await fetchAll() : []
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
      await writeItem(task)
      return { created: summarizeTask(task) }
    },
  },
  {
    name: 'update_task',
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
    async run({ id, title, description, projectId, status, priority, dueAt, tags, notes, link, githubUrl, addChecklist, tickChecklist, peopleIds, placeId, placeName }) {
      const task = await fetchTask(id)
      const wasDone = task.status === 'done'
      if (peopleIds !== undefined || placeId !== undefined || placeName !== undefined) {
        const ctx = resolveContext(await fetchAll(), { peopleIds, placeId, placeName })
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
      if (status !== undefined) applyStatus(task, status)
      task.updatedAt = newerStamp(task.updatedAt)
      const writes = [task]
      let spawned = null
      if (!wasDone && task.status === 'done' && task.recurrence) {
        spawned = nextOccurrence(task, newId)
        delete task.recurrence
        if (spawned) writes.push(spawned)
      }
      const all = await syncWrite(writes)
      const stored = all.find(p => p.id === task.id)
      if (!stored || stored.updatedAt !== task.updatedAt) {
        throw new Error('Write was rejected by the last-write-wins merge (a newer copy exists). Re-read the task and retry.')
      }
      return { updated: summarizeTask(task), nextOccurrence: spawned ? summarizeTask(spawned) : null }
    },
  },
  {
    name: 'complete_task',
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
    async run({ id, comment, completedAt }) {
      const task = await fetchTask(id)
      const wasDone = task.status === 'done'
      task.status = 'done'
      task.completedAt = completedAt ? isoOrThrow(completedAt, 'completedAt') : (task.completedAt ?? now())
      if (comment) task.comments = [...(task.comments ?? []), { id: newId(), body: String(comment), createdAt: now() }]
      task.updatedAt = newerStamp(task.updatedAt)
      const writes = [task]
      let spawned = null
      if (!wasDone && task.recurrence) {
        spawned = nextOccurrence(task, newId)
        delete task.recurrence
        if (spawned) writes.push(spawned)
      }
      const all = await syncWrite(writes)
      const stored = all.find(p => p.id === task.id)
      if (!stored || stored.updatedAt !== task.updatedAt) {
        throw new Error('Write was rejected by the last-write-wins merge (a newer copy exists). Re-read the task and retry.')
      }
      return { completed: summarizeTask(task), nextOccurrence: spawned ? summarizeTask(spawned) : null }
    },
  },
  {
    name: 'add_comment',
    description: 'Append a comment to a task’s trail: progress notes, decisions, blockers, links. Comments are timestamped and never overwrite each other.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, body: { type: 'string' } }, required: ['id', 'body'] },
    async run({ id, body }) {
      if (!body || !String(body).trim()) throw new Error('body must not be empty')
      const task = await fetchTask(id)
      const comment = { id: newId(), body: String(body).trim(), createdAt: now() }
      task.comments = [...(task.comments ?? []), comment]
      task.updatedAt = newerStamp(task.updatedAt)
      await writeItem(task)
      return { added: comment, commentCount: task.comments.length }
    },
  },
  {
    name: 'delete_task',
    description: 'Soft-delete a task (tombstone). Reserved for true junk — to drop something on purpose set status "canceled" with update_task instead.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async run({ id }) {
      const task = await fetchTask(id)
      task.deletedAt = now()
      task.updatedAt = newerStamp(task.updatedAt)
      await writeItem(task)
      return { deleted: id }
    },
  },
  {
    name: 'list_people',
    description: 'People you track visits with: last seen, visits in the last 30/90 days, target rhythm, and whether they are overdue a catch-up or being seen a lot.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const all = await fetchAll()
      const tasks = all.filter(i => i.kind === 'task')
      const nowMs = Date.now()
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
    description:
      'Places the user goes (restaurants, parks, venues…): when they last went, how often, who they usually go with, and — only for places with a cadenceDays rhythm — whether they are due/overdue a return (status is "none" otherwise).',
    inputSchema: { type: 'object', properties: { category: { type: 'string', enum: PLACE_CATEGORIES } } },
    async run({ category }) {
      const all = await fetchAll()
      const tasks = all.filter(i => i.kind === 'task')
      const people = all.filter(i => i.kind === 'person')
      const places = all.filter(i => i.kind === 'place' && (!category || i.category === category))
      return { count: places.length, places: places.map(p => summarizePlace(p, tasks, people)).sort((a, b) => (b.lastWent ?? '').localeCompare(a.lastWent ?? '')) }
    },
  },
  {
    name: 'create_place',
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
    async run({ name, category, emoji, cadenceDays, notes }) {
      const clean = String(name ?? '').trim()
      if (!clean) throw new Error('name must not be empty')
      let cadence
      if (cadenceDays !== undefined && cadenceDays !== null) {
        cadence = Number(cadenceDays)
        if (!Number.isInteger(cadence) || cadence <= 0) throw new Error('cadenceDays must be a positive integer')
      }
      const all = await fetchAll()
      const dup = matchPlace(clean, all.filter(i => i.kind === 'place'))
      if (dup && normalisePlaceText(dup.name) === normalisePlaceText(clean)) throw new Error(`"${dup.name}" already exists (id ${dup.id}).`)
      const stamp = now()
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
      await writeItem(place)
      return { created: summarizePlace(place) }
    },
  },
  {
    name: 'log_visit',
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
    async run({ personId, peopleIds, placeId, placeName, at, note }) {
      const all = await fetchAll()
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
      const stamp = now()
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
      await writeItem(task)
      return { logged: summarizeTask(task) }
    },
  },
  {
    name: 'list_recipes',
    description: 'Recipes the household cooks: ingredients, steps, tags, servings. Use the id with plan_meal.',
    inputSchema: { type: 'object', properties: { search: { type: 'string', description: 'Match on name, tag or ingredient' } } },
    async run({ search }) {
      let recipes = (await fetchAll()).filter(i => i.kind === 'recipe')
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
    description: 'The meal plan for the Sunday-start week containing a date (default today): every planned breakfast/lunch/dinner and the grocery list for that week.',
    inputSchema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD, default today' } } },
    async run({ date }) {
      const day = date ? String(date).trim() : localDayKey()
      assertDayKey(day)
      const all = await fetchAll()
      const meals = mealsInWeekOf(all.filter(i => i.kind === 'meal'), day)
      const weekKey = weekKeyOf(day)
      const grocery = all.find(i => i.kind === 'grocery' && i.weekKey === weekKey) ?? null
      return {
        weekKey,
        days: weekDayKeys(day),
        meals: meals.map(m => ({ id: m.id, date: m.date, slot: m.slot, title: m.title, recipeId: m.recipeId ?? null, notes: m.notes ?? null })),
        grocery: grocery ? { id: grocery.id, items: grocery.items ?? [] } : null,
      }
    },
  },
  {
    name: 'plan_meal',
    description:
      'Plan a meal on a day: a recipe (recipeId or recipeName from list_recipes) or a free-text title such as "Leftovers". Replaces whatever was in that slot and rebuilds the week\'s grocery list from every planned recipe, keeping Have / Got it ticks and hand-added lines.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        slot: { type: 'string', enum: MEAL_SLOTS, description: 'default dinner' },
        recipeId: { type: 'string' },
        recipeName: { type: 'string' },
        title: { type: 'string', description: 'Free text when no recipe' },
        notes: { type: 'string' },
      },
      required: ['date'],
    },
    async run({ date, slot, recipeId, recipeName, title, notes }) {
      const day = String(date ?? '').trim()
      assertDayKey(day)
      const when = slot ? oneOf(slot, MEAL_SLOTS, 'slot') : 'dinner'
      const all = await fetchAll()
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
      const label = recipe ? recipe.name : String(title ?? '').trim()
      if (!label) throw new Error('Give a recipeId / recipeName, or a title.')
      const id = mealId(day, when)
      const existing = all.find(i => i.kind === 'meal' && i.id === id)
      const stamp = now()
      const meal = {
        kind: 'meal',
        id,
        date: day,
        slot: when,
        recipeId: recipe?.id,
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
      const stored = await syncWrite([meal, grocery])
      for (const w of [meal, grocery]) {
        const check = stored.find(p => p.id === w.id)
        if (!check || check.updatedAt !== w.updatedAt) throw new Error(`Write of ${w.kind} ${w.id} was rejected by the last-write-wins merge (a newer copy exists). Re-read and retry.`)
      }
      return { planned: { id: meal.id, date: meal.date, slot: meal.slot, title: meal.title, recipeId: meal.recipeId ?? null }, groceryItems: grocery.items.length, weekKey }
    },
  },
  {
    name: 'get_grocery_list',
    description: 'The grocery list for the week containing a date (default today): each line with qty/unit, state (need|have|done) and the recipes it came from.',
    inputSchema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD, default today' }, state: { type: 'string', enum: GROCERY_STATES } } },
    async run({ date, state }) {
      const day = date ? String(date).trim() : localDayKey()
      assertDayKey(day)
      const weekKey = weekKeyOf(day)
      const all = await fetchAll()
      const list = all.find(i => i.kind === 'grocery' && i.weekKey === weekKey) ?? buildGroceryList(weekKey, mealsInWeekOf(all.filter(i => i.kind === 'meal'), day), all.filter(i => i.kind === 'recipe'), null)
      const items = state ? list.items.filter(i => i.state === oneOf(state, GROCERY_STATES, 'state')) : list.items
      return { weekKey, count: items.length, items }
    },
  },
  {
    name: 'add_grocery_item',
    description: 'Add a line by hand to the week\'s grocery list ("milk", "2 kg potatoes"). Hand-added lines survive when the list is rebuilt from the meal plan.',
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
    async run({ name, qty, unit, date }) {
      const clean = String(name ?? '').trim()
      if (!clean) throw new Error('name must not be empty')
      const day = date ? String(date).trim() : localDayKey()
      assertDayKey(day)
      const weekKey = weekKeyOf(day)
      const all = await fetchAll()
      const prev = all.find(i => i.kind === 'grocery' && i.weekKey === weekKey) ?? null
      const list = prev ?? buildGroceryList(weekKey, mealsInWeekOf(all.filter(i => i.kind === 'meal'), day), all.filter(i => i.kind === 'recipe'), null, now())
      const key = ingredientKey(clean, unit)
      const dup = (list.items ?? []).find(l => ingredientKey(l.name, l.unit) === key)
      if (dup) {
        dup.state = 'need'
        if (qty != null && Number.isFinite(Number(qty))) dup.qty = (dup.qty ?? 0) + Number(qty)
      } else {
        list.items = [...(list.items ?? []), { id: newId(), name: clean, qty: qty != null && Number.isFinite(Number(qty)) ? Number(qty) : undefined, unit: unit ? String(unit).trim() || undefined : undefined, state: 'need', recipeIds: [], manual: true }]
      }
      list.id = groceryId(weekKey)
      list.updatedAt = newerStamp(prev?.updatedAt)
      await writeItem(list)
      return { weekKey, added: dup ? 'merged into an existing line' : clean, count: list.items.length }
    },
  },
  {
    name: 'set_grocery_state',
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
    async run({ name, id, state, date }) {
      const day = date ? String(date).trim() : localDayKey()
      assertDayKey(day)
      const next = oneOf(state, GROCERY_STATES, 'state')
      const weekKey = weekKeyOf(day)
      const all = await fetchAll()
      const list = all.find(i => i.kind === 'grocery' && i.weekKey === weekKey)
      if (!list) throw new Error(`No grocery list for week ${weekKey} yet. Plan a meal or add an item first.`)
      const needle = String(name ?? '').trim().toLowerCase()
      const line = (list.items ?? []).find(l => (id && l.id === id) || (needle && l.name.toLowerCase() === needle)) ?? (needle ? (list.items ?? []).find(l => l.name.toLowerCase().includes(needle)) : null)
      if (!line) throw new Error(`No line matches ${id ? `id "${id}"` : `"${name}"`} on this week's list.`)
      line.state = next
      list.updatedAt = newerStamp(list.updatedAt)
      await writeItem(list)
      return { weekKey, line }
    },
  },
  {
    name: 'list_journal',
    description:
      'Journal entries — one per day of free text plus an optional mood 1 (rough) to 5 (great) — newest first. days defaults to 14; search filters by text. This is personal writing: summarise or quote it only when the user asks about their journal.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How many days back from today (default 14, max 366)' },
        search: { type: 'string' },
      },
    },
    async run({ days, search }) {
      const [all, journal] = await Promise.all([fetchAll(), fetchJournal()])
      const names = peopleNameMap(all.filter(i => i.kind === 'person'))
      const today = localDayKey()
      const span = Math.min(Math.max(Number(days) || 14, 1), 366)
      let entries = entriesBetween(journal, shiftDayKey(today, -(span - 1)), shiftDayKey(today, 1))
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
    async run({ text, date, mood, peopleIds, peopleNames }) {
      if (!text || !String(text).trim()) throw new Error('text must not be empty')
      const day = date ? String(date).trim() : localDayKey()
      assertDayKey(day)
      const m = mood === undefined || mood === null || mood === '' ? undefined : Number(mood)
      if (m !== undefined && !(Number.isInteger(m) && m >= 1 && m <= 5)) throw new Error('mood must be a whole number from 1 to 5')
      const [all, journal] = await Promise.all([fetchAll(), fetchJournal()])
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
      const next = appendEntry(existing, day, String(text), { mood: m, now: now(), rand: randomBytes(4).toString('hex'), peopleIds: ids })
      await writeItem(next)
      const names = peopleNameMap(people)
      return {
        created: !existing,
        entry: { id: next.id, date: next.date, mood: next.mood ?? null, peopleIds: next.peopleIds ?? [], people: peopleNamesOf(next, names), body: next.body },
      }
    },
  },
  {
    name: 'get_overview',
    description: 'The Today page as data: counts by status, overdue / due today / due this week, blocked items, per-project progress, what was completed in the last 7 days, and whether today has a journal entry.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const all = await fetchAll()
      const tasks = all.filter(i => i.kind === 'task')
      const projects = all.filter(i => i.kind === 'project' && i.status !== 'archived')
      const journal = await fetchJournal()
      const nowMs = Date.now()
      const startOfToday = new Date()
      startOfToday.setHours(0, 0, 0, 0)
      const endOfToday = startOfToday.getTime() + DAY
      const at = iso => (iso ? new Date(iso).getTime() : NaN)
      const open = tasks.filter(t => OPEN.includes(t.status))
      const counts = Object.fromEntries(TASK_STATUSES.map(s => [s, tasks.filter(t => t.status === s).length]))
      const todayKey = localDayKey()
      return {
        counts,
        journal: { writtenToday: !!entryOn(journal, todayKey), streak: streak(journal, todayKey) },
        overdue: open.filter(t => t.dueAt && at(t.dueAt) < startOfToday.getTime()).map(summarizeTask),
        dueToday: open.filter(t => t.dueAt && at(t.dueAt) >= startOfToday.getTime() && at(t.dueAt) < endOfToday).map(summarizeTask),
        dueThisWeek: open.filter(t => t.dueAt && at(t.dueAt) >= endOfToday && at(t.dueAt) < endOfToday + 7 * DAY).map(summarizeTask),
        blocked: open.filter(t => t.status === 'blocked').map(summarizeTask),
        projects: projects.map(p => summarizeProject(p, tasks.filter(t => t.projectId === p.id))),
        completedLast7Days: tasks.filter(t => t.status === 'done' && t.completedAt && nowMs - at(t.completedAt) < 7 * DAY).length,
      }
    },
  },
]

// ---------------------------------------------------------------------------
// MCP stdio transport: newline-delimited JSON-RPC 2.0
// ---------------------------------------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(msg) {
  // JSON.parse can legally yield null/scalars/arrays; only plain objects are messages
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    process.stderr.write('drafter-mcp: ignoring non-object message\n')
    return
  }
  const { id, method, params } = msg
  const isRequest = id !== undefined && id !== null
  // JSON-RPC: notifications are never answered, whatever their method
  if (!isRequest) return

  try {
    if (method === 'initialize') {
      const requested = params?.protocolVersion
      reply(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'drafter', version: '2.0.0' },
      })
      return
    }
    if (method === 'ping') {
      reply(id, {})
      return
    }
    if (method === 'tools/list') {
      reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
      return
    }
    if (method === 'tools/call') {
      const tool = TOOLS.find(t => t.name === params?.name)
      if (!tool) {
        replyError(id, -32602, `Unknown tool: ${params?.name}`)
        return
      }
      try {
        const result = await tool.run(params?.arguments ?? {})
        reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false })
      } catch (e) {
        reply(id, { content: [{ type: 'text', text: `Error: ${e?.message ?? e}` }], isError: true })
      }
      return
    }
    replyError(id, -32601, `Method not found: ${method}`)
  } catch (e) {
    replyError(id, -32603, `Internal error: ${e?.message ?? e}`)
  }
}

// Requests are processed strictly in arrival order: agents chain dependent
// calls (create → schedule → …), and concurrent read-modify-writes on the same
// post could otherwise race each other's last-write-wins stamps. The server
// also exits only after every queued request has been answered — stdin can
// close (e.g. when driven from a pipe) while tool calls are still running.
let pending = 0
let stdinClosed = false
let queue = Promise.resolve()

function maybeExit() {
  // flush stdout before exiting — process.exit() drops buffered pipe writes
  if (stdinClosed && pending === 0) process.stdout.write('', () => process.exit(0))
}

/** Serve MCP over stdio. Called only when this file is the entry point, so tests can import the pieces above. */
export function startStdio() {
  const rl = createInterface({ input: process.stdin, terminal: false })
  rl.on('line', line => {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg
    try {
      msg = JSON.parse(trimmed)
    } catch {
      process.stderr.write(`drafter-mcp: ignoring unparseable line\n`)
      return
    }
    pending++
    queue = queue
      .then(() => handle(msg))
      .catch(e => {
        // a rejected chain must never poison later requests or the process
        process.stderr.write(`drafter-mcp: handler error: ${e?.message ?? e}\n`)
      })
      .finally(() => {
        pending--
        maybeExit()
      })
  })
  rl.on('close', () => {
    stdinClosed = true
    maybeExit()
  })

  if (!BASE || !KEY) {
    process.stderr.write('drafter-mcp: warning — SUPABASE_URL / SUPABASE_SERVICE_KEY not set; tools will return a configuration error.\n')
  }
}

// pieces the tests exercise without a database or a transport
export { TOOLS, syncWrite, writeItem, fetchJournal, assertDayKey, resolveContext, summarizeTask, summarizePlace }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startStdio()
