// Scheduled hourly. For every user with push subscriptions or the email
// digest on: at their chosen local hour send the morning digest (overdue,
// due today, occasions, people due a catch-up), and every hour nudge about
// timed tasks that came due in the last hour. Email goes through Resend when
// RESEND_API_KEY is set. Tasks are the (single-owner) planner's tasks.

import { legacyPostToTask } from '../../shared/domain.mjs'
import { pushConfigured, sendToAll } from './push.mjs'

export const config = { schedule: '@hourly' }

const DAY = 86_400_000
const OPEN = ['todo', 'doing', 'blocked']

async function rest(path, init = {}) {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  if (!res.ok) throw new Error(`${path}: ${res.status}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

function localParts(date, tz) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(x => [x.type, x.value]))
    return { hour: Number(p.hour), day: `${p.year}-${p.month}-${p.day}` }
  } catch {
    return { hour: date.getUTCHours(), day: date.toISOString().slice(0, 10) }
  }
}

function dayKeyIn(iso, tz) {
  return localParts(new Date(iso), tz).day
}

function buildDigest(items, tz, now) {
  const tasks = items.filter(i => i.kind === 'task' && !i.deletedAt)
  const people = items.filter(i => i.kind === 'person' && !i.deletedAt)
  const today = localParts(now, tz).day
  const open = tasks.filter(t => OPEN.includes(t.status))
  const overdue = open.filter(t => t.dueAt && dayKeyIn(t.dueAt, tz) < today)
  const dueToday = open.filter(t => t.dueAt && dayKeyIn(t.dueAt, tz) === today)
  const nowMs = now.getTime()
  const peopleDue = people
    .map(p => {
      const last = tasks.filter(t => t.status === 'done' && t.completedAt && (t.peopleIds ?? []).includes(p.id)).map(t => t.completedAt).sort().pop()
      const days = last ? Math.floor((nowMs - Date.parse(last)) / DAY) : null
      return p.cadenceDays && days !== null && days > p.cadenceDays ? `${p.name} (${days}d)` : null
    })
    .filter(Boolean)
  const occasions = []
  for (const p of people) {
    for (const kind of ['birthday', 'anniversary']) {
      const m = (p[kind] ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
      if (!m) continue
      const [y, mo, d] = today.split('-').map(Number)
      let next = Date.UTC(y, Number(m[2]) - 1, Number(m[3]))
      if (next < Date.UTC(y, mo - 1, d)) next = Date.UTC(y + 1, Number(m[2]) - 1, Number(m[3]))
      const inDays = Math.round((next - Date.UTC(y, mo - 1, d)) / DAY)
      if (inDays <= 7) occasions.push(`${p.name}'s ${kind}${inDays === 0 ? ' today' : ` in ${inDays}d`}`)
    }
  }
  const lines = []
  if (overdue.length) lines.push(`${overdue.length} overdue: ${overdue.slice(0, 3).map(t => t.title).join(', ')}${overdue.length > 3 ? '…' : ''}`)
  if (dueToday.length) lines.push(`${dueToday.length} due today: ${dueToday.slice(0, 3).map(t => t.title).join(', ')}${dueToday.length > 3 ? '…' : ''}`)
  if (occasions.length) lines.push(`Occasions: ${occasions.join(', ')}`)
  if (peopleDue.length) lines.push(`Catch up with: ${peopleDue.join(', ')}`)
  return { overdue, dueToday, occasions, peopleDue, lines }
}

async function userEmail(userId) {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  const res = await fetch(`${url}/auth/v1/admin/users/${userId}`, { headers: { apikey: key, authorization: `Bearer ${key}` } })
  if (!res.ok) return null
  return (await res.json())?.email ?? null
}

async function sendEmail(to, subject, text) {
  if (!process.env.RESEND_API_KEY) return false
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: process.env.DIGEST_FROM || 'Drafter <onboarding@resend.dev>', to, subject, text }),
  })
  return res.ok
}

export default async () => {
  if (!process.env.SUPABASE_SERVICE_KEY) return new Response('not configured', { status: 200 })
  const now = new Date()
  const users = await rest('user_settings?select=*')
  const active = users.filter(u => (u.push_subscriptions?.length ?? 0) > 0 || u.digest_email)
  if (active.length === 0) return new Response('no subscribers', { status: 200 })

  const items = (await rest('posts?select=data&deleted=is.false')).map(r => legacyPostToTask(r.data))
  const site = process.env.URL || process.env.DEPLOY_PRIME_URL || ''
  let sent = 0
  for (const u of active) {
    const tz = u.timezone || 'UTC'
    const { hour, day } = localParts(now, tz)
    const subs = u.push_subscriptions ?? []
    const patch = {}

    // 1. morning digest, once per local day at the chosen hour
    const wantHour = Number.isInteger(u.digest_hour) ? u.digest_hour : 8
    if (hour === wantHour && u.last_digest_day !== day) {
      const digest = buildDigest(items, tz, now)
      if (digest.lines.length > 0) {
        if (subs.length && pushConfigured()) {
          const gone = await sendToAll(subs, { title: 'Good morning — today in Drafter', body: digest.lines.join('\n'), tag: 'digest', url: site ? `${site}/` : '/' })
          if (gone.length) patch.push_subscriptions = subs.filter(s => !gone.includes(s.endpoint))
          sent++
        }
        if (u.digest_email) {
          const email = await userEmail(u.user_id).catch(() => null)
          if (email) await sendEmail(email, `Today in Drafter: ${digest.dueToday.length} due, ${digest.overdue.length} overdue`, [...digest.lines, '', `Open Drafter: ${site}/`].join('\n'))
        }
      }
      patch.last_digest_day = day
    }

    // 2. timed tasks that came due in the last hour
    if (subs.length && pushConfigured()) {
      const due = items.filter(t => t.kind === 'task' && !t.deletedAt && OPEN.includes(t.status) && t.dueAt && Date.parse(t.dueAt) <= now.getTime() && Date.parse(t.dueAt) > now.getTime() - 3_600_000)
      for (const t of due.slice(0, 5)) {
        const gone = await sendToAll(patch.push_subscriptions ?? subs, { title: `Due now: ${t.title || 'Untitled task'}`, body: t.description ? t.description.slice(0, 120) : 'Open Drafter for the details.', tag: `due-${t.id}`, url: site ? `${site}/` : '/' })
        if (gone.length) patch.push_subscriptions = (patch.push_subscriptions ?? subs).filter(s => !gone.includes(s.endpoint))
        sent++
      }
    }
    if (Object.keys(patch).length) {
      await rest(`user_settings?user_id=eq.${u.user_id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify(patch) })
    }
  }
  return new Response(`sent ${sent}`, { status: 200 })
}
