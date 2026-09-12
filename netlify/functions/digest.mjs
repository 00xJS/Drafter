// Scheduled hourly. For every user with push subscriptions or the email digest
// on: at their chosen local hour send the morning digest (overdue, due today,
// occasions, people due a catch-up), and nudge about timed tasks that came due
// since the last check. Email goes through Resend when RESEND_API_KEY is set.
//
// Records are scoped per recipient exactly as the database policy scopes them:
// your own rows plus your household's (plus legacy unowned rows, which belong
// to the owner). The service key bypasses RLS, so that filtering happens here
// and must stay in step with public.household_user_ids().

import { newerStamp } from '../../shared/domain.mjs'
import { buildDigest, localParts, visibleItemsFor } from '../../shared/digest.mjs'
import { entriesBetween, journalLines, peopleNameMap } from '../../shared/journal.mjs'
import { complete, resolveProvider } from './lib/ai.mjs'
import { previousWeekIn } from './lib/reviewweek.mjs'
import { pushConfigured, sendToAll } from './push.mjs'

export const config = { schedule: '@hourly' }

const DAY = 86_400_000
const HOUR = 3_600_000
/** Cap the catch-up window so an outage can't unleash a flood of stale nudges. */
const MAX_NUDGE_WINDOW = 6 * HOUR
const OPEN = ['todo', 'doing', 'blocked']
const TOMBSTONE_TTL_MS = 90 * DAY

async function rest(path, init = {}) {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  if (!res.ok) throw new Error(`${path.split('?')[0]}: ${res.status}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

/**
 * Draft a weekly review summary into posts when the owner hasn't written one.
 * Never clobbers reflections or an existing summary. `opts.timezone` is the
 * reader's zone, which decides what "last week" is (lib/reviewweek.mjs).
 */
export async function upsertSundayReview(userId, items, now = new Date(), opts = {}) {
  if (!resolveProvider()) return null
  const meta = previousWeekIn(now, opts.timezone)
  // reviews are personal: only this user's row counts, never a household peer's for the same week
  const existing = (items ?? []).find(i => i.kind === 'review' && i.period === 'week' && i.key === meta.key && !i.deletedAt && (i.ownerId == null || i.ownerId === userId))
  if (existing?.summary?.trim() || existing?.reflections?.trim()) return null

  const tasks = (items ?? []).filter(i => i.kind === 'task' && !i.deletedAt)
  const inRange = iso => {
    const t = Date.parse(iso ?? '')
    return Number.isFinite(t) && t >= meta.start.getTime() && t < meta.end.getTime()
  }
  const done = tasks.filter(t => t.status === 'done' && inRange(t.completedAt) && !(t.tags ?? []).includes('visit')).map(t => t.title).slice(0, 40)
  const slipped = tasks.filter(t => OPEN.includes(t.status) && inRange(t.dueAt)).map(t => t.title).slice(0, 40)
  const people = (items ?? []).filter(i => i.kind === 'person' && !i.deletedAt)
  const seen = people
    .filter(p => tasks.some(t => t.status === 'done' && inRange(t.completedAt) && (t.peopleIds ?? []).includes(p.id)))
    .map(p => p.name)
    .slice(0, 20)
  // the journal is personal: only this user's own entries, never a household peer's
  // …and it reaches the model only when the account opted in (user_settings.digest_journal);
  // the on-demand summary the user presses for is explicit consent and always may
  const wrote = opts.journal
    ? journalLines(
        entriesBetween(
          (items ?? []).filter(i => i.kind === 'journal' && (i.ownerId == null || i.ownerId === userId)),
          meta.startKey,
          meta.endKey,
        ),
        10,
        220,
        peopleNameMap(people), // "with Mum, Dad" on a line; a mention is not a visit and is not in "People seen"
      )
    : []
  const list = xs => (xs.length ? xs.map(x => `- ${x}`).join('\n') : '- none')
  const journalSection = opts.journal ? `\n\nMy journal this week:\n${list(wrote)}` : ''

  const ai = await complete({
    system:
      'You write a warm, candid personal review — like a good friend who is also organised. Plain text, short paragraphs and "-" bullets only, no headings, no markdown emphasis. Be specific: name the tasks and people. Celebrate real progress, be honest about what slipped, and end with two or three things that would matter most next. When the journal explains why the week went the way it did, say so in the writer\'s own terms. Never invent anything not in the data.',
    prompt: `Period: last week (${meta.label})\n\nCompleted:\n${list(done)}\n\nSlipped (due but not done):\n${list(slipped)}\n\nPeople seen:\n${list(seen)}${journalSection}\n\nWrite the review in 120–220 words.`,
    maxTokens: 900,
  })
  if (ai.error || !ai.text?.trim()) return null

  const stamp = newerStamp(existing?.updatedAt)
  const review = {
    kind: 'review',
    id: existing?.id ?? `review-${meta.key}-${String(userId).slice(0, 8)}`,
    period: 'week',
    key: meta.key,
    top: existing?.top ?? [],
    topDone: existing?.topDone,
    reflections: existing?.reflections,
    summary: ai.text.trim(),
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: stamp,
  }

  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_KEY
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/sync_posts`, {
    method: 'POST',
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ incoming: [review], since: new Date(Date.now() + 86_400_000).toISOString() }),
  })
  if (!res.ok) return null
  await fetch(`${supabaseUrl}/rest/v1/posts?id=eq.${encodeURIComponent(review.id)}`, {
    method: 'PATCH',
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: userId }),
  }).catch(() => {})
  return review.id
}

