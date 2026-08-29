import { Post } from './types'
import { sanitizePost } from './schema'
import { getSupabase } from './supabase'

export interface SyncResult {
  /** Posts newer than `since` (everything when since is null). Null when unreachable. */
  posts: Post[] | null
  /** True when the failure was an expired/invalid session rather than the network. */
  authError: boolean
}

/**
 * Delta sync against the sync_posts RPC: push only the posts newer than the
 * cursor, receive only the rows newer than the cursor. `since: null` performs
 * a full exchange (first run or repair).
 */
export async function syncNow(outgoing: Post[], since: string | null): Promise<SyncResult> {
  const sb = getSupabase()
  if (!sb) return { posts: null, authError: false }
  const { data, error } = await sb.rpc('sync_posts', { incoming: outgoing, since })
  if (error) {
    console.error('Supabase sync failed:', error.message)
    const msg = `${error.message} ${error.code ?? ''}`.toLowerCase()
    const authError = msg.includes('jwt') || msg.includes('401') || msg.includes('permission denied')
    return { posts: null, authError }
  }
  if (!Array.isArray(data)) return { posts: null, authError: false }
  return { posts: data.map(sanitizePost).filter((p): p is Post => p !== null), authError: false }
}
