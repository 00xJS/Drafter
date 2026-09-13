// Scheduled hourly. For every user with push subscriptions or the email digest
// on: at their chosen local hour send the morning digest (overdue, due today,
// occasions, people due a catch-up), and nudge about timed tasks that came due
// since the last check. Email goes through Resend when RESEND_API_KEY is set.
//
// Sunday's review draft is for every account, push and email or not: on its
// own Sunday, from its digest hour, last week's review is written for it once
// (upsertSundayReview), and a digest that day ends with what it says. An
// account the site owner has disabled in Admin (an auth ban) is not drafted:
// a run with a draft due reads every account's sign-in status once, and when
// that read fails nobody is skipped, as before. Netlify
// stops a scheduled function at 30 seconds, so the accounts whose digest may
// be due go first, and a draft starts only while the run has time to finish
// it (RUN_BUDGET_MS). One that can't start waits for the next hourly run: it
// stays due for the rest of that Sunday.
//
// Records are scoped per recipient exactly as the database policy scopes them:
// your own rows plus your household's (plus legacy unowned rows, which belong
// to the owner), minus a household member's personal kinds. The service key
// bypasses RLS, so that filtering happens here (visibleItemsFor) and must stay
// in step with public.household_user_ids() and the policy's kind list.
//
// Once a run, before anyone's digest, the sync canary writes one synthetic row
// of every kind through sync_posts and rolls it back (public.sync_canary). The
// answer is kept for Admin → Data, and a refusal reaches the owner through the
// same push and email as the digest, at most every twelve hours.

import { buildDigest, localParts, visibleItemsFor } from '../../shared/digest.mjs'
import { entriesBetween, journalLines, peopleNameMap } from '../../shared/journal.mjs'
import { seenTasks } from '../../shared/people.mjs'
import { peopleSeen, reviewLists } from '../../shared/review.mjs'
import { SYNC_KINDS } from '../../shared/kinds.mjs'
import { proposeWeek, weekPlanSummary } from '../../shared/weekplan.mjs'
import { complete, resolveProvider } from './lib/ai.mjs'
import { canaryAlert, nextCanaryRecord, readCanary, runSyncCanary, writeCanary } from './lib/canary.mjs'
import { previousWeekIn, sundayDraftDue, sundayLine } from './lib/reviewweek.mjs'
import { pushConfigured, sendToAll } from './push.mjs'

export const config = { schedule: '@hourly' }

const DAY = 86_400_000
const HOUR = 3_600_000
/** Cap the catch-up window so an outage can't unleash a flood of stale nudges. */
const MAX_NUDGE_WINDOW = 6 * HOUR
const OPEN = ['todo', 'doing', 'blocked']
const TOMBSTONE_TTL_MS = 90 * DAY
/**
 * How long a run may go on starting work that can wait. Netlify stops a
 * scheduled function at 30s; the rest is for the digests, nudges and writes
 * still to do once the last draft has had its time.
 */
const RUN_BUDGET_MS = 22_000
/** Left of the budget, at least, before a draft starts: a model call, and a write either side of it. */
const DRAFT_MIN_MS = 12_000
/** Accounts a page when the run reads which are disabled, as Admin → Users pages them. */
const AUTH_PAGE = 200
/** Pages read at most (4,000 accounts); an account past them is drafted as though enabled. */
const AUTH_MAX_PAGES = 20

