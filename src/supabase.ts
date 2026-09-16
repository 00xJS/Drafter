import { SupabaseClient, createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

let client: SupabaseClient | null = null

export function isSupabaseConfigured(): boolean {
  return Boolean(url && anonKey)
}

/**
 * A key of the new style ("sb_publishable_…") is not a JWT, so Supabase reads
 * it in the `apikey` header alone and refuses it as a Bearer token. supabase-js
 * falls back to sending the key as the bearer whenever nobody is signed in yet,
 * which is exactly when signing in happens, so its fetch is wrapped to drop the
 * header it just added. A signed-in person's own token is never touched, and a
 * legacy key ("eyJ…") keeps both headers as before.
 */
export const isNewKey = (key: string): boolean => key.startsWith('sb_publishable_') || key.startsWith('sb_secret_')

const apiKeyOnly =
  (key: string): typeof fetch =>
  (input, init) => {
    const headers = new Headers(init?.headers)
    if (headers.get('Authorization') === `Bearer ${key}`) headers.delete('Authorization')
    return fetch(input, { ...init, headers })
  }

/** Shared client, or null when the app runs in local mode (no Supabase env vars). */
export function getSupabase(): SupabaseClient | null {
  if (!url || !anonKey) return null
  client ??= isNewKey(anonKey) ? createClient(url, anonKey, { global: { fetch: apiKeyOnly(anonKey) } }) : createClient(url, anonKey)
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
