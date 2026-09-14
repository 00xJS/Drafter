import { useEffect, useState } from 'react'
import { SyncCheck, fetchSyncCheck } from '../../admin'
import { SyncAlarmDismissal, readSyncAlarmDismissal, syncAlarmOf, writeSyncAlarmDismissal } from '../../syncalarm'

/** How often, at most, the check is read again as the app comes back to the front. */
const REREAD_MS = 15 * 60_000

/**
 * Today's sync alarm, for the site owner only: the latest hourly sync check,
 * read as Admin → Data reads it (admin.mjs syncCheck) when the app opens and
 * again as it comes back to the front, at most every REREAD_MS. Nothing is
 * read for anyone else. Dismissing it is this device's own note.
 */
export function useSyncAlarm(isOwner: boolean) {
  const [check, setCheck] = useState<SyncCheck | null>(null)
  const [dismissed, setDismissed] = useState<SyncAlarmDismissal | null>(readSyncAlarmDismissal)

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
      fetchSyncCheck().then(
        c => {
          if (alive) setCheck(c)
        },
        () => {
          /* no answer, no banner: Admin → Data still has the card */
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

  const syncAlarm = syncAlarmOf(check, new Date(), dismissed)
  const dismissSyncAlarm = () => {
    if (!syncAlarm) return
    const d = { since: syncAlarm.since, at: new Date().toISOString() }
    writeSyncAlarmDismissal(d)
    setDismissed(d)
  }
  return { syncAlarm, dismissSyncAlarm }
}
