type Rest = (path: string, init?: RequestInit) => Promise<unknown>

export type JobName = 'backup' | 'digest'
/** The background function's jobs (ai-jobs-background.mjs): recorded like the scheduled ones, shown in Admin → Data, never an alarm. */
export type BackgroundJobName = 'sunday-draft' | 'email-triage'

/** What a run hands in: its counts and failures, and whether it worked. */
export interface JobRun {
  /** Nothing failed; the default is "no failures". */
  ok?: boolean
  /** The backup's own measure: every snapshot was written. Defaults to `ok`. */
  good?: boolean
  counts?: Record<string, number | boolean | string | null>
  failures?: unknown[]
}

/** A job's last run, as public.job_runs keeps it. */
export interface JobRecord {
  at: string
  ok: boolean
  counts: Record<string, number | boolean | string | null>
  failures: string[]
  failureCount: number
  failingSince: string | null
  lastOkAt: string | null
  lastGoodAt: string | null
}

export declare const JOBS: JobName[]
export declare const BACKGROUND_JOBS: BackgroundJobName[]
export declare const FAILURES_KEPT: number
export declare function nextJobRecord(prev: JobRecord | null | undefined, run: JobRun, now?: Date | string | number): JobRecord
export declare function readJobs(rest: Rest): Promise<Record<JobName | BackgroundJobName, JobRecord | null>>
export declare function readJob(rest: Rest, job: JobName | BackgroundJobName): Promise<JobRecord | null>
export declare function writeJob(rest: Rest, job: JobName | BackgroundJobName, record: JobRecord): Promise<void>
export declare function recordJobRun(rest: Rest, job: JobName | BackgroundJobName, run: JobRun, now?: Date): Promise<JobRecord | null>
