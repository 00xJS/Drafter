// Telling the other member: POST /api/notify, in one of two shapes.
//   { taskId, events: [{ type: 'status' | 'checklist' | 'comment' | 'due' | 'title' | 'assigned', detail?, done? }] }
//     what changed on a task you share;
//   { messageId }
//     a message you sent the household (the Household side of the chat).
//
// The device of whoever made a change, or said something, calls this with
// their own session once the server has it (src/activity.ts). It names what
// happened; this decides who hears of it, writes their notice for the hub on
// Home, and pushes it to their devices.
//
// A task. Who: the rule is shared/notices.mts noticeRecipients — whoever
// handed the task over hears what its assignee does, the assignee hears what
// changes their job, a shared task's owner hears it finished or commented on
// — and never the one who did it. Then three checks here, because the service
// key this reads with bypasses every policy (readableRow is the one rule): the
// actor must be able to read the task, and each recipient must be in the
// actor's household and able to read it too. A task its owner keeps private
// tells nobody anything. A recipient who switched "Tell me when someone
// updates a task we share" off (Settings → Notifications) gets neither.
//
// What: one notice per recipient, task and quarter of an hour (lib/notices.mjs
// merges the rest in as lines), and a push under the tag task-<id>, so the
// banner on the lock screen is replaced rather than stacked. The words are the
// task's title, a checklist step, a comment — never anything else.
//
// A message. It must be filed under the caller: a member can write a row
// under their housemate, so a row's owner is no proof of who said it, and the
// name the notice gives is the caller's own, from their session, never the
// row's. It must be live, in the caller's household, and readable by them
// (readableRow again, as the service key reads it). Everyone else in the
// household who can read it hears of it; the one who said it never does.
// There is no switch for it: a phone's own notification settings quiet it.
//
// What: one notice per recipient, sender and quarter of an hour, a line per
// message in its own words — the stored row's, never the request's. A message
// the notice holds already is not added again, nor pushed again, so a retry
// tells nobody twice (shared/notices.mts mergeMessageNotice). The push is
// headed with the sender's name and says the notice's lines, the latest last,
// under the tag messages-<sender>: the lock screen keeps one banner per sender,
// which each message renews and sounds. A tap opens the chat on its Household
// side (?chat=household).
//
// A ceiling per account on calls, one for tasks and one for messages, so a
// lively chat never holds up word of a task. Counted across instances, as
// /api/ai's is (lib/ratelimit.mjs, v3.33): each instance's own count alone let
// calls spread over cold starts through, and falls back to that only while the
// shared count cannot be reached.

import { isRecord, legacyPostToTask } from '../../shared/domain.mts'
import { readableRow } from '../../shared/kinds.mts'
import {
  ACTIVITY_TYPES,
  activityLine,
  dueWords,
  mergeMessageNotice,
  messageNotice,
  messagesAbout,
  noticeBucket,
  noticeId,
  noticeRecipients,
  noticeTitle,
  noticeTypeOf,
  oneLine,
} from '../../shared/notices.mts'
import { withCors } from './lib/cors.mjs'
import { putNotice } from './lib/notices.mjs'
import { sharedWindow } from './lib/ratelimit.mjs'
import { requireUser, settingsGet, settingsSet, settingsStoreConfigured } from './lib/session.mjs'
import { keyHeaders } from './lib/supabasekeys.mjs'
import { pushConfigured, sendToAll } from './push.mjs'

/** The largest body read: twenty events at their caps come to well under this. */
const MAX_BODY = 32 * 1024
const MAX_EVENTS = 20
const MAX_DETAIL = 2000
// 30 calls per 10 minutes per account: a device sends one a task every ten seconds at most
const perActor = sharedWindow({ bucket: 'notify', limit: 30, windowMs: 10 * 60_000 })
// 60 per 10 minutes for messages, one call a message: counted apart, so a lively chat never starves the tasks'
const perActorMessages = sharedWindow({ bucket: 'notify-message', limit: 60, windowMs: 10 * 60_000 })

