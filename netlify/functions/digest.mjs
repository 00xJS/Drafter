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
// Sunday's review draft is for every account, push and email or not, and is
// written by the background function (ai-jobs-background.mjs,
// lib/sundaydraft.mjs), not here: the model takes 20 to 60 seconds and this
// run has 30 for everyone. From the hour before an account's digest hour on
// its Sunday, a run that finds its review still wanting a draft names it to
// the background function, which has minutes; the next two hours' runs do
// the same if that try got no answer (lib/reviewweek.mjs sundayDraftStarts).
// The digest itself only reads the week's review, and ends Sunday's with its
// first sentence, or with the invitation to look back while there is none.
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
//
// A digest or an alarm that went out is also kept for its reader as a notice
// (v3.32, lib/notices.mjs): the hub on Home lists it, so one swiped away
// unread on the lock screen can still be read.
//
// On the 1st of each month, from its digest hour, an account is also sent
// last month's highlights (lib/recap.mjs): Insights' own lines, counted as
// Insights counts them, once — the notice for that month is its watermark,
// written first. The rows are the digest's, plus that member's journal,
// habits and clothes, read only on a run where a recap is still to go.
//
// Most hours are quiet: no account's morning digest, Sunday draft or recap is
// due, and all a run can send is "Due now". user_settings, read first, says
// which hour this is, and a quiet one reads only the tasks that can come due
// now (dueWindowPath) — or nothing, with no browser to nudge — where every
// hour used to read every row of the digest's eight kinds.

import { buildDigest, localParts, visibleItemsFor } from '../../shared/digest.mts'
import { isMineTask } from '../../shared/domain.mts'
import { hasDueTime } from '../../shared/due.mts'
import { SYNC_KINDS, kindOf } from '../../shared/kinds.mts'
import { proposeWeek, weekPlanSummary } from '../../shared/weekplan.mts'
import { resolveProvider } from './lib/ai.mjs'
import { startJob } from './lib/aijobs.mjs'
import { restAll } from './lib/backup.mjs'
import { canaryAlert, nextCanaryRecord, readCanary, runSyncCanary, writeCanary } from './lib/canary.mjs'
import { emailConfigured, sendEmail } from './lib/email.mjs'
import { recordJobRun } from './lib/jobhealth.mjs'
import { putNotice } from './lib/notices.mjs'
import { noticeId } from '../../shared/notices.mts'
import { buildPeerMap as peerMap } from './lib/peers.mjs'
import { recipeNightAccounts, recipeNightStarts, startRecipeNight } from './lib/recipedrafts.mjs'
import { sundayDraftStarts, sundayLine } from './lib/reviewweek.mjs'
import { signInLine } from './lib/signins.mjs'
import { wantsDraft, weekReviewOf } from './lib/sundaydraft.mjs'
import { keyHeaders } from './lib/supabasekeys.mjs'
import { pushConfigured, sendToAll } from './push.mjs'
import { RECAP_KINDS, buildRecap, keepWritten, recapDue, recapNotice, recapNoticeId, recapPath, recapQuietMark } from './lib/recap.mjs'

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
 * The kinds a digest reads: the day's tasks, the people and places it nudges
 * about, tonight's dinner and its recipe, events (who was seen, and the week
 * plan's busy evenings), the project the week plan's Top 3 come from, and the
 * reviews (Sunday's line). It used to read every row of every kind each hour
 * — notes, wardrobe, chat and all — to use these.
 */
export const DIGEST_KINDS = Object.freeze(['task', 'project', 'person', 'place', 'meal', 'recipe', 'event', 'review'])

/** An account's morning digest is due: once per local day, at or after its hour (8am unless it chose another). */
function morningDue(u, now) {
  const { hour, day } = localParts(now, u.timezone || 'UTC')
  if (hour === null || day === null) return false
  const wantHour = Number.isInteger(u.digest_hour) ? u.digest_hour : 8
  return hour >= wantHour && u.last_digest_day !== day
}

/** An account a "Due now" can reach: push is set up here and it has a browser to push to (the iOS app keeps its own reminders). */
const nudgeable = u => pushConfigured() && (u.push_subscriptions ?? []).some(s => s?.type !== 'apns')

/**
 * The rows a quiet hour reads: the tasks that can come due now, open (a row
 * from before v3, with no kind, is read whatever its status says, as it reads
 * as a task only once converted), their due date (due_at, stored as text) in
 * a window a day wider on each side than the furthest a nudge reaches back
 * (MAX_NUDGE_WINDOW), so an instant written with an offset is inside it too.
 * The run then keeps, as it always did, only those due since each account's
 * last check.
 */
export function dueWindowPath(now) {
  const day = ms => new Date(ms).toISOString().slice(0, 10)
  const from = day(now.getTime() - MAX_NUDGE_WINDOW - DAY)
  const to = day(now.getTime() + 2 * DAY)
  return `posts?select=id,data,user_id&deleted=is.false&kind=eq.task&or=(data->>kind.is.null,status.in.(${OPEN.join(',')}))&due_at=gte.${from}&due_at=lt.${to}`
}

async function rest(path, init = {}) {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: keyHeaders(key, { 'content-type': 'application/json', ...(init.headers ?? {}) }) })
  if (!res.ok) throw new Error(`${path.split('?')[0]}: ${res.status}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

async function userEmail(userId) {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  const res = await fetch(`${url}/auth/v1/admin/users/${userId}`, { headers: keyHeaders(key) })
  if (!res.ok) return null
  return (await res.json())?.email ?? null
}

// Admin's digest preview emails through the same sender (lib/email.mjs)
export { sendEmail }

/** userId -> the set of owner ids whose records that user may see (lib/peers.mjs); Admin reads it through here. */
export const buildPeerMap = () => peerMap(rest)

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
    if (told) {
      const alertedAt = now.toISOString()
      record.alertedAt = alertedAt
      // kept in the owner's hub too, as the push or email was worded
      await keepNotice(ownerId, { id: noticeId(ownerId, 'alarm', alertedAt), type: 'alarm', title, lines: [body] }, now).catch(e =>
        console.error(`digest: the alarm's notice was not kept: ${e?.message ?? e}`),
      )
    }
  }
  await writeCanary(rest, record).catch(() => {})
  return record
}

