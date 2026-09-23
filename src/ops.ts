import { adminAction, type SyncCheck } from './admin'

// Is it safe to run (v3.29): the site owner's read-outs of the scheduled jobs
// and of what broke on devices, through /api/admin (admin.mjs opsHealth,
// listErrors, clearErrors). Nobody else can ask; the server checks.

export type JobName = 'backup' | 'digest'

/** A scheduled job's last run, as public.job_runs keeps it (netlify/functions/lib/jobhealth.mjs). */
export interface JobRecord {
  at: string
  ok: boolean
  counts: Record<string, number | boolean | string | null>
  /** The first few failure messages; failureCount says how many there were. */
  failures: string[]
  failureCount: number
  /** The first run of the current streak of failures; null while it works. */
  failingSince: string | null
  lastOkAt: string | null
  /** The backup's: the last run that wrote every snapshot, whatever else failed. */
  lastGoodAt: string | null
}

export interface OpsHealth {
  syncCheck: SyncCheck | null
  /** Each job's last run, null until it has run once; null altogether when the records cannot be read. */
  jobs: Partial<Record<JobName, JobRecord | null>> | null
  /** The newest snapshot in the bucket, read only while the backup has no record of its own. */
  lastSnapshotAt?: string | null
}

/** One error the devices reported, however many times. Never a record: shared/errorreport.mts is what it may hold. */
export interface ClientError {
  id: string
  message: string
  stack: string | null
  count: number
  firstAt: string | null
  lastAt: string | null
  build: string | null
  platform: string | null
  view: string | null
  path: string | null
}

export function fetchOpsHealth(): Promise<OpsHealth> {
  return adminAction('opsHealth')
}

export function fetchClientErrors(): Promise<{ errors: ClientError[]; unavailable?: string }> {
  return adminAction('listErrors')
}

/** Clear one error, or every one without an id. */
export function clearClientErrors(id?: string): Promise<{ cleared: number }> {
  return adminAction('clearErrors', id ? { id } : {})
}
