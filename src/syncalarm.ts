import type { SyncCheck } from './admin'

// Today's banner for the site owner when the hourly sync check (the canary,
// netlify/functions/lib/canary.mjs) finds the server refusing writes. The
// canary tells the owner through the digest's push or email; with both off
// nothing reached them outside Admin → Data, so Today says it too, until
// dismissed, with the way to that card. Only a refusal counts, as it does for
// the alert: a check that could not run at all is what every run looks like
// between a deploy and the migration that installs it, and Admin shows it.

const HOUR = 3_600_000

/**
 * A failing check older than this is not news for Today: the digest runs it
 * hourly, so one this old means the check itself has stopped running, which
 * is Admin → Data's to show.
 */
export const SYNC_ALARM_RECENT_MS = 48 * HOUR

/**
 * Dismissed, the banner stays away this long while the check keeps failing —
 * as long as the push and email alert waits (ALERT_GAP_MS) — and comes back at
 * once for a new run of failures.
 */
export const SYNC_ALARM_SNOOZE_MS = 12 * HOUR

export interface SyncAlarm {
  /** The check's own sentence, as Admin → Data words it. */
  sentence: string
  /** When this run of failures began: a dismissal holds for this run only. */
  since: string
}

/** A dismissal: the run of failures it was for, and when. */
export interface SyncAlarmDismissal {
  since: string
  at: string
}

/** Today's banner for the latest check, or null when there is nothing to say. */
export function syncAlarmOf(check: SyncCheck | null | undefined, now: Date, dismissed?: SyncAlarmDismissal | null): SyncAlarm | null {
  const r = check?.record
  if (!check || !r || r.ok || !r.failures?.length) return null
  const at = Date.parse(r.at)
  if (!Number.isFinite(at) || now.getTime() - at > SYNC_ALARM_RECENT_MS) return null
  const since = r.failingSince ?? r.at
  if (dismissed?.since === since && now.getTime() - Date.parse(dismissed.at) < SYNC_ALARM_SNOOZE_MS) return null
  return { sentence: check.sentence, since }
}

const DISMISSED_KEY = 'drafter:sync-alarm-dismissed'

/** This device's last dismissal, or null when there is none or it cannot be read. */
export function readSyncAlarmDismissal(): SyncAlarmDismissal | null {
  try {
    const d = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? 'null') as Partial<SyncAlarmDismissal> | null
    return typeof d?.since === 'string' && typeof d.at === 'string' ? { since: d.since, at: d.at } : null
  } catch {
    return null
  }
}

export function writeSyncAlarmDismissal(d: SyncAlarmDismissal): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(d))
  } catch {
    /* kept for this session only: the banner comes back on the next launch */
  }
}