/**
 * A server push that is not about a task — the morning digest, an alarm — kept
 * for its reader in the notification hub, as the lock screen said it. Resolves
 * false when the kind is not stored yet (the v3.32 migration), and throws when
 * the database could not be reached.
 * @param {string} userId
 * @param {{ id: string, type: import('../../src/types.ts').NoticeType, title: string, lines: string[], target?: import('../../src/types.ts').Notice['target'] }} what
 * @param {Date} now
 */
async function keepNotice(userId, { id, type, title, lines, target }, now) {
  const stamp = now.toISOString()
  const put = await putNotice(
    { kind: 'notice', id, at: stamp, type, title, lines: lines.slice(0, 8), ...(target ? { target } : {}), createdAt: stamp, updatedAt: stamp },
    userId,
  )
  return put.ok
}

/**
 * The monthly recaps this hour still has to send: each account whose 1st it
 * is, from its digest hour (recapDue), whose notice for the month is not
 * written yet — asked in one read — and those accounts' own journal, habits
 * and clothes, the only rows a recap reads that the digest does not. A run
 * with no recap to send reads nothing more at all.
 * @param {{ user_id: string, timezone?: string | null, digest_hour?: number | null }[]} active the accounts with the digest on
 * @param {Date} now
 * @param {string | null} _ownerId not read: posts.user_id is NOT NULL (2026-09-08), so no row is unowned
 */
async function recapsToSend(active, now, _ownerId) {
  /** @type {Map<string, string>} */
  const due = new Map()
  for (const u of active) {
    const month = u.user_id ? recapDue(u, now) : null
    if (month) due.set(u.user_id, month)
  }
  if (!due.size) return { due, rows: [] }
  const ids = [...due].map(([userId, month]) => recapNoticeId(userId, month))
  const written = /** @type {{ id: string }[] | null} */ (await rest(`posts?select=id&id=in.(${ids.map(encodeURIComponent).join(',')})`))
  const gone = new Set((written ?? []).map(r => r.id))
  for (const [userId, month] of [...due]) if (gone.has(recapNoticeId(userId, month))) due.delete(userId)
  if (!due.size) return { due, rows: [] }
  const who = [...due.keys()].map(encodeURIComponent).join(',')
  const whose = `user_id=in.(${who})`
  const rows = /** @type {{ user_id: string | null, data: unknown }[]} */ (await restAll(`posts?select=id,data,user_id&deleted=is.false&kind=in.(${RECAP_KINDS.join(',')})&${whose}`))
  return { due, rows }
}

/**
 * One account's recap: counted as Insights counts, and its notice written
 * for its month. Resolves what to push — or null when the month held nothing
 * worth saying (marked done all the same, recapQuietMark, so the hours after
 * this one do not count it again), when the notice was there already (another
 * run sent it), or when notices cannot be kept yet, since a push with no
 * watermark behind it could go again an hour later.
 * @param {{ user_id: string, timezone?: string | null }} u
 * @param {{ user_id: string | null, data: unknown }[]} rows the digest's
 * @param {{ user_id: string | null, data: unknown }[]} personal the recap's own read
 * @param {Iterable<string> | undefined} peerIds
 * @param {string | null} ownerId
 * @param {Date} now
 * @param {string} month
 */
