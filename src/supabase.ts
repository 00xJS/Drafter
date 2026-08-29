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
