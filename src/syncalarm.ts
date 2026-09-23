import type { SyncCheck } from './admin'
import type { JobRecord, OpsHealth } from './ops'

// Today's banner for the site owner when the hourly sync check (the canary,
// netlify/functions/lib/canary.mjs) finds the server refusing writes. The
// canary tells the owner through the digest's push or email; with both off
// nothing reached them outside Admin → Data, so Today says it too, until
// dismissed, with the way to that card. Only a refusal counts, as it does for
// the alert: a check that could not run at all is what every run looks like
// between a deploy and the migration that installs it, and Admin shows it.
//
// Since v3.29 the same banner carries the scheduled jobs (jobAlarms): a
// nightly backup that failed or has not worked for a day and a half, and an
// hourly digest that has stopped or failed. A job that failed used to answer
// 200 and log it where nobody looks, and one that stopped left nothing at all.

const HOUR = 3_600_000

/**
 * A failing check older than this is not news for Today: the digest runs it
 * hourly, so one this old means the check itself has stopped running — and
 * that is the digest's own alarm now ("The hourly digest has stopped",
 * jobAlarms), three hours in.
 */
export const SYNC_ALARM_RECENT_MS = 48 * HOUR

/**
 * Dismissed, the banner stays away this long while the check keeps failing —
 * as long as the push and email alert waits (ALERT_GAP_MS) — and comes back at
 * once for a new run of failures.
 */
export const SYNC_ALARM_SNOOZE_MS = 12 * HOUR

export interface SyncAlarm {
  /** The banner's first words; without them it is the sync check's own, "Some edits are not reaching the server." */
  title?: string
  /** The check's own sentence, as Admin → Data words it. */
  sentence: string
  /** When this run of failures began: a dismissal holds for this run only. */
  since: string
  /** A scheduled job's alarm (v3.29), put aside on a list of its own; the sync check's carries none. */
  job?: 'backup' | 'digest'
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

// ---- the scheduled jobs (v3.29)

/** The hourly digest, or the sync check it runs, not heard from for this long has stopped. */
export const DIGEST_STALE_MS = 3 * HOUR
/** No nightly backup that wrote every snapshot for this long: the job has stopped, or keeps failing. */
export const BACKUP_STALE_MS = 36 * HOUR

/** "40 minutes", "5 hours", "3 days". */
export function howLong(ms: number): string {
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
  if (!Number.isFinite(ms) || ms < HOUR) return unit(Math.max(1, Math.round((Number.isFinite(ms) ? ms : 0) / 60_000)), 'minute')
  if (ms < 48 * HOUR) return unit(Math.round(ms / HOUR), 'hour')
  return unit(Math.floor(ms / (24 * HOUR)), 'day')
}

/** A failed run in a sentence: its first failure, how many more, and when. */
function failedRun(r: JobRecord, now: number): string {
  const first = (r.failures[0] ?? 'it gave no reason').replace(/[.\s]+$/, '').slice(0, 200)
  const more = r.failureCount > 1 ? ` (and ${r.failureCount - 1} more)` : ''
  return `${first}${more}, ${howLong(now - Date.parse(r.at))} ago.`
}

/**
 * The scheduled jobs' alarms, the most pressing first: the nightly backup
 * failed, or none has worked for BACKUP_STALE_MS; the hourly digest has not
 * run for DIGEST_STALE_MS, or its last run failed. A job with no record says
 * nothing — records begin with the v3.29 deploy — except that the sync check
 * the digest runs stands in for the digest's, and the newest snapshot in the
 * bucket for the backup's (admin.mjs sends it while there is no record).
 */
export function jobAlarms(health: OpsHealth | null | undefined, now: Date): SyncAlarm[] {
  const t = now.getTime()
  const out: SyncAlarm[] = []

  const backup = health?.jobs?.backup ?? null
  if (backup && !backup.ok) {
    // the snapshots are the backup; a run that wrote them and then failed at housekeeping is a lesser thing
    const wrote = !!backup.lastGoodAt && backup.lastGoodAt === backup.at
    out.push({ job: 'backup', title: wrote ? 'The nightly backup had a problem:' : 'Nightly backup failed:', sentence: failedRun(backup, t), since: `backup-failed:${backup.failingSince ?? backup.at}` })
  } else {
    const lastGood = backup ? backup.lastGoodAt : (health?.lastSnapshotAt ?? null)
    const good = Date.parse(lastGood ?? '')
    if ((backup || lastGood) && (!Number.isFinite(good) || t - good > BACKUP_STALE_MS)) {
      out.push({
        job: 'backup',
        title: 'No recent backup.',
        sentence: Number.isFinite(good) ? `The last nightly backup that worked was ${howLong(t - good)} ago.` : 'No nightly backup has worked yet.',
        since: `backup-stale:${lastGood ?? 'never'}`,
      })
    }
  }

  const digest = health?.jobs?.digest ?? null
  const heard = [digest?.at, health?.syncCheck?.record?.at].map(s => Date.parse(s ?? '')).filter(Number.isFinite)
  const lastRun = heard.length ? Math.max(...heard) : null
  if (lastRun !== null && t - lastRun > DIGEST_STALE_MS) {
    out.push({
      job: 'digest',
      title: 'The hourly digest has stopped.',
      sentence: `It last ran ${howLong(t - lastRun)} ago, so no digest, due-now nudge or sync check has gone out since.`,
      since: `digest-stale:${new Date(lastRun).toISOString()}`,
    })
  } else if (digest && !digest.ok) {
    out.push({ job: 'digest', title: 'The hourly digest failed:', sentence: failedRun(digest, t), since: `digest-failed:${digest.failingSince ?? digest.at}` })
  }
  return out
}

/**
 * Today's one banner: the sync check's refusal first, as before, then the
 * jobs' alarms in jobAlarms' order, each put aside on its own for
 * SYNC_ALARM_SNOOZE_MS.
 */
export function opsAlarmOf(
  health: OpsHealth | null | undefined,
  now: Date,
  dismissed?: SyncAlarmDismissal | null,
  dismissedJobs: readonly SyncAlarmDismissal[] = [],
): SyncAlarm | null {
  const sync = syncAlarmOf(health?.syncCheck, now, dismissed)
  if (sync) return sync
  const aside = (a: SyncAlarm) => dismissedJobs.some(d => d.since === a.since && now.getTime() - Date.parse(d.at) < SYNC_ALARM_SNOOZE_MS)
  return jobAlarms(health, now).find(a => !aside(a)) ?? null
}

const JOB_DISMISSED_KEY = 'drafter:job-alarm-dismissed'

/** The jobs' alarms this device has put aside, newest first. */
export function readJobAlarmDismissals(): SyncAlarmDismissal[] {
  try {
    const list = JSON.parse(localStorage.getItem(JOB_DISMISSED_KEY) ?? '[]') as Partial<SyncAlarmDismissal>[] | null
    return Array.isArray(list) ? list.filter((d): d is SyncAlarmDismissal => typeof d?.since === 'string' && typeof d.at === 'string').map(d => ({ since: d.since, at: d.at })) : []
  } catch {
    return []
  }
}

/** Put one more aside, keeping the newest eight; answers the list as it now stands. */
export function writeJobAlarmDismissal(d: SyncAlarmDismissal, list: readonly SyncAlarmDismissal[] = readJobAlarmDismissals()): SyncAlarmDismissal[] {
  const next = [d, ...list.filter(x => x.since !== d.since)].slice(0, 8)
  try {
    localStorage.setItem(JOB_DISMISSED_KEY, JSON.stringify(next))
  } catch {
    /* kept for this session only */
  }
  return next
}
