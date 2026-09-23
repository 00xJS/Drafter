// The scheduled jobs' last runs (public.job_runs, migration 20261006000000).
//
// backup.mjs (@daily) and digest.mjs (@hourly) used to log a failure to the
// console and answer 200 either way, so a job that failed every night — or
// stopped being run at all — looked exactly like one that worked. Each run now
// leaves a record here: when, whether it worked, its counts and the first few
// failures. The service key alone reads it; Admin → Data shows each job's last
// run and the owner's Today banner (src/syncalarm.ts) says when one has
// stopped or failed.
//
// Recording never fails a job: a run whose record cannot be written (the
// migration not applied yet, the database away) still did its work, and its
// HTTP answer is what it always was.

export const JOBS = ['backup', 'digest']
/**
 * The background function's jobs (ai-jobs-background.mjs): Sunday's review
 * draft and email-in's triage. Recorded the same way and shown in Admin →
 * Data once they have run; no alarm reads them, since they run when asked, not
 * on a schedule.
 */
export const BACKGROUND_JOBS = ['sunday-draft', 'email-triage']
/** Failure messages kept per run; the count says how many there were. */
export const FAILURES_KEPT = 5
const FAILURE_MAX = 300

/**
 * The record a run leaves, folded onto the one before it. `run.ok` defaults to
 * "nothing failed"; `run.good` (the backup's: every snapshot was written)
 * defaults to `ok`. A streak of failures keeps the time it began, so a banner
 * put aside for it stays put aside until it ends.
 */
export function nextJobRecord(prev, run, now = new Date()) {
  const at = new Date(now).toISOString()
  const all = (Array.isArray(run?.failures) ? run.failures : []).map(f => String(f?.message ?? f).slice(0, FAILURE_MAX))
  const ok = typeof run?.ok === 'boolean' ? run.ok : all.length === 0
  const good = typeof run?.good === 'boolean' ? run.good : ok
  return {
    at,
    ok,
    counts: run?.counts && typeof run.counts === 'object' ? run.counts : {},
    failures: all.slice(0, FAILURES_KEPT),
    failureCount: all.length,
    failingSince: ok ? null : (prev?.ok === false && prev.failingSince) || at,
    lastOkAt: ok ? at : (prev?.lastOkAt ?? null),
    lastGoodAt: good ? at : (prev?.lastGoodAt ?? null),
  }
}

function fromRow(r) {
  if (!r || typeof r !== 'object') return null
  return {
    at: r.ran_at,
    ok: r.ok === true,
    counts: r.counts && typeof r.counts === 'object' ? r.counts : {},
    failures: Array.isArray(r.failures) ? r.failures.map(String) : [],
    failureCount: Number(r.failure_count) || 0,
    failingSince: r.failing_since ?? null,
    lastOkAt: r.last_ok_at ?? null,
    lastGoodAt: r.last_good_at ?? null,
  }
}

function toRow(job, record) {
  return {
    job,
    ran_at: record.at,
    ok: record.ok,
    counts: record.counts,
    failures: record.failures,
    failure_count: record.failureCount,
    failing_since: record.failingSince,
    last_ok_at: record.lastOkAt,
    last_good_at: record.lastGoodAt,
  }
}

/** Every job's last run: { backup, digest, 'sunday-draft', 'email-triage' }, each null until it has run once. Throws when the table cannot be read. */
export async function readJobs(rest) {
  const rows = await rest('job_runs?select=*')
  const names = [...JOBS, ...BACKGROUND_JOBS]
  const out = Object.fromEntries(names.map(j => [j, null]))
  for (const r of Array.isArray(rows) ? rows : []) if (names.includes(r?.job)) out[r.job] = fromRow(r)
  return out
}

export async function readJob(rest, job) {
  const rows = await rest(`job_runs?job=eq.${encodeURIComponent(job)}&select=*&limit=1`)
  return fromRow(Array.isArray(rows) ? rows[0] : null)
}

export async function writeJob(rest, job, record) {
  await rest('job_runs?on_conflict=job', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(toRow(job, record)),
  })
}

/**
 * Record a run: read the last record, fold this run onto it, write it back.
 * Never throws — a job must not fail for want of its own bookkeeping — and
 * resolves the record written, or null when it could not be.
 */
export async function recordJobRun(rest, job, run, now = new Date()) {
  try {
    const prev = await readJob(rest, job).catch(() => null)
    const record = nextJobRecord(prev, run, now)
    await writeJob(rest, job, record)
    return record
  } catch (e) {
    // a warning, not an error: the run itself did its work, and says so on its own
    console.warn(`${job}: could not record this run: ${e?.message ?? e}`)
    return null
  }
}
