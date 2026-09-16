// The backup pass, shared by the @daily backup.mjs handler and the Admin
// panel's "Back up now". Both call runBackup(), so an on-demand snapshot is
// exactly what the schedule would have written — no second code path to drift.
//
// A snapshot is one JSON object per user in the private media bucket at
// backups/<user_id>/<YYYY-MM-DD>.json. The newest KEEP_BACKUPS per user are
// kept. The same pass drops posts_history rows past HISTORY_TTL_MS, deletes
// the wardrobe photos no piece of clothing points at any more (see
// sweepPersonalPhotos), and hard-deletes purged tombstones past
// TOMBSTONE_TTL_MS (peers have had time to see them).

import { kindOf, readableKind } from '../../../shared/kinds.mjs'
import { garmentMediaIds, isPersonalMediaOf, personalFolder } from '../../../shared/media.mjs'
import { keyHeaders } from './supabasekeys.mjs'

const DAY = 86_400_000
export const KEEP_BACKUPS = 14
export const HISTORY_TTL_MS = 60 * DAY
export const TOMBSTONE_TTL_MS = 90 * DAY
/**
 * A wardrobe photo nothing points at is swept only once it is this old: as old
 * as a tombstone is kept. A piece deleted forever or aged out of Trash had its
 * photos taken at least that long ago, while a photo just uploaded, whose
 * piece may not have reached the server yet, is never this old.
 */
export const PHOTO_GRACE_MS = TOMBSTONE_TTL_MS
/**
 * How long a piece in Trash still counts as pointing at its photos: a month
 * past the 90 days a device keeps it in Trash (src/itemops.ts), so a Restore
 * from a device that was offline near the end still finds them.
 */
export const TRASH_KEEPS_PHOTOS_MS = TOMBSTONE_TTL_MS + 30 * DAY
/** Objects asked for per storage list, and paths per storage delete. */
const LIST_PAGE = 1000
const DELETE_BATCH = 100
/** Private bucket and prefix the snapshots live under. */
export const BUCKET = 'media'
export const PREFIX = 'backups'

function env() {
  return { url: process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_KEY }
}

export function baseUrl() {
  return env().url
}

async function restResponse(path, init = {}) {
  const e = env()
  const res = await fetch(`${e.url}/rest/v1/${path}`, {
    ...init,
    headers: keyHeaders(e.key, { 'content-type': 'application/json', ...(init.headers ?? {}) }),
  })
  if (!res.ok) throw new Error(`${path.split('?')[0]}: ${res.status} ${(await res.text()).slice(0, 160)}`)
  return res
}

