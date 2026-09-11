// Outbound calendar feed, per user: /api/feed.ics?token=… serves open tasks,
// project targets and milestones as an iCalendar feed that Google Calendar /
// Apple Calendar subscribe to. Calendar clients can't carry a session, so
// each user gets their own random feed token, kept in user_settings (service
// role only) and shown once in Settings. POST { action: enable|rotate|disable }
// manages it; GET without a token reports status for the signed-in user.

import { withCors } from './lib/cors.mjs'
import { buildICS } from '../../shared/ics.mjs'
import { isMineTask, isUntimed, legacyPostToTask, localDate } from '../../shared/domain.mjs'
import { getUser, settingsFind, settingsGet, settingsSet, settingsStoreConfigured } from './lib/session.mjs'
import { randomToken } from './lib/google.mjs'

const OPEN = ['todo', 'doing', 'blocked']
const DAY = 86_400_000

/** The day before a YYYY-MM-DD key. UTC arithmetic: a date key carries no time, so no DST applies. */
function prevDayKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''))
  if (!m) return undefined
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

export function feedFor(items, site, tz, myId) {
  const projects = new Map(items.filter(i => i.kind === 'project').map(p => [p.id, p]))
  const feed = []
  const cutoff = Date.now() - 30 * DAY
  for (const t of items) {
    if (t.kind !== 'task' || !t.dueAt) continue
    if (!isMineTask(t, myId)) continue
    const isOpen = OPEN.includes(t.status)
    const recentlyDone = t.status === 'done' && t.completedAt && Date.parse(t.completedAt) > cutoff
    if (!isOpen && !recentlyDone) continue
    const project = t.projectId ? projects.get(t.projectId) : null
    const start = Date.parse(t.dueAt)
    const timed = !isUntimed(t.dueAt, tz)
    const prefix = t.status === 'done' ? '✓ ' : t.priority === 'urgent' ? '‼ ' : t.priority === 'high' ? '▲ ' : ''
    feed.push({
      uid: `task-${t.id}@drafter`,
      title: `${prefix}${t.title || 'Untitled task'}${project ? ` · ${project.name}` : ''}`,
      start,
      end: timed ? start + 3_600_000 : undefined,
      allDay: !timed,
      // the reader's own calendar day, not the UTC one: an untimed task is
      // stored at local midnight, which is the previous day in UTC all summer
      date: timed ? undefined : localDate(t.dueAt, tz),
      description: [t.description, t.checklist?.length ? `Checklist: ${t.checklist.filter(c => c.done).length}/${t.checklist.length}` : '', `Status: ${t.status} · Priority: ${t.priority}`]
        .filter(Boolean)
        .join('\n\n'),
      url: site,
      categories: [project?.name, ...(t.tags ?? [])].filter(Boolean),
    })
  }
  for (const p of projects.values()) {
    if (p.status === 'archived' || p.status === 'done') continue
    if (p.ownerId && myId && p.ownerId !== myId) continue
    if (p.targetAt) feed.push({ uid: `project-${p.id}@drafter`, title: `🎯 ${p.name} target`, start: Date.parse(p.targetAt), allDay: true, date: localDate(p.targetAt, tz), description: p.description, url: site, categories: [p.name] })
    for (const m of p.milestones ?? []) {
      if (!m.dueAt) continue
      feed.push({ uid: `milestone-${p.id}-${m.id}@drafter`, title: `${m.done ? '✓' : '◆'} ${m.name} · ${p.name}`, start: Date.parse(m.dueAt), allDay: true, date: localDate(m.dueAt, tz), url: site, categories: [p.name] })
    }
  }
  // Entries the user wrote themselves. These are the only rows in the feed with
  // a real duration — everything else marks a moment — so they are the ones a
  // subscribed calendar can show as busy.
  for (const e of items) {
    if (e.kind !== 'event' || e.deletedAt || !e.start) continue
    if (e.ownerId && myId && e.ownerId !== myId) continue
    feed.push({
      uid: `event-${e.id}@drafter`,
      title: e.title || 'Untitled event',
      start: Date.parse(e.allDay ? `${e.start}T12:00:00Z` : e.start),
      end: e.allDay ? undefined : Date.parse(e.end),
      allDay: !!e.allDay,
      // all-day rows carry their day keys straight through: they are already
      // the reader's own calendar days, so nothing needs converting
      date: e.allDay ? e.start : undefined,
      // stored end is EXCLUSIVE (the ICS convention); buildICS wants the last
      // day INCLUSIVE and re-adds the day itself, so step back one
      endDate: e.allDay ? prevDayKey(e.end) : undefined,
      description: e.notes,
      url: site,
    })
  }
  return feed
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
/** The row's owner, as the app would see it. Exported for the tests. */
export function withOwner(item, userId) {
  return item && typeof item === 'object' && userId ? { ...item, ownerId: userId } : item
}

async function loadItems(ownerIds) {
  if (!ownerIds.length) return []
  const list = ownerIds.map(id => `"${id}"`).join(',')
  // user_id comes back beside data on purpose. sync_posts strips `ownerId`
  // before storing and only re-adds it on the way back to a signed-in client,
  // so a row read straight from the table carries no owner at all — and every
  // "only mine" filter in feedFor silently passed a household peer's events,
  // project targets and unassigned tasks into this user's calendar.
  const res = await fetch(`${baseUrl()}/rest/v1/posts?select=data,user_id&deleted=is.false&user_id=in.(${encodeURIComponent(list)})`, { headers: serviceHeaders() })
  if (!res.ok) throw new Error(`Supabase ${res.status}`)
  return (await res.json()).map(r => withOwner(legacyPostToTask(r.data), r.user_id))
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
    const tz = row.timezone ?? undefined
    return new Response(buildICS('Drafter', feedFor(items, url.origin, tz, row.user_id)), {
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
