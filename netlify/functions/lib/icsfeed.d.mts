// Types for icsfeed.mjs: what calendars.mjs and src/'s tests import from it.
// The runtime is icsfeed.mjs; Netlify bundles the .mjs and never reads this.

import type { SafeGetOptions } from './safefetch.mjs'

export declare const FEED_LIMITS: Readonly<{
  timeoutMs: number
  maxBytes: number
  maxRedirects: number
  freshMs: number
  cacheBytes: number
}>

/** What Settings shows beside a feed that could not be read. */
export declare class FeedError extends Error {
  constructor(message: string)
}

export declare function feedUrl(raw: unknown): URL

export interface CachedFeed {
  text: string
  etag: string | null
  lastModified: string | null
  checkedAt: number
  bytes: number
}

export interface FeedCache {
  get(key: string): CachedFeed | null
  set(key: string, entry: CachedFeed): void
  readonly size: number
}

export declare function createFeedCache(opts?: { maxBytes?: number }): FeedCache

export interface FeedOptions extends SafeGetOptions {
  cache?: FeedCache
  freshMs?: number
  /** Skip the freshness window (a pull-to-refresh); the request is still conditional. */
  fresh?: boolean
  now?: () => number
}

export declare function fetchFeed(url: URL, opts?: FeedOptions): Promise<{ text: string; from: 'memory' | 'revalidated' | 'network' }>