export async function rest(path, init = {}) {
  const res = await restResponse(path, init)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

export async function storage(path, init = {}) {
  const e = env()
  const res = await fetch(`${e.url}/storage/v1${path}`, {
    ...init,
    headers: keyHeaders(e.key, init.headers ?? {}),
  })
  if (!res.ok) throw new Error(`storage ${path}: ${res.status} ${(await res.text()).slice(0, 160)}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

/** Rows affected, from PostgREST's content-range, or null when it didn't say. */
function rangeTotal(res) {
  const m = /\/(\d+|\*)$/.exec(res.headers.get('content-range') ?? '')
  return m && m[1] !== '*' ? Number(m[1]) : null
}

/**
 * Every row a select matches, in id order, or a throw — never a shorter list.
 * PostgREST cuts a response at max_rows (1000 on Supabase), and a list of
 * pieces of clothing cut short would read as photos nothing points at. So
 * each page asks how many rows are still to come (count=exact) and the next
 * one carries on after the last id it got: a row deleted meanwhile cannot
 * shift another out of the read, as an offset would. `path` selects `id`.
 */
export async function restAll(path, pageSize = 1000) {
  const table = path.split('?')[0]
  const out = []
  let after = null
  for (let page = 0; page < 1000; page++) {
    const res = await restResponse(`${path}${after === null ? '' : `&id=gt.${encodeURIComponent(after)}`}&order=id.asc&limit=${pageSize}`, {
      headers: { prefer: 'count=exact' },
    })
    const left = rangeTotal(res)
    const text = await res.text()
    const rows = text ? JSON.parse(text) : []
    if (left === null || !Array.isArray(rows)) throw new Error(`${table}: the server did not say how many rows there are`)
    out.push(...rows)
    if (rows.length >= left) return out
    const last = rows[rows.length - 1]?.id
    if (typeof last !== 'string') throw new Error(`${table}: a page came back without an id to carry on from`)
    after = last
  }
  throw new Error(`${table}: too many rows to read`)
}

export function dayKey(d = new Date()) {
  return new Date(d).toISOString().slice(0, 10)
}

/**
 * posts rows -> Map<user_id, rows[]>. Rows with no owner are left out: there is
 * no account to restore them into, and the owner's own rows already cover them.
 */
export function groupRowsByUser(rows) {
  const byUser = new Map()
  for (const r of rows ?? []) {
    if (!r?.user_id) continue
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, [])
    byUser.get(r.user_id).push(r)
  }
  return byUser
}

export function backupPath(userId, date = dayKey()) {
  return `${PREFIX}/${userId}/${date}.json`
}

/** Only ever sign or fetch a path that looks like one of our own snapshots. */
export function isSnapshotPath(path) {
  return typeof path === 'string' && new RegExp(`^${PREFIX}/[0-9a-f-]{36}/\\d{4}-\\d{2}-\\d{2}\\.json$`, 'i').test(path)
}

/**
 * The snapshot body, exactly as it is written. Pure, so tests can pin the shape.
 * runBackup hands each account only the rows it owns; the filter is the belt to
 * those braces. A snapshot is one signed link away from whoever holds Admin, so
 * another member's journal, reviews, calendars, habits or routines must never
 * ride in this account's file, even if a caller passes the household's rows.
 */
export function buildSnapshot(userId, rows, exportedAt = new Date()) {
  return {
    exportedAt: new Date(exportedAt).toISOString(),
    userId,
    items: (rows ?? []).filter(r => readableKind(kindOf(r?.data), r?.user_id, userId)).map(r => r.data),
  }
}

/** Newest-first names split into the ones we keep and the ones that age out. */
export function snapshotsToDrop(names, keep = KEEP_BACKUPS) {
  const files = (names ?? [])
    .filter(n => typeof n === 'string' && n.endsWith('.json'))
    .sort()
    .reverse()
  return { kept: files.slice(0, keep), drop: files.slice(keep) }
}

function snapshotEntry(userId, file) {
  return {
    name: file.name,
    path: `${PREFIX}/${userId}/${file.name}`,
    date: file.name.replace(/\.json$/, ''),
    size: Number(file.metadata?.size ?? 0),
    updatedAt: file.updated_at ?? file.created_at ?? null,
  }
}

/** One user's snapshots, newest first. */
export async function listUserSnapshots(userId) {
  const listed = await storage(`/object/list/${BUCKET}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prefix: `${PREFIX}/${userId}/`, limit: 100, sortBy: { column: 'name', order: 'desc' } }),
  }).catch(() => [])
  return (Array.isArray(listed) ? listed : [])
    .filter(f => typeof f?.name === 'string' && f.name.endsWith('.json'))
    .map(f => snapshotEntry(userId, f))
    .sort((a, b) => b.name.localeCompare(a.name))
}

/** Every user folder under backups/, each with its snapshots. */
export async function listAllSnapshots() {
  const folders = await storage(`/object/list/${BUCKET}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prefix: `${PREFIX}/`, limit: 1000, sortBy: { column: 'name', order: 'asc' } }),
  }).catch(() => [])
  const out = []
  for (const folder of Array.isArray(folders) ? folders : []) {
    // a folder comes back with a null id; a stray object directly under backups/ is not a user
    if (typeof folder?.name !== 'string' || folder.id) continue
    out.push({ userId: folder.name, files: await listUserSnapshots(folder.name) })
  }
  return out
}

/** A short-lived download URL for one snapshot. The bucket itself stays private. */
export async function signSnapshotUrl(objectPath, expiresIn = 300) {
  if (!isSnapshotPath(objectPath)) throw new Error('not a backup path')
  const body = await storage(`/object/sign/${BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expiresIn }),
  })
  const signed = body?.signedURL ?? body?.signedUrl
  if (!signed) throw new Error('storage did not return a signed URL')
  return `${baseUrl()}/storage/v1${signed.startsWith('/') ? signed : `/${signed}`}`
}

