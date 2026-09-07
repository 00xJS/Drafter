// Scheduled hourly. For every user with push subscriptions or the email digest
// on: at their chosen local hour send the morning digest (overdue, due today,
// occasions, people due a catch-up), and nudge about timed tasks that came due
// since the last check. Email goes through Resend when RESEND_API_KEY is set.
//
// Records are scoped per recipient exactly as the database policy scopes them:
// your own rows plus your household's (plus legacy unowned rows, which belong
// to the owner). The service key bypasses RLS, so that filtering happens here
// and must stay in step with public.household_user_ids().

import { legacyPostToTask } from '../../shared/domain.mjs'
import { pushConfigured, sendToAll } from './push.mjs'

export const config = { schedule: '@hourly' }

const DAY = 86_400_000
const HOUR = 3_600_000
/** Cap the catch-up window so an outage can't unleash a flood of stale nudges. */
const MAX_NUDGE_WINDOW = 6 * HOUR
const OPEN = ['todo', 'doing', 'blocked']

async function rest(path, init = {}) {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  if (!res.ok) throw new Error(`${path.split('?')[0]}: ${res.status}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

/** Local hour + calendar day for an instant. Never throws: an invalid date yields nulls. */
function localParts(date, tz) {
  const ms = date instanceof Date ? date.getTime() : Date.parse(date)
  if (!Number.isFinite(ms)) return { hour: null, day: null, weekday: null }
  try {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
        .formatToParts(new Date(ms))
        .map(x => [x.type, x.value]),
    )
    return { hour: Number(p.hour), day: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday ?? null }
  } catch {
    const d = new Date(ms)
    return { hour: d.getUTCHours(), day: d.toISOString().slice(0, 10), weekday: null }
  }
}

const dayKeyIn = (iso, tz) => localParts(iso, tz).day

function buildDigest(items, tz, now) {
  const tasks = items.filter(i => i.kind === 'task' && !i.deletedAt)
  const people = items.filter(i => i.kind === 'person' && !i.deletedAt)
  const today = localParts(now, tz).day
  const open = tasks.filter(t => OPEN.includes(t.status))
  // a task whose dueAt is unparseable yields a null day key and is simply skipped
  const overdue = open.filter(t => t.dueAt && dayKeyIn(t.dueAt, tz) && dayKeyIn(t.dueAt, tz) < today)
  const dueToday = open.filter(t => t.dueAt && dayKeyIn(t.dueAt, tz) === today)
  const nowMs = now.getTime()

  const peopleDue = people
    .map(p => {
      if (!p.cadenceDays) return null
      const last = tasks
        .filter(t => t.status === 'done' && t.completedAt && (t.peopleIds ?? []).includes(p.id))
        .map(t => Date.parse(t.completedAt))
        .filter(Number.isFinite)
        .sort((a, b) => b - a)[0]
      // never seen: surface them too, rather than hiding them forever
      if (last === undefined) return `${p.name} (no visit logged)`
      const days = Math.floor((nowMs - last) / DAY)
      return days > p.cadenceDays ? `${p.name} (${days}d)` : null
    })
    .filter(Boolean)

  const occasions = []
  const [ty, tm, td] = (today ?? '').split('-').map(Number)
  if (Number.isFinite(ty)) {
    for (const p of people) {
      for (const kind of ['birthday', 'anniversary']) {
        const m = (p[kind] ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
        if (!m) continue
        let next = Date.UTC(ty, Number(m[2]) - 1, Number(m[3]))
        if (next < Date.UTC(ty, tm - 1, td)) next = Date.UTC(ty + 1, Number(m[2]) - 1, Number(m[3]))
        const inDays = Math.round((next - Date.UTC(ty, tm - 1, td)) / DAY)
        if (inDays <= 7) occasions.push(`${p.name}'s ${kind}${inDays === 0 ? ' today' : ` in ${inDays}d`}`)
      }
    }
  }

  const lines = []
  if (overdue.length) lines.push(`${overdue.length} overdue: ${overdue.slice(0, 3).map(t => t.title).join(', ')}${overdue.length > 3 ? '…' : ''}`)
  if (dueToday.length) lines.push(`${dueToday.length} due today: ${dueToday.slice(0, 3).map(t => t.title).join(', ')}${dueToday.length > 3 ? '…' : ''}`)
  if (occasions.length) lines.push(`Occasions: ${occasions.join(', ')}`)
  if (peopleDue.length) lines.push(`Catch up with: ${peopleDue.slice(0, 3).join(', ')}${peopleDue.length > 3 ? `, +${peopleDue.length - 3} more` : ''}`)
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

/** userId -> the set of owner ids whose records that user may see (mirrors household_user_ids()). */
async function buildPeerMap() {
  const rows = await rest('household_members?select=household_id,user_id').catch(() => [])
  const byHousehold = new Map()
  for (const r of rows ?? []) {
    if (!byHousehold.has(r.household_id)) byHousehold.set(r.household_id, [])
    byHousehold.get(r.household_id).push(r.user_id)
  }
  const peers = new Map()
  for (const members of byHousehold.values()) {
    for (const uid of members) {
      const set = peers.get(uid) ?? new Set()
      for (const other of members) set.add(other)
      peers.set(uid, set)
    }
  }
  return peers
}

