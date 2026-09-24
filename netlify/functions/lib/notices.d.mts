import type { Notice } from '../../../src/types.ts'

export declare function noticesStored(): Promise<boolean>
export declare function forgetNoticesStored(): void
export declare function putNotice(
  notice: Notice,
  recipientId: string,
  merge?: (existing: Notice | null | undefined, incoming: Notice) => Notice,
): Promise<{ ok: true; notice: Notice; unchanged?: true } | { ok: false; reason: string }>
export declare function expireNotices(now?: Date, keepDays?: number): Promise<number>
