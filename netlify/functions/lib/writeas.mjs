// Writing records with the service key AS one account: the one way the
// functions write for someone (v3.34).
//
// sync_posts under the service key has no signed-in caller, so it filed a new
// row under the site owner and a losing copy in the site owner's history.
// Email-in, Sunday's draft, email-in's triage and the notices all write for
// somebody else: a new row stayed the site owner's until a PATCH handed it
// over (long enough for the site owner's device to pull it and keep it, and
// with synced_at left behind, so a device that synced in between never heard
// of it), and a write that lost landed in the site owner's Versions panel.
//
// public.sync_posts_as(p_owner, incoming) writes as p_owner instead: a new
// row is theirs from the instant it exists, a loss is filed under them, and a
// row stored under anyone else is refused. Until the v3.34 migration is
// applied the function is not there — PostgREST answers 404 — and writeAs
// falls back to what the writers did before: sync_posts, then, with
// `handOver`, the PATCH that gives a new row to its owner. That PATCH now
// moves synced_at as well, from this clock, so the owner's devices hear of it.

import { keyHeaders } from './supabasekeys.mjs'

const DAY = 86_400_000

/** A service-key request to PostgREST, answered as it came. */
export function serviceRequest(path, init = {}) {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  return fetch(`${url}/rest/v1/${path}`, { ...init, headers: keyHeaders(process.env.SUPABASE_SERVICE_KEY, { 'content-type': 'application/json', ...(init.headers ?? {}) }) })
}

/** The ids an answer lists under `key`, whatever else it holds. */
const listed = (answer, key) => (Array.isArray(answer?.[key]) ? answer[key].filter(id => typeof id === 'string') : [])

/**
 * Give the row under `id` to `ownerId`: the hand-over a database before v3.34
 * needs, and the repair of a row an older build left with the site owner.
 * synced_at moves with the owner, or the owner's devices, whose cursors are
 * already past the row, would never be sent it. Tried twice.
 * @param {string} ownerId
 * @param {string} id
 * @param {{ request?: (path: string, init: RequestInit) => Promise<Response> }} [opts]
 */
export async function handOver(ownerId, id, { request = serviceRequest } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await request(`posts?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: ownerId, synced_at: new Date().toISOString() }),
    }).catch(() => null)
    if (res?.ok) return true
  }
  return false
}

/**
 * Write `items` through sync_posts as `ownerId`. Never throws. Resolves
 * { ok: true, rejected, stale, gone, owned } with the ids the database
 * refused, found older than what it holds, or has deleted for good — and
 * `owned` false only when, on a database before v3.34, a new row asked to be
 * handed over (`handOver`) could not be, and is still the site owner's — or
 * { ok: false, why } when the write did not go through at all.
 * @param {string} ownerId
 * @param {Record<string, unknown>[]} items
 * @param {{ handOver?: boolean, request?: (path: string, init: RequestInit) => Promise<Response> }} [opts]
 * @returns {Promise<{ ok: true, rejected: string[], stale: string[], gone: string[], owned: boolean } | { ok: false, why: string }>}
 */
export async function writeAs(ownerId, items, { handOver: handing = false, request = serviceRequest } = {}) {
  const read = async (res, what) => {
    const answer = await res.json().catch(() => null)
    if (!answer || typeof answer !== 'object') return { ok: /** @type {const} */ (false), why: `${what} answered nothing it could read` }
    return { ok: /** @type {const} */ (true), rejected: listed(answer, 'rejected'), stale: listed(answer, 'stale'), gone: listed(answer, 'gone'), owned: true }
  }
  const asOwner = await request('rpc/sync_posts_as', { method: 'POST', body: JSON.stringify({ p_owner: ownerId, incoming: items }) }).catch(e => e)
  if (!(asOwner instanceof Response)) return { ok: false, why: `sync_posts_as: ${asOwner?.message ?? asOwner}` }
  if (asOwner.status !== 404) return asOwner.ok ? read(asOwner, 'sync_posts_as') : { ok: false, why: `sync_posts_as: ${asOwner.status}` }

  // before v3.34: stored as the site owner's, and handed over after
  // a future cursor: the answer carries the verdicts, never the whole table
  const plain = await request('rpc/sync_posts', { method: 'POST', body: JSON.stringify({ incoming: items, since: new Date(Date.now() + DAY).toISOString() }) }).catch(e => e)
  if (!(plain instanceof Response)) return { ok: false, why: `sync_posts: ${plain?.message ?? plain}` }
  if (!plain.ok) return { ok: false, why: `sync_posts: ${plain.status}` }
  const out = await read(plain, 'sync_posts')
  if (!out.ok || !handing) return out
  const refused = new Set([...out.rejected, ...out.stale, ...out.gone])
  for (const item of items) {
    const id = typeof item?.id === 'string' ? item.id : null
    if (id && !refused.has(id) && !(await handOver(ownerId, id, { request }))) out.owned = false
  }
  return out
}
