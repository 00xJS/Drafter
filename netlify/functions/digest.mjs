// Scheduled hourly. For every user with push subscriptions or the email digest
// on: at their chosen local hour send the morning digest (overdue, due today,
// occasions, people due a catch-up), and nudge about timed tasks that came due
// since the last check. Email goes through Resend when RESEND_API_KEY is set
// (lib/email.mjs); a send that fails is on the run's record.
//
// Each account's watermarks — the day its digest went, the instant up to which
// its due tasks were nudged — are written BEFORE anything is sent. A send can
// stall (lib/apns.mjs now stops one at 8 seconds, but Netlify stops the whole
// run at 30), and a run killed after sending and before writing them sent the
// same digest and nudges again an hour later. Written first, a run that dies
// mid-send loses what it had not sent yet rather than repeating what it had.
//
// Sunday's review draft is for every account, push and email or not: on its
// own Sunday, from its digest hour, last week's review is written for it once
// (upsertSundayReview), and a digest that day ends with what it says. An
// account the site owner has disabled in Admin (an auth ban) is not drafted,
// though its digest still ends with the week's review as it stands: a run
// with a draft due reads every account's sign-in status once, for
// AUTH_READ_MS at most, and when that read fails or runs out of time nobody
// is skipped, as before. Netlify
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

import { buildDigest, localParts, visibleItemsFor } from '../../shared/digest.mts'
import { isMineTask } from '../../shared/domain.mts'
import { hasDueTime } from '../../shared/due.mts'
import { entriesBetween, journalLines, peopleNameMap } from '../../shared/journal.mts'
import { seenTasks } from '../../shared/people.mts'
import { habitLines, habitsKept, peopleSeen, reviewLists } from '../../shared/review.mts'
import { SYNC_KINDS } from '../../shared/kinds.mts'
import { proposeWeek, weekPlanSummary } from '../../shared/weekplan.mts'
import { complete, resolveProvider } from './lib/ai.mjs'
import { restAll } from './lib/backup.mjs'
import { canaryAlert, nextCanaryRecord, readCanary, runSyncCanary, writeCanary } from './lib/canary.mjs'
import { emailConfigured, sendEmail } from './lib/email.mjs'
import { recordJobRun } from './lib/jobhealth.mjs'
import { previousWeekIn, sundayDraftDue, sundayLine } from './lib/reviewweek.mjs'
import { keyHeaders } from './lib/supabasekeys.mjs'
import { NO_THINKING, REVIEW_SYSTEM, looksLikeThinking } from '../../shared/ai.mts'
import { pushConfigured, sendToAll } from './push.mjs'

export const config = { schedule: '@hourly' }

const DAY = 86_400_000
const HOUR = 3_600_000
/** Cap the catch-up window so an outage can't unleash a flood of stale nudges. */
const MAX_NUDGE_WINDOW = 6 * HOUR
/** "Due now" nudges a run sends one account at most; the rest wait for the next run. */
const MAX_NUDGES = 5
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
/**
 * The longest a run waits to learn which accounts are disabled, every page
 * together. A read still going then is let go and skips nobody, as a failed
 * one does, and the drafts still have their time after it.
 */
const AUTH_READ_MS = 5_000

