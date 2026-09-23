// What a device keeps about its sync: the delta cursor, the records with an
// edit still to push, and the rows the server refused. It lives beside the
// records it covers — in IndexedDB's 'meta' row, written in the same
// transaction as they are (src/idb.ts) — so the two can never disagree.
//
// It used to live in localStorage, written the moment it changed, while the
// records reached IndexedDB 300 ms later: a phone suspended in between kept a
// cursor that had moved past rows it never saved, and the partner's changes
// in them were skipped for good. The keys below are only read now, once, from
// a device an older build left them on (readLegacyBookkeeping).

/** Delta cursor for sync_posts — null/absent means a full exchange. (Legacy: read once.) */
export const CURSOR_KEY = 'drafter:sync-cursor'
/** Ids waiting to push. (Legacy: read once.) */
export const DIRTY_KEY = 'drafter:dirty-ids'
/** Ids the server refused, with the reason and when to try each again. (Legacy: read once.) */
export const FAILURES_KEY = 'drafter:sync-failures'
/** The kinds this build syncs, as last booted. (Legacy: read once.) */
export const KINDS_KEY = 'drafter:sync-kinds'

/** The small synchronous store: localStorage in the app, a Map in tests. */
export interface KV {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** localStorage, looked up on every call so a test (or a locked-down browser) can swap or lack it. */
export const browserKV: KV = {
  getItem: key => globalThis.localStorage?.getItem(key) ?? null,
  setItem: (key, value) => globalThis.localStorage?.setItem(key, value),
  removeItem: key => globalThis.localStorage?.removeItem(key),
}

/** A row the server refused. It stays dirty and is pushed again once `nextAt` passes. */
export interface SyncFailure {
  id: string
  /** What the server said, when it said anything. */
  reason?: string
  /** Refusals in a row; the wait before the next try doubles with each. */
  attempts: number
  /** Epoch ms before which the row is not pushed again (a full exchange sends it anyway). */
  nextAt: number
  /** Epoch ms of the first refusal in this run. */
  firstAt: number
}

/** The sync state kept beside the records. */
export interface SyncBookkeeping {
  /** Where the last answer got to; null: the next round is a full exchange. */
  cursor: string | null
  /**
   * The kinds list of the build that reached the cursor (KINDS_EPOCH). A build
   * that did not know a kind dropped its rows on pull and still moved past
   * them, so a cursor reached under another list is not used.
   */
  kinds: string | null
  /** Records with an edit the server has not confirmed. */
  dirty: string[]
  /** Rows the server refused, and the backoff each waits out. */
  failures: SyncFailure[]
}

export const NO_BOOKKEEPING: SyncBookkeeping = Object.freeze({ cursor: null, kinds: null, dirty: [], failures: [] }) as SyncBookkeeping

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Refusals as stored, one per id; a corrupt entry only costs its backoff, never the dirty row. */
export function parseFailures(v: unknown): SyncFailure[] {
  const out = new Map<string, SyncFailure>()
  for (const f of Array.isArray(v) ? v : []) {
    if (!f || typeof f !== 'object' || typeof f.id !== 'string') continue
    const n = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d)
    out.set(f.id, {
      id: f.id,
      reason: typeof f.reason === 'string' && f.reason ? f.reason : undefined,
      attempts: Math.max(1, Math.round(n(f.attempts, 1))),
      nextAt: n(f.nextAt, 0),
      firstAt: n(f.firstAt, 0),
    })
  }
  return [...out.values()]
}

/** Bookkeeping as read back from storage, or null when there is none to read (a cache an older build wrote). */
export function parseBookkeeping(v: unknown): SyncBookkeeping | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const b = v as Partial<Record<keyof SyncBookkeeping, unknown>>
  return {
    cursor: typeof b.cursor === 'string' && b.cursor ? b.cursor : null,
    kinds: typeof b.kinds === 'string' ? b.kinds : null,
    dirty: [...new Set(strings(b.dirty))],
    failures: parseFailures(b.failures),
  }
}

function read(kv: KV, key: string): string | null {
  try {
    return kv.getItem(key)
  } catch {
    return null
  }
}

function json(raw: string | null): unknown {
  try {
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** What an older build kept in localStorage, or null when it kept nothing there. */
export function readLegacyBookkeeping(kv: KV = browserKV): SyncBookkeeping | null {
  const raw = [CURSOR_KEY, DIRTY_KEY, FAILURES_KEY, KINDS_KEY].map(k => read(kv, k))
  if (raw.every(r => r === null)) return null
  const [cursor, dirty, failures, kinds] = raw
  return { cursor: cursor || null, kinds, dirty: [...new Set(strings(json(dirty)))], failures: parseFailures(json(failures)) }
}

/** Remove what readLegacyBookkeeping read: done once a write has put it beside the records. */
export function forgetLegacyBookkeeping(kv: KV = browserKV): void {
  for (const key of [CURSOR_KEY, DIRTY_KEY, FAILURES_KEY, KINDS_KEY]) {
    try {
      kv.removeItem(key)
    } catch {
      /* read again next boot, and ignored: IndexedDB has its own now */
    }
  }
}
