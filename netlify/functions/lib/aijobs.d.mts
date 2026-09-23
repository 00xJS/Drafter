// Types for aijobs.mjs. The runtime is aijobs.mjs.

export declare const JOB_PATH: string
export declare const JOB_MAX_AGE_MS: number

export type Job = Record<string, unknown> & { type: string }

/** The signature over a job's moment and body, with a key made from `secret`. */
export declare function signJob(body: string, at: string, secret: string): string
/** Where a function reaches the site's own functions. */
export declare function siteOrigin(fallback?: string): string
/** Hand a job to the background function: true once it has taken it. Never throws. */
export declare function startJob(job: Job, opts?: { origin?: string; secret?: string; fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number }): Promise<boolean>
/** The job a request carries when one of our functions made it lately; otherwise why not. */
export declare function readJob(req: Request, opts?: { secret?: string; now?: number }): Promise<{ job: Job } | { status: number; error: string }>
