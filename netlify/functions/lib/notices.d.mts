import type { Notice } from '../../../src/types.ts'

export declare function noticesStored(): Promise<boolean>
export declare function forgetNoticesStored(): void
export declare function putNotice(notice: Notice, recipientId: string): Promise<{ ok: true; notice: Notice } | { ok: false; reason: string }>
export declare function expireNotices(now?: Date, keepDays?: number): Promise<number>
