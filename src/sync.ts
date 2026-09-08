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
}

type RemoteRow = Item & { syncedAt?: string }

/**
 * Delta sync against the sync_posts RPC: push dirty items, receive rows newer
 * than the synced_at cursor. `since: null` is a full exchange.
 */
export async function syncNow(outgoing: Item[], since: string | null): Promise<SyncResult> {
  const sb = getSupabase()
  if (!sb) return { items: null, rejected: [], authError: false }
  const { data, error } = await sb.rpc('sync_posts', { incoming: outgoing, since })
  if (error) {
    console.error('Supabase sync failed:', error.message)
    const msg = `${error.message} ${error.code ?? ''}`.toLowerCase()
    const authError = msg.includes('jwt') || msg.includes('401') || msg.includes('permission denied')
    return { items: null, rejected: [], authError }
  }
  // new shape: { items, rejected }; legacy array still accepted during rollout
  let rows: unknown[] = []
  let rejected: string[] = []
  if (Array.isArray(data)) {
    rows = data
  } else if (data && typeof data === 'object') {
    const obj = data as { items?: unknown; rejected?: unknown }
    rows = Array.isArray(obj.items) ? obj.items : []
    rejected = Array.isArray(obj.rejected) ? obj.rejected.filter((x): x is string => typeof x === 'string') : []
  } else {
    return { items: null, rejected: [], authError: false }
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
  return { items, rejected, authError: false }
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
  const tombstones = ids.map(id => {
    const cur = byId.get(id)
    const kind = cur?.kind ?? 'task'
    return {
      kind,
      id,
      deletedAt: now,
      purged: true,
      updatedAt: now,
      ...(kind === 'task'
        ? { title: '', description: '', status: 'canceled', priority: 'normal', createdAt: now, tags: [] }
        : kind === 'project'
          ? { name: '', color: '#888', status: 'archived', createdAt: now }
          : kind === 'person' || kind === 'place'
            ? { name: '', createdAt: now }
            : { createdAt: now }),
    }
  })
  const { error } = await sb.rpc('sync_posts', { incoming: tombstones, since: null })
  if (error) throw new Error(error.message)
}
