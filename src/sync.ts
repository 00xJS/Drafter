import { Item } from './types'
import { sanitizeItem } from './schema'
import { getSupabase } from './supabase'

export interface SyncResult {
  /** Items newer than `since` (everything when since is null). Null when unreachable. */
  items: Item[] | null
  /** Ids the server refused to store — drop from the dirty set; do not clamp the cursor. */
  rejected: string[]
  /** True when the failure was an expired/invalid session rather than the network. */
  authError: boolean
  /**
   * True when the server answered in the { items, rejected } shape — it says
   * what it refused. Then a sent row that is neither rejected nor echoed was
   * accepted unchanged, and the caller may count it confirmed.
   */
  reportsRejections: boolean
}

type RemoteRow = Item & { syncedAt?: string }

/**
 * Delta sync against the sync_posts RPC: push dirty items, receive rows newer
 * than the synced_at cursor. `since: null` is a full exchange.
 */
export async function syncNow(outgoing: Item[], since: string | null): Promise<SyncResult> {
  const sb = getSupabase()
  if (!sb) return { items: null, rejected: [], authError: false, reportsRejections: false }
  const { data, error } = await sb.rpc('sync_posts', { incoming: outgoing, since })
  if (error) {
    console.error('Supabase sync failed:', error.message)
    const msg = `${error.message} ${error.code ?? ''}`.toLowerCase()
    const authError = msg.includes('jwt') || msg.includes('401') || msg.includes('permission denied')
    return { items: null, rejected: [], authError, reportsRejections: false }
  }
  // new shape: { items, rejected }; legacy array still accepted during rollout
  let rows: unknown[] = []
  let rejected: string[] = []
  let reportsRejections = false
  if (Array.isArray(data)) {
    rows = data
  } else if (data && typeof data === 'object') {
    reportsRejections = true
    const obj = data as { items?: unknown; rejected?: unknown }
    rows = Array.isArray(obj.items) ? obj.items : []
    rejected = Array.isArray(obj.rejected) ? obj.rejected.filter((x): x is string => typeof x === 'string') : []
  } else {
    return { items: null, rejected: [], authError: false, reportsRejections: false }
  }
  const items: RemoteRow[] = []
  for (const raw of rows) {
    const syncedAt =
      raw && typeof raw === 'object' && typeof (raw as { syncedAt?: unknown }).syncedAt === 'string'
        ? (raw as { syncedAt: string }).syncedAt
        : undefined
    const clean = sanitizeItem(raw)
    if (clean) items.push(syncedAt ? { ...clean, syncedAt } : clean)
  }
  return { items, rejected, authError: false, reportsRejections }
}

/**
 * The content-free tombstone "Delete forever" pushes for a kind. Every
 * sanitizer accepts this shape when deletedAt is set (see schema.ts), or a
 * device that still holds the live copy would discard the tombstone and keep
 * showing the record.
 */
export function purgeTombstone(kind: Item['kind'], id: string, now: string): Record<string, unknown> {
  const base = { kind, id, deletedAt: now, purged: true, updatedAt: now, createdAt: now }
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
    default:
      return base
  }
}

/**
 * Soft-purge: push stripped tombstones with purged:true so peers see the delete.
 * A nightly job hard-deletes tombstones older than the TTL.
 */
export async function purgeRemote(ids: string[], items: Item[]): Promise<void> {
  const sb = getSupabase()
  if (!sb || ids.length === 0) return
  const byId = new Map(items.map(i => [i.id, i]))
  const now = new Date().toISOString()
  const tombstones = ids.map(id => purgeTombstone(byId.get(id)?.kind ?? 'task', id, now))
  const { error } = await sb.rpc('sync_posts', { incoming: tombstones, since: null })
  if (error) throw new Error(error.message)
}
