// Types for triage.mjs. The runtime is triage.mjs.

export declare const TRIAGE_MS: number
export declare function wallNow(now: number | Date, tz: string): string
export declare function dueAtFrom(value: unknown, tz: string, now: number): string | null
export declare function triagePrompt(
  email: { subject?: string; text?: string; from?: string; title?: string },
  at: { tz: string; now: number },
): { system: string; prompt: string }
export declare function readTriage(text: unknown, task: { tags?: string[] }, at: { tz: string; now: number }): Record<string, unknown> | null

export type TriageOutcome = { state: 'triaged' | 'unchanged' | 'edited' | 'gone' | 'off' } | { state: 'no answer' | 'failed'; why: string }
export declare function runTriage(job: Record<string, unknown>): Promise<TriageOutcome>
