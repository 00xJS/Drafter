// The sync canary's bookkeeping. public.sync_canary (migration 20260919020000)
// writes one synthetic row of every kind through the real sync_posts and rolls
// it back; the hourly digest runs it once a run and Admin → Data can run it by
// hand. The latest answer lives in app_config under CANARY_KEY, and that is
// also where the alert throttle reads when the owner was last told.
//
// Everything takes the caller's `rest` (service-key PostgREST), so the digest
// and Admin share one path without a third copy of that helper.

import { SYNC_KINDS } from '../../../shared/kinds.mjs'

export const CANARY_KEY = 'sync_canary'
const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** A failing canary tells the owner at most this often. */
export const ALERT_GAP_MS = 12 * HOUR

/** Run the check. Never throws: a check that could not run says so in `error`. */
export async function runSyncCanary(rest, kinds = [...SYNC_KINDS]) {
  try {
    const r = await rest('rpc/sync_canary', { method: 'POST', body: JSON.stringify({ kinds }) })
    if (!r || typeof r !== 'object') return { ok: false, checked: 0, failures: [], error: 'sync_canary gave no answer' }
    return {
      ok: r.ok === true,
      checked: Number(r.checked) || 0,
      failures: (Array.isArray(r.failures) ? r.failures : []).map(f => ({ kind: f?.kind ?? null, reason: String(f?.reason ?? 'unknown') })),
      error: null,
    }
  } catch (e) {
    return { ok: false, checked: 0, failures: [], error: String(e?.message ?? e).slice(0, 200) }
  }
}

/** The stored record, or null when none has been written yet (or it does not parse). */
export async function readCanary(rest) {
  const rows = await rest(`app_config?key=eq.${CANARY_KEY}&select=value&limit=1`)
  try {
    const value = JSON.parse(rows?.[0]?.value ?? 'null')
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

export async function writeCanary(rest, record) {
  await rest('app_config?on_conflict=key', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key: CANARY_KEY, value: JSON.stringify(record) }),
  })
}

/**
 * Fold a fresh result into the stored record. `alert` is true when the server
 * refused a test write and the owner has not been told for ALERT_GAP_MS; the
 * caller stamps `alertedAt` only once a message actually went out. A check that
 * could not run at all (an error, nothing checked) is recorded but never
 * alerts: that is for Admin to show, and it is also what every run looks like
 * between a deploy and the `db push` that installs the function.
 */
export function nextCanaryRecord(prev, result, now = new Date()) {
  const at = now.toISOString()
  const refused = result.failures.length > 0
  const record = {
    ok: result.ok,
    checked: result.checked,
    failures: result.failures,
    error: result.error ?? null,
    at,
    failingSince: result.ok ? null : (prev?.ok === false && prev.failingSince) || at,
    alertedAt: prev?.alertedAt ?? null,
  }
  const last = Date.parse(record.alertedAt ?? '')
  const alert = refused && (!Number.isFinite(last) || now.getTime() - last >= ALERT_GAP_MS)
  return { record, alert }
}

function listOf(words) {
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

const kindName = f => f.kind ?? '(no kind)'

/** "5 minutes ago", "3 hours ago", "2 days ago"; anything under a minute (or in the future) is "just now". */
export function ago(ms) {
  if (!Number.isFinite(ms) || ms < MINUTE) return 'just now'
  if (ms < HOUR) {
    const m = Math.floor(ms / MINUTE)
    return `${m} minute${m === 1 ? '' : 's'} ago`
  }
  if (ms < 48 * HOUR) {
    const h = Math.floor(ms / HOUR)
    return `${h} hour${h === 1 ? '' : 's'} ago`
  }
  const d = Math.floor(ms / (24 * HOUR))
  return `${d} days ago`
}

/** What the owner is sent: which kinds, and what that means for their edits. */
export function canaryAlert(record) {
  const kinds = record.failures.map(kindName)
  const body = `The server refused a test write for ${listOf(kinds)}. New edits of ${kinds.length === 1 ? 'that kind' : 'those kinds'} are not reaching the server — details in Admin → Data.`
  return {
    title: 'Drafter: the server is refusing writes',
    body,
    text: [body, '', ...record.failures.map(f => `- ${kindName(f)}: ${f.reason}`)].join('\n'),
  }
}

/** Admin → Data's one sentence about the latest check. */
export function canarySentence(record, now = new Date()) {
  if (!record) return 'No sync check has run yet. The hourly digest runs one, or press Check now.'
  const when = ago(now.getTime() - Date.parse(record.at))
  if (record.ok) return `The server accepted a test write for all ${record.checked} kinds, ${when}.`
  if (record.failures?.length) {
    const first = record.failingSince && record.failingSince !== record.at ? ` First seen ${ago(now.getTime() - Date.parse(record.failingSince))}.` : ''
    return `The server refused a test write for ${listOf(record.failures.map(f => `${kindName(f)} (${f.reason})`))}, ${when}.${first}`
  }
  return `The sync check could not run ${when}: ${record.error ?? 'the database gave no answer'}.`
}
