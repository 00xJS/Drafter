// Inbound calendar overlay: the app posts the ICS subscription URLs it manages
// (Google "secret address", iCloud share link, any webcal feed) and gets back
// concrete event instances for a window. Fetching happens here because the
// calendar hosts don't send CORS headers. Session-gated like every function.

import { expandEvents, parseICS } from '../../shared/ics.mjs'

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

export default async req => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY
  if (supabaseUrl && anonKey) {
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!token) return Response.json({ error: 'sign in required' }, { status: 401 })
    const check = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: anonKey, authorization: `Bearer ${token}` } })
    if (!check.ok) return Response.json({ error: 'invalid session' }, { status: 401 })
  }

  let body
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 })
  }
  const sources = Array.isArray(body?.sources) ? body.sources.slice(0, MAX_SOURCES) : []
  const now = Date.now()
  const from = Number.isFinite(Date.parse(body?.from)) ? Date.parse(body.from) : now - 60 * DAY
  const to = Number.isFinite(Date.parse(body?.to)) ? Date.parse(body.to) : now + 400 * DAY

  const events = []
  const errors = {}
  const names = {}
  await Promise.all(
    sources.map(async src => {
      const id = String(src?.id ?? '')
      const url = normalizeUrl(src?.url)
      if (!id) return
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