async function rest(path) {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const res = await fetch(`${url}/rest/v1/${path}`, { headers: keyHeaders(process.env.SUPABASE_SERVICE_KEY, { 'content-type': 'application/json' }) })
  if (!res.ok) throw new Error(`${path.split('?')[0]}: ${res.status}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

/**
 * The body's events, each checked: a known type, its detail one string at
 * most, `done` a boolean. Null when anything is off.
 * @returns {import('../../shared/notices.mts').ActivityEvent[] | null}
 */
export function readEvents(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_EVENTS) return null
  const out = []
  for (const e of raw) {
    if (!isRecord(e)) return null
    const type = /** @type {import('../../shared/notices.mts').ActivityType} */ (e.type)
    const { detail, done } = e
    if (!ACTIVITY_TYPES.includes(type)) return null
    if (detail !== undefined && typeof detail !== 'string') return null
    if (done !== undefined && typeof done !== 'boolean') return null
    out.push({ type, ...(typeof detail === 'string' ? { detail: detail.slice(0, MAX_DETAIL) } : {}), ...(typeof done === 'boolean' ? { done } : {}) })
  }
  return out
}

/** Everyone in the household `userId` belongs to, them included. */
async function householdOf(userId) {
  const mine = await rest(`household_members?user_id=eq.${encodeURIComponent(userId)}&select=household_id&limit=1`)
  const hid = Array.isArray(mine) ? mine[0]?.household_id : null
  if (!hid) return new Set([userId])
  const rows = await rest(`household_members?household_id=eq.${encodeURIComponent(hid)}&select=user_id`)
  return new Set([userId, ...(Array.isArray(rows) ? rows.map(r => r.user_id) : [])])
}

/** What the recipient's notice says: a line per change, in their zone, and the due date with a hand-over. */
export function noticeLines(events, task, tz) {
  const lines = []
  for (const e of events) {
    const line = e.type === 'assigned' ? (task.dueAt ? `Due ${dueWords(task.dueAt, tz)}` : null) : activityLine(e, tz)
    if (line && !lines.includes(line)) lines.push(line)
  }
  return lines
}

/**
 * Push `payload` to every device `recipientId` has push on for, and take off
 * their list any a push service says is gone (keeping what Apple said of an
 * iPhone's environment on the ones that stay).
 */
async function pushTo(recipientId, settings, payload) {
  const subs = Array.isArray(settings?.push_subscriptions) ? settings.push_subscriptions : []
  if (!subs.length || !pushConfigured()) return
  const { gone, updated } = await sendToAll(subs, payload)
  if (gone.length || updated?.length) {
    const byEp = new Map((updated ?? []).map(u => [u.endpoint, u]))
    await settingsSet(recipientId, { push_subscriptions: subs.filter(s => !gone.includes(s.endpoint)).map(s => byEp.get(s.endpoint) ?? s) }).catch(() => {})
  }
}

/** Over a ceiling: when to try again. */
const tooMany = slot =>
  Response.json({ error: 'Too many updates at once — they will go out shortly.' }, { status: 429, headers: { 'retry-after': String(Math.ceil(slot.retryAfterMs / 1000)) } })

/** What changed on a task, told to whoever it concerns. */
async function tellTask(user, body) {
  const slot = await perActor.take(user.id)
  if (!slot.ok) return tooMany(slot)
  const taskId = typeof body?.taskId === 'string' ? body.taskId.trim() : ''
  const events = readEvents(body?.events)
  if (!taskId || taskId.length > 200 || !events) return Response.json({ error: 'A task and what changed on it, please.' }, { status: 400 })

  try {
    // the task as the database holds it, read with the service key — so the
    // policy's question is asked here, of the actor first
    const rows = await rest(`posts?id=eq.${encodeURIComponent(taskId)}&select=user_id,data`)
    const row = Array.isArray(rows) ? rows[0] : null
    const data = row ? legacyPostToTask(row.data) : null
    const owner = row?.user_id ?? null
    const household = await householdOf(user.id)
    const seen = !!data && isRecord(data) && data.kind === 'task' && !data.deletedAt && !!owner && household.has(owner) && readableRow(data, owner, user.id)
    // a task this member cannot read is one that does not exist, as far as they can tell
    if (!seen) return Response.json({ error: 'No such task.' }, { status: 404 })
    const task = /** @type {import('../../src/types.ts').Task} */ ({ ...data, ownerId: owner })

    const me = await settingsGet(user.id).catch(() => null)
    const actorName = oneLine(me?.display_name || user.email.split('@')[0] || '', 40)
    const renamed = [...events].reverse().find(e => e.type === 'title' && e.detail?.trim())
    const taskTitle = renamed?.detail ?? task.title
    const site = process.env.URL || process.env.DEPLOY_PRIME_URL || ''
    const now = new Date()
    const stamp = now.toISOString()

    let notified = 0
    for (const [recipientId, theirs] of noticeRecipients(task, user.id, events)) {
      // only a member of this household who can read the task, and who wants to hear
      if (!household.has(recipientId) || !readableRow(data, owner, recipientId)) continue
      const settings = await settingsGet(recipientId).catch(() => null)
      if (settings?.notify_activity === false) continue
      const type = noticeTypeOf(theirs)
      /** @type {import('../../src/types.ts').Notice} */
      const notice = {
        kind: 'notice',
        id: noticeId(recipientId, taskId, noticeBucket(now.getTime())),
        at: stamp,
        type,
        actorId: user.id,
        target: { kind: 'task', id: taskId },
        title: noticeTitle(type, actorName, taskTitle),
        lines: noticeLines(theirs, task, settings?.timezone),
        createdAt: stamp,
        updatedAt: stamp,
      }
      const put = await putNotice(notice, recipientId)
      if (!put.ok) continue
      notified++
      const lines = put.notice.lines ?? []
      await pushTo(recipientId, settings, {
        title: put.notice.title,
        body: lines.length ? lines.join('\n') : 'Open Drafter for the details.',
        // one banner per task: a later push replaces the earlier on the lock
        // screen, and a browser sounds it again rather than swapping it silently
        tag: `task-${taskId}`,
        renotify: true,
        url: `${site}/?task=${encodeURIComponent(taskId)}`,
      })
    }
    return Response.json({ ok: true, notified })
  } catch (e) {
    return Response.json({ error: `Could not tell them: ${e?.message ?? e}` }, { status: 502 })
  }
}

/** A message the caller sent the household, told to everyone else in it. */
async function tellMessage(user, body) {
  const slot = await perActorMessages.take(user.id)
  if (!slot.ok) return tooMany(slot)
  const messageId = typeof body.messageId === 'string' ? body.messageId.trim() : ''
  // a message, and nothing of a task's beside it
  if (!messageId || messageId.length > 200 || 'taskId' in body || 'events' in body) return Response.json({ error: 'A message, please.' }, { status: 400 })

  try {
    // the message as the database holds it, read with the service key
    const rows = await rest(`posts?id=eq.${encodeURIComponent(messageId)}&select=user_id,data`)
    const row = Array.isArray(rows) ? rows[0] : null
    const data = isRecord(row?.data) ? row.data : null
    const owner = row?.user_id ?? null
    const words = typeof data?.body === 'string' ? data.body : ''
    const household = await householdOf(user.id)
    // the caller's own: filed under them — which alone is no proof they wrote
    // it, but the name told is theirs, from their session — live, with
    // something said, in their household and readable by them
    const said = !!data && data.kind === 'message' && !data.deletedAt && !!words.trim() && owner === user.id && household.has(owner) && readableRow(data, owner, user.id)
    if (!said) return Response.json({ error: 'No such message.' }, { status: 404 })

    const me = await settingsGet(user.id).catch(() => null)
    const senderName = oneLine(me?.display_name || user.email.split('@')[0] || '', 40)
    /** @type {import('../../shared/notices.mts').ToldMessage} */
    const told = { id: messageId, body: words, createdAt: typeof data.createdAt === 'string' ? data.createdAt : undefined, senderId: user.id, senderName }
    const site = process.env.URL || process.env.DEPLOY_PRIME_URL || ''
    const now = new Date()

    let notified = 0
    for (const recipientId of household) {
      // everyone else in the household who can read it; never the one who said it
      if (recipientId === user.id || !readableRow(data, owner, recipientId)) continue
      const put = await putNotice(messageNotice(recipientId, told, now), recipientId, (had, news) => mergeMessageNotice(had, news, senderName))
      // nothing written (no notices on this database yet), or nothing new: this
      // message was told already, by a retry or another tab, and is not pushed again
      if (!put.ok || put.unchanged) continue
      notified++
      const settings = await settingsGet(recipientId).catch(() => null)
      const lines = put.notice.lines ?? []
      await pushTo(recipientId, settings, {
        title: senderName || 'Someone',
        body: lines.length ? lines.join('\n') : 'Open Drafter to read it.',
        // one banner per sender: each message renews it, and a browser sounds
        // it again rather than swapping the words silently
        tag: messagesAbout(user.id),
        renotify: true,
        url: `${site}/?chat=household`,
      })
    }
    return Response.json({ ok: true, notified })
  } catch (e) {
    return Response.json({ error: `Could not tell them: ${e?.message ?? e}` }, { status: 502 })
  }
}

const handler = async req => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const { user, response } = await requireUser(req)
  if (response) return response
  if (!settingsStoreConfigured()) return Response.json({ error: 'Notices need SUPABASE_SERVICE_KEY on the host.' }, { status: 501 })

  const text = await req.text()
  if (text.length > MAX_BODY) return Response.json({ error: 'That is too much to send at once.' }, { status: 413 })
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 })
  }
  // which of the two it is decides which ceiling the call counts against
  return isRecord(body) && 'messageId' in body ? tellMessage(user, body) : tellTask(user, body)
}

export default withCors(handler)
