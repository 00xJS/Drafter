import { Post } from './types'
import { sanitizePost } from './schema'
import { getSupabase } from './supabase'

function sanitizeList(list: unknown[]): Post[] {
  return list.map(sanitizePost).filter((p): p is Post => p !== null)
}

/**
 * Push the local set and receive the merged set back (last-write-wins per post).
 * Uses Supabase when configured, else the local `npm run server` endpoint.
 * Returns null when no backend is reachable (the app keeps working locally).
 */
export async function syncNow(local: Post[]): Promise<Post[] | null> {
  const sb = getSupabase()
  if (sb) {
    const { data, error } = await sb.rpc('sync_posts', { incoming: local })
    if (error) {
      console.error('Supabase sync failed:', error.message)
      return null
    }
    return Array.isArray(data) ? sanitizeList(data) : null
  }

  try {
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ posts: local }),
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return null
    const data: unknown = await res.json()
    const list = data && typeof data === 'object' ? (data as { posts?: unknown }).posts : null
    return Array.isArray(list) ? sanitizeList(list) : null
  } catch {
    return null
  }
}