async function claimRecap(u, rows, personal, peerIds, ownerId, now, month) {
  const recap = buildRecap(
    // the digest's kinds from its own read, and the recap's personal kinds from
    // this member's alone, whatever either read brought back
    [
      ...rows.filter(r => DIGEST_KINDS.includes(String(kindOf(r.data)))),
      ...personal.filter(r => RECAP_KINDS.includes(String(kindOf(r.data))) && (r.user_id === u.user_id || (r.user_id === null && u.user_id === ownerId))),
    ],
    u.user_id,
    peerIds,
    ownerId,
    u.timezone,
    now,
    month,
  )
  if (!recap.lines.length) {
    await putNotice(recapQuietMark(u.user_id, month, now), u.user_id, keepWritten)
    return null
  }
  const put = await putNotice(recapNotice(u.user_id, recap, now), u.user_id, keepWritten)
  return put.ok && !put.unchanged ? recap : null
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
  // Sunday's draft is started even with nobody subscribed, on a Sunday hour
  // that starts one somewhere: {} stands for an account with no settings row
  const drafting = !!resolveProvider() && [...(users ?? []), {}].some(u => sundayDraftStarts(u, now))
  // …and the nightly recipe drafts, in the small hours somewhere (lib/recipedrafts.mjs)
  const recipeNight = !!resolveProvider() && [...(users ?? []), {}].some(u => recipeNightStarts(u, now))
  run.counts = { subscribers: active.length, sent: 0, draftsStarted: 0 }
  if (active.length === 0 && !drafting && !recipeNight) return new Response(`no subscribers; ${checked}`, { status: 200 })

  // the monthly recaps still to go this hour, and the rows only they read
  const recaps = await recapsToSend(active, now, ownerId).catch(e => {
    run.failures.push(`recap: ${e?.message ?? e}`)
    return { due: new Map(), rows: [] }
  })
  // A quiet hour — no morning digest, Sunday draft or recap due anywhere —
  // can only send "Due now": it reads just the tasks that can come due now,
  // and nothing with no browser to nudge.
  const quiet = !drafting && recaps.due.size === 0 && !active.some(u => morningDue(u, now))
  // keep row ownership so each recipient only ever sees their own scope. Read a
  // page at a time (restAll, as the nightly backup reads them): one request
  // stops at PostgREST's max_rows, and a read that can't be finished fails the
  // run, to be tried again the next hour, rather than send a digest from part
  // of the records. Only the kinds a digest reads (DIGEST_KINDS).
  const rows = /** @type {{ user_id: string | null, data: unknown }[]} */ (
    !quiet
      ? await restAll(`posts?select=id,data,user_id&deleted=is.false&kind=in.(${DIGEST_KINDS.join(',')})`)
      : active.some(nudgeable)
        ? await restAll(dueWindowPath(now))
        : []
  )
  const peers = await buildPeerMap()
  let sent = 0
  // the job's record reads this list as it grows, so a run that throws part-way keeps what failed before
  const failures = run.failures
  /** Accounts whose review of last week still wants Sunday's draft, for the background function. */
  const drafts = []

  // accounts whose digest may be due go first, as they did before Sunday's
  // draft ran for everyone
  const accounts = accountsOf(users, rows, ownerId)
  for (const u of [...accounts.filter(a => active.includes(a)), ...accounts.filter(a => !active.includes(a))]) {
    const subscribed = active.includes(u)
    const startsDraft = drafting && sundayDraftStarts(u, now)
    if (!subscribed && !startsDraft) continue
    try {
      const items = visibleItemsFor(rows, u.user_id, peers.get(u.user_id), ownerId)

      const tz = u.timezone || 'UTC'
      // 0. Sunday's review: read for Sunday's line, and named to the background
      //    function while it still wants a draft (lib/sundaydraft.mjs), which
      //    skips an account disabled in Admin
      const sundayHere = localParts(now, tz).weekday === 'Sun'
      const review = sundayHere ? weekReviewOf(items, u.user_id, now, tz) : null
      if (startsDraft && wantsDraft(review)) drafts.push(u.user_id)
      if (!subscribed) continue

      const { hour, day, weekday } = localParts(now, tz)
      if (hour === null || day === null) continue
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
      let morning = null
      if (morningDue(u, now)) {
        // Sunday's digest is the doorway to the weekly review, and to planning the week it starts
        const sunday = weekday === 'Sun'
        const weekPlan = sunday ? weekPlanSummary(proposeWeek(items, { todayKey: day, tz, userId: u.user_id, now })) : null
        const digest = buildDigest(items, tz, now, u.nudged ?? {}, u.user_id, { weekPlan })
        // a calendar whose sign-in died has gone quiet: said every morning until it is signed in again
        const signIn = signInLine(u)
        if (signIn) digest.lines.push(signIn)
        // the review's first sentence, drafted an hour ago or written by you; while it has none, the invitation to look back
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
          .filter(t => t.kind === 'task' && !t.deletedAt && OPEN.includes(t.status ?? '') && t.dueAt && isMineTask(t, u.user_id) && hasDueTime(t.dueAt, tz))
          .map(t => ({ t, at: Date.parse(t.dueAt ?? '') }))
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

      // 3. last month's recap, on the 1st: its notice is its watermark, written
      //    before the push, and a notice already there means it has gone
      let recap = null
      const month = recaps.due.get(u.user_id)
      if (month) {
        try {
          recap = await claimRecap(u, rows, recaps.rows, peers.get(u.user_id), ownerId, now, month)
        } catch (e) {
          failures.push(`recap ${u.user_id}: ${e?.message ?? e}`)
        }
      }

      if (morning && morning.digest.lines.length > 0) {
        const { digest, sunday, weekPlan, path } = morning
        const title = 'Good morning — today in Drafter'
        let delivered = false
        if (liveSubs.length && pushConfigured()) {
          const to = liveSubs.length
          const { failed } = await applySend({ title, body: digest.lines.join('\n'), tag: 'digest', url: `${site || ''}${path}`, badge: digest.overdue.length + digest.dueToday.length })
          if (failed.length) failures.push(`digest ${u.user_id}: ${failed.map(f => f.statusCode).join(',')}`)
          sent += Math.max(0, liveSubs.length - failed.length)
          delivered = to > failed.length
        }
        // no key on the host: the switch in Settings says email is not set up here, so there is nothing to record
        if (u.digest_email && emailConfigured()) {
          const email = await userEmail(u.user_id).catch(() => null)
          const plan = sunday ? (weekPlan ? `Plan the week: ${site}${path}` : null) : `Plan your day: ${site}${path}`
          const emailed = email
            ? await sendEmail(email, `Today in Drafter: ${digest.dueToday.length} due, ${digest.overdue.length} overdue`, [...digest.lines, '', ...(plan ? [plan] : []), `Open Drafter: ${site}/`].join('\n')).catch(() => false)
            : false
          if (!emailed) failures.push(`digest email ${u.user_id}: ${email ? 'the email service refused it' : 'no address to send to'}`)
          delivered ||= emailed
        }
        // the digest that went out, kept in the hub; Sunday's opens the review, as its push does
        if (delivered) {
          await keepNotice(u.user_id, { id: noticeId(u.user_id, 'digest', day), type: 'digest', title, lines: digest.lines, ...(sunday ? { target: { kind: 'review', id: day } } : {}) }, now).catch(e =>
            failures.push(`digest notice ${u.user_id}: ${e?.message ?? e}`),
          )
        }
      }

      // the recap's push, once its notice is kept: every device, a phone's too,
      // and a tap opens Insights on that month (useDeepLinks). Counts only on
      // the lock screen (recapPushBody); the lines, names and all, are in the bell
      if (recap && liveSubs.length && pushConfigured()) {
        const { failed } = await applySend({ title: recap.title, body: recap.push, tag: `recap-${recap.month}`, url: `${site || ''}${recapPath(recap.month)}` })
        if (failed.length) failures.push(`recap ${u.user_id}: ${failed.map(f => f.statusCode).join(',')}`)
        sent += Math.max(0, liveSubs.length - failed.length)
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

  // Sunday's drafts go to the background function, which has minutes where this
  // run has seconds; a try that gets no answer is tried again next hour
  let draftsStarted = 0
  if (drafts.length) {
    if (await startJob({ type: 'sunday-drafts', userIds: drafts, at: now.toISOString() }, { origin: site })) draftsStarted = drafts.length
    else failures.push(`Sunday's draft could not be started for ${drafts.length} account(s): the background function did not answer`)
  }

  // Recipe drafts for the households whose night it is and that have a recipe
  // still bare, subscribed or not: written by the background function too
  if (recipeNight) {
    const unstarted = await startRecipeNight(recipeNightAccounts(accounts, rows, peers, now), now, site)
    if (unstarted) failures.push(unstarted)
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

  const report = `${active.length ? `sent ${sent}` : 'no subscribers'}${draftsStarted ? `; drafts started ${draftsStarted}` : ''}; ${checked}${failures.length ? `; ${failures.length} failure(s): ${failures.slice(0, 5).join(' | ')}` : ''}`
  if (failures.length) console.error('digest:', report)
  run.counts = { subscribers: active.length, sent, draftsStarted }
  return new Response(report, { status: 200 })
}
