import { Item } from './types'
import { sanitizeItem } from './schema'
import { getSupabase } from './supabase'

export interface SyncResult {
  /** Items newer than `since` (everything when since is null). Null when unreachable. */
  items: Item[] | null
  /** Ids the server refused to store. They stay dirty and are retried with backoff; they never clamp the cursor. */
  rejected: string[]
  /** Why the server refused an id, when it said. */
  reasons: Record<string, string>
  /**
   * Ids we pushed that did not change the server row, because the server's
   * updatedAt was >= ours: this device lost last-write-wins. The server puts
   * its current row for each of them in `items`, even when older than `since`.
   */
  stale: string[]
  /** Ids we pushed that the server had permanently purged; it did not re-insert them. */
  gone: string[]
  /** True when the failure was an expired/invalid session rather than the network. */
  authError: boolean
  /**
   * True when the server answered in the object shape — it says what it
   * refused. Then a sent row that is neither rejected nor echoed was accepted
   * unchanged, and the caller may count it confirmed.
   */
  reportsRejections: boolean
}

type RemoteRow = Item & { syncedAt?: string }

const OFFLINE: Omit<SyncResult, 'authError'> = { items: null, rejected: [], reasons: {}, stale: [], gone: [], reportsRejections: false }

function ids(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function rows(list: unknown[]): RemoteRow[] {
  const items: RemoteRow[] = []
  for (const raw of list) {
    const syncedAt =
      raw && typeof raw === 'object' && typeof (raw as { syncedAt?: unknown }).syncedAt === 'string'
        ? (raw as { syncedAt: string }).syncedAt
        : undefined
    const clean = sanitizeItem(raw)
    if (clean) items.push(syncedAt ? { ...clean, syncedAt } : clean)
  }
  return items
}

/**
 * Read a sync_posts answer in any shape production has spoken or will speak:
 * the legacy bare array of rows; `{ items, rejected }`; and
 * `{ items, rejected, stale, gone }`. A rejected entry may be a bare id or
 * `{ id, reason }`, and a `reasons` map is honoured too — whichever the server
 * sends, a reason is kept for Settings. Null for anything unrecognisable.
 */
export function parseSyncResponse(data: unknown): (Omit<SyncResult, 'authError' | 'items'> & { items: Item[] }) | null {
  if (Array.isArray(data)) return { ...OFFLINE, items: rows(data) }
  if (!data || typeof data !== 'object') return null
  const obj = data as { items?: unknown; rejected?: unknown; reasons?: unknown; stale?: unknown; gone?: unknown }
  const rejected: string[] = []
  const reasons: Record<string, string> = {}
  for (const entry of Array.isArray(obj.rejected) ? obj.rejected : []) {
    if (typeof entry === 'string') rejected.push(entry)
    else if (entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string') {
      const e = entry as { id: string; reason?: unknown; error?: unknown; message?: unknown }
      rejected.push(e.id)
      const why = [e.reason, e.error, e.message].find((x): x is string => typeof x === 'string' && x.trim() !== '')
      if (why) reasons[e.id] = why
    }
  }
  if (obj.reasons && typeof obj.reasons === 'object' && !Array.isArray(obj.reasons)) {
    for (const [id, why] of Object.entries(obj.reasons as Record<string, unknown>)) {
      if (typeof why === 'string' && why.trim() && !reasons[id]) reasons[id] = why
    }
  }
  return {
    items: rows(Array.isArray(obj.items) ? obj.items : []),
    rejected,
    reasons,
    stale: ids(obj.stale),
    gone: ids(obj.gone),
    reportsRejections: true,
  }
}

/**
 * Delta sync against the sync_posts RPC: push dirty items, receive rows newer
 * than the synced_at cursor. `since: null` is a full exchange.
 */
export async function syncNow(outgoing: Item[], since: string | null): Promise<SyncResult> {
  const sb = getSupabase()
  if (!sb) return { ...OFFLINE, authError: false }
  let data: unknown
  try {
    const res = await sb.rpc('sync_posts', { incoming: outgoing, since })
    if (res.error) {
      console.error('Supabase sync failed:', res.error.message)
      const msg = `${res.error.message} ${res.error.code ?? ''}`.toLowerCase()
      const authError = msg.includes('jwt') || msg.includes('401') || msg.includes('permission denied')
      return { ...OFFLINE, authError }
    }
    data = res.data
  } catch (e) {
    // a thrown fetch is the network, not the session
    console.error('Supabase sync failed:', e)
    return { ...OFFLINE, authError: false }
  }
  const parsed = parseSyncResponse(data)
  return parsed ? { ...parsed, authError: false } : { ...OFFLINE, authError: false }
}

/**
 * The content-free tombstone "Delete forever" writes for a kind. Every
 * sanitizer accepts this shape when deletedAt is set (see schema.ts), or a
 * device that still holds the live copy would discard the tombstone and keep
 * showing the record. `now` is its updatedAt — newerStamp of the record it
 * replaces, so it wins against that copy everywhere — and `deletedAt`, which
 * starts the 90-day clock, is the wall clock (the same instant by default).
 */
export function purgeTombstone(kind: Item['kind'], id: string, now: string, deletedAt = now): Record<string, unknown> {
  const base = { kind, id, deletedAt, purged: true, updatedAt: now, createdAt: now }
  switch (kind) {
    case 'task':
      return { ...base, title: '', description: '', status: 'canceled', priority: 'normal', tags: [] }
    case 'project':
      return { ...base, name: '', color: '#888', status: 'archived' }
    case 'person':
    case 'place':
    case 'recipe':
    case 'template':
      return { ...base, name: '' }
    case 'meal':
      return { ...base, title: '', date: '', slot: 'dinner' }
    case 'grocery':
      return { ...base, weekKey: '', items: [] }
    case 'journal':
      // the day stays in the id (journal~YYYY-MM-DD~…); the body is gone on purpose
      return { ...base, date: /^journal~(\d{4}-\d{2}-\d{2})~/.exec(id)?.[1] ?? '', body: '' }
    case 'review':
      return { ...base, period: 'week', key: '', top: [] }
    case 'calendar':
      return { ...base, name: '', url: '', color: '#888', enabled: false }
    case 'note':
      return { ...base, title: '', body: '' }
    default:
      return base
  }
}
