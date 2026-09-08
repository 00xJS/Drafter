// Email-in: a per-user webhook that turns an email into a task.
//   POST /api/inbound?key=<inbound_token>
// Accepts Mailgun Routes (form: subject, body-plain, sender), SendGrid Inbound
// Parse (multipart: subject, text, from), Cloudflare Email Workers / Zapier /
// Make (JSON: { subject, text, from }). The token is the only auth, so it is
// long, per user, and rotatable from Settings.
//
// After the raw task is safely stored, a best-effort AI second pass may refine
// title / due / priority / tags without blocking the webhook.

import { newerStamp } from '../../shared/domain.mjs'
import { complete, resolveProvider } from './lib/ai.mjs'
import { settingsFind, settingsStoreConfigured } from './lib/session.mjs'

const MAX_BODY = 4000

async function parseBody(req) {
  const type = req.headers.get('content-type') ?? ''
  if (type.includes('application/json')) {
    const j = await req.json().catch(() => ({}))
    return { subject: j.subject ?? j.Subject ?? '', text: j.text ?? j['body-plain'] ?? j.body ?? j.plain ?? '', from: j.from ?? j.sender ?? j.From ?? '' }
  }
  if (type.includes('multipart/form-data') || type.includes('application/x-www-form-urlencoded')) {
    const form = await req.formData().catch(() => null)
    const get = k => (form?.get(k) ?? '').toString()
    return { subject: get('subject') || get('Subject'), text: get('body-plain') || get('text') || get('stripped-text') || get('plain'), from: get('sender') || get('from') || get('From') }
  }
  const text = await req.text().catch(() => '')
  return { subject: '', text, from: '' }
}

async function triageTask(task, { subject, text, from }) {
  if (!resolveProvider()) return null
  const ai = await complete({
    system:
      'You triage personal email into a single planner task. Respond with ONLY a JSON object: {"title":"short imperative under 80 chars","dueAt":"ISO datetime or null","priority":"low|normal|high|urgent","projectHint":"short name or null","tags":["optional"]}. Prefer a concrete due when the email mentions a day or time; otherwise null. Never invent facts.',
    prompt: `From: ${from || '(unknown)'}\nSubject: ${subject || '(none)'}\n\n${text.slice(0, 2500)}\n\nCurrent title: ${task.title}`,
    maxTokens: 400,
    json: true,
  })
  if (ai.error || !ai.text) return null
  let raw
  try {
    raw = JSON.parse(ai.text.replace(/^```json\s*|\s*```$/g, '').trim())
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const patch = {}
  const title = String(raw.title ?? '').trim().slice(0, 140)
  if (title) patch.title = title
  const due = raw.dueAt ? Date.parse(raw.dueAt) : NaN
  if (Number.isFinite(due)) patch.dueAt = new Date(due).toISOString()
  if (['low', 'normal', 'high', 'urgent'].includes(raw.priority)) patch.priority = raw.priority
  const tags = Array.isArray(raw.tags) ? raw.tags.map(String).filter(Boolean).slice(0, 6) : []
  if (tags.length) patch.tags = [...new Set([...(task.tags ?? []), ...tags])]
  return Object.keys(patch).length ? patch : null
}

export default async req => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  if (!settingsStoreConfigured()) return new Response('Not configured', { status: 501 })
  const url = new URL(req.url)
  const key = url.searchParams.get('key') ?? ''
  if (key.length < 16) return new Response('Not found', { status: 404 })
  const row = await settingsFind('inbound_token', key).catch(() => null)
  if (!row) return new Response('Not found', { status: 404 })

  const { subject, text, from } = await parseBody(req)
  const title = (subject || text.split('\n').find(l => l.trim()) || 'Email').toString().replace(/^(re|fwd?):\s*/i, '').trim().slice(0, 140)
  const body = text.toString().replace(/\r\n/g, '\n').trim().slice(0, MAX_BODY)
  const link = (body.match(/https?:\/\/\S+/) ?? [])[0]
  const stamp = new Date().toISOString()
  const task = {
    kind: 'task',
    id: `mail-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    description: body,
    status: 'todo',
    priority: 'normal',
    createdAt: stamp,
    updatedAt: newerStamp(),
    tags: ['email'],
    notes: from ? `From: ${from}` : undefined,
    link,
  }
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_KEY
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/sync_posts`, {
    method: 'POST',
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' },
    // a future cursor means the RPC returns nothing: without it every inbound
    // email makes Postgres aggregate the entire table into one json document
    body: JSON.stringify({ incoming: [task], since: new Date(Date.now() + 86_400_000).toISOString() }),
  })
  if (!res.ok) return new Response('store failed', { status: 502 })
  // sync_posts runs under the service key, so auth.uid() is null and the row
  // would otherwise be attributed to the site owner. Re-point it at whoever
  // owns this inbound token. (The LWW trigger allows this: data is unchanged.)
  await fetch(`${supabaseUrl}/rest/v1/posts?id=eq.${encodeURIComponent(task.id)}`, {
    method: 'PATCH',
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: row.user_id }),
  }).catch(() => {})

  // Second pass: refine title/due after the raw task is safely stored.
  let triaged = false
  try {
    const patch = await triageTask(task, { subject, text: body, from })
    if (patch) {
      const next = { ...task, ...patch, updatedAt: newerStamp(task.updatedAt) }
      const up = await fetch(`${supabaseUrl}/rest/v1/rpc/sync_posts`, {
        method: 'POST',
        headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ incoming: [next], since: new Date(Date.now() + 86_400_000).toISOString() }),
      })
      if (up.ok) {
        await fetch(`${supabaseUrl}/rest/v1/posts?id=eq.${encodeURIComponent(task.id)}`, {
          method: 'PATCH',
          headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json', prefer: 'return=minimal' },
          body: JSON.stringify({ user_id: row.user_id }),
        }).catch(() => {})
        triaged = true
        Object.assign(task, patch)
      }
    }
  } catch {
    /* triage is best-effort */
  }

  return Response.json({ ok: true, id: task.id, title: task.title, triaged })
}
