// Pure shaping for the Admin panel's Data overview. Given the thin posts
// projection (user_id, deleted, kind, purged, synced_at) it produces the counts
// that answer "is my data still there?" — no record contents ever leave the
// server, only tallies.

/** The kinds sync_posts accepts, plus place which rides along in data. */
export const KINDS = ['task', 'project', 'person', 'place', 'calendar', 'review', 'template', 'recipe', 'meal', 'grocery']

/** Rows written before `kind` existed are legacy tasks; count them separately. */
export const UNKNOWN_KIND = 'unknown'

function newer(a, b) {
  if (!a) return b
  if (!b) return a
  return Date.parse(b) > Date.parse(a) ? b : a
}

/**
 * @param rows thin posts rows
 * @param emails uid -> email, so per-user counts read as people not uuids
 */
export function shapeDataStats(rows, { emails = {} } = {}) {
  const kinds = Object.fromEntries([...KINDS, UNKNOWN_KIND].map(k => [k, 0]))
  const perUser = new Map()
  let live = 0
  let tombstones = 0
  let purged = 0
  let unowned = 0
  let newestSyncedAt = null

  for (const r of rows ?? []) {
    const userId = r?.user_id ?? null
    if (!userId) unowned++
    let bucket = perUser.get(userId)
    if (!bucket) {
      bucket = { userId, email: userId ? (emails[userId] ?? null) : null, live: 0, deleted: 0 }
      perUser.set(userId, bucket)
    }
    if (r?.deleted) {
      tombstones++
      bucket.deleted++
      if (String(r.purged) === 'true') purged++
    } else {
      live++
      bucket.live++
      const kind = typeof r?.kind === 'string' && r.kind ? r.kind : UNKNOWN_KIND
      kinds[kind] = (kinds[kind] ?? 0) + 1
    }
    newestSyncedAt = newer(newestSyncedAt, r?.synced_at ?? null)
  }

  const users = [...perUser.values()].sort((a, b) => b.live - a.live || (a.email ?? a.userId ?? '').localeCompare(b.email ?? b.userId ?? ''))
  return { total: (rows ?? []).length, live, tombstones, purged, unowned, kinds, newestSyncedAt, users }
}
