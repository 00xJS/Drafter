import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { prerender } from 'react-dom/static'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Offline, with an access token past its hour, a cold start was a blank
// screen for about 25 seconds and then the sign-in page: App waited on
// getSession(), which refreshes an expired token over the network first and,
// offline, gives up with no session — while the session was still on the
// device. The first screen now comes from the session stored on the device,
// so the offline planner opens at once, behind the App Lock as ever.

const auth = vi.hoisted(() => ({ stored: null as string | null, getSession: 0 }))
vi.mock('../supabase', async importOriginal => ({
  ...(await importOriginal<typeof import('../supabase')>()),
  isSupabaseConfigured: () => true,
  storedUserId: () => auth.stored,
  getSupabase: () => ({
    auth: {
      // offline with an expired token: the refresh is still retrying
      getSession: () => {
        auth.getSession++
        return new Promise(() => {})
      },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  }),
}))
vi.mock('../components/Planner', () => ({ default: () => <main>the planner</main> }))
vi.mock('../components/LockGate', () => ({ LockGate: () => <div className="lock-overlay">the lock</div> }))

const { default: App } = await import('../App')

async function html(): Promise<string> {
  const { prelude } = await prerender(<App />)
  return new Response(prelude).text()
}

afterEach(() => {
  auth.stored = null
  vi.unstubAllGlobals()
})

describe('a cold start', () => {
  it('with a session stored on the device opens the planner at once, locked, whatever getSession is doing', async () => {
    vi.stubGlobal('window', { sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } })
    auth.stored = 'user-1'
    const page = await html()
    expect(page).toContain('the planner')
    expect(page).toContain('the lock')
    expect(page).not.toContain('Sign in')
    // and no sign-in overlay over it
    expect(page).not.toContain('auth-overlay')
  })

  it('with none, waits for getSession — which answers quickly then — and shows no planner', async () => {
    vi.stubGlobal('window', { sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } })
    expect(await html()).toBe('')
  })
})

describe('main.tsx starts the planner and its saved copy side by side', () => {
  const main = readFileSync(fileURLToPath(new URL('../main.tsx', import.meta.url)), 'utf8')

  it('for a device that opens straight to its planner, before the first render', () => {
    const start = main.search(/if \(storedUserId\(\) \|\| !isSupabaseConfigured\(\)\) \{\s*preloadPlanner\(\)\s*prefetchRecordCache\(\)\s*\}/)
    expect(start).toBeGreaterThan(-1)
    expect(start).toBeLessThan(main.indexOf('createRoot('))
  })
})
