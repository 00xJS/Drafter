// Outbound calendar feed: /api/feed.ics?token=… serves open tasks, project
// targets and milestones as an iCalendar feed that Google Calendar / Apple
// Calendar can subscribe to. Calendar clients can't carry a session, so the
// feed is protected by CALENDAR_FEED_TOKEN (any long random string) and reads
// the database with SUPABASE_SERVICE_KEY — both set on the host, never in the
// browser. Without ?token, a signed-in session gets the subscribe URL as JSON.

import { timingSafeEqual } from 'node:crypto'
import { buildICS } from '../../shared/ics.mjs'
import { legacyPostToTask } from '../../shared/domain.mjs'

const OPEN = ['todo', 'doing', 'blocked']
const DAY = 86_400_000

function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

function hasClock(iso) {
  const d = new Date(iso)
  return d.getUTCHours() + d.getUTCMinutes() > 0
}

async function loadItems(supabaseUrl, serviceKey) {
  const res = await fetch(`${supabaseUrl}/rest/v1/posts?select=data&deleted=is.false`, {
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
  })
  if (!res.ok) throw new Error(`Supabase ${res.status}`)
  return (await res.json()).map(r => legacyPostToTask(r.data))
}

export default async req => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
  const url = new URL(req.url)
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY
  const feedToken = process.env.CALENDAR_FEED_TOKEN
  const serviceKey = process.env.SUPABASE_SERVICE_KEY
  const configured = !!(feedToken && feedToken.length >= 16 && serviceKey && supabaseUrl)
  const token = url.searchParams.get('token')

  if (!token) {
    // signed-in app asking where to subscribe
    if (supabaseUrl && anonKey) {
      const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
      if (!bearer) return Response.json({ error: 'sign in required' }, { status: 401 })
      const check = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: anonKey, authorization: `Bearer ${bearer}` } })
      if (!check.ok) return Response.json({ error: 'invalid session' }, { status: 401 })
    }
    return Response.json({
      configured,
      url: configured ? `${url.origin}/api/feed.ics?token=${encodeURIComponent(feedToken)}` : null,
      missing: [!feedToken || feedToken.length < 16 ? 'CALENDAR_FEED_TOKEN (16+ characters)' : null, !serviceKey ? 'SUPABASE_SERVICE_KEY' : null].filter(Boolean),
    })
  }

  if (!configured || !safeEqual(token, feedToken)) return new Response('Not found', { status: 404 })

  let items
  try {
    items = await loadItems(supabaseUrl, serviceKey)
  } catch (e) {
    return new Response(`feed unavailable: ${e?.message ?? e}`, { status: 502 })
  }
  const projects = new Map(items.filter(i => i.kind === 'project').map(p => [p.id, p]))
  const site = url.origin
  const feed = []
  const cutoff = Date.now() - 30 * DAY
  for (const t of items) {
    if (t.kind !== 'task' || !t.dueAt) continue
    const isOpen = OPEN.includes(t.status)
    const recentlyDone = t.status === 'done' && t.completedAt && Date.parse(t.completedAt) > cutoff
    if (!isOpen && !recentlyDone) continue
    const project = t.projectId ? projects.get(t.projectId) : null
    const start = Date.parse(t.dueAt)
    const prefix = t.status === 'done' ? '✓ ' : t.priority === 'urgent' ? '‼ ' : t.priority === 'high' ? '▲ ' : ''
    feed.push({
      uid: `task-${t.id}@drafter`,
      title: `${prefix}${t.title || 'Untitled task'}${project ? ` · ${project.name}` : ''}`,
      start,
      end: hasClock(t.dueAt) ? start + 3_600_000 : undefined,
      allDay: !hasClock(t.dueAt),
      description: [t.description, t.checklist?.length ? `Checklist: ${t.checklist.filter(c => c.done).length}/${t.checklist.length}` : '', `Status: ${t.status} · Priority: ${t.priority}`]
        .filter(Boolean)
        .join('\n\n'),
      url: site,
      categories: [project?.name, ...(t.tags ?? [])].filter(Boolean),
    })
  }
  for (const p of projects.values()) {
    if (p.status === 'archived' || p.status === 'done') continue
    if (p.targetAt) feed.push({ uid: `project-${p.id}@drafter`, title: `🎯 ${p.name} target`, start: Date.parse(p.targetAt), allDay: true, description: p.description, url: site, categories: [p.name] })
    for (const m of p.milestones ?? []) {
      if (!m.dueAt) continue
      feed.push({ uid: `milestone-${p.id}-${m.id}@drafter`, title: `${m.done ? '✓' : '◆'} ${m.name} · ${p.name}`, start: Date.parse(m.dueAt), allDay: true, url: site, categories: [p.name] })
    }
  }
  return new Response(buildICS('Drafter', feed), {
    headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'private, max-age=300', 'content-disposition': 'inline; filename="drafter.ics"' },
  })
}
