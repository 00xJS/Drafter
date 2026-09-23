// Client error reports, kept for the site owner (public.client_errors,
// migration 20261006000000). /api/log writes them for a signed-in account;
// Admin → Data lists and clears them; the nightly backup purges old ones
// (lib/backup.mjs purgeClientErrors).
//
// Everything takes the caller's `rest` (service-key PostgREST), as the canary
// helpers do, so the tests hand in a fake and no helper keeps its own key.

import { cleanReport } from '../../../shared/errorreport.mts'

/** Reports one request may carry; the app sends at most this many at a time. */
export const MAX_REPORTS = 10
/** The most Admin lists at once, newest first. */
export const LIST_LIMIT = 100

/**
 * The reports a request may store: each one cleaned (shared/errorreport.mts),
 * the empty ones dropped, at most MAX_REPORTS, and two that are the same error
 * merged into one with their counts added — the database would refuse to
 * touch one row twice in a statement.
 */
export function cleanReports(list) {
  const byFingerprint = new Map()
  for (const raw of Array.isArray(list) ? list.slice(0, MAX_REPORTS) : []) {
    const r = cleanReport(raw)
    if (!r) continue
    const seen = byFingerprint.get(r.fingerprint)
    if (seen) seen.count = Math.min(seen.count + r.count, 1_000_000)
    else byFingerprint.set(r.fingerprint, r)
  }
  return [...byFingerprint.values()]
}

/** Store cleaned reports for `userId`: one upsert through public.log_client_errors. Resolves how many rows it touched. */
export async function storeReports(rest, userId, reports) {
  if (!reports.length) return 0
  const n = await rest('rpc/log_client_errors', { method: 'POST', body: JSON.stringify({ p_user: userId, p_reports: reports }) })
  return Number(n) || 0
}

/** One stored row, as Admin shows it. */
function rowOut(r) {
  return {
    id: r.id,
    message: r.message,
    stack: r.stack ?? null,
    count: Number(r.count) || 1,
    firstAt: r.first_at ?? null,
    lastAt: r.last_at ?? null,
    build: r.build ?? null,
    platform: r.platform ?? null,
    view: r.view ?? null,
    path: r.path ?? null,
  }
}

/** The most recent errors, newest first. */
export async function listErrors(rest, limit = LIST_LIMIT) {
  const rows = await rest(`client_errors?select=id,message,stack,count,first_at,last_at,build,platform,view,path&order=last_at.desc&limit=${limit}`)
  return (Array.isArray(rows) ? rows : []).map(rowOut)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Clear one error by id, or every one. The filter is never left off: Supabase
 * refuses a DELETE without one, and "every row" is said out loud.
 */
export async function clearErrors(rest, id) {
  if (id != null && !UUID.test(String(id))) throw Object.assign(new Error('That is not an error id.'), { status: 400 })
  const filter = id == null ? 'id=not.is.null' : `id=eq.${encodeURIComponent(String(id))}`
  const gone = await rest(`client_errors?${filter}&select=id`, { method: 'DELETE', headers: { prefer: 'return=representation' } })
  return Array.isArray(gone) ? gone.length : 0
}
