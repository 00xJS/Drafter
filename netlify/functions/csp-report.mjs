// Content-Security-Policy reports: POST /.netlify/functions/csp-report, posted
// by the browser itself, with no account.
//
// The web app is served with a policy (shared/csp.mts, written into
// dist/_headers by vite.config.ts), reported only for now: when a page does
// something the policy would block, the browser posts a report here instead of
// blocking it. This keeps what the owner needs to decide whether the policy
// can be enforced — which directive, and the origin of what it would have
// blocked — in the error log Admin → Data already lists
// (public.client_errors), one row per kind of violation with a count. Never
// the page's address, the source file, a line of script, or anything else a
// report carries.
//
// A browser sends a report with no credentials, so there is no account to hold
// it to: the ceiling is the whole site's, sixty requests in ten minutes
// counted across instances (lib/ratelimit.mjs), and a request stores at most
// ten violations of a fixed set of directives. Every answer is final and
// empty: a browser never retries a report or reads what comes back.

import { cspMessage, cspViolations } from '../../shared/csp.mts'
import { cleanReports, storeReports } from './lib/errorlog.mjs'
import { sharedWindow } from './lib/ratelimit.mjs'
import { settingsStoreConfigured } from './lib/session.mjs'
import { keyHeaders } from './lib/supabasekeys.mjs'

/** A report is a few hundred bytes; ten of them with their policies come to well under this. */
const MAX_BODY = 32 * 1024
const perSite = sharedWindow({ bucket: 'csp-report', limit: 60, windowMs: 10 * 60_000 })

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
  const slot = await perSite.take('site')
  if (!slot.ok) return new Response(null, { status: 429, headers: { 'retry-after': String(Math.ceil(slot.retryAfterMs / 1000)) } })

  const text = await req.text()
  if (text.length > MAX_BODY) return new Response(null, { status: 413 })
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return new Response(null, { status: 400 })
  }
  const reports = cleanReports(cspViolations(body).map(v => ({ message: cspMessage(v), platform: 'web', count: 1 })))
  if (!reports.length || !settingsStoreConfigured()) return new Response(null, { status: 204 })
  try {
    await storeReports(rest, null, reports)
  } catch (e) {
    // most likely the error log's migration is not applied; the browser can do nothing either way
    console.error(`csp-report: could not keep ${reports.length} report(s): ${e?.message ?? e}`)
  }
  return new Response(null, { status: 204 })
}

export default handler
