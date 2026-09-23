// Types for the helpers src/__tests__ imports. The runtime is backup-offsite.mjs.

/** Runs `supabase <args>` and resolves what it printed. */
export type Cli = (args: string[]) => Promise<string>

export interface OffsiteResult {
  accounts: number
  copied: number
  present: number
  plain: number
  pruned: number
  failures: string[]
}

/** Shows a notification; resolves whether it could. */
export type Notify = (title: string, message: string) => Promise<boolean>

export declare const KEEP_DAYS: number
export declare const LABEL: string
export declare const REMOTE: string
export declare const STALE_DAYS: number
export declare const WARN_EVERY_DAYS: number
export declare const PINNED_FILES: readonly string[]
export declare function defaultPaths(home?: string): { cloud: string; dest: string; log: string; pinned: string; state: string }
export declare function supabaseCli(opts?: { bin?: string; cwd?: string }): Cli
export declare function listedNames(stdout: unknown): string[]
export declare function cutoffDay(now: Date | number | string, keepDays?: number): string
export declare function copiesToPrune(names: string[], now: Date | number | string, keepDays?: number): string[]
export declare function copyOffsite(opts: { cli: Cli; dest: string; cloud?: string; tmp?: string; now?: Date; keepDays?: number }): Promise<OffsiteResult>
export declare function newestCopyDay(names: string[]): string | null
export declare function newestCopyIn(dest: string): Promise<string | null>
export declare function staleCheck(opts: { newest: string | null; now: Date | number | string; lastWarnedAt?: string | null }): { stale: boolean; ageDays: number | null; warn: boolean }
export declare function staleMessage(newest: string | null, ageDays: number | null): string
export declare function notificationArgs(title: string, message: string): string[]
export declare function macNotifier(opts?: {
  bin?: string
  run?: (bin: string, args: string[], opts: { timeout: number }, done: (err: Error | null) => void) => unknown
  os?: string
}): Notify
export declare function pinCopy(opts: { from?: string; to: string }): Promise<{ files: string[]; linked: boolean }>
export declare function logLine(now: Date | number | string, result: OffsiteResult | null, error?: unknown): string
export declare function launchAgentPlist(opts: {
  node: string
  supabase: string
  script?: string
  repo?: string
  log?: string
  hour?: number
  minute?: number
  label?: string
}): string
export declare function main(
  argv?: string[],
  deps?: { home?: string; cli?: Cli | null; now?: Date; tmp?: string; out?: Pick<Console, 'log' | 'error'>; notify?: Notify | null },
): Promise<number>
