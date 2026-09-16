import { afterEach, describe, expect, it, vi } from 'vitest'

// A key of the new style ("sb_publishable_…") is not a JWT: Supabase reads it
// in the apikey header alone and refuses it as a Bearer token. supabase-js
// sends the key as the bearer whenever nobody is signed in yet — which is
// exactly when signing in happens — so the client's fetch drops that header.
// These pin both halves: the wrap for a new key, and no wrap at all for the
// legacy one the app runs on today.

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

const URL_ = 'https://abcdefghijklmnopqrst.supabase.co'

/** The headers a request left with, whatever the client did on the way. */
function watchFetch() {
  const seen: Headers[] = []
  vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers))
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return seen
}

describe('the browser client and a key of the new style', () => {
  it('never sends a publishable key as a Bearer token, and keeps it on apikey', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', URL_)
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_abc123')
    const seen = watchFetch()
    const { getSupabase } = await import('../supabase')
    await getSupabase()!.from('posts').select('id').limit(1)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0].get('Authorization'), 'the key must not travel as a token').toBeNull()
    expect(seen[0].get('apikey')).toBe('sb_publishable_abc123')
  })

  it('leaves a legacy key exactly as it was, bearer and all', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', URL_)
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'eyJhbGciOiJIUzI1NiJ9.legacy')
    const seen = watchFetch()
    const { getSupabase } = await import('../supabase')
    await getSupabase()!.from('posts').select('id').limit(1)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0].get('Authorization')).toBe('Bearer eyJhbGciOiJIUzI1NiJ9.legacy')
    expect(seen[0].get('apikey')).toBe('eyJhbGciOiJIUzI1NiJ9.legacy')
  })

  it('knows which keys are of the new style', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', URL_)
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
    const { isNewKey } = await import('../supabase')
    expect(isNewKey('sb_publishable_abc')).toBe(true)
    expect(isNewKey('sb_secret_abc')).toBe(true)
    expect(isNewKey('eyJhbGciOiJIUzI1NiJ9.legacy')).toBe(false)
    expect(isNewKey('anon-key')).toBe(false)
  })
})