export async function backupUser(userId, rows, date = dayKey(), exportedAt = new Date()) {
  const snapshot = buildSnapshot(userId, rows, exportedAt)
  const body = JSON.stringify(snapshot)
  const path = backupPath(userId, date)
  await storage(`/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-upsert': 'true' },
    body,
  })
  const listed = await storage(`/object/list/${BUCKET}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prefix: `${PREFIX}/${userId}/`, limit: 100 }),
  }).catch(() => [])
  const { kept, drop } = snapshotsToDrop((Array.isArray(listed) ? listed : []).map(f => f?.name))
  if (drop.length) {
    await storage(`/object/${BUCKET}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prefixes: drop.map(name => `${PREFIX}/${userId}/${name}`) }),
    }).catch(() => null)
  }
  return { userId, path, items: snapshot.items.length, bytes: Buffer.byteLength(body), kept: kept.length, dropped: drop.length }
}

/** Drop history rows older than the TTL. Returns the row count, or null if the server didn't say. */
export async function purgeHistory(now = new Date()) {
  const cutoff = new Date(now.getTime() - HISTORY_TTL_MS).toISOString()
  const res = await restResponse(`posts_history?replaced_at=lt.${encodeURIComponent(cutoff)}`, {
    method: 'DELETE',
    headers: { prefer: 'count=exact,return=minimal' },
  }).catch(() => null)
  return res ? rangeTotal(res) : null
}

/** Hard-delete purged tombstones past the TTL. Returns the row count, or null. */
export async function purgeTombstones(now = new Date()) {
  const cutoff = new Date(now.getTime() - TOMBSTONE_TTL_MS).toISOString()
  const res = await restResponse(`posts?deleted=eq.true&updated_at=lt.${encodeURIComponent(cutoff)}&data->>purged=eq.true`, {
    method: 'DELETE',
    headers: { prefer: 'count=exact,return=minimal' },
  }).catch(() => null)
  return res ? rangeTotal(res) : null
}

/** Objects directly in an account's personal/ folder, a page at a time. A short read only ever means fewer deleted. */
async function listPersonalFolder(userId) {
  const out = []
  for (let offset = 0; offset < 100_000; offset += LIST_PAGE) {
    const page = await storage(`/object/list/${BUCKET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prefix: personalFolder(userId), limit: LIST_PAGE, offset, sortBy: { column: 'name', order: 'asc' } }),
    })
    if (!Array.isArray(page)) throw new Error(`storage did not list ${personalFolder(userId)}`)
    out.push(...page)
    if (page.length < LIST_PAGE) break
  }
  return out
}

/**
 * Which of the objects listed in an account's personal/ folder may be deleted:
 * a photo of the media store's own shape (never a folder, a bare id or
 * anything under backups/), that no piece of clothing points at and, unless
 * `olderThan` is null, last written before that instant. An object whose
 * times can't be read stays.
 */
export function photosToSweep(userId, listed, inUse, olderThan) {
  const limit = olderThan === null ? Infinity : Date.parse(olderThan)
  const out = []
  for (const f of listed ?? []) {
    // a folder comes back with a null id
    if (typeof f?.name !== 'string' || !f.id) continue
    const path = `${personalFolder(userId)}${f.name}`
    if (!isPersonalMediaOf(path, userId) || inUse.has(path)) continue
    if (olderThan !== null) {
      const stamps = [f.updated_at, f.created_at].map(t => Date.parse(t ?? '')).filter(Number.isFinite)
      if (stamps.length === 0 || !(Math.max(...stamps) < limit)) continue
    }
    out.push(path)
  }
  return out
}

