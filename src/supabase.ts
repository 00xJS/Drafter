import { SupabaseClient, createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

let client: SupabaseClient | null = null

export function isSupabaseConfigured(): boolean {
  return Boolean(url && anonKey)
}

/** Shared client, or null when the app runs in local mode (no Supabase env vars). */
export function getSupabase(): SupabaseClient | null {
  if (!url || !anonKey) return null
  client ??= createClient(url, anonKey)
  return client
}

/**
 * The account auth-js last stored on this device, read straight from local
 * storage under supabase-js's own default key: no network and no token
 * refresh, and still there once the access token has expired. Null in local
 * mode, when signed out, or when the stored session cannot be read.
 */
export function storedUserId(): string | null {
  if (!url || !anonKey) return null
  try {
    const raw = localStorage.getItem(`sb-${new URL(url).hostname.split('.')[0]}-auth-token`)
    const id: unknown = raw ? (JSON.parse(raw) as { user?: { id?: unknown } } | null)?.user?.id : null
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}
