// Scheduled daily. For every signed-in user with posts: write a JSON snapshot
// to the private media bucket under backups/<user_id>/<YYYY-MM-DD>.json, keep
// the newest 14, purge posts_history older than 60 days, and hard-delete
// purged tombstones past the TTL (peers have had time to see them).

export const config = { schedule: '@daily' }

const DAY = 86_400_000
const KEEP_BACKUPS = 14
const HISTORY_TTL_MS = 60 * DAY
const TOMBSTONE_TTL_MS = 90 * DAY

async function rest(path, init = {}) {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) throw new Error(`${path.split('?')[0]}: ${res.status} ${(await res.text()).slice(0, 160)}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

async function storage(path, init = {}) {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  const res = await fetch(`${url}/storage/v1${path}`, {
    ...init,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) throw new Error(`storage ${path}: ${res.status} ${(await res.text()).slice(0, 160)}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10)
}

export async function backupUser(userId, rows, date = dayKey()) {
  const body = JSON.stringify({
    exportedAt: new Date().toISOString(),
    userId,
    items: rows.map(r => r.data),
  })
  const objectPath = `backups/${userId}/${date}.json`
  await storage(`/object/media/${objectPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-upsert': 'true' },
    body,
  })
  // keep only the newest KEEP_BACKUPS files for this user
  const listed = await storage(`/object/list/media`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prefix: `backups/${userId}/`, limit: 100 }),
  }).catch(() => [])
  const files = (Array.isArray(listed) ? listed : [])
    .filter(f => typeof f?.name === 'string' && f.name.endsWith('.json'))
    .map(f => f.name)
    .sort()
    .reverse()
  const drop = files.slice(KEEP_BACKUPS)
  if (drop.length) {
    await storage(`/object/media`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prefixes: drop.map(name => `backups/${userId}/${name}`) }),
    }).catch(() => null)
  }
  return { userId, kept: Math.min(files.length, KEEP_BACKUPS), dropped: drop.length }
}

export default async () => {
  if (!process.env.SUPABASE_SERVICE_KEY) return new Response('not configured', { status: 200 })

  const rows = await rest('posts?select=data,user_id&deleted=is.false')
  const byUser = new Map()
  for (const r of rows ?? []) {
    if (!r.user_id) continue
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, [])
    byUser.get(r.user_id).push(r)
  }

  const date = dayKey()
  const results = []
  const failures = []
  for (const [userId, userRows] of byUser) {
    try {
      results.push(await backupUser(userId, userRows, date))
    } catch (e) {
      failures.push(`${userId}: ${e?.message ?? e}`)
    }
  }

  // purge history older than 60 days
  try {
    const cutoff = new Date(Date.now() - HISTORY_TTL_MS).toISOString()
    await rest(`posts_history?replaced_at=lt.${encodeURIComponent(cutoff)}`, {
      method: 'DELETE',
      headers: { prefer: 'return=minimal' },
    }).catch(() => null)
  } catch {
    /* best-effort */
  }

  // hard-delete purged tombstones older than the TTL
  try {
    const cutoff = new Date(Date.now() - TOMBSTONE_TTL_MS).toISOString()
    await rest(`posts?deleted=eq.true&updated_at=lt.${encodeURIComponent(cutoff)}&data->>purged=eq.true`, {
      method: 'DELETE',
      headers: { prefer: 'return=minimal' },
    }).catch(() => null)
  } catch {
    /* best-effort */
  }

  const report = `backed up ${results.length} user(s)${failures.length ? `; ${failures.length} failure(s): ${failures.slice(0, 5).join(' | ')}` : ''}`
  if (failures.length) console.error('backup:', report)
  return new Response(report, { status: 200 })
}
