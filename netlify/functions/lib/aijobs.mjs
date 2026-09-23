// Work the server does with a model when nobody is waiting on it — Sunday's
// review draft and email-in's triage — handed to a background function
// (netlify/functions/ai-jobs-background.mjs).
//
// Why. The hourly digest is a scheduled function, which Netlify stops at 30
// seconds, and the email webhook should answer its mail service at once; the
// model takes 20 to 60 seconds to write a review. So the Sunday draft was
// stamped as the week's one try with a dozen seconds left to finish in, and
// most Sundays ended with a claimed, empty draft; triage had nine. A
// background function runs for up to 15 minutes, and its caller gets an empty
// 202 the moment it starts.
//
// Only our own functions may start one. A job carries a signature made with a
// key derived from the service key, which only the functions hold, over the
// moment it was made and everything it says; one that is not ours, or older
// than a few minutes, is refused. The jobs themselves re-read what they act
// on and change nothing a person has written since, so a job run twice does
// no harm either.

import { createHmac, timingSafeEqual } from 'node:crypto'

/** Where the background function answers: its own name, no redirect of ours in front of it. */
export const JOB_PATH = '/.netlify/functions/ai-jobs-background'
/** A job made longer ago than this is refused, so one seen in passing cannot be sent again later. */
export const JOB_MAX_AGE_MS = 5 * 60_000

const AT_HEADER = 'x-drafter-job-at'
const SIG_HEADER = 'x-drafter-job-sig'

/** The signing key: not the service key itself, a key made from it for this one use. */
const jobKey = secret => createHmac('sha256', secret).update('drafter background jobs v1').digest()

/** The signature over a job's moment and body. */
export function signJob(body, at, secret) {
  return createHmac('sha256', jobKey(secret)).update(`${at}.${body}`).digest('base64url')
}

/** Where a function reaches the site's own functions: the address Netlify gives the site, else the one the request came in on. */
export function siteOrigin(fallback = '') {
  return (process.env.URL || process.env.DEPLOY_PRIME_URL || fallback || '').replace(/\/+$/, '')
}

/**
 * Hand a job to the background function. True once it has taken it (Netlify
 * answers 202 as it starts); false when it could not be reached or the site
 * has no service key to sign with. Never throws: the caller's own work — the
 * digest, the stored email — goes on either way, and says what happened.
 * @param {Record<string, unknown> & { type: string }} job
 * @param {{ origin?: string, secret?: string, fetchImpl?: typeof fetch, timeoutMs?: number, now?: () => number }} [opts]
 */
export async function startJob(job, opts = {}) {
  const { origin = siteOrigin(), secret = process.env.SUPABASE_SERVICE_KEY, fetchImpl = fetch, timeoutMs = 4_000, now = Date.now } = opts
  if (!origin || !secret) return false
  const body = JSON.stringify(job)
  const at = String(now())
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${origin}${JOB_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AT_HEADER]: at, [SIG_HEADER]: signJob(body, at, secret) },
      body,
      signal: ctrl.signal,
    })
    return res.status === 202 || res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The job a request carries, when one of our functions made it within
 * JOB_MAX_AGE_MS; otherwise why not, with the status to answer.
 * @param {Request} req
 * @param {{ secret?: string, now?: number }} [opts]
 * @returns {Promise<{ job: Record<string, unknown> & { type: string } } | { status: number, error: string }>}
 */
export async function readJob(req, opts = {}) {
  const { secret = process.env.SUPABASE_SERVICE_KEY, now = Date.now() } = opts
  if (req.method !== 'POST') return { status: 405, error: 'Method not allowed' }
  if (!secret) return { status: 501, error: 'not configured' }
  const at = req.headers.get(AT_HEADER) ?? ''
  const sig = req.headers.get(SIG_HEADER) ?? ''
  const body = await req.text().catch(() => '')
  if (!/^\d{10,16}$/.test(at) || !(Math.abs(now - Number(at)) <= JOB_MAX_AGE_MS)) return { status: 401, error: 'not a job of ours' }
  const want = Buffer.from(signJob(body, at, secret))
  const got = Buffer.from(sig)
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { status: 401, error: 'not a job of ours' }
  try {
    const job = JSON.parse(body)
    if (job && typeof job === 'object' && typeof job.type === 'string') return { job }
  } catch {
    /* signed, but not a job */
  }
  return { status: 400, error: 'not a job' }
}
