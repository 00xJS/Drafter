// Email-in: a per-user webhook that turns an email into a task.
//   POST /api/inbound?key=<inbound_token>
// Accepts Mailgun Routes (form: subject, body-plain, body-html, sender,
// Message-Id), SendGrid Inbound Parse (multipart: subject, text, html, from,
// headers), Cloudflare Email Workers / Zapier / Make (JSON: { subject, text,
// html, from, messageId }). The token is the only auth, so it is long, per
// user and rotatable from Settings, and one token files at most so many
// emails in ten minutes.
//
// The raw task is stored under its owner and the webhook answers at once. The
// model's second pass — a title, a due date read in the owner's zone, a
// priority — runs in the background function (lib/triage.mjs), which has a
// minute and a half where this had nine seconds against a model that takes
// twenty or more.
//
// An email is filed once. Its task's id is made from its owner and its
// Message-ID, so a mail service delivering it again — after a timeout, or the
// 503 below — finds the task it made the first time rather than making a
// second. An email with no Message-ID gets a fresh id, as before.
//
// Whose task it is matters most. sync_posts under the service key files a new
// row under the site owner, and the next call hands it to the token's owner.
// That hand-over used to be fire-and-forget, so an email sent to the other
// member's address could stay filed as the site owner's with nothing said. It
// is tried twice now, and when it still fails the webhook answers 503: the
// mail service tries again, and the retry, finding the task by its id, hands
// it over then.
//
// Every outbound call runs against one deadline (BUDGET_MS), so one slow
// answer from Supabase cannot hold the webhook open until the platform kills it.

import { createHash } from 'node:crypto'
import { newerStamp } from '../../shared/domain.mts'
import { resolveProvider } from './lib/ai.mjs'
import { siteOrigin, startJob } from './lib/aijobs.mjs'
import { slidingWindow } from './lib/ratelimit.mjs'
import { readableText } from './lib/recipeimport.mjs'
import { settingsFind, settingsStoreConfigured } from './lib/session.mjs'
import { keyHeaders } from './lib/supabasekeys.mjs'
import { validTimeZone } from './lib/timezone.mjs'

const MAX_BODY = 4000
/** The whole webhook, from arrival to answer. */
export const BUDGET_MS = 9_000
/** The longest any single call may take. */
export const CALL_MS = 4_000
/** Emails one token may file in RATE_WINDOW_MS; past it the mail service is told to try again later. */
export const RATE_LIMIT = 30
export const RATE_WINDOW_MS = 10 * 60_000

// per token, in this instance's memory (lib/ratelimit.mjs): enough to stop a
// forwarding loop or a leaked address filing hundreds of tasks, and asking
// the model hundreds of times
const perToken = slidingWindow({ limit: RATE_LIMIT, windowMs: RATE_WINDOW_MS })

/** Run `work(signal)`, aborting it after `ms`. */
async function withTimeout(ms, work) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), Math.max(0, ms))
  try {
    return await work(ctrl.signal)
  } finally {
    clearTimeout(timer)
  }
}

/** The first of these that has something in it: a mail service sends an empty text part as "" as often as it leaves it out. */
const firstText = (...values) => values.map(v => (typeof v === 'string' ? v : v == null ? '' : String(v))).find(v => v.trim()) ?? ''

/** A Message-ID as written, without its angle brackets, or '' for none. */
function cleanMessageId(value) {
  const id = String(value ?? '')
    .trim()
    .replace(/^<|>$/g, '')
    .trim()
  return id.length > 0 && id.length <= 998 && !/\s/.test(id) ? id : ''
}

/** The Message-ID in a block of raw headers (SendGrid's `headers`), folded lines and all. */
function messageIdInHeaders(raw) {
  const unfolded = String(raw ?? '').replace(/\r?\n[ \t]+/g, ' ')
  return cleanMessageId(/^message-id:\s*(.+)$/im.exec(unfolded)?.[1])
}

