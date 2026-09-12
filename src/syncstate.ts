/** Delta cursor for sync_posts — null/absent means a full exchange. */
export const CURSOR_KEY = 'drafter:sync-cursor'
/** Ids waiting to push; only used when a cursor is present. */
export const DIRTY_KEY = 'drafter:dirty-ids'

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
