import { Metrics, Platform, Post, Status } from '../src/types'

export declare const PLATFORMS: Platform[]
export declare const STATUSES: Status[]
export declare const METRIC_KEYS: (keyof Metrics)[]
export declare function engagement(post: Pick<Post, 'metrics'>): number
export declare function impressions(post: Pick<Post, 'metrics'>): number
export declare function cleanMetrics(raw: unknown): Metrics
export declare function newerStamp(prevIso?: string): string
export declare function nextOccurrence(post: Post, uidFn: () => string): Post | null