async function rest(path, init = {}) {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  if (!res.ok) throw new Error(`${path.split('?')[0]}: ${res.status}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

/**
 * Every row a select matches, a page at a time, as admin.mjs reads them.
 * PostgREST answers at most max_rows (1000) rows a request, and in no fixed
 * order unless asked, so `path` carries its own `order`.
 */
async function fetchAll(path, pageSize = 1000) {
  const out = []
  for (let from = 0; from < 200_000; from += pageSize) {
    // a range that starts past the last row answers 416 rather than an empty
    // page — on any page but the first that just means we have them all
    const page = await rest(path, { headers: { 'range-unit': 'items', range: `${from}-${from + pageSize - 1}` } }).catch(e => {
      if (from === 0) throw e
      return null
    })
    const list = Array.isArray(page) ? page : []
    out.push(...list)
    if (list.length < pageSize) break
  }
  return out
}

/** `promise`'s value, or `fallback` once `ms` has passed. Nothing is cancelled; a late answer is not waited for. */
async function settleWithin(promise, ms, fallback) {
  if (!Number.isFinite(ms)) return promise
  let timer
  try {
    return await Promise.race([promise, new Promise(resolve => (timer = setTimeout(resolve, Math.max(0, ms), fallback)))])
  } finally {
    clearTimeout(timer)
  }
}

/** The id Sunday's draft gives the review of a week it has to create for an account. */
const draftIdOf = (key, userId) => `review-${key}-${String(userId).slice(0, 8)}`

/**
 * An account's own reviews of a week, deleted ones included. Reviews are
 * personal: never a household peer's for the same week, and never another
 * account's draft that the site owner holds while its hand-over is retried.
 */
const ownReviews = (items, userId, key) =>
  (items ?? []).filter(
    i =>
      i.kind === 'review' &&
      i.period === 'week' &&
      i.key === key &&
      (i.ownerId == null || i.ownerId === userId) &&
      (i.id === draftIdOf(key, userId) || !String(i.id).startsWith(`review-${key}-`)),
  )

/** One millisecond after `iso`, or null without a valid one: newer than the copy a write was built on, and older than any save made since. */
function justAfter(iso) {
  const t = Date.parse(iso ?? '')
  return Number.isFinite(t) ? new Date(t + 1).toISOString() : null
}

/**
 * Write a review through sync_posts. False when the server did not take it:
 * the request failed, or a newer copy stands. A new row is the site owner's,
 * so with `handOver` it is then given to its reader, and the write counts
 * only once that has worked. A claim left with the site owner is out of its
 * reader's sight, so the next hourly run writes it and hands it over again.
 */
async function writeReview(review, userId, { handOver = false } = {}) {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_KEY
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/sync_posts`, {
    method: 'POST',
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ incoming: [review], since: new Date(Date.now() + 86_400_000).toISOString() }),
  })
  if (!res.ok) return false
  const answer = await res.json().catch(() => null)
  if (['rejected', 'stale', 'gone'].some(k => Array.isArray(answer?.[k]) && answer[k].includes(review.id))) return false
  if (!handOver) return true
  // for the site owner this changes nothing and answers 204 all the same
  return fetch(`${supabaseUrl}/rest/v1/posts?id=eq.${encodeURIComponent(review.id)}`, {
    method: 'PATCH',
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: userId }),
  }).then(
    r => r.ok,
    () => false,
  )
}

/**
 * Draft a weekly review summary into posts when the owner hasn't written one.
 * Never clobbers reflections or an existing summary. `opts.timezone` is the
 * reader's zone, which decides what "last week" is (lib/reviewweek.mjs).
 *
 * One try a week, however many hourly runs find it due: the record is stamped
 * `draftedAt` before the model is asked, so a call that fails or runs out of
 * time is not paid for again every hour of the day. `items` is one read of
 * every record, made at the start of the run: it can be cut short, and a save
 * made since is not in it. So the week's own rows are read again, straight
 * from the table, just before the stamp, and they decide. Both writes are
 * stamped just after the copy they were built on, so a save made meanwhile
 * wins and the draft steps aside.
 *
 * `opts.deadline` (epoch ms) is when the run stops starting work. Without
 * DRAFT_MIN_MS left, nothing is stamped and the week waits for the next hour.
 * Past the deadline the model is not waited for, and its try is spent.
 * `opts.ownerId` is the site owner, whose legacy unowned rows are its own.
 * Answers the week's review as it now stands, { id, summary, drafted }, or
 * null when it has none.
 */
