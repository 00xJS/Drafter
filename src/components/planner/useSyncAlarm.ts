import { useEffect, useState } from 'react'
import { OpsHealth, fetchOpsHealth } from '../../ops'
import {
  SyncAlarmDismissal,
  opsAlarmOf,
  readJobAlarmDismissals,
  readSyncAlarmDismissal,
  writeJobAlarmDismissal,
  writeSyncAlarmDismissal,
} from '../../syncalarm'

/** How often, at most, the check is read again as the app comes back to the front. */
const REREAD_MS = 15 * 60_000

/**
 * Today's sync alarm, for the site owner only: the latest hourly sync check,
 * read as Admin → Data reads it, and since v3.29 the scheduled jobs' last runs
 * with it (admin.mjs opsHealth), when the app opens and again as it comes
 * back to the front, at most every REREAD_MS. Nothing is read for anyone
 * else. Dismissing it is this device's own note.
 */
export function useSyncAlarm(isOwner: boolean) {
  const [check, setCheck] = useState<OpsHealth | null>(null)
  const [dismissed, setDismissed] = useState<SyncAlarmDismissal | null>(readSyncAlarmDismissal)
  const [dismissedJobs, setDismissedJobs] = useState<SyncAlarmDismissal[]>(readJobAlarmDismissals)

  useEffect(() => {
    if (!isOwner) {
      setCheck(null)
      return
    }
    let alive = true
    let readAt = 0
    const read = () => {
      if (Date.now() - readAt < REREAD_MS) return
      readAt = Date.now()
      fetchOpsHealth().then(
        c => {
          if (alive) setCheck(c)
        },
        () => {
          /* no answer, no banner: Admin → Data still has the cards */
        },
      )
    }
    read()
    const onShow = () => {
      if (document.visibilityState === 'visible') read()
    }
    document.addEventListener('visibilitychange', onShow)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onShow)
    }
  }, [isOwner])

  const syncAlarm = opsAlarmOf(check, new Date(), dismissed, dismissedJobs)
  const dismissSyncAlarm = () => {
    if (!syncAlarm) return
    const d = { since: syncAlarm.since, at: new Date().toISOString() }
    // a job's alarm goes on a list of its own, so putting one aside never brings another back
    if (syncAlarm.job) {
      setDismissedJobs(writeJobAlarmDismissal(d, dismissedJobs))
      return
    }
    writeSyncAlarmDismissal(d)
    setDismissed(d)
  }
  return { syncAlarm, dismissSyncAlarm }
}
