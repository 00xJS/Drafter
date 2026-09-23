// Scheduled daily: snapshot every user's posts to the private media bucket and
// purge what has aged out. The pass itself lives in lib/backup.mjs so the Admin
// panel can run the identical thing on demand ("Back up now") — this file is
// only the schedule, and the record each scheduled run leaves in job_runs
// (lib/jobhealth.mjs), which is how a night that failed, or a schedule that
// stopped, reaches the owner rather than only this function's log.
//
// After the snapshots, the hub's notices older than thirty days are let go
// (lib/notices.mjs expireNotices): each becomes the tombstone "Delete forever"
// writes, so its reader's devices drop it too, and the tombstone ages out with
// the rest. Nightly housekeeping only — Back up now leaves notices alone.

import { rest, runBackup } from './lib/backup.mjs'
import { recordJobRun } from './lib/jobhealth.mjs'
import { expireNotices } from './lib/notices.mjs'

export const config = { schedule: '@daily' }

export default async () => {
  if (!process.env.SUPABASE_SERVICE_KEY) return new Response('not configured', { status: 200 })

  const now = new Date()
  let result
  try {
    result = await runBackup(now)
  } catch (e) {
    // a read that could not be finished writes no snapshot at all: a failed night
    await recordJobRun(rest, 'backup', { ok: false, good: false, failures: [`the run stopped: ${e?.message ?? e}`] }, now)
    throw e
  }
  const { users } = result
  const failures = [...result.failures]
  const noticesExpired = await expireNotices(now).catch(e => {
    failures.push(`notices: ${e?.message ?? e}`)
    return null
  })
  await recordJobRun(
    rest,
    'backup',
    {
      // every snapshot written, whatever the housekeeping after them did
      good: result.snapshotsFailed === 0,
      counts: {
        snapshots: users.length,
        records: users.reduce((n, u) => n + u.items, 0),
        encrypted: result.encrypted,
        historyPurged: result.historyPurged,
        photosDeleted: result.photosDeleted,
        tombstonesPurged: result.tombstonesPurged,
        errorsPurged: result.errorsPurged,
        noticesExpired,
      },
      failures,
    },
    now,
  )
  const report = `backed up ${users.length} user(s)${failures.length ? `; ${failures.length} failure(s): ${failures.slice(0, 5).join(' | ')}` : ''}`
  if (failures.length) console.error('backup:', report)
  return new Response(report, { status: 200 })
}
