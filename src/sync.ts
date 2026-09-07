import { Item } from './types'
import { sanitizeItem } from './schema'
import { getSupabase } from './supabase'

export interface SyncResult {
  /** Items newer than `since` (everything when since is null). Null when unreachable. */
  items: Item[] | null
  /** True when the failure was an expired/invalid session rather than the network. */
  authError: boolean
}

/**
 * Delta sync against the sync_posts RPC (the table keeps its historical name;
 * it holds tasks and projects alike): push only the items newer than the
 * cursor, receive only the rows newer than the cursor. `since: null` performs
 * a full exchange (first run or repair).
 */
export async function syncNow(outgoing: Item[], since: string | null): Promise<SyncResult> {
  const sb = getSupabase()
  if (!sb) return { items: null, authError: false }
  const { data, error } = await sb.rpc('sync_posts', { incoming: outgoing, since })
  if (error) {
    console.error('Supabase sync failed:', error.message)
    const msg = `${error.message} ${error.code ?? ''}`.toLowerCase()
    const authError = msg.includes('jwt') || msg.includes('401') || msg.includes('permission denied')
    return { items: null, authError }
  }
  if (!Array.isArray(data)) return { items: null, authError: false }
  return { items: data.map(sanitizeItem).filter((p): p is Item => p !== null), authError: false }
}
