import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Session } from '@supabase/supabase-js'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App, { authorizeRoute } from '../App'
import { Login } from '../components/Login'
import { OAUTH_REQUEST_KEY } from '../oauthRequest'

/*
 * An assistant sends the browser to /oauth/authorize?…; main.tsx keeps the
 * query, and App decides what the visit shows: Login saying why (signed out),
 * the consent sheet over the planner (signed in), or a card saying there is
 * no account to connect (local mode).
 */

// whether this copy has a backend; the rest of the module is the real one
const backend = vi.hoisted(() => ({ on: false }))
vi.mock('../supabase', async importOriginal => ({ ...(await importOriginal<typeof import('../supabase')>()), isSupabaseConfigured: () => backend.on }))

afterEach(() => {
  backend.on = false
  vi.unstubAllGlobals()
})

const session = { user: { email: 'owner@example.test' } } as Session
const request = new URLSearchParams({
  response_type: 'code',
  client_id: 'dcr_x',
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  code_challenge: 'abc',
  code_challenge_method: 'S256',
  state: 's',
})

describe('authorizeRoute: where a waiting connection request takes the gate', () => {
  it('goes nowhere when no request is waiting', () => {
    expect(authorizeRoute(null, null, true)).toBe('none')
    expect(authorizeRoute(null, session, true)).toBe('none')
    expect(authorizeRoute(null, null, false)).toBe('none')
  })

  it('asks a signed-out visitor to sign in, and a signed-in one to answer', () => {
    expect(authorizeRoute(request, null, true)).toBe('sign-in')
    expect(authorizeRoute(request, session, true)).toBe('consent')
  })

  it('says there is no account to connect when this copy has no backend', () => {
    expect(authorizeRoute(request, null, false)).toBe('no-account')
  })
})

describe('the gate, rendered with a request waiting', () => {
  /** A tab whose sessionStorage holds what captureAuthorizeRequest keeps. */
  const tabHolding = (search: string) => {
    const values = new Map([[OAUTH_REQUEST_KEY, JSON.stringify({ search, at: Date.now() })]])
    const sessionStorage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v), removeItem: (k: string) => void values.delete(k) }
    vi.stubGlobal('window', { sessionStorage })
  }

  it('in local mode, says connecting needs an account and offers the way on, with no form', () => {
    tabHolding(`?${request}`)
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('Connect Claude to Drafter')
    expect(html).toContain('Connecting Claude needs a Drafter account')
    expect(html).toContain('>Cancel</button>')
    expect(html).not.toContain('type="password"')
  })
})

describe('Login, when an assistant is waiting', () => {
  it('says signing in is what connects Claude, and calls Back Cancel', () => {
    backend.on = true
    const html = renderToStaticMarkup(<Login connecting onBack={() => {}} />)
    expect(html).toContain('Sign in to connect Claude to Drafter')
    expect(html).toContain('type="password"')
    expect(html).toContain('>Cancel</button>')
  })

  it('reads as it always did otherwise', () => {
    backend.on = true
    const html = renderToStaticMarkup(<Login onBack={() => {}} />)
    expect(html).toContain('Sign in to your planner')
    expect(html).toContain('← Back')
    expect(html).not.toContain('Claude')
  })
})

const SRC = fileURLToPath(new URL('../', import.meta.url))
const source = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8')

/** Static imports only, as lazyload.test.ts walks them: `import type` and import() are not followed. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>()
  const todo = [entry]
  while (todo.length) {
    const file = todo.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const code = readFileSync(file, 'utf8')
    for (const m of code.matchAll(/^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      const base = resolve(dirname(file), m[1])
      const hit = [base, `${base}.ts`, `${base}.tsx`].find(p => existsSync(p) && statSync(p).isFile())
      if (hit && /\.tsx?$/.test(hit)) todo.push(hit)
    }
  }
  return seen
}

describe('the consent sheet is wired in, and waits for its own visit', () => {
  const main = source('main.tsx')
  const app = source('App.tsx')

  it('keeps the request in main.tsx before the first render, so no link handling eats it', () => {
    expect(main).toMatch(/import \{ captureAuthorizeRequest \} from '\.\/oauthRequest'/)
    const call = main.indexOf('captureAuthorizeRequest()')
    expect(call).toBeGreaterThan(-1)
    expect(call).toBeLessThan(main.indexOf('createRoot('))
  })

  it('shows the sheet over the planner with the signed-in address, and drops the request when it is done', () => {
    expect(app).toMatch(/<ConnectAssistantSheet params=\{pending\} email=\{session\.user\.email \?\? ''\} onDone=\{dropRequest\}/)
    expect(app).toMatch(/const dropRequest = \(\) => \{\s*clearAuthorizeRequest\(\)\s*setPending\(null\)/)
  })

  it('loads the sheet on demand: nothing the first load imports reaches it', () => {
    expect(app).toMatch(/preloadable\(\(\) => import\('\.\/components\/ConnectAssistantSheet'\)/)
    const first = reachable(resolve(SRC, 'main.tsx'))
    expect(first).toContain(resolve(SRC, 'App.tsx'))
    expect(first).not.toContain(resolve(SRC, 'components/ConnectAssistantSheet.tsx'))
  })
})
