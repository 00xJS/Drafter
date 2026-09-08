/** Delta cursor for sync_posts — null/absent means a full exchange. */
export const CURSOR_KEY = 'drafter:sync-cursor'
/** Ids waiting to push; only used when a cursor is present. */
export const DIRTY_KEY = 'drafter:dirty-ids'

export function readDirty(): Set<string> {
  try {
    const raw = localStorage.getItem(DIRTY_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

export function writeDirty(ids: Set<string>): void {
  try {
    localStorage.setItem(DIRTY_KEY, JSON.stringify([...ids]))
  } catch {
    /* ignore */
  }
}

export function readCursor(): string | null {
  try {
    return localStorage.getItem(CURSOR_KEY)
  } catch {
    return null
  }
}

export function writeCursor(iso: string): void {
  try {
    localStorage.setItem(CURSOR_KEY, iso)
  } catch {
    /* ignore */
  }
}

/** Drop the delta cursor so the next sync_posts uses since=null (full exchange). */
export function clearSyncCursor(): void {
  try {
    localStorage.removeItem(CURSOR_KEY)
  } catch {
    /* ignore */
  }
}

export function clearDirtyIds(): void {
  try {
    localStorage.removeItem(DIRTY_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * Same effect as Settings → Data → Full resync's cursor reset.
 * When local cache is empty, also drop the dirty set (stale ids would only confuse a full pull).
 */
export function prepareFullResync(opts?: { clearDirty?: boolean }): void {
  clearSyncCursor()
  if (opts?.clearDirty) clearDirtyIds()
}