export async function upsertSundayReview(userId, items, now = new Date(), opts = {}) {
  const meta = previousWeekIn(now, opts.timezone)
  const answer = (r, drafted = false) => (r ? { id: r.id, summary: r.summary?.trim() || undefined, drafted } : null)
  const yours = r => !!(r?.summary?.trim() || r?.reflections?.trim())
  const left = () => (opts.deadline == null ? Infinity : opts.deadline - Date.now())
  let existing = ownReviews(items, userId, meta.key).find(r => !r.deletedAt)
  if (!resolveProvider() || yours(existing) || existing?.draftedAt || left() < DRAFT_MIN_MS) return answer(existing)

  // the week's rows as they stand now, deleted ones too: a stamp on any of
  // them means the week has had its try, however the read above was cut
  const week = await rest(`posts?select=data,user_id&kind=eq.review&data->>key=eq.${encodeURIComponent(meta.key)}`).catch(() => null)
  if (!Array.isArray(week)) return answer(existing)
  const mine = ownReviews(visibleItemsFor(week, userId, [], opts.ownerId), userId, meta.key)
  existing = mine.find(r => !r.deletedAt)
  if (yours(existing) || mine.some(r => r.draftedAt)) return answer(existing)

  const tasks = (items ?? []).filter(i => i.kind === 'task' && !i.deletedAt)
  const people = (items ?? []).filter(i => i.kind === 'person' && !i.deletedAt)
  // the lists Home → Week shows for that week (shared/review.mjs); your own past
  // events with people on them count as seeing them there, and so here
  const lists = reviewLists(tasks, meta, now)
  const done = lists.done.map(t => t.title).slice(0, 40)
  const slipped = lists.slipped.map(t => t.title).slice(0, 40)
  const seen = peopleSeen(people, seenTasks(tasks, (items ?? []).filter(i => i.kind === 'event'), now), meta, iso => localParts(iso, opts.timezone || 'UTC').day)
    .map(p => p.person.name)
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

  // the week's one try is claimed before the model is asked, just after the
  // copy read above: a save made since is newer, and the claim steps aside
  const stamp = justAfter(existing?.updatedAt) ?? new Date().toISOString()
  const claim = {
    kind: 'review',
    id: existing?.id ?? draftIdOf(meta.key, userId),
    period: 'week',
    key: meta.key,
    top: existing?.top ?? [],
    topDone: existing?.topDone,
    reflections: existing?.reflections,
    draftedAt: now.toISOString(),
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: stamp,
  }
  if (!(await writeReview(claim, userId, { handOver: true }))) return answer(existing)

  const ai = await settleWithin(
    complete({
      system:
        'You write a warm, candid personal review — like a good friend who is also organised. Plain text, short paragraphs and "-" bullets only, no headings, no markdown emphasis. Be specific: name the tasks and people. Celebrate real progress, be honest about what slipped, and end with two or three things that would matter most next. When the journal explains why the week went the way it did, say so in the writer\'s own terms. Never invent anything not in the data.',
      prompt: `Period: last week (${meta.label})\n\nCompleted:\n${list(done)}\n\nSlipped (due but not done):\n${list(slipped)}\n\nPeople seen:\n${list(seen)}${journalSection}\n\nWrite the review in 120–220 words.`,
      maxTokens: 900,
    }),
    left(),
    { error: 'the run ran out of time' },
  )
  if (ai.error || !ai.text?.trim()) return answer(claim)

  // just after the claim, not now: reflections or a Top 3 saved while the
  // model was asked are newer, so they stand and the summary is not written
  const review = { ...claim, summary: ai.text.trim(), updatedAt: justAfter(claim.updatedAt) }
  return (await writeReview(review, userId)) ? answer(review, true) : answer(claim)
}

async function userEmail(userId) {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  const res = await fetch(`${url}/auth/v1/admin/users/${userId}`, { headers: { apikey: key, authorization: `Bearer ${key}` } })
  if (!res.ok) return null
  return (await res.json())?.email ?? null
}

/**
 * The accounts disabled in Admin → Users, for Sunday's draft to skip. Disable
 * is a Supabase Auth ban (banned_until far ahead, admin.mjs), so this reads
 * every account through the same service-key admin API, a page at a time,
 * and counts a ban only until it runs out. Throws when a page can't be read:
 * a list cut short can't say who is disabled on the pages it missed.
 */
