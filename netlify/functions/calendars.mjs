// Inbound calendar overlay: the app posts the ICS subscription URLs it manages
// (Google "secret address", iCloud share link, any webcal feed) and gets back
// concrete event instances for a window. Fetching happens here because the
// calendar hosts don't send CORS headers. Session-gated like every function.

import { withCors } from './lib/cors.mjs'
import { expandEvents, parseICS } from '../../shared/ics.mjs'
import { listEvents, toEvent } from './lib/google.mjs'
import { isOwnDrafterCalendar, listAccounts as msListAccounts, listEvents as msListEvents, toEvent as msToEvent } from './lib/microsoft.mjs'
import { getUser } from './lib/session.mjs'

const MAX_SOURCES = 12
const MAX_BYTES = 4 * 1024 * 1024
const DAY = 86_400_000

function normalizeUrl(raw) {
  let u
  try {
    u = new URL(String(raw).trim().replace(/^webcal:\/\//i, 'https://'))
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  // never let the browser point this proxy at private hosts
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[::1\])/.test(u.hostname)) return null
  return u.toString()
}

async function fetchICS(url) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 12_000)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'text/calendar, text/plain, */*', 'user-agent': 'drafter-planner' }, redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > MAX_BYTES) throw new Error('calendar is too large (4 MB max)')
    const text = await res.text()
    if (text.length > MAX_BYTES) throw new Error('calendar is too large (4 MB max)')
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('not an iCalendar (.ics) feed')
    return text
  } finally {
    clearTimeout(t)
  }
}

const handler = async req => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const { user, response } = await getUser(req)
  if (response) return response

  let body
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 })
  }
  const all = Array.isArray(body?.sources) ? body.sources : []
  const sources = all.slice(0, MAX_SOURCES)
  const now = Date.now()
  const from = Number.isFinite(Date.parse(body?.from)) ? Date.parse(body.from) : now - 60 * DAY
  const to = Number.isFinite(Date.parse(body?.to)) ? Date.parse(body.to) : now + 400 * DAY

  const events = []
  const errors = {}
  // Anything past the cap used to vanish and read as "0 events" in Settings.
  // Name it instead: all three Settings lists already show errors[id].
  for (const s of all.slice(MAX_SOURCES)) {
    if (s && s.id) errors[String(s.id)] = `Only ${MAX_SOURCES} calendars can be shown at once. Untick another to see this one.`
  }
  const names = {}
  // read once, and only when an Outlook calendar is asked for
  let msAccounts = null
  const outlookAccounts = () => (msAccounts ??= msListAccounts(user.id).catch(() => []))
  await Promise.all(
    sources.map(async src => {
      const id = String(src?.id ?? '')
      if (!id) return
      const raw = String(src?.url ?? '')
      if (raw.startsWith('ms:')) {
        // ms:<accountId>:<calendarId>
        const rest = raw.slice(3)
        const sep = rest.indexOf(':')
        const accountId = sep === -1 ? '' : rest.slice(0, sep)
        const calendarId = sep === -1 ? '' : rest.slice(sep + 1)
        if (!accountId || !calendarId) return
        if (!user) {
          errors[id] = 'Outlook calendars need a signed-in account'
          return
        }
        // The account's own Drafter calendar holds Drafter's mirrored entries,
        // which the grid already draws from Drafter itself: overlaid, every one
        // showed twice. Settings no longer offers it; one ticked before is
        // refused here with a reason rather than drawn.
        if (isOwnDrafterCalendar((await outlookAccounts()).find(a => a.id === accountId), calendarId)) {
          errors[id] = 'This is Drafter’s own calendar in Outlook: its entries already show here, so it is not overlaid. Untick it.'
          return
        }
        try {
          for (const item of await msListEvents(user.id, accountId, calendarId, new Date(from).toISOString(), new Date(to).toISOString())) {
            const ev = msToEvent(item, id)
            if (ev) events.push(ev)
          }
        } catch (e) {
          errors[id] = e?.message ?? 'Outlook fetch failed'
        }
        return
      }
      if (raw.startsWith('google:')) {
        const calendarId = raw.slice('google:'.length)
        if (!calendarId || calendarId === 'push') return
        if (!user) {
          errors[id] = 'Google calendars need a signed-in account'
          return
        }
        try {
          for (const item of await listEvents(user.id, calendarId, new Date(from).toISOString(), new Date(to).toISOString())) {
            const ev = toEvent(item, id)
            if (ev) events.push(ev)
          }
        } catch (e) {
          errors[id] = e?.message ?? 'Google fetch failed'
        }
        return
      }
      const url = normalizeUrl(raw)
      if (!url) {
        errors[id] = 'not a valid https:// or webcal:// address'
        return
      }
      try {
        const parsed = parseICS(await fetchICS(url))
        if (parsed.calendarName) names[id] = parsed.calendarName
        for (const ev of expandEvents(parsed, from, to)) events.push({ ...ev, sourceId: id })
      } catch (e) {
        errors[id] = e?.name === 'AbortError' ? 'timed out fetching the calendar' : (e?.message ?? 'fetch failed')
      }
    }),
  )
  events.sort((a, b) => a.start.localeCompare(b.start))
  return Response.json({ events, errors, names, fetchedAt: new Date(now).toISOString() })
}

export default withCors(handler)
