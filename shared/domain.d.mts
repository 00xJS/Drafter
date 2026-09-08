import { Metrics, Platform, PostStatus, Priority, ProjectStatus, RecurrenceFreq, Task, TaskStatus } from '../src/types'

export declare const PLATFORMS: Platform[]
export declare const METRIC_KEYS: (keyof Metrics)[]
export declare const POST_STATUSES: PostStatus[]
export declare const TASK_STATUSES: TaskStatus[]
export declare const PROJECT_STATUSES: ProjectStatus[]
export declare const PRIORITIES: Priority[]
export declare const RECURRENCE_FREQS: RecurrenceFreq[]
export declare const SOCIAL_PROJECT_ID: string
export declare function engagement(post: { metrics?: Partial<Record<Platform, Metrics>> }): number
export declare function impressions(post: { metrics?: Partial<Record<Platform, Metrics>> }): number
export declare function cleanMetrics(raw: unknown): Metrics
export declare function newerStamp(prevIso?: string): string
export declare function isLegacyPost(raw: unknown): boolean
export declare function legacyPostToTask(raw: unknown): unknown
export declare function localDate(iso: string | number, tz?: string | null): string | null
export declare function isUntimed(iso: string, tz?: string | null): boolean
export declare function localMidnightIso(dateKey: string): string | null
export declare function spawnId(taskId: string, freq: string, nextDueIso: string): string
export declare function nextOccurrence(task: Task, uidFn: () => string): Task | null
export declare function isMineTask(task: { kind?: string; ownerId?: string; assigneeId?: string }, myId?: string | null): boolean
