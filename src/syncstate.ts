/** Delta cursor for sync_posts — null/absent means a full exchange. */
export const CURSOR_KEY = 'drafter:sync-cursor'
/** Ids waiting to push; only used when a cursor is present. */
export const DIRTY_KEY = 'drafter:dirty-ids'
/** Ids the server refused, with the reason and when to try each again. */
export const FAILURES_KEY = 'drafter:sync-failures'

/** The small synchronous store this state lives in: localStorage in the app, a Map in tests. */
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

export function readDirty(kv: KV = browserKV): Set<string> {
  try {
    const raw = kv.getItem(DIRTY_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

export function writeDirty(ids: Set<string>, kv: KV = browserKV): void {
  try {
    kv.setItem(DIRTY_KEY, JSON.stringify([...ids]))
  } catch {
    /* ignore */
  }
}

export function readCursor(kv: KV = browserKV): string | null {
  try {
    return kv.getItem(CURSOR_KEY)
  } catch {
    return null
  }
}

export function writeCursor(iso: string, kv: KV = browserKV): void {
  try {
    kv.setItem(CURSOR_KEY, iso)
  } catch {
    /* ignore */
  }
}

/** Drop the delta cursor so the next sync_posts uses since=null (full exchange). */
export function clearSyncCursor(kv: KV = browserKV): void {
  try {
    kv.removeItem(CURSOR_KEY)
  } catch {
    /* ignore */
  }
}

export function clearDirtyIds(kv: KV = browserKV): void {
  try {
    kv.removeItem(DIRTY_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * Same effect as Settings → Data → Full resync's cursor reset.
 * When local cache is empty, also drop the dirty set (stale ids would only confuse a full pull).
 */
export function prepareFullResync(opts?: { clearDirty?: boolean }, kv: KV = browserKV): void {
  clearSyncCursor(kv)
  if (opts?.clearDirty) clearDirtyIds(kv)
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

export function readFailures(kv: KV = browserKV): Map<string, SyncFailure> {
  const out = new Map<string, SyncFailure>()
  try {
    const raw = kv.getItem(FAILURES_KEY)
    const arr = raw ? JSON.parse(raw) : []
    for (const f of Array.isArray(arr) ? arr : []) {
      if (!f || typeof f !== 'object' || typeof f.id !== 'string') continue
      const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
      out.set(f.id, {
        id: f.id,
        reason: typeof f.reason === 'string' && f.reason ? f.reason : undefined,
        attempts: Math.max(1, Math.round(n(f.attempts, 1))),
        nextAt: n(f.nextAt, 0),
        firstAt: n(f.firstAt, 0),
      })
    }
  } catch {
    /* a corrupt entry only costs the backoff, never the dirty row */
  }
  return out
}

export function writeFailures(failures: Map<string, SyncFailure>, kv: KV = browserKV): void {
  try {
    if (failures.size === 0) kv.removeItem(FAILURES_KEY)
    else kv.setItem(FAILURES_KEY, JSON.stringify([...failures.values()]))
  } catch {
    /* ignore */
  }
}