async function userEmail(userId) {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  const res = await fetch(`${url}/auth/v1/admin/users/${userId}`, { headers: { apikey: key, authorization: `Bearer ${key}` } })
  if (!res.ok) return null
  return (await res.json())?.email ?? null
}

export async function sendEmail(to, subject, text) {
  if (!process.env.RESEND_API_KEY) return false
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: process.env.DIGEST_FROM || 'Drafter <onboarding@resend.dev>', to, subject, text }),
  })
  return res.ok
}

/** userId -> the set of owner ids whose records that user may see (mirrors household_user_ids()). */
export async function buildPeerMap() {
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
      const items = visibleItemsFor(rows, u.user_id, peers.get(u.user_id), ownerId)

      const tz = u.timezone || 'UTC'
      const { hour, day, weekday } = localParts(now, tz)
      if (hour === null) continue
      const subs = u.push_subscriptions ?? []
      const patch = {}
      let liveSubs = subs

      const applySend = async (payload) => {
        const { gone, failed, updated } = await sendToAll(liveSubs, payload)
        if (gone.length) liveSubs = liveSubs.filter(s => !gone.includes(s.endpoint))
        if (updated?.length) {
          const byEp = new Map(updated.map(x => [x.endpoint, x]))
          liveSubs = liveSubs.map(s => byEp.get(s.endpoint) ?? s)
        }
        return { failed }
      }

      // 1. morning digest — once per local day, at or after the chosen hour so a
      //    skipped or delayed run still delivers instead of silently dropping the day
      const wantHour = Number.isInteger(u.digest_hour) ? u.digest_hour : 8
      if (hour >= wantHour && u.last_digest_day !== day) {
        const digest = buildDigest(items, tz, now, u.nudged ?? {})
        // Sunday's digest is the doorway to the weekly review
        const sunday = weekday === 'Sun'
        if (sunday) {
          digest.lines.push('Sunday: your weekly review is ready.')
          await upsertSundayReview(u.user_id, items, now, { journal: !!u.digest_journal, timezone: tz }).catch(() => null)
        }
        if (digest.lines.length > 0) {
          if (liveSubs.length && pushConfigured()) {
            const { failed } = await applySend({ title: 'Good morning — today in Drafter', body: digest.lines.join('\n'), tag: 'digest', url: `${site || ''}/${sunday ? '?view=review' : ''}`, badge: digest.overdue.length + digest.dueToday.length })
            if (failed.length) failures.push(`digest ${u.user_id}: ${failed.map(f => f.statusCode).join(',')}`)
            sent += Math.max(0, liveSubs.length - failed.length)
          }
          if (u.digest_email) {
            const email = await userEmail(u.user_id).catch(() => null)
            if (email) await sendEmail(email, `Today in Drafter: ${digest.dueToday.length} due, ${digest.overdue.length} overdue`, [...digest.lines, '', `Open Drafter: ${site}/`].join('\n'))
          }
        }
        patch.last_digest_day = day
        patch.nudged = digest.nudgedNext
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
          const { failed } = await applySend({ title: `Due now: ${t.title || 'Untitled task'}`, body: t.description ? t.description.slice(0, 120) : 'Open Drafter for the details.', tag: `due-${t.id}`, url: `${site || ''}/?task=${encodeURIComponent(t.id)}`, badge: 1 })
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

  // hard-delete purged tombstones older than the TTL (peers have had time to see them)
  try {
    const cutoff = new Date(Date.now() - TOMBSTONE_TTL_MS).toISOString()
    await rest(`posts?deleted=eq.true&updated_at=lt.${encodeURIComponent(cutoff)}&data->>purged=eq.true`, {
      method: 'DELETE',
      headers: { prefer: 'return=minimal' },
    }).catch(() => null)
  } catch {
    /* best-effort */
  }

  const report = `sent ${sent}${failures.length ? `; ${failures.length} failure(s): ${failures.slice(0, 5).join(' | ')}` : ''}`
  if (failures.length) console.error('digest:', report)
  return new Response(report, { status: 200 })
}
