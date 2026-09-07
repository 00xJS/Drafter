// Email-in: a per-user webhook that turns an email into a task.
//   POST /api/inbound?key=<inbound_token>
// Accepts Mailgun Routes (form: subject, body-plain, sender), SendGrid Inbound
// Parse (multipart: subject, text, from), Cloudflare Email Workers / Zapier /
// Make (JSON: { subject, text, from }). The token is the only auth, so it is
// long, per user, and rotatable from Settings.

import { newerStamp } from '../../shared/domain.mjs'
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
    body: JSON.stringify({ incoming: [task] }),
  })
  if (!res.ok) return new Response('store failed', { status: 502 })
  return Response.json({ ok: true, id: task.id, title })
}
