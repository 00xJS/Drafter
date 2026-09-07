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
export declare function nextOccurrence(task: Task, uidFn: () => string): Task | null
