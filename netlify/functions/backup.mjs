// Scheduled daily: snapshot every user's posts to the private media bucket and
// purge what has aged out. The pass itself lives in lib/backup.mjs so the Admin
// panel can run the identical thing on demand ("Back up now") — this file is
// only the schedule.

import { runBackup } from './lib/backup.mjs'

export const config = { schedule: '@daily' }

export default async () => {
  if (!process.env.SUPABASE_SERVICE_KEY) return new Response('not configured', { status: 200 })

  const { users, failures } = await runBackup()
  const report = `backed up ${users.length} user(s)${failures.length ? `; ${failures.length} failure(s): ${failures.slice(0, 5).join(' | ')}` : ''}`
  if (failures.length) console.error('backup:', report)
  return new Response(report, { status: 200 })
}
