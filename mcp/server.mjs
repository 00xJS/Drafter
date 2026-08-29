#!/usr/bin/env node
// Drafter MCP server — purpose-built tools for AI agents to manage the planner.
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
// merge that protects the app protects agent edits too.

import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'

const BASE = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
// 2025-03-26 is deliberately absent: that revision mandates JSON-RPC batch
// support, which this server does not implement.
const PROTOCOL_VERSIONS = ['2025-06-18', '2024-11-05']

const PLATFORMS = ['x', 'instagram', 'threads', 'linkedin', 'facebook', 'tiktok', 'youtube']
const STATUSES = ['idea', 'draft', 'scheduled', 'posted', 'canceled']
const DAY = 86_400_000

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

/** Write posts through the LWW merge; returns the full current post list. */
async function syncWrite(posts) {
  return api('/rest/v1/rpc/sync_posts', { method: 'POST', body: JSON.stringify({ incoming: posts }) })
}

async function fetchPost(id) {
  const rows = await api(`/rest/v1/posts?id=eq.${encodeURIComponent(id)}&select=data`)
  const post = rows?.[0]?.data
  if (!post) throw new Error(`No post with id "${id}".`)
  if (post.deletedAt) throw new Error(`Post "${id}" is deleted.`)
  return post
}

/** Persist one edited post and confirm the write won the merge. */
async function writePost(post) {
  const all = await syncWrite([post])
  const stored = all.find(p => p.id === post.id)
  if (!stored || stored.updatedAt !== post.updatedAt) {
    throw new Error('Write was rejected by the last-write-wins merge (a newer copy exists). Re-read the post and retry.')
  }
  return stored
}

// ---------------------------------------------------------------------------
// Domain helpers (mirror the app's rules)
// ---------------------------------------------------------------------------

const now = () => new Date().toISOString()

/**
 * A stamp guaranteed strictly newer than the previous one, so an edit always
 * wins the strictly-newer-wins merge against the copy it was based on — and
 * writePost's equality check is then a sound success signal.
 */
function newerStamp(prevIso) {
  const prev = prevIso ? Date.parse(prevIso) : 0
  return new Date(Math.max(Date.now(), (Number.isFinite(prev) ? prev : 0) + 1)).toISOString()
}

const METRIC_KEYS = ['likes', 'comments', 'shares', 'impressions']

/** Keep only known metric fields with finite non-negative numeric values. */
function cleanMetrics(raw) {
  const out = {}
  for (const key of METRIC_KEYS) {
    const n = Number(raw?.[key])
    if (Number.isFinite(n) && n >= 0) out[key] = Math.round(n)
  }
  return out
}

