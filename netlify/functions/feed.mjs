// Outbound calendar feed, per user: /api/feed.ics?token=… serves open tasks,
// project targets and milestones as an iCalendar feed that Google Calendar /
// Apple Calendar subscribe to. Calendar clients can't carry a session, so
// each user gets their own random feed token, kept in user_settings (service
// role only) and shown once in Settings. POST { action: enable|rotate|disable }
// manages it; GET without a token reports status for the signed-in user.

import { withCors } from './lib/cors.mjs'
import { buildICS } from '../../shared/ics.mjs'
import { legacyPostToTask } from '../../shared/domain.mjs'
import { getUser, settingsFind, settingsGet, settingsSet, settingsStoreConfigured } from './lib/session.mjs'
import { randomToken } from './lib/google.mjs'

const OPEN = ['todo', 'doing', 'blocked']
const DAY = 86_400_000

function hasClock(iso) {
  const d = new Date(iso)
  return d.getUTCHours() + d.getUTCMinutes() > 0
}

function serviceHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY
  return { apikey: key, authorization: `Bearer ${key}` }
}

const baseUrl = () => process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL

/** The owner ids a user may see: themselves plus their household (mirrors household_user_ids()). */
async function visibleOwnerIds(userId) {
  const ids = new Set([userId])
  try {
    const mine = await fetch(`${baseUrl()}/rest/v1/household_members?user_id=eq.${encodeURIComponent(userId)}&select=household_id`, { headers: serviceHeaders() })
    const rows = mine.ok ? await mine.json() : []
    for (const r of rows) {
      const peers = await fetch(`${baseUrl()}/rest/v1/household_members?household_id=eq.${encodeURIComponent(r.household_id)}&select=user_id`, { headers: serviceHeaders() })
      if (peers.ok) for (const p of await peers.json()) ids.add(p.user_id)
    }
  } catch {
    /* a household lookup failure must not widen the scope — fall through with just the user */
  }
  return [...ids]
}

/**
 * The feed reads with the service key, which bypasses RLS, so the owner filter
 * MUST be applied here: without it one feed token would dump every user's
 * tasks. Scope is the token's owner plus their household, matching the app.
 */
async function loadItems(ownerIds) {
  if (!ownerIds.length) return []
  const list = ownerIds.map(id => `"${id}"`).join(',')
  const res = await fetch(`${baseUrl()}/rest/v1/posts?select=data&deleted=is.false&user_id=in.(${encodeURIComponent(list)})`, { headers: serviceHeaders() })
  if (!res.ok) throw new Error(`Supabase ${res.status}`)
  return (await res.json()).map(r => legacyPostToTask(r.data))
}

function feedFor(items, site) {
  const projects = new Map(items.filter(i => i.kind === 'project').map(p => [p.id, p]))
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
  return feed
}

const feedUrl = (origin, token) => `${origin}/api/feed.ics?token=${encodeURIComponent(token)}`

const handler = async req => {
  const url = new URL(req.url)
  const token = url.searchParams.get('token')

  // calendar client fetching a feed
  if (req.method === 'GET' && token) {
    if (!settingsStoreConfigured()) return new Response('Not found', { status: 404 })
    const row = await settingsFind('feed_token', token).catch(() => null)
    if (!row) return new Response('Not found', { status: 404 })
    let items
    try {
      items = await loadItems(await visibleOwnerIds(row.user_id))
    } catch (e) {
      return new Response(`feed unavailable: ${e?.message ?? e}`, { status: 502 })
    }
    return new Response(buildICS('Drafter', feedFor(items, url.origin)), {
      headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'private, max-age=300', 'content-disposition': 'inline; filename="drafter.ics"' },
    })
  }

  if (req.method !== 'GET' && req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const { user, response, unconfigured } = await getUser(req)
  if (response) return response
  const configured = settingsStoreConfigured() && !unconfigured && !!user
  if (!configured) return Response.json({ configured: false, enabled: false, url: null, missing: [!settingsStoreConfigured() ? 'SUPABASE_SERVICE_KEY' : 'a signed-in account'] })

  try {
    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      if (body.action === 'enable' || body.action === 'rotate') {
        const current = await settingsGet(user.id)
        const feedToken = body.action === 'rotate' || !current?.feed_token ? randomToken(24) : current.feed_token
        await settingsSet(user.id, { feed_token: feedToken })
        return Response.json({ configured: true, enabled: true, url: feedUrl(url.origin, feedToken), missing: [] })
      }
      if (body.action === 'inbound-enable' || body.action === 'inbound-rotate') {
        const current = await settingsGet(user.id)
        const tok = body.action === 'inbound-rotate' || !current?.inbound_token ? randomToken(24) : current.inbound_token
        await settingsSet(user.id, { inbound_token: tok })
        return Response.json({ inboundUrl: `${url.origin}/api/inbound?key=${encodeURIComponent(tok)}` })
      }
      if (body.action === 'inbound-disable') {
        await settingsSet(user.id, { inbound_token: null })
        return Response.json({ inboundUrl: null })
      }
      if (body.action === 'disable') {
        await settingsSet(user.id, { feed_token: null })
        return Response.json({ configured: true, enabled: false, url: null, missing: [] })
      }
      return Response.json({ error: 'unknown action' }, { status: 400 })
    }
    const s = await settingsGet(user.id)
    return Response.json({
      configured: true,
      enabled: !!s?.feed_token,
      url: s?.feed_token ? feedUrl(url.origin, s.feed_token) : null,
      inboundUrl: s?.inbound_token ? `${url.origin}/api/inbound?key=${encodeURIComponent(s.inbound_token)}` : null,
      missing: [],
    })
  } catch (e) {
    return Response.json({ error: e?.message ?? 'settings unavailable' }, { status: e?.status === 501 ? 501 : 502 })
  }
}

export default withCors(handler)