async function rest(path, init = {}) {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: keyHeaders(key, { 'content-type': 'application/json', ...(init.headers ?? {}) }) })
  if (!res.ok) throw new Error(`${path.split('?')[0]}: ${res.status}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
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
    headers: keyHeaders(serviceKey, { 'content-type': 'application/json' }),
    body: JSON.stringify({ incoming: [review], since: new Date(Date.now() + 86_400_000).toISOString() }),
  })
  if (!res.ok) return false
  const answer = await res.json().catch(() => null)
  if (['rejected', 'stale', 'gone'].some(k => Array.isArray(answer?.[k]) && answer[k].includes(review.id))) return false
  if (!handOver) return true
  // for the site owner this changes nothing and answers 204 all the same
  return fetch(`${supabaseUrl}/rest/v1/posts?id=eq.${encodeURIComponent(review.id)}`, {
    method: 'PATCH',
    headers: keyHeaders(serviceKey, { 'content-type': 'application/json', prefer: 'return=minimal' }),
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
 * Past the deadline the model is not waited for, and its try is spent. A
 * deadline of 0 only reads the week's review, as it stands, from `items`.
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
  // the lists Home → Week shows for that week (shared/review.mts); your own past
  // events with people on them count as seeing them there, and so here
  const lists = reviewLists(tasks, meta, now, opts.timezone || 'UTC')
  const done = lists.done.map(t => t.title).slice(0, 40)
  const slipped = lists.slipped.map(t => t.title).slice(0, 40)
  const seen = peopleSeen(people, seenTasks(tasks, (items ?? []).filter(i => i.kind === 'event'), now, userId), meta, iso => localParts(iso, opts.timezone || 'UTC').day)
    .map(p => p.person.name)
    .slice(0, 20)
  // habits are personal, like the journal: only this user's own, never a
  // household peer's. Kept, missed and the streak each ended the week on, in
  // the one line the ✨ summary on Home → Week sends (shared/review.mts)
  const habits = habitLines(
    habitsKept(
      (items ?? []).filter(i => i.kind === 'habit' && (i.ownerId == null || i.ownerId === userId)),
      meta,
      now,
      iso => localParts(iso, opts.timezone || 'UTC').day,
    ),
  )
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
  const habitSection = habits.length ? `\n\nHabits:\n${list(habits)}` : ''
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

  const prompt = `Period: last week (${meta.label})\n\nCompleted:\n${list(done)}\n\nSlipped (due but not done):\n${list(slipped)}\n\nPeople seen:\n${list(seen)}${habitSection}${journalSection}\n\n120–220 words. Begin with the review's first sentence.`

  const ai = await settleWithin(
    complete({
      // REVIEW_SYSTEM, not a second wording: this writes the same review the
      // ✨ button does, and the two briefs had drifted apart — this one was
      // still the rule-heavy original the model got stuck weighing.
      system: REVIEW_SYSTEM,
      prompt,
      maxTokens: 900,
      // nobody is waiting on it: a second NVIDIA key takes it first, and the owner's own requests keep the main one
      background: true,
    }),
    left(),
    { error: 'the run ran out of time' },
  )
  if (ai.error || !ai.text?.trim()) return answer(claim)

  /**
   * The thinking guard, on the one path nobody watches.
   *
   * NVIDIA's default model reasons before it answers, and when the budget runs
   * out in the reasoning that is what comes back. In the app a bad answer is in
   * front of someone who can press the button again; here it is written
   * straight into the review, on a Sunday, unasked — which is exactly how a
   * week's review came to be 3,625 characters of the model working out how to
   * write one. Ask once more without the reasoning, and if that is thinking
   * too, leave the summary unwritten: the claim alone still lets them press ✨
   * themselves, and no summary is better than that one.
   */
  let text = ai.text.trim()
  if (looksLikeThinking(text, REVIEW_SYSTEM)) {
    const retry = await settleWithin(
      complete({ system: `${REVIEW_SYSTEM}\n\n${NO_THINKING}`, prompt, maxTokens: 2048, background: true }),
      left(),
      { error: 'the run ran out of time' },
    )
    text = retry.error ? '' : (retry.text ?? '').trim()
    if (!text || looksLikeThinking(text, REVIEW_SYSTEM)) return answer(claim)
  }

  // just after the claim, not now: reflections or a Top 3 saved while the
  // model was asked are newer, so they stand and the summary is not written
  const review = { ...claim, summary: text, updatedAt: justAfter(claim.updatedAt) }
  return (await writeReview(review, userId)) ? answer(review, true) : answer(claim)
}

async function userEmail(userId) {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  const res = await fetch(`${url}/auth/v1/admin/users/${userId}`, { headers: keyHeaders(key) })
  if (!res.ok) return null
  return (await res.json())?.email ?? null
}

/**
 * The accounts disabled in Admin → Users, for Sunday's draft to skip. Disable
 * is a Supabase Auth ban (banned_until far ahead, admin.mjs), so this reads
 * every account through the same service-key admin API, a page at a time,
 * and counts a ban only until it runs out. Throws when a page can't be read,
 * or when the pages together take longer than `ms`: a list cut short can't
 * say who is disabled on the pages it missed.
 */
