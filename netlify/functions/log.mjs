// Client error reports: POST /api/log { reports: [...] }, signed-in accounts only.
//
// When something breaks on a device the app sends what broke (src/errorreport.ts)
// and this keeps a count of it for the site owner, in public.client_errors,
// which only the service key can read (Admin → Data lists it). Each report is
// cleaned again here with the rule the app used (shared/errorreport.mts):
// message at most 500 characters, stack at most 4 KB, no query string on any
// path or URL — so a device can never store more than that rule allows.
//
// A report is not worth a retry, and the app never waits on this: every answer
// is final. Per account there is a ceiling, counted across instances as
// /api/ai's is (lib/ratelimit.mjs), so a page stuck throwing cannot fill the table.

import { withCors } from './lib/cors.mjs'
import { cleanReports, storeReports } from './lib/errorlog.mjs'
import { sharedWindow } from './lib/ratelimit.mjs'
import { requireUser, settingsStoreConfigured } from './lib/session.mjs'
import { keyHeaders } from './lib/supabasekeys.mjs'

/** The largest body read; ten reports at their caps come to under 50 KB. */
const MAX_BODY = 64 * 1024
// 20 requests per 10 minutes per account, each of up to ten reports
const perUser = sharedWindow({ bucket: 'log', limit: 20, windowMs: 10 * 60_000 })

async function rest(path, init = {}) {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: keyHeaders(key, { 'content-type': 'application/json', ...(init.headers ?? {}) }) })
  if (!res.ok) throw new Error(`${path.split('?')[0]}: ${res.status}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

const handler = async req => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const { user, response } = await requireUser(req)
  if (response) return response

  const slot = await perUser.take(user.id)
  if (!slot.ok) {
    return Response.json({ error: 'Too many error reports from this account.' }, { status: 429, headers: { 'retry-after': String(Math.ceil(slot.retryAfterMs / 1000)) } })
  }

  const text = await req.text()
  if (text.length > MAX_BODY) return Response.json({ error: 'That report is too large.' }, { status: 413 })
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 })
  }
  const reports = cleanReports(body?.reports)
  // nowhere to keep them is not the device's problem
  if (!reports.length || !settingsStoreConfigured()) return Response.json({ stored: 0 })
  try {
    return Response.json({ stored: await storeReports(rest, user.id, reports) })
  } catch (e) {
    // most likely the migration is not applied yet; nothing for the device to do either way
    return Response.json({ error: `Could not keep the report: ${e?.message ?? e}` }, { status: 502 })
  }
}

export default withCors(handler)
