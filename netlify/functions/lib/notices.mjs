// Notices on the server (v3.32): writing one for its recipient, and letting
// old ones go.
//
// A notice is its RECIPIENT's row (kind 'notice', personal). Two writers make
// them — /api/notify, for a change to a task two members share and for a
// message to the household, and the hourly digest, for the morning digest and
// an alarm — and both write here.
//
// How it is written matters as much as what. sync_posts under the service key
// stores a NEW row as the site owner's (auth.uid() is null there), and the
// digest's Sunday review is handed over afterwards with a PATCH of user_id.
// That will not do for a notice. For that moment it would be the site
// owner's, and the site owner is one of the two members: their device could
// pull the other's notice then, and keep it. And the hand-over leaves
// synced_at where it was, so a recipient whose device synced in between would
// never be sent it at all. So a new notice is INSERTED straight into posts
// under its recipient, synced_at left to its default — the database's own
// clock, which is what sync_posts stamps too — and Realtime nudges that
// recipient alone, since the SELECT policy decides who hears an insert. News
// for a notice that exists already goes through sync_posts, whose update
// keeps the owner and moves synced_at, so the recipient's next round brings it.
//
// The direct insert skips sync_posts' check that the database stores the kind,
// so record_kinds is asked first: until the v3.32 migration is applied no
// notice is written at all, rather than one no device could ever mark read.

import { newerStamp } from '../../../shared/domain.mts'
import { NOTICE_KEEP_DAYS, mergeNotice } from '../../../shared/notices.mts'
import { keyHeaders } from './supabasekeys.mjs'

const DAY = 86_400_000
/** Tombstones a nightly expiry writes per sync_posts call. */
const EXPIRE_BATCH = 100
/** The most notices one night lets go; the rest wait for the next. */
const EXPIRE_MAX = 1000

function env() {
  return { url: process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_KEY }
}

/** A service-key request to PostgREST, answered as it came. */
async function request(path, init = {}) {
  const e = env()
  return fetch(`${e.url}/rest/v1/${path}`, { ...init, headers: keyHeaders(e.key, { 'content-type': 'application/json', ...(init.headers ?? {}) }) })
}

async function json(res, what) {
  if (!res.ok) throw new Error(`${what}: ${res.status}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

/** Whether the database stores notices yet: remembered once it says yes, asked again while it says no. */
let kindKnown = false
export async function noticesStored() {
  if (kindKnown) return true
  const res = await request('rpc/record_kind_allowed', { method: 'POST', body: JSON.stringify({ p_kind: 'notice' }) })
  kindKnown = (await json(res, 'record_kind_allowed')) === true
  return kindKnown
}

/** For tests: forget what the database said. */
export function forgetNoticesStored() {
  kindKnown = false
}

/** The stored row under an id, whoever it is, or null. */
async function readRow(id) {
  const rows = await json(await request(`posts?id=eq.${encodeURIComponent(id)}&select=user_id,data`), 'posts')
  return Array.isArray(rows) && rows[0] ? rows[0] : null
}

/** What sync_posts said about one id it was sent: null when it stored it. */
async function syncOne(item) {
  // a cursor in the future: the answer carries no rows, only the verdicts
  const res = await request('rpc/sync_posts', { method: 'POST', body: JSON.stringify({ incoming: [item], since: new Date(Date.now() + DAY).toISOString() }) })
  const answer = await json(res, 'sync_posts')
  for (const k of ['rejected', 'stale', 'gone']) if (Array.isArray(answer?.[k]) && answer[k].includes(item.id)) return k
  return null
}

/** A notice as the row's `data` holds it: never the owner or the arrival stamp, which the database keeps itself. */
function asData(notice) {
  const { ownerId: _o, syncedAt: _s, ...data } = notice
  return data
}

/**
 * Write `notice` for `recipientId`: a new row under them, or news folded into
 * the one already under that id — by `merge`, mergeNotice unless the caller
 * has its own (a message notice's, shared/notices.mts mergeMessageNotice).
 * Resolves { ok: true, notice } with the notice as stored, or { ok: false,
 * reason } when nothing was written: the kind not stored yet, an id that is
 * somebody else's row, or a write the database refused twice. A merge that
 * hands the stored notice back as it was has nothing new: nothing is written,
 * and { ok: true, notice, unchanged: true } says so.
 */
export async function putNotice(notice, recipientId, merge = mergeNotice) {
  if (!(await noticesStored())) return { ok: false, reason: 'the notices migration is not applied yet' }
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await readRow(notice.id)
    if (row && row.user_id !== recipientId) return { ok: false, reason: 'that id belongs to someone else' }
    if (row) {
      const next = merge(row.data, notice)
      if (next === row.data) return { ok: true, notice: asData(row.data), unchanged: true }
      const merged = asData({ ...next, updatedAt: newerStamp(row.data?.updatedAt) })
      const refused = await syncOne(merged)
      if (!refused) return { ok: true, notice: merged }
      // stale: a read mark landed in between; read it again and fold the news into that
      continue
    }
    const data = asData(notice)
    const res = await request('posts', {
      method: 'POST',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ id: data.id, updated_at: data.updatedAt, data, user_id: recipientId }),
    })
    if (res.ok) return { ok: true, notice: data }
    // 409: written by another call a moment ago — fold into that one instead
    if (res.status !== 409) throw new Error(`posts: ${res.status}`)
  }
  return { ok: false, reason: 'the database kept refusing it' }
}

/**
 * The nightly let-go: every notice older than NOTICE_KEEP_DAYS becomes the
 * content-free tombstone "Delete forever" writes (src/sync.ts purgeTombstone),
 * through sync_posts, so it keeps its recipient and every device of theirs
 * drops it on its next round. The tombstone itself goes with the rest, when
 * purged tombstones age out (lib/backup.mjs, digest.mjs). Answers how many
 * were let go; throws when the notices could not be read.
 */
export async function expireNotices(now = new Date(), keepDays = NOTICE_KEEP_DAYS) {
  if (!(await noticesStored().catch(() => false))) return 0
  const cutoff = new Date(now.getTime() - keepDays * DAY).toISOString()
  const rows = await json(
    await request(`posts?select=id,data&kind=eq.notice&deleted=is.false&data->>at=lt.${encodeURIComponent(cutoff)}&order=id.asc&limit=${EXPIRE_MAX}`),
    'posts',
  )
  const stamp = now.toISOString()
  // newer than the copy it replaces, as newerStamp is, but by the run's clock
  const after = iso => {
    const prev = Date.parse(iso ?? '')
    return new Date(Math.max(now.getTime(), Number.isFinite(prev) ? prev + 1 : 0)).toISOString()
  }
  const tombs = (Array.isArray(rows) ? rows : []).map(r => ({
    kind: 'notice',
    id: r.id,
    deletedAt: stamp,
    purged: true,
    createdAt: r.data?.createdAt ?? stamp,
    updatedAt: after(r.data?.updatedAt),
  }))
  let done = 0
  for (let i = 0; i < tombs.length; i += EXPIRE_BATCH) {
    const batch = tombs.slice(i, i + EXPIRE_BATCH)
    const answer = await json(
      await request('rpc/sync_posts', { method: 'POST', body: JSON.stringify({ incoming: batch, since: new Date(now.getTime() + DAY).toISOString() }) }),
      'sync_posts',
    )
    const refused = new Set(['rejected', 'stale', 'gone'].flatMap(k => (Array.isArray(answer?.[k]) ? answer[k] : [])))
    done += batch.filter(t => !refused.has(t.id)).length
  }
  return done
}
