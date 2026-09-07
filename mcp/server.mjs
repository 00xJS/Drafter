#!/usr/bin/env node
// Drafter MCP server — purpose-built tools for AI agents to manage the planner:
// projects, tasks (due dates, priorities, checklists, comments) and the social
// posting extension.
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
// merge that protects the app protects agent edits too. Pre-v3 rows (social
// posts) are converted to tasks on read, exactly like the app does.

import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'
import {
  PLATFORMS,
  PRIORITIES,
  PROJECT_STATUSES,
  RECURRENCE_FREQS,
  SOCIAL_PROJECT_ID,
  TASK_STATUSES,
  cleanMetrics,
  engagement,
  legacyPostToTask,
  newerStamp,
  nextOccurrence,
} from '../shared/domain.mjs'

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

/** Write items through the LWW merge; returns the full current item list (normalized). */
async function syncWrite(items) {
  const all = await api('/rest/v1/rpc/sync_posts', { method: 'POST', body: JSON.stringify({ incoming: items }) })
  return all.map(legacyPostToTask)
}

/** All live rows, normalized to v3 shape. */
async function fetchAll() {
  const rows = await api('/rest/v1/posts?select=data&deleted=is.false&order=updated_at.desc')
  return rows.map(r => legacyPostToTask(r.data))
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

function checkPlatforms(platforms) {
  if (!Array.isArray(platforms) || platforms.length === 0) throw new Error('platforms must be a non-empty array')
  const bad = platforms.filter(p => !PLATFORMS.includes(p))
  if (bad.length > 0) throw new Error(`Unknown platforms: ${bad.join(', ')}. Valid: ${PLATFORMS.join(', ')}`)
  return platforms
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
    social: t.social ? { platforms: t.social.platforms, engagement: t.status === 'done' ? engagement({ metrics: t.social.metrics }) : null } : null,
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
    description: 'Fetch one task in full (description, checklist, comments, social fields, everything) by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async run({ id }) {
      return fetchTask(id)
    },
  },
  {
    name: 'create_task',
    description:
      'Create a task. Defaults: status "todo" (or "wishlist" if you say so), priority "normal". Give it a projectId from list_projects when it belongs somewhere. For a social post, pass social.platforms — the description is the post text (keep X within 280 characters; use social.variants for per-platform text).',
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
        social: {
          type: 'object',
          description: 'Makes this task a social post',
          properties: {
            platforms: { type: 'array', items: { type: 'string', enum: PLATFORMS } },
            variants: { type: 'object', additionalProperties: { type: 'string' } },
          },
          required: ['platforms'],
        },
      },
      required: ['title'],
    },
    async run({ title, description, projectId, status, priority, dueAt, tags, notes, link, githubUrl, checklist, recurrence, social }) {
      if (!title || !String(title).trim()) throw new Error('title must not be empty')
      const stamp = now()
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
      }
      if (task.status === 'done') task.completedAt = stamp
      if (social) {
        checkPlatforms(social.platforms)
        task.social = {
          platforms: social.platforms,
          variants:
            social.variants && typeof social.variants === 'object'
              ? Object.fromEntries(Object.entries(social.variants).filter(([k, v]) => PLATFORMS.includes(k) && typeof v === 'string'))
              : undefined,
        }
        if (!task.projectId) task.projectId = SOCIAL_PROJECT_ID
      }
      if (task.projectId) {
        const projects = (await fetchAll()).filter(i => i.kind === 'project')
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
        variants: { type: 'object', additionalProperties: { type: 'string' }, description: 'Social per-platform overrides' },
      },
      required: ['id'],
    },
    async run({ id, title, description, projectId, status, priority, dueAt, tags, notes, link, githubUrl, addChecklist, tickChecklist, variants }) {
      const task = await fetchTask(id)
      const wasDone = task.status === 'done'
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
      if (variants !== undefined && task.social) {
        task.social.variants = Object.fromEntries(Object.entries(variants ?? {}).filter(([k, v]) => PLATFORMS.includes(k) && typeof v === 'string' && v.trim()))
        if (Object.keys(task.social.variants).length === 0) delete task.social.variants
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
    description: 'Mark a task done (optionally with a closing comment and, for social posts, per-platform metrics). Repeating tasks spawn their next occurrence.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        comment: { type: 'string', description: 'Closing note appended to the comment trail' },
        completedAt: { type: 'string', description: 'ISO datetime (default: now)' },
        metrics: { type: 'object', description: 'Social posts only: {"x": {"likes": 10, "impressions": 900}}', additionalProperties: { type: 'object' } },
      },
      required: ['id'],
    },
    async run({ id, comment, completedAt, metrics }) {
      const task = await fetchTask(id)
      const wasDone = task.status === 'done'
      task.status = 'done'
      task.completedAt = completedAt ? isoOrThrow(completedAt, 'completedAt') : (task.completedAt ?? now())
      if (comment) task.comments = [...(task.comments ?? []), { id: newId(), body: String(comment), createdAt: now() }]
      if (metrics && typeof metrics === 'object' && task.social) {
        task.social.metrics = task.social.metrics ?? {}
        for (const [pl, m] of Object.entries(metrics)) {
          if (PLATFORMS.includes(pl) && m && typeof m === 'object') task.social.metrics[pl] = { ...task.social.metrics[pl], ...cleanMetrics(m) }
        }
      }
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
    name: 'log_metrics',
    description: 'Social posts only: add or update engagement metrics (likes, comments, shares, impressions) for one platform on a completed post.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        platform: { type: 'string', enum: PLATFORMS },
        likes: { type: 'number' },
        comments: { type: 'number' },
        shares: { type: 'number' },
        impressions: { type: 'number' },
      },
      required: ['id', 'platform'],
    },
    async run({ id, platform, likes, comments, shares, impressions }) {
      if (!PLATFORMS.includes(platform)) throw new Error(`Unknown platform "${platform}"`)
      const task = await fetchTask(id)
      if (!task.social) throw new Error('This task is not a social post.')
      task.social.metrics = task.social.metrics ?? {}
      task.social.metrics[platform] = { ...task.social.metrics[platform], ...cleanMetrics({ likes, comments, shares, impressions }) }
      task.updatedAt = newerStamp(task.updatedAt)
      await writeItem(task)
      return { updated: { id: task.id, metrics: task.social.metrics } }
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
            const visits = tasks
              .filter(t => t.status === 'done' && t.completedAt && (t.peopleIds ?? []).includes(p.id))
              .map(t => t.completedAt)
              .sort()
              .reverse()
            const daysSince = visits[0] ? Math.floor((nowMs - Date.parse(visits[0])) / DAY) : null
            const c = p.cadenceDays
            const status = !visits[0] ? 'never' : c && daysSince > c * 1.5 ? 'overdue' : c && daysSince > c ? 'due' : 'ok'
            return {
              id: p.id,
              name: p.name,
              group: p.group,
              cadenceDays: c ?? null,
              lastSeen: visits[0] ?? null,
              daysSince,
              visitsLast30Days: visits.filter(v => nowMs - Date.parse(v) < 30 * DAY).length,
              visitsLast90Days: visits.filter(v => nowMs - Date.parse(v) < 90 * DAY).length,
              status,
              notes: p.notes ?? null,
            }
          }),
      }
    },
  },
  {
    name: 'log_visit',
    description: 'Record that the user saw someone (creates a completed "visit" task attached to that person). personId from list_people.',
    inputSchema: {
      type: 'object',
      properties: {
        personId: { type: 'string' },
        at: { type: 'string', description: 'ISO date/datetime (default: now)' },
        note: { type: 'string', description: 'What you did, e.g. "Sunday lunch"' },
      },
      required: ['personId'],
    },
    async run({ personId, at, note }) {
      const all = await fetchAll()
      const person = all.find(i => i.kind === 'person' && i.id === personId)
      if (!person) throw new Error(`No person with id "${personId}". Use list_people.`)
      const stamp = now()
      const task = {
        kind: 'task',
        id: newId(),
        title: note ? String(note) : `Saw ${person.name}`,
        description: '',
        status: 'done',
        priority: 'normal',
        completedAt: at ? isoOrThrow(at, 'at') : stamp,
        createdAt: stamp,
        updatedAt: stamp,
        tags: ['visit'],
        peopleIds: [person.id],
      }
      await writeItem(task)
      return { logged: summarizeTask(task) }
    },
  },
  {
    name: 'get_overview',
    description: 'The Today page as data: counts by status, overdue / due today / due this week, blocked items, per-project progress, and what was completed in the last 7 days.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const all = await fetchAll()
      const tasks = all.filter(i => i.kind === 'task')
      const projects = all.filter(i => i.kind === 'project' && i.status !== 'archived')
      const nowMs = Date.now()
      const startOfToday = new Date()
      startOfToday.setHours(0, 0, 0, 0)
      const endOfToday = startOfToday.getTime() + DAY
      const at = iso => (iso ? new Date(iso).getTime() : NaN)
      const open = tasks.filter(t => OPEN.includes(t.status))
      const counts = Object.fromEntries(TASK_STATUSES.map(s => [s, tasks.filter(t => t.status === s).length]))
      return {
        counts,
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
