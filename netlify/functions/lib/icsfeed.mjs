// A subscribed calendar feed (ICS): the address someone pasted into Settings,
// fetched for /api/calendars through the one careful transport
// (lib/safefetch.mjs) — so a link can no more reach the cloud's metadata
// address or a private network from here than from the recipe importer — and
// kept for a while on a warm function.
//
// Why the cache. The app asked for every feed each time it came to the front,
// and each ask downloaded the whole calendar again: a family calendar of a few
// years is a megabyte or two, several times an hour, for nothing new. So a
// feed fetched in the last FRESH_MS is answered from memory, and one older than
// that is asked for again with the validators its server gave (If-None-Match,
// If-Modified-Since): the usual answer is a 304 with no body. A pull-to-refresh
// skips the freshness window (`fresh`), never the conditional request. The
// cache lives in this instance's memory only, capped by size, least recently
// used out first; an address is its own key, as it is its own credential.

import { SafeFetchError, checkUrl, safeGet } from './safefetch.mjs'

export const FEED_LIMITS = Object.freeze({
  timeoutMs: 12_000,
  maxBytes: 4 * 1024 * 1024,
  /** iCloud's public links hop between its servers before they answer. */
  maxRedirects: 5,
  /** A feed fetched this recently is not asked for again. */
  freshMs: 3 * 60_000,
  /** What one warm instance keeps, all feeds together. */
  cacheBytes: 24 * 1024 * 1024,
})

/** What Settings shows beside a feed that could not be read. */
export class FeedError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'FeedError'
  }
}

const NOT_AN_ADDRESS = 'not a valid https:// or webcal:// address'

/** The calendars' own words for each way the transport can refuse (lib/safefetch.mjs FETCH_FAILURES). */
const WORDS = {
  not_a_link: () => NOT_AN_ADDRESS,
  scheme: () => NOT_AN_ADDRESS,
  credentials: () => 'An address with a user name or password in it can’t be subscribed to.',
  port: () => 'That address asks for a port Drafter doesn’t open.',
  refused: () => 'Drafter won’t fetch that address: it isn’t on the public internet.',
  not_found: () => 'Couldn’t find that calendar’s server — check the address.',
  encoding: () => 'The calendar’s server answered in a compression Drafter can’t read.',
  redirects: () => 'That address redirects too many times.',
  redirect_nowhere: () => 'The calendar’s server redirected without saying where to.',
  redirect_bad: () => 'The calendar’s server redirected somewhere that isn’t a web address.',
  http: status => `The calendar’s server answered ${status}.`,
  type: () => 'not an iCalendar (.ics) feed',
  too_big: () => `calendar is too large (${FEED_LIMITS.maxBytes / 1024 / 1024} MB max)`,
  timeout: () => 'timed out fetching the calendar',
  failed: () => 'Couldn’t fetch the calendar.',
}

function asFeedError(err) {
  if (err instanceof FeedError) return err
  if (err instanceof SafeFetchError) return new FeedError((WORDS[err.code] ?? WORDS.failed)(err.detail))
  return new FeedError(WORDS.failed())
}

/**
 * The feed's address as a URL the transport will fetch: webcal:// (and
 * webcals://) is https://, and the rest is checkUrl's rule (http and https,
 * the usual ports, no credentials). Throws a FeedError with the reason.
 * @param {unknown} raw
 * @returns {URL}
 */
export function feedUrl(raw) {
  try {
    return checkUrl(String(raw ?? '').trim().replace(/^webcals?:\/\//i, 'https://'))
  } catch (err) {
    throw asFeedError(err)
  }
}

/**
 * @typedef {{ text: string, etag: string | null, lastModified: string | null, checkedAt: number, bytes: number }} CachedFeed
 */

/**
 * A feed cache: address -> the last copy and its validators, least recently
 * used first out once the copies together pass `maxBytes`.
 * @param {{ maxBytes?: number }} [opts]
 */
export function createFeedCache({ maxBytes = FEED_LIMITS.cacheBytes } = {}) {
  /** @type {Map<string, CachedFeed>} */
  const entries = new Map()
  let total = 0
  const drop = key => {
    const had = entries.get(key)
    if (!had) return
    total -= had.bytes
    entries.delete(key)
  }
  return {
    /** @param {string} key */
    get(key) {
      const hit = entries.get(key)
      if (!hit) return null
      // a Map keeps insertion order: moved to the end, it is the most recently used
      entries.delete(key)
      entries.set(key, hit)
      return hit
    },
    /** @param {string} key @param {CachedFeed} entry */
    set(key, entry) {
      drop(key)
      if (entry.bytes > maxBytes) return
      entries.set(key, entry)
      total += entry.bytes
      for (const oldest of entries.keys()) {
        if (total <= maxBytes) break
        drop(oldest)
      }
    },
    get size() {
      return entries.size
    },
  }
}

const sharedCache = createFeedCache()

const REQUEST_HEADERS = Object.freeze({
  accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1',
  'accept-encoding': 'gzip, br',
  'user-agent': 'Drafter/1.0 (calendar subscription)',
})

/** The feed's text in the character set its server names, else UTF-8, which iCalendar is by definition. */
function decode(bytes, contentType) {
  const charset = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType ?? '')?.[1]
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/**
 * @typedef {import('./safefetch.mjs').SafeGetOptions & {
 *   cache?: ReturnType<typeof createFeedCache>,
 *   freshMs?: number,
 *   fresh?: boolean,
 *   now?: () => number,
 * }} FeedOptions
 */

/**
 * The feed's text: from memory while it is fresh (unless `fresh` asks for
 * the server), else from its server — conditionally, when a copy is kept.
 * `from` says which: 'memory', 'revalidated' (a 304) or 'network'. Throws a
 * FeedError with the reason, which Settings shows beside the feed.
 * @param {URL} url from feedUrl
 * @param {FeedOptions} [opts]
 * @returns {Promise<{ text: string, from: 'memory' | 'revalidated' | 'network' }>}
 */
export async function fetchFeed(url, opts = {}) {
  const {
    cache = sharedCache,
    freshMs = FEED_LIMITS.freshMs,
    fresh = false,
    now = () => Date.now(),
    timeoutMs = FEED_LIMITS.timeoutMs,
    maxBytes = FEED_LIMITS.maxBytes,
    maxRedirects = FEED_LIMITS.maxRedirects,
    resolve,
    transport,
    isAllowed,
  } = opts
  const key = url.toString()
  const hit = cache.get(key)
  if (hit && !fresh && now() - hit.checkedAt < freshMs) return { text: hit.text, from: 'memory' }
  const headers = { ...REQUEST_HEADERS }
  if (hit?.etag) headers['if-none-match'] = hit.etag
  if (hit?.lastModified) headers['if-modified-since'] = hit.lastModified
  let res
  try {
    res = await safeGet(url, { resolve, transport, isAllowed, timeoutMs, maxBytes, maxRedirects, headers })
  } catch (err) {
    throw asFeedError(err)
  }
  if (res.status === 304) {
    // asked conditionally only with a copy in hand; a 304 to an unconditional ask says nothing
    if (!hit) throw new FeedError('The calendar’s server answered with nothing to show.')
    cache.set(key, { ...hit, checkedAt: now() })
    return { text: hit.text, from: 'revalidated' }
  }
  const text = decode(res.body, res.header('content-type'))
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new FeedError(WORDS.type())
  cache.set(key, { text, etag: res.header('etag') || null, lastModified: res.header('last-modified') || null, checkedAt: now(), bytes: res.body.byteLength })
  return { text, from: 'network' }
}
