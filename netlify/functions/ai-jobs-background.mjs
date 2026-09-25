// The server's AI work that nobody waits on, as a Netlify background function:
// the caller is answered 202 at once, and this runs for up to fifteen minutes.
// Three jobs, each started by one of our own functions with a signed request
// (lib/aijobs.mjs): Sunday's review drafts and the nightly recipe drafts, both
// started by the hourly digest (lib/sundaydraft.mjs, lib/recipedrafts.mjs),
// and one email's triage, started by the email-in webhook (lib/triage.mjs).
// Each keeps its outcome in job_runs.
//
// It never throws. Netlify runs a background invocation that fails twice more,
// a minute and then two apart, and each retry would ask the model again.

import { readJob } from './lib/aijobs.mjs'
import { runRecipeDrafts } from './lib/recipedrafts.mjs'
import { runSundayDrafts } from './lib/sundaydraft.mjs'
import { runTriage } from './lib/triage.mjs'

export const config = { background: true }

/**
 * The handler, with the job reader's clock and key replaceable for tests.
 * @param {{ secret?: string, now?: () => number }} [opts]
 */
export function aiJobsHandler(opts = {}) {
  return async req => {
    const read = await readJob(req, { ...(opts.secret !== undefined ? { secret: opts.secret } : {}), now: (opts.now ?? Date.now)() })
    if (!('job' in read)) return new Response(read.error, { status: read.status })
    const { job } = read
    try {
      if (job.type === 'sunday-drafts') {
        const out = await runSundayDrafts(job)
        return Response.json(out)
      }
      if (job.type === 'triage') return Response.json(await runTriage(job))
      if (job.type === 'recipe-drafts') return Response.json(await runRecipeDrafts(job))
      return new Response('unknown job', { status: 400 })
    } catch (e) {
      console.error(`ai-jobs: ${job.type} stopped: ${e?.message ?? e}`)
      return new Response('stopped', { status: 200 })
    }
  }
}

export default aiJobsHandler()