function newId() {
  return `mcp-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

function isoOrThrow(value, field) {
  const d = new Date(value)
  if (isNaN(d.getTime())) throw new Error(`"${field}" is not a valid date: ${value}`)
  return d.toISOString()
}

function checkPlatforms(platforms) {
  if (!Array.isArray(platforms) || platforms.length === 0) throw new Error('platforms must be a non-empty array')
  const bad = platforms.filter(p => !PLATFORMS.includes(p))
  if (bad.length > 0) throw new Error(`Unknown platforms: ${bad.join(', ')}. Valid: ${PLATFORMS.join(', ')}`)
  return platforms
}

function engagementOf(post) {
  let sum = 0
  for (const m of Object.values(post.metrics ?? {})) {
    sum += (m?.likes ?? 0) + (m?.comments ?? 0) + (m?.shares ?? 0)
  }
  return sum
}

function summarize(post) {
  return {
    id: post.id,
    title: post.title || null,
    body: (post.body ?? '').length > 120 ? post.body.slice(0, 120) + '…' : post.body,
    status: post.status,
    platforms: post.platforms,
    scheduledFor: post.scheduledFor ?? null,
    postedAt: post.postedAt ?? null,
    tags: post.tags ?? [],
    recurrence: post.recurrence?.freq ?? null,
    engagement: post.status === 'posted' ? engagementOf(post) : null,
  }
}

/** The app spawns the next occurrence when a recurring post is completed; mirror that. */
function nextOccurrence(post) {
  if (!post.recurrence) return null
  const base = new Date(post.postedAt ?? post.scheduledFor ?? Date.now())
  if (isNaN(base.getTime())) return null
  const next = new Date(base)
  if (post.recurrence.freq === 'weekly') next.setDate(next.getDate() + 7)
  else if (post.recurrence.freq === 'biweekly') next.setDate(next.getDate() + 14)
  else next.setMonth(next.getMonth() + 1)
  const stamp = now()
  return {
    id: newId(),
    title: post.title,
    body: post.body,
    platforms: [...post.platforms],
    status: 'scheduled',
    createdAt: stamp,
    updatedAt: stamp,
    scheduledFor: next.toISOString(),
    tags: [...(post.tags ?? [])],
    notes: post.notes,
    variants: post.variants ? { ...post.variants } : undefined,
    recurrence: { ...post.recurrence },
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'list_posts',
    description:
      'List posts, newest first. Filter by status (idea|draft|scheduled|posted|canceled) and/or a search term matched against title, body, and tags. Returns compact summaries; use get_post for full detail.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: STATUSES, description: 'Only posts with this status' },
        search: { type: 'string', description: 'Case-insensitive term matched against title, body, and tags' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
      },
    },
    async run({ status, search, limit }) {
      const SCAN = 1000
      let path = `/rest/v1/posts?select=data&deleted=is.false&order=updated_at.desc&limit=${SCAN}`
      if (status) {
        if (!STATUSES.includes(status)) throw new Error(`Invalid status "${status}". Valid: ${STATUSES.join(', ')}`)
        path += `&status=eq.${status}`
      }
      const rows = await api(path)
      let posts = rows.map(r => r.data)
      if (search) {
        const needle = String(search).toLowerCase()
        posts = posts.filter(p =>
          `${p.title ?? ''} ${p.body ?? ''} ${(p.tags ?? []).join(' ')}`.toLowerCase().includes(needle),
        )
      }
      const cap = Math.min(Math.max(Number(limit) || 20, 1), 100)
      return {
        count: posts.length,
        showing: Math.min(cap, posts.length),
        ...(rows.length === SCAN ? { note: `search/count covered only the ${SCAN} most recently updated posts` } : {}),
        posts: posts.slice(0, cap).map(summarize),
      }
    },
  },
  {
    name: 'get_post',
    description: 'Fetch one post in full (body, variants, metrics, notes, everything) by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    async run({ id }) {
      return fetchPost(id)
    },
  },
  {
    name: 'create_draft',
    description:
      'Create a new post. Defaults to status "draft"; pass scheduledFor (ISO datetime) to create it scheduled instead. Platforms: x, instagram, threads, linkedin, facebook, tiktok, youtube. Keep X bodies within 280 characters (use variants for per-platform text).',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'The post text' },
        platforms: { type: 'array', items: { type: 'string', enum: PLATFORMS } },
        title: { type: 'string', description: 'Internal title (not published)' },
        tags: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string', description: 'Internal notes for the human reviewer' },
        scheduledFor: { type: 'string', description: 'ISO datetime; if set, the post is created as scheduled' },
        variants: {
          type: 'object',
          description: 'Optional per-platform text overrides, e.g. {"x": "short version"}',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['body', 'platforms'],
    },
    async run({ body, platforms, title, tags, notes, scheduledFor, variants }) {
      if (!body || !String(body).trim()) throw new Error('body must not be empty')
      checkPlatforms(platforms)
      const stamp = now()
      const post = {
        id: newId(),
        title: title ? String(title) : '',
        body: String(body),
        platforms,
        status: scheduledFor ? 'scheduled' : 'draft',
        createdAt: stamp,
        updatedAt: stamp,
        scheduledFor: scheduledFor ? isoOrThrow(scheduledFor, 'scheduledFor') : undefined,
        tags: Array.isArray(tags) ? tags.map(String) : [],
        notes: notes ? String(notes) : undefined,
        variants:
          variants && typeof variants === 'object'
            ? Object.fromEntries(Object.entries(variants).filter(([k, v]) => PLATFORMS.includes(k) && typeof v === 'string'))
            : undefined,
      }
      await writePost(post)
      return { created: summarize(post) }
    },
  },
  {
    name: 'update_post',
    description: 'Edit an existing post’s content fields (title, body, tags, notes, link, variants). Reads the latest copy first, so edits are merge-safe.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
        link: { type: 'string' },
        variants: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['id'],
    },
    async run({ id, title, body, tags, notes, link, variants }) {
      const post = await fetchPost(id)
      if (title !== undefined) post.title = String(title)
      if (body !== undefined) post.body = String(body)
      if (tags !== undefined) post.tags = Array.isArray(tags) ? tags.map(String) : post.tags
      if (notes !== undefined) post.notes = String(notes) || undefined
      if (link !== undefined) post.link = String(link) || undefined
      if (variants !== undefined && variants && typeof variants === 'object') {
        post.variants = Object.fromEntries(
          Object.entries(variants).filter(([k, v]) => PLATFORMS.includes(k) && typeof v === 'string' && v.trim()),
        )
        if (Object.keys(post.variants).length === 0) delete post.variants
      }
      post.updatedAt = newerStamp(post.updatedAt)
      await writePost(post)
      return { updated: summarize(post) }
    },
  },
  {
    name: 'schedule_post',
    description: 'Schedule a post (any non-posted status) for an ISO datetime. Use this to promote drafts and ideas onto the calendar.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        scheduledFor: { type: 'string', description: 'ISO datetime, e.g. 2026-09-01T09:00:00Z' },
      },
      required: ['id', 'scheduledFor'],
    },
    async run({ id, scheduledFor }) {
      const post = await fetchPost(id)
      if (post.status === 'posted') throw new Error('Post is already posted; scheduling it again is not allowed.')
      post.status = 'scheduled'
      post.scheduledFor = isoOrThrow(scheduledFor, 'scheduledFor')
      post.updatedAt = newerStamp(post.updatedAt)
      await writePost(post)
      return { scheduled: summarize(post) }
    },
  },
  {
    name: 'mark_posted',
    description:
      'Mark a post as published. Optionally record when (postedAt, default now) and initial per-platform metrics. If the post repeats, its next occurrence is created automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        postedAt: { type: 'string', description: 'ISO datetime (default: now)' },
        metrics: {
          type: 'object',
          description: 'Per-platform metrics, e.g. {"x": {"likes": 10, "comments": 2, "shares": 1, "impressions": 900}}',
          additionalProperties: { type: 'object' },
        },
      },
      required: ['id'],
    },
    async run({ id, postedAt, metrics }) {
      const post = await fetchPost(id)
      const wasPosted = post.status === 'posted'
      post.status = 'posted'
      post.postedAt = postedAt ? isoOrThrow(postedAt, 'postedAt') : (post.postedAt ?? post.scheduledFor ?? now())
      if (metrics && typeof metrics === 'object') {
        post.metrics = post.metrics ?? {}
        for (const [pl, m] of Object.entries(metrics)) {
          if (PLATFORMS.includes(pl) && m && typeof m === 'object') {
            post.metrics[pl] = { ...post.metrics[pl], ...cleanMetrics(m) }
          }
        }
      }
      post.updatedAt = newerStamp(post.updatedAt)
      const writes = [post]
      let spawned = null
      if (!wasPosted && post.recurrence) {
        spawned = nextOccurrence(post)
        delete post.recurrence
        if (spawned) writes.push(spawned)
      }
      const all = await syncWrite(writes)
      const stored = all.find(p => p.id === post.id)
      if (!stored || stored.updatedAt !== post.updatedAt) {
        throw new Error('Write was rejected by the last-write-wins merge (a newer copy exists). Re-read the post and retry.')
      }
      return { posted: summarize(post), nextOccurrence: spawned ? summarize(spawned) : null }
    },
  },
  {
    name: 'cancel_post',
    description: 'Cancel (deny/discard) a post — the editorial "no". Keeps it visible in the Canceled lane; prefer this over delete_post.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        reason: { type: 'string', description: 'Why it was canceled; appended to the post notes' },
      },
      required: ['id'],
    },
    async run({ id, reason }) {
      const post = await fetchPost(id)
      post.status = 'canceled'
      if (reason) post.notes = [post.notes, `Canceled: ${reason}`].filter(Boolean).join('\n')
      post.updatedAt = newerStamp(post.updatedAt)
      await writePost(post)
      return { canceled: summarize(post) }
    },
  },
  {
    name: 'log_metrics',
    description: 'Add or update engagement metrics (likes, comments, shares, impressions) for one platform on a posted post.',
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
      const post = await fetchPost(id)
      post.metrics = post.metrics ?? {}
      post.metrics[platform] = { ...post.metrics[platform], ...cleanMetrics({ likes, comments, shares, impressions }) }
      post.updatedAt = newerStamp(post.updatedAt)
      await writePost(post)
      return { updated: { id: post.id, metrics: post.metrics } }
    },
  },
  {
    name: 'delete_post',
    description: 'Soft-delete a post (tombstone). Reserved for true junk — for editorial rejection use cancel_post instead.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    async run({ id }) {
      const post = await fetchPost(id)
      post.deletedAt = now()
      post.updatedAt = newerStamp(post.updatedAt)
      await writePost(post)
      return { deleted: id }
    },
  },
  {
    name: 'get_stats',
    description: 'Pipeline overview: counts by status, what’s upcoming and overdue, when the last post went out, and 30-day output. Same numbers as the app’s dashboard.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const posts = (await api('/rest/v1/posts?select=data&deleted=is.false')).map(r => r.data)
      const nowMs = Date.now()
      const at = iso => (iso ? new Date(iso).getTime() : NaN)
      const of = status => posts.filter(p => p.status === status)
      const scheduled = of('scheduled')
      const upcoming = scheduled
        .filter(p => p.scheduledFor && at(p.scheduledFor) > nowMs)
        .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))
      const overdue = scheduled.filter(p => p.scheduledFor && at(p.scheduledFor) <= nowMs)
      const posted = of('posted')
        .filter(p => p.postedAt)
        .sort((a, b) => b.postedAt.localeCompare(a.postedAt))
      return {
        counts: {
          idea: of('idea').length,
          draft: of('draft').length,
          scheduled: scheduled.length,
          posted: posted.length,
          canceled: of('canceled').length,
        },
        upcoming: upcoming.slice(0, 3).map(summarize),
        overdue: overdue.map(summarize),
        unscheduled: scheduled.filter(p => !p.scheduledFor).length,
        lastPostedAt: posted[0]?.postedAt ?? null,
        postedLast30Days: posted.filter(p => nowMs - at(p.postedAt) < 30 * DAY).length,
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
        serverInfo: { name: 'drafter', version: '1.0.0' },
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
