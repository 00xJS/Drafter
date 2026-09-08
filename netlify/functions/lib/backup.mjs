// The backup pass, shared by the @daily backup.mjs handler and the Admin
// panel's "Back up now". Both call runBackup(), so an on-demand snapshot is
// exactly what the schedule would have written — no second code path to drift.
//
// A snapshot is one JSON object per user in the private media bucket at
// backups/<user_id>/<YYYY-MM-DD>.json. The newest KEEP_BACKUPS per user are
// kept. The same pass drops posts_history rows past HISTORY_TTL_MS and
// hard-deletes purged tombstones past TOMBSTONE_TTL_MS (peers have had time to
// see them).

const DAY = 86_400_000
export const KEEP_BACKUPS = 14
export const HISTORY_TTL_MS = 60 * DAY
export const TOMBSTONE_TTL_MS = 90 * DAY
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
    headers: {
      apikey: e.key,
      authorization: `Bearer ${e.key}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
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
    headers: {
      apikey: e.key,
      authorization: `Bearer ${e.key}`,
      ...(init.headers ?? {}),
    },
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

/** The snapshot body, exactly as it is written. Pure, so tests can pin the shape. */
export function buildSnapshot(userId, rows, exportedAt = new Date()) {
  return {
    exportedAt: new Date(exportedAt).toISOString(),
    userId,
    items: (rows ?? []).map(r => r.data),
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
  const body = JSON.stringify(buildSnapshot(userId, rows, exportedAt))
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
  return { userId, path, items: (rows ?? []).length, bytes: Buffer.byteLength(body), kept: kept.length, dropped: drop.length }
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

/**
 * Snapshot every user with live posts, then purge what has aged out. One user
 * failing never costs the others their snapshot.
 */
export async function runBackup(now = new Date()) {
  if (!process.env.SUPABASE_SERVICE_KEY) throw Object.assign(new Error('SUPABASE_SERVICE_KEY is not set on the host'), { status: 501 })

  const rows = await rest('posts?select=data,user_id&deleted=is.false')
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

  return {
    date,
    users,
    failures,
    unowned: (rows ?? []).filter(r => !r?.user_id).length,
    historyPurged: await purgeHistory(now),
    tombstonesPurged: await purgeTombstones(now),
  }
}
