import { afterEach, describe, expect, it, vi } from 'vitest'

// storedUserId reads the account auth-js keeps on this device without asking
// auth-js (no network, no refresh), so a garment photo saved offline, long
// after the access token expired, still goes under its owner's own folder.
// Its key therefore has to be the one supabase-js stores the session under:
// a real client says which.

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

function memoryStorage() {
  const data = new Map<string, string>()
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) }
}

describe('storedUserId', () => {
  it('is null in local mode', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')
    const { storedUserId } = await import('../supabase')
    expect(storedUserId()).toBeNull()
  })

  it('reads the stored session’s user under supabase-js’s own key, and nothing else', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    const { getSupabase, storedUserId } = await import('../supabase')
    const client = getSupabase()!
    // auth-js settles first, with no session of its own, so it never tries a refresh
    await client.auth.getSession()
    expect(storedUserId()).toBeNull()
    const key = (client.auth as unknown as { storageKey: string }).storageKey
    expect(key).toBe('sb-abcdefghijklmnopqrst-auth-token')
    // an expired token is no matter: the account is still the account
    storage.setItem(key, JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: 1, user: { id: 'user-1' } }))
    expect(storedUserId()).toBe('user-1')
    storage.setItem(key, '{not json')
    expect(storedUserId()).toBeNull()
    storage.setItem(key, JSON.stringify({ user: { id: 7 } }))
    expect(storedUserId()).toBeNull()
  })
})