/** The Message-ID a JSON body carries, however the sender named it. */
function jsonMessageId(j) {
  const direct = firstText(j.messageId, j.message_id, j.messageID, j['Message-ID'], j['Message-Id'], j['message-id'])
  if (direct) return cleanMessageId(direct)
  const h = j.headers
  if (typeof h === 'string') return messageIdInHeaders(h)
  if (Array.isArray(h)) return cleanMessageId(h.find(x => Array.isArray(x) && /^message-id$/i.test(String(x[0])))?.[1])
  if (h && typeof h === 'object') return cleanMessageId(Object.entries(h).find(([k]) => /^message-id$/i.test(k))?.[1])
  return ''
}

/** Mailgun's `message-headers`: a JSON list of [name, value] pairs. */
function mailgunMessageId(raw) {
  try {
    const list = JSON.parse(String(raw ?? ''))
    return Array.isArray(list) ? cleanMessageId(list.find(x => Array.isArray(x) && /^message-id$/i.test(String(x[0])))?.[1]) : ''
  } catch {
    return ''
  }
}

/**
 * The email as the mail service sent it: subject, the text part — or, when
 * that is empty or missing, the HTML part as readable text — sender, and
 * Message-ID. An empty text part used to win over the HTML one, and an
 * HTML-only email filed a task with nothing in it.
 */
async function parseBody(req) {
  const type = req.headers.get('content-type') ?? ''
  let mail = { subject: '', text: '', html: '', from: '', messageId: '' }
  if (type.includes('application/json')) {
    const j = await req.json().catch(() => ({}))
    const o = j && typeof j === 'object' ? j : {}
    mail = {
      subject: firstText(o.subject, o.Subject),
      text: firstText(o.text, o['body-plain'], o['stripped-text'], o.body, o.plain),
      html: firstText(o.html, o['body-html'], o['stripped-html']),
      from: firstText(o.from, o.sender, o.From),
      messageId: jsonMessageId(o),
    }
  } else if (type.includes('multipart/form-data') || type.includes('application/x-www-form-urlencoded')) {
    const form = await req.formData().catch(() => null)
    const get = k => (form?.get(k) ?? '').toString()
    mail = {
      subject: firstText(get('subject'), get('Subject')),
      text: firstText(get('body-plain'), get('text'), get('stripped-text'), get('plain')),
      html: firstText(get('body-html'), get('html'), get('stripped-html')),
      from: firstText(get('sender'), get('from'), get('From')),
      messageId: cleanMessageId(firstText(get('Message-Id'), get('Message-ID'), get('message-id'))) || mailgunMessageId(get('message-headers')) || messageIdInHeaders(get('headers')),
    }
  } else {
    mail.text = await req.text().catch(() => '')
  }
  if (!mail.text.trim() && mail.html.trim()) mail.text = readableText(mail.html, MAX_BODY)
  return mail
}

/**
 * The task's title from a subject: every "Re:", "Fwd:" and "FW:" in front of
 * it, however many and however written ("RE[2]:", "Fwd:Re:"), taken off. The
 * first line of the body stands in for a subject that is only those.
 */
export function titleFromMail(subject, text) {
  const strip = s =>
    String(s ?? '')
      .replace(/^(?:\s*(?:re|fwd?|fw|aw|wg)(?:\s*\[\d+\])?\s*:)+/i, '')
      .trim()
  return (strip(subject) || strip(String(text ?? '').split('\n').find(l => l.trim()) ?? '') || 'Email').slice(0, 140)
}