/** Delete an account's own photos from the bucket, a batch at a time, refusing any other path; returns how many went. */
async function removeOwnPhotos(userId, paths) {
  const mine = paths.filter(p => isPersonalMediaOf(p, userId))
  let removed = 0
  for (let i = 0; i < mine.length; i += DELETE_BATCH) {
    const batch = mine.slice(i, i + DELETE_BATCH)
    const gone = await storage(`/object/${BUCKET}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prefixes: batch }),
    })
    removed += Array.isArray(gone) ? gone.length : batch.length
  }
  return removed
}

/**
 * The nightly wardrobe-photo sweep. For each account the server holds a piece
 * of clothing for (live, in Trash or deleted forever), delete the photos in
 * its personal/ folder that no piece points at any more — replaced ones the
 * app could not delete itself, those of pieces deleted forever, and those of
 * pieces a month past their time in Trash (TRASH_KEEPS_PHOTOS_MS) — once they
 * are PHOTO_GRACE_MS old. An account with no pieces on the server is left
 * alone: they may still be waiting on its devices (a build ahead of `db
 * push`) with their photos already uploaded. Every account's pieces count as
 * pointing, not just the folder's owner's. Reads with the service key, and
 * nothing it reads leaves here but a count.
 */
export async function sweepPersonalPhotos(now = new Date()) {
  const rows = await restAll('posts?select=id,user_id,data&kind=eq.garment')
  const cutoff = new Date(now.getTime() - PHOTO_GRACE_MS).toISOString()
  const expiredBefore = new Date(now.getTime() - TRASH_KEEPS_PHOTOS_MS).toISOString()
  const inUse = garmentMediaIds(rows.map(r => r?.data), { expiredBefore })
  const owners = [...new Set(rows.map(r => r?.user_id).filter(u => typeof u === 'string'))]
  let deleted = 0
  const failures = []
  for (const userId of owners) {
    try {
      deleted += await removeOwnPhotos(userId, photosToSweep(userId, await listPersonalFolder(userId), inUse, cutoff))
    } catch (e) {
      failures.push(`photos of ${userId}: ${e?.message ?? e}`)
    }
  }
  return { deleted, failures }
}

/**
 * An account's wardrobe photos, deleted with the account: everything in its
 * personal/ folder that no piece of clothing points at, whatever its age.
 * Admin runs it once admin_prepare_user_deletion has deleted the account's own
 * pieces, and before the sign-in goes. Returns how many went.
 */
export async function removePersonalPhotos(userId) {
  const inUse = garmentMediaIds((await restAll('posts?select=id,user_id,data&kind=eq.garment')).map(r => r?.data))
  return removeOwnPhotos(userId, photosToSweep(userId, await listPersonalFolder(userId), inUse, null))
}

/**
 * Snapshot every user with live posts, then purge what has aged out. One user
 * failing never costs the others their snapshot. The live posts are read a
 * page at a time (restAll): one request stops at max_rows, and a snapshot cut
 * short there would look whole. A read that cannot be finished writes no
 * snapshot at all.
 */
export async function runBackup(now = new Date()) {
  if (!process.env.SUPABASE_SERVICE_KEY) throw Object.assign(new Error('SUPABASE_SERVICE_KEY is not set on the host'), { status: 501 })

  const rows = await restAll('posts?select=id,data,user_id&deleted=is.false')
  const byUser = groupRowsByUser(rows)
  const date = dayKey(now)
  const users = []
  const failures = []
  for (const [userId, userRows] of byUser) {
    try {
      users.push(await backupUser(userId, userRows, date, now))
    } catch (e) {
      failures.push(`${userId}: ${e?.message ?? e}`)
    }
  }

  // before the tombstones go: an account whose last pieces were deleted
  // forever is still one the server holds pieces for, so its photos are swept
  const photos = await sweepPersonalPhotos(now).catch(e => ({ deleted: null, failures: [`photos: ${e?.message ?? e}`] }))
  failures.push(...photos.failures)

  return {
    date,
    users,
    failures,
    unowned: (rows ?? []).filter(r => !r?.user_id).length,
    historyPurged: await purgeHistory(now),
    photosDeleted: photos.deleted,
    tombstonesPurged: await purgeTombstones(now),
  }
}