async function disabledAccounts(now, ms) {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  // one timer for every page, so a slow list is let go rather than waited on a page at a time
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error(`auth admin users: no answer within ${ms} ms`)), ms)
  try {
    const out = new Set()
    for (let page = 1; page <= AUTH_MAX_PAGES; page++) {
      const res = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=${AUTH_PAGE}`, { headers: keyHeaders(key), signal: ctrl.signal })
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
  } finally {
    clearTimeout(timer)
  }
}

// Admin's digest preview emails through the same sender (lib/email.mjs)
export { sendEmail }

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

/**
 * The hourly run, and the record it leaves in job_runs (lib/jobhealth.mjs):
 * when it ran, what it sent, and the first few failures. That record is how a
 * run that failed, or runs that stopped coming, reach the owner's Today. The
 * answer is the run's own, as it always was; a run that throws is recorded
 * as failed and still throws.
 */
export default async () => {
  if (!process.env.SUPABASE_SERVICE_KEY) return new Response('not configured', { status: 200 })
  const now = new Date()
  const run = { counts: {}, failures: [] }
  let res
  try {
    res = await digestRun(now, run)
  } catch (e) {
    await recordJobRun(rest, 'digest', { ok: false, counts: run.counts, failures: [...run.failures, `the run stopped: ${e?.message ?? e}`] }, now)
    throw e
  }
  await recordJobRun(rest, 'digest', run, now)
  return res
}

/** One hourly run. `run` collects its counts and failures for the job's record. */
async function digestRun(now, run) {
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
  run.counts = { subscribers: active.length, sent: 0, drafted: 0 }
  if (active.length === 0 && !drafting) return new Response(`no subscribers; ${checked}`, { status: 200 })

  // keep row ownership so each recipient only ever sees their own scope. Read a
  // page at a time (restAll, as the nightly backup reads them): one request
  // stops at PostgREST's max_rows, and a read that can't be finished fails the
  // run, to be tried again the next hour, rather than send a digest or draft
  // Sunday's review from part of the records
  const rows = /** @type {{ user_id: string | null, data: unknown }[]} */ (await restAll('posts?select=id,data,user_id&deleted=is.false'))
  const peers = await buildPeerMap()
  let sent = 0
  let drafted = 0
  // the job's record reads this list as it grows, so a run that throws part-way keeps what failed before
  const failures = run.failures
  // Sunday's drafts start only while there is time to finish them
  const deadline = now.getTime() + RUN_BUDGET_MS

  // accounts whose digest may be due go first, as they did before Sunday's
  // draft ran for everyone: a draft for an account with neither push nor email
  // never holds up anyone's digest or nudges
  const accounts = accountsOf(users, rows, ownerId)
  // an account disabled in Admin gets no draft; which ones are is read once,
  // and only on a run with a draft due and time left to start one. The read
  // stops at AUTH_READ_MS, or sooner when a draft could no longer start after
  // it: one that fails or runs out of time skips nobody, as before, says so
  // in the log, and holds up no digest.
  const draftDue = drafting && accounts.some(a => sundayDraftDue(a, now))
  const readFor = Math.min(AUTH_READ_MS, deadline - Date.now() - DRAFT_MIN_MS)
  const disabled =
    draftDue && readFor > 0
      ? await disabledAccounts(now, readFor).catch(e => {
          console.error(`digest: could not read which accounts are disabled, so none is skipped: ${e?.message ?? e}`)
          return new Set()
        })
      : new Set()
  for (const u of [...accounts.filter(a => active.includes(a)), ...accounts.filter(a => !active.includes(a))]) {
    const subscribed = active.includes(u)
    // from its hour on its Sunday the week's review is read, for Sunday's
    // line, and drafted unless the account is disabled in Admin
    const reviewDue = sundayDraftDue(u, now)
    const mayDraft = reviewDue && !disabled.has(u.user_id)
    if (!subscribed && !mayDraft) continue
    try {
      const items = visibleItemsFor(rows, u.user_id, peers.get(u.user_id), ownerId)

      const tz = u.timezone || 'UTC'
      // 0. Sunday's review draft — every account not disabled in Admin, once a
      //    week (its record keeps the stamp), when the run has time for it, and
      //    before the digest so Sunday's line can carry it. A disabled account
      //    is given no time: its review is read as it stands, and not drafted
      const review = reviewDue
        ? await upsertSundayReview(u.user_id, items, now, { journal: !!u.digest_journal, timezone: tz, ownerId, deadline: mayDraft ? deadline : 0 }).catch(() => null)
        : null
      if (review?.drafted) drafted++
      if (!subscribed) continue

      const { hour, day, weekday } = localParts(now, tz)
      if (hour === null) continue
      const subs = u.push_subscriptions ?? []
      let liveSubs = subs
      const settingsPath = `user_settings?user_id=eq.${encodeURIComponent(u.user_id)}`

      const applySend = async (payload, to = liveSubs) => {
        const { gone, failed, updated } = await sendToAll(to, payload)
        if (gone.length) liveSubs = liveSubs.filter(s => !gone.includes(s.endpoint))
        if (updated?.length) {
          const byEp = new Map(updated.map(x => [x.endpoint, x]))
          liveSubs = liveSubs.map(s => byEp.get(s.endpoint) ?? s)
        }
        return { failed }
      }

      // Everything this run will send the account is decided first, and its
      // watermarks written, before any of it goes (see the top of this file).
      const claim = {}

      // 1. morning digest — once per local day, at or after the chosen hour so a
      //    skipped or delayed run still delivers instead of silently dropping the day
      const wantHour = Number.isInteger(u.digest_hour) ? u.digest_hour : 8
      let morning = null
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
        morning = { digest, sunday, weekPlan, path }
        claim.last_digest_day = day
        claim.nudged = digest.nudgedNext
      }

      // 2. timed tasks that came due since the last check (watermarked, so a
      //    delayed or repeated invocation neither duplicates nor skips nudges).
      //    Only a time comes due: a day with no time is due all of it, is not
      //    "due now" at the 00:00 it is stored at, and the morning digest lists
      //    it (shared/due.mts, read in the account's zone). Only the person doing
      //    it is nudged (isMineTask), as on the phones. And only in a browser:
      //    the iOS app keeps its own task reminders with push on — 9am for a day
      //    with no time (src/reminders.ts) — so its APNs entries never get a
      //    "Due now" here, which would be the same task ringing twice.
      const browsers = () => liveSubs.filter(s => s?.type !== 'apns')
      let nudges = []
      if (liveSubs.length && pushConfigured()) {
        const lastCheck = Date.parse(u.last_due_check ?? '')
        const from = Math.max(Number.isFinite(lastCheck) ? lastCheck : now.getTime() - HOUR, now.getTime() - MAX_NUDGE_WINDOW)
        // rows of every kind, read here for a task's fields; soonest first
        const due = /** @type {Partial<import('../../src/types.js').Task>[]} */ (browsers().length ? items : [])
          .filter(t => t.kind === 'task' && !t.deletedAt && OPEN.includes(t.status) && t.dueAt && isMineTask(t, u.user_id) && hasDueTime(t.dueAt, tz))
          .map(t => ({ t, at: Date.parse(t.dueAt) }))
          .filter(({ at }) => Number.isFinite(at) && at <= now.getTime() && at > from)
          .sort((a, b) => a.at - b.at)
        // At most MAX_NUDGES a run, and none skipped: when more came due, the
        // watermark stops at the last one to be sent and the next run sends on
        // from there. Tasks due at one instant go out together, even past the
        // cap, as a watermark between them could not tell the sent from the
        // unsent. A push service's refusal is the run's failure, on the job's
        // record, and the watermark moves on past it as before.
        let n = 0
        while (n < due.length && (n < MAX_NUDGES || due[n].at === due[n - 1].at)) n++
        nudges = due.slice(0, n).map(d => d.t)
        claim.last_due_check = n < due.length ? new Date(due[n - 1].at).toISOString() : now.toISOString()
      }

      // the claim: a write that fails sends nothing this hour, rather than
      // something the next hour cannot know was sent
      if (Object.keys(claim).length) {
        try {
          await rest(settingsPath, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify(claim) })
        } catch (e) {
          failures.push(`watermark ${u.user_id}: ${e?.message ?? e}`)
          continue
        }
      }

      if (morning && morning.digest.lines.length > 0) {
        const { digest, sunday, weekPlan, path } = morning
        if (liveSubs.length && pushConfigured()) {
          const { failed } = await applySend({ title: 'Good morning — today in Drafter', body: digest.lines.join('\n'), tag: 'digest', url: `${site || ''}${path}`, badge: digest.overdue.length + digest.dueToday.length })
          if (failed.length) failures.push(`digest ${u.user_id}: ${failed.map(f => f.statusCode).join(',')}`)
          sent += Math.max(0, liveSubs.length - failed.length)
        }
        // no key on the host: the switch in Settings says email is not set up here, so there is nothing to record
        if (u.digest_email && emailConfigured()) {
          const email = await userEmail(u.user_id).catch(() => null)
          const plan = sunday ? (weekPlan ? `Plan the week: ${site}${path}` : null) : `Plan your day: ${site}${path}`
          const emailed = email
            ? await sendEmail(email, `Today in Drafter: ${digest.dueToday.length} due, ${digest.overdue.length} overdue`, [...digest.lines, '', ...(plan ? [plan] : []), `Open Drafter: ${site}/`].join('\n')).catch(() => false)
            : false
          if (!emailed) failures.push(`digest email ${u.user_id}: ${email ? 'the email service refused it' : 'no address to send to'}`)
        }
      }

      for (const t of nudges) {
        const to = browsers()
        if (!to.length) break
        const { failed } = await applySend({ title: `Due now: ${t.title || 'Untitled task'}`, body: t.description ? t.description.slice(0, 120) : 'Open Drafter for the details.', tag: `due-${t.id}`, url: `${site || ''}/?task=${encodeURIComponent(t.id)}`, badge: 1 }, to)
        if (failed.length) failures.push(`nudge ${u.user_id}: ${failed.map(f => f.statusCode).join(',')}`)
        sent += Math.max(0, to.length - failed.length)
      }

      // a device the push service says is gone, or whose APNs host was learned
      if (liveSubs !== subs) {
        await rest(settingsPath, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ push_subscriptions: liveSubs }) })
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
  run.counts = { subscribers: active.length, sent, drafted }
  return new Response(report, { status: 200 })
}
