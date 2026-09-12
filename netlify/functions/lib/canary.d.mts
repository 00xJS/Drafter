// Types for the helpers src/ imports in tests. The runtime is canary.mjs.
export interface CanaryFailure {
  kind: string | null
  reason: string
}

export interface CanaryResult {
  ok: boolean
  checked: number
  failures: CanaryFailure[]
  error: string | null
}

export interface CanaryRecord extends CanaryResult {
  at: string
  failingSince: string | null
  alertedAt: string | null
}

type Rest = (path: string, init?: RequestInit) => Promise<unknown>

export declare const CANARY_KEY: string
export declare const ALERT_GAP_MS: number
export declare function runSyncCanary(rest: Rest, kinds?: string[]): Promise<CanaryResult>
export declare function readCanary(rest: Rest): Promise<CanaryRecord | null>
export declare function writeCanary(rest: Rest, record: CanaryRecord): Promise<void>
export declare function nextCanaryRecord(prev: CanaryRecord | null | undefined, result: CanaryResult, now?: Date): { record: CanaryRecord; alert: boolean }
export declare function ago(ms: number): string
export declare function canaryAlert(record: CanaryRecord): { title: string; body: string; text: string }
export declare function canarySentence(record: CanaryRecord | null | undefined, now?: Date): string