export default async () => {
  if (!process.env.SUPABASE_SERVICE_KEY) return new Response('not configured', { status: 200 })
  const now = new Date()
  const users = await rest('user_settings?select=*')
  const active = (users ?? []).filter(u => (u.push_subscriptions?.length ?? 0) > 0 || u.digest_email)
  if (active.length === 0) return new Response('no subscribers', { status: 200 })

  // keep row ownership so each recipient only ever sees their own scope
  const rows = await rest('posts?select=data,user_id&deleted=is.false')
  const [peers, ownerId] = await Promise.all([
    buildPeerMap(),
    rest('rpc/owner_user_id', { method: 'POST', body: '{}' }).catch(() => null),
  ])
  const site = process.env.URL || process.env.DEPLOY_PRIME_URL || ''
  let sent = 0
  const failures = []

  for (const u of active) {
    try {
      const visible = new Set([u.user_id, ...(peers.get(u.user_id) ?? [])])
      const items = (rows ?? [])
        .filter(r => visible.has(r.user_id) || (r.user_id === null && u.user_id === ownerId))
        .map(r => legacyPostToTask(r.data))

      const tz = u.timezone || 'UTC'
      const { hour, day, weekday } = localParts(now, tz)
      if (hour === null) continue
      const subs = u.push_subscriptions ?? []
      const patch = {}
      let liveSubs = subs

      // 1. morning digest — once per local day, at or after the chosen hour so a
      //    skipped or delayed run still delivers instead of silently dropping the day
      const wantHour = Number.isInteger(u.digest_hour) ? u.digest_hour : 8
      if (hour >= wantHour && u.last_digest_day !== day) {
        const digest = buildDigest(items, tz, now)
        // Sunday's digest is the doorway to the weekly review
        const sunday = weekday === 'Sun'
        if (sunday) digest.lines.push('Sunday: your weekly review is ready.')
        if (digest.lines.length > 0) {
          if (liveSubs.length && pushConfigured()) {
            const { gone, failed } = await sendToAll(liveSubs, { title: 'Good morning — today in Drafter', body: digest.lines.join('\n'), tag: 'digest', url: `${site || ''}/${sunday ? '?view=review' : ''}` })
            if (gone.length) liveSubs = liveSubs.filter(s => !gone.includes(s.endpoint))
            if (failed.length) failures.push(`digest ${u.user_id}: ${failed.map(f => f.statusCode).join(',')}`)
            sent += Math.max(0, liveSubs.length - failed.length)
          }
          if (u.digest_email) {
            const email = await userEmail(u.user_id).catch(() => null)
            if (email) await sendEmail(email, `Today in Drafter: ${digest.dueToday.length} due, ${digest.overdue.length} overdue`, [...digest.lines, '', `Open Drafter: ${site}/`].join('\n'))
          }
        }
        patch.last_digest_day = day
      }

      // 2. timed tasks that came due since the last check (watermarked, so a
      //    delayed or repeated invocation neither duplicates nor skips nudges)
      if (liveSubs.length && pushConfigured()) {
        const lastCheck = Date.parse(u.last_due_check ?? '')
        const from = Math.max(Number.isFinite(lastCheck) ? lastCheck : now.getTime() - HOUR, now.getTime() - MAX_NUDGE_WINDOW)
        const due = items.filter(t => {
          if (t.kind !== 'task' || t.deletedAt || !OPEN.includes(t.status) || !t.dueAt) return false
          const at = Date.parse(t.dueAt)
          return Number.isFinite(at) && at <= now.getTime() && at > from
        })
        for (const t of due.slice(0, 5)) {
          const { gone, failed } = await sendToAll(liveSubs, { title: `Due now: ${t.title || 'Untitled task'}`, body: t.description ? t.description.slice(0, 120) : 'Open Drafter for the details.', tag: `due-${t.id}`, url: `${site || ''}/?task=${encodeURIComponent(t.id)}` })
          if (gone.length) liveSubs = liveSubs.filter(s => !gone.includes(s.endpoint))
          if (failed.length) failures.push(`nudge ${u.user_id}: ${failed.map(f => f.statusCode).join(',')}`)
          sent += Math.max(0, liveSubs.length - failed.length)
        }
        patch.last_due_check = now.toISOString()
      }

      if (liveSubs !== subs) patch.push_subscriptions = liveSubs
      if (Object.keys(patch).length) {
        await rest(`user_settings?user_id=eq.${encodeURIComponent(u.user_id)}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify(patch) })
      }
    } catch (e) {
      // one user's failure must never cost everyone else their digest
      failures.push(`${u.user_id}: ${e?.message ?? e}`)
    }
  }
  const report = `sent ${sent}${failures.length ? `; ${failures.length} failure(s): ${failures.slice(0, 5).join(' | ')}` : ''}`
  if (failures.length) console.error('digest:', report)
  return new Response(report, { status: 200 })
}