/** The task id an email is filed under: from its owner and Message-ID when it has one, so a delivery made again finds it. */
export function mailTaskId(userId, messageId) {
  if (!messageId) return `mail-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return `mail-${createHash('sha256').update(`${userId}\n${messageId}`).digest('base64url').slice(0, 22)}`
}

export default async req => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  if (!settingsStoreConfigured()) return new Response('Not configured', { status: 501 })
  const deadline = Date.now() + BUDGET_MS
  const left = (cap = CALL_MS) => Math.min(cap, deadline - Date.now())
  const url = new URL(req.url)
  const key = url.searchParams.get('key') ?? ''
  if (key.length < 16) return new Response('Not found', { status: 404 })
  // before anything is looked up: a flood costs this instance nothing more
  const slot = perToken.take(key)
  if (!slot.ok) return new Response('Too many emails — try again later', { status: 429, headers: { 'retry-after': String(Math.max(1, Math.ceil(slot.retryAfterMs / 1000))) } })
  let row
  try {
    row = await withTimeout(left(), signal => settingsFind('inbound_token', key, { signal }))
  } catch {
    // a slow or unreachable store means "try again later", not "no such address"
    return new Response('Temporarily unavailable', { status: 503 })
  }
  if (!row) return new Response('Not found', { status: 404 })

  const { subject, text, from, messageId } = await parseBody(req)
  const body = text.toString().replace(/\r\n/g, '\n').trim().slice(0, MAX_BODY)
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_KEY
  const supabase = (path, init) =>
    withTimeout(left(), signal =>
      fetch(`${supabaseUrl}/rest/v1/${path}`, {
        ...init,
        signal,
        headers: keyHeaders(serviceKey, { 'content-type': 'application/json', ...(init.headers ?? {}) }),
      }),
    )
  const id = mailTaskId(row.user_id, messageId)
  // the task to its owner: tried twice, and a refusal both times is a 503 — never a task left under the site owner in silence
  const handOver = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await supabase(`posts?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ user_id: row.user_id }) }).catch(() => null)
      if (res?.ok) return true
    }
    return false
  }
  const unavailable = () => new Response('Temporarily unavailable', { status: 503 })
  // the second pass, in the background: it has time this webhook does not
  const triage = async updatedAt => {
    if (!resolveProvider()) return 'off'
    const job = { type: 'triage', userId: row.user_id, taskId: id, updatedAt, subject, text: body, from, tz: validTimeZone(row.timezone) ?? 'UTC' }
    return left() > 0 && (await startJob(job, { origin: siteOrigin(url.origin), timeoutMs: left() })) ? 'started' : 'not started'
  }

  // delivered before: the task it made then stands — and when the hand-over
  // failed that time (the 503 below), it is handed over now and triaged now
  if (messageId) {
    const seen = await supabase(`posts?id=eq.${encodeURIComponent(id)}&select=user_id,data`, { method: 'GET' })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
    if (!Array.isArray(seen)) return unavailable()
    if (seen[0]) {
      const stranded = seen[0].user_id !== row.user_id
      if (stranded && !(await handOver())) return unavailable()
      return Response.json({ ok: true, id, title: seen[0].data?.title ?? '', duplicate: true, ...(stranded ? { triage: await triage(seen[0].data?.updatedAt) } : {}) })
    }
  }

  const stamp = new Date().toISOString()
  const task = {
    kind: 'task',
    id,
    title: titleFromMail(subject, body),
    description: body,
    status: 'todo',
    priority: 'normal',
    createdAt: stamp,
    updatedAt: newerStamp(),
    tags: ['email'],
    notes: from ? `From: ${from}` : undefined,
    link: (body.match(/https?:\/\/\S+/) ?? [])[0],
  }
  // a future cursor means the RPC returns nothing: without it every inbound
  // email makes Postgres aggregate the entire table into one json document
  const stored = await supabase('rpc/sync_posts', { method: 'POST', body: JSON.stringify({ incoming: [task], since: new Date(Date.now() + 86_400_000).toISOString() }) }).catch(() => null)
  if (!stored?.ok) return new Response('store failed', { status: 502 })
  const verdict = await stored.json().catch(() => null)
  if (Array.isArray(verdict?.rejected) && verdict.rejected.includes(id)) return new Response('store refused', { status: 502 })
  // deleted forever since an earlier delivery made it: it stays deleted
  if (Array.isArray(verdict?.gone) && verdict.gone.includes(id)) return Response.json({ ok: true, id, title: task.title, duplicate: true })
  if (!(await handOver())) return unavailable()
  return Response.json({ ok: true, id, title: task.title, triage: await triage(task.updatedAt) })
}