async function disabledAccounts(now) {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  const out = new Set()
  for (let page = 1; page <= AUTH_MAX_PAGES; page++) {
    const res = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=${AUTH_PAGE}`, { headers: { apikey: key, authorization: `Bearer ${key}` } })
    if (!res.ok) throw new Error(`auth admin users: ${res.status}`)
    const list = (await res.json())?.users
    if (!Array.isArray(list)) throw new Error('auth admin users: no list')
    for (const u of list) {
      const until = Date.parse(u?.banned_until ?? '')
      if (u?.id && Number.isFinite(until) && until > now.getTime()) out.add(u.id)
    }
    if (list.length < AUTH_PAGE) break
  }
  return out
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

/**
 * Every account a run is for: each settings row, then each account with
 * records and no row (legacy unowned rows are the site owner's), which reads
 * as the defaults — no push, no email, UTC, 8am. Sunday's draft needs nothing more.
 */
function accountsOf(users, rows, ownerId) {
  const byId = new Map((users ?? []).map(u => [u.user_id, u]))
  for (const r of rows ?? []) {
    const id = r.user_id ?? ownerId
    if (id && !byId.has(id)) byId.set(id, { user_id: id })
  }
  return [...byId.values()]
}

/**
 * The sync canary, once a run. September's outage rejected every write for
 * days with nothing to say so; this is the thing that says so. The owner is
 * told through whichever of the digest's channels they have on (push, the
 * email digest), and `alertedAt` is stamped only when one of them took the
 * message — with neither on, Admin → Data is where it shows.
 */
async function checkSyncCanary(users, ownerId, now, site) {
  const prev = await readCanary(rest).catch(() => null)
  const { record, alert } = nextCanaryRecord(prev, await runSyncCanary(rest, [...SYNC_KINDS]), now)
  if (!record.ok) console.error('digest: sync canary', JSON.stringify(record.failures.length ? record.failures : record.error))
  if (alert && ownerId) {
    const owner = (users ?? []).find(u => u.user_id === ownerId)
    const { title, body, text } = canaryAlert(record)
    let told = false
    const subs = owner?.push_subscriptions ?? []
    if (subs.length && pushConfigured()) {
      const { gone, failed } = await sendToAll(subs, { title, body, tag: 'sync-canary', url: `${site}/` })
      told = subs.length > gone.length + failed.length
    }
    if (owner?.digest_email) {
      const email = await userEmail(ownerId).catch(() => null)
      if (email && (await sendEmail(email, title, `${text}\n\nOpen Drafter: ${site}/`).catch(() => false))) told = true
    }
    if (told) record.alertedAt = now.toISOString()
  }
  await writeCanary(rest, record).catch(() => {})
  return record
}

export default async () => {
  if (!process.env.SUPABASE_SERVICE_KEY) return new Response('not configured', { status: 200 })
  const now = new Date()
  const site = process.env.URL || process.env.DEPLOY_PRIME_URL || ''
  const users = await rest('user_settings?select=*')
  const ownerId = await rest('rpc/owner_user_id', { method: 'POST', body: '{}' }).catch(() => null)

  // once a run, not once a user — and ahead of the early return below, so a
  // site with nobody subscribed still finds out its writes are failing
  const canary = await checkSyncCanary(users, ownerId, now, site).catch(e => ({ ok: false, failures: [], error: String(e?.message ?? e) }))
  const checked = canary.ok
    ? 'sync check ok'
    : `sync check failed: ${canary.failures.length ? canary.failures.map(f => `${f.kind} ${f.reason}`).join(', ') : canary.error}`

  const active = (users ?? []).filter(u => (u.push_subscriptions?.length ?? 0) > 0 || u.digest_email)
  // Sunday's draft reads the records even with nobody subscribed, on a Sunday
  // that is due somewhere: {} stands for an account with no settings row
  const drafting = !!resolveProvider() && [...(users ?? []), {}].some(u => sundayDraftDue(u, now))
  if (active.length === 0 && !drafting) return new Response(`no subscribers; ${checked}`, { status: 200 })

  // keep row ownership so each recipient only ever sees their own scope; paged,
  // as one request stops at PostgREST's max_rows
  const rows = await fetchAll('posts?select=data,user_id&deleted=is.false&order=id.asc')
  const peers = await buildPeerMap()
  let sent = 0
  let drafted = 0
  const failures = []
  // Sunday's drafts start only while there is time to finish them
  const deadline = now.getTime() + RUN_BUDGET_MS

  // accounts whose digest may be due go first, as they did before Sunday's
  // draft ran for everyone: a draft for an account with neither push nor email
  // never holds up anyone's digest or nudges
  const accounts = accountsOf(users, rows, ownerId)
  // an account disabled in Admin gets no draft; which ones are is read once,
  // and only on a run with a draft due. A read that fails skips nobody, as
  // before, and says so in the log.
  const draftDue = drafting && accounts.some(a => sundayDraftDue(a, now))
  const disabled = draftDue
    ? await disabledAccounts(now).catch(e => {
        console.error(`digest: could not read which accounts are disabled, so none is skipped: ${e?.message ?? e}`)
        return new Set()
      })
    : new Set()
  for (const u of [...accounts.filter(a => active.includes(a)), ...accounts.filter(a => !active.includes(a))]) {
    const subscribed = active.includes(u)
    const sundayDue = sundayDraftDue(u, now) && !disabled.has(u.user_id)
    if (!subscribed && !sundayDue) continue
    try {
      const items = visibleItemsFor(rows, u.user_id, peers.get(u.user_id), ownerId)

      const tz = u.timezone || 'UTC'
      // 0. Sunday's review draft — every account not disabled in Admin, once a
      //    week (its record keeps the stamp), when the run has time for it, and
      //    before the digest so Sunday's line can carry it
      const review = sundayDue
        ? await upsertSundayReview(u.user_id, items, now, { journal: !!u.digest_journal, timezone: tz, ownerId, deadline }).catch(() => null)
        : null
      if (review?.drafted) drafted++
      if (!subscribed) continue

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
        // Sunday's digest is the doorway to the weekly review, and to planning the week it starts
        const sunday = weekday === 'Sun'
        const weekPlan = sunday ? weekPlanSummary(proposeWeek(items, { todayKey: day, tz, userId: u.user_id, now })) : null
        const digest = buildDigest(items, tz, now, u.nudged ?? {}, u.user_id, { weekPlan })
        // the review's first sentence, drafted above or written by you; the fixed line without one
        if (sunday) digest.lines.push(sundayLine(review?.summary))
        // Either link only opens a sheet — Plan my day, or the week plan over the
        // review — and the sheet writes nothing until its button is pressed. With
        // nothing to plan, Sunday opens the review on its own.
        const path = sunday ? (weekPlan ? '/?view=review&plan=week' : '/?view=review') : '/?plan=day'
        if (digest.lines.length > 0) {
          if (liveSubs.length && pushConfigured()) {
            const { failed } = await applySend({ title: 'Good morning — today in Drafter', body: digest.lines.join('\n'), tag: 'digest', url: `${site || ''}${path}`, badge: digest.overdue.length + digest.dueToday.length })
            if (failed.length) failures.push(`digest ${u.user_id}: ${failed.map(f => f.statusCode).join(',')}`)
            sent += Math.max(0, liveSubs.length - failed.length)
          }
          if (u.digest_email) {
            const email = await userEmail(u.user_id).catch(() => null)
            const plan = sunday ? (weekPlan ? `Plan the week: ${site}${path}` : null) : `Plan your day: ${site}${path}`
            if (email) await sendEmail(email, `Today in Drafter: ${digest.dueToday.length} due, ${digest.overdue.length} overdue`, [...digest.lines, '', ...(plan ? [plan] : []), `Open Drafter: ${site}/`].join('\n'))
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

  // hard-delete purged tombstones older than the TTL (peers have had time to see them);
  // on a run with someone subscribed, as before Sunday's draft ran for everyone
  if (active.length) {
    try {
      const cutoff = new Date(Date.now() - TOMBSTONE_TTL_MS).toISOString()
      await rest(`posts?deleted=eq.true&updated_at=lt.${encodeURIComponent(cutoff)}&data->>purged=eq.true`, {
        method: 'DELETE',
        headers: { prefer: 'return=minimal' },
      }).catch(() => null)
    } catch {
      /* best-effort */
    }
  }

  const report = `${active.length ? `sent ${sent}` : 'no subscribers'}${drafted ? `; drafted ${drafted}` : ''}; ${checked}${failures.length ? `; ${failures.length} failure(s): ${failures.slice(0, 5).join(' | ')}` : ''}`
  if (failures.length) console.error('digest:', report)
  return new Response(report, { status: 200 })
}
