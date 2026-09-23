import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The browser posts what the Content-Security-Policy would block to
// /.netlify/functions/csp-report, with no account. It keeps the directive and
// the blocked origin in the error log Admin → Data lists (client_errors, via
// log_client_errors), one row per kind with a count, and nothing about the
// page; the whole site shares one ceiling, counted across instances.

type Handler = (req: Request) => Promise<Response>
const SUPABASE = 'https://db.example.test'

let stored: { p_user: string | null; p_reports: { message: string; stack: unknown; path: unknown; view: unknown; platform: string; count: number }[] }[]
let limitAsked: Record<string, unknown>[]
let limitAnswer: { allowed: boolean; remaining: number; retry_after_ms: number } | 'missing'
let storeFails: boolean

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'sb_secret_service')
  stored = []
  limitAsked = []
  limitAnswer = { allowed: true, remaining: 59, retry_after_ms: 0 }
  storeFails = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `${SUPABASE}/rest/v1/rpc/rate_limit_take`) {
        limitAsked.push(JSON.parse(String(init?.body)))
        return limitAnswer === 'missing' ? Response.json({ message: 'Could not find the function' }, { status: 404 }) : Response.json(limitAnswer)
      }
      if (url === `${SUPABASE}/rest/v1/rpc/log_client_errors`) {
        if (storeFails) return Response.json({ message: 'relation client_errors does not exist' }, { status: 404 })
        const body = JSON.parse(String(init?.body))
        stored.push(body)
        return Response.json(body.p_reports.length)
      }
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/** A fresh copy of the function, as a cold start gets one: nothing counted in its memory yet. */
const coldStart = async (): Promise<Handler> => {
  vi.resetModules()
  return ((await import('../../netlify/functions/csp-report.mjs' as string)) as { default: Handler }).default
}
const post = (handler: Handler, body: unknown, type = 'application/csp-report') =>
  handler(new Request('https://site.test/.netlify/functions/csp-report', { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) }))

const report = (over: Record<string, unknown> = {}) => ({
  'csp-report': {
    'document-uri': 'https://drafterz.netlify.app/?task=Buy%20milk',
    'effective-directive': 'script-src-elem',
    'violated-directive': 'script-src-elem',
    'blocked-uri': 'https://evil.example/steal.js?who=maria',
    'source-file': 'https://drafterz.netlify.app/assets/index-abc.js',
    'script-sample': 'alert(document.cookie)',
    disposition: 'report',
    ...over,
  },
})

describe('/.netlify/functions/csp-report', () => {
  it('stores the directive and the blocked origin for the owner, and nothing about the page', async () => {
    const res = await post(await coldStart(), report())
    expect(res.status).toBe(204)
    expect(stored).toHaveLength(1)
    expect(stored[0].p_user).toBeNull()
    const [row] = stored[0].p_reports
    expect(row).toMatchObject({ message: 'CSP would block https://evil.example (script-src-elem)', stack: null, path: null, view: null, platform: 'web', count: 1 })
    expect(JSON.stringify(stored)).not.toMatch(/milk|maria|steal|cookie|index-abc|drafterz/)
  })

  it('reads the Reporting API’s batches too, one row per kind of violation with a count', async () => {
    const one = { type: 'csp-violation', body: { effectiveDirective: 'img-src', blockedURL: 'https://cdn.example/a.png', disposition: 'enforce' } }
    const res = await post(await coldStart(), [one, one, { type: 'csp-violation', body: { effectiveDirective: 'connect-src', blockedURL: 'https://api.example/x', disposition: 'enforce' } }], 'application/reports+json')
    expect(res.status).toBe(204)
    expect(stored[0].p_reports.map(r => [r.message, r.count])).toEqual([
      ['CSP blocked https://cdn.example (img-src)', 2],
      ['CSP blocked https://api.example (connect-src)', 1],
    ])
  })

  it('shares one ceiling across the site and its instances, and turns a flood away before reading it', async () => {
    const handler = await coldStart()
    await post(handler, report())
    expect(limitAsked).toEqual([{ p_subject: 'site', p_bucket: 'csp-report', p_limit: 60, p_window_seconds: 600 }])
    limitAnswer = { allowed: false, remaining: 0, retry_after_ms: 90_000 }
    const refused = await post(await coldStart(), report())
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toBe('90')
    expect(stored).toHaveLength(1)
  })

  it('before the v3.33 migration, each instance keeps its own sixty', async () => {
    limitAnswer = 'missing'
    const handler = await coldStart()
    for (let i = 0; i < 60; i++) expect((await post(handler, report())).status).toBe(204)
    expect((await post(handler, report())).status).toBe(429)
  })

  it('refuses what is not a report, and stores nothing it cannot keep', async () => {
    const handler = await coldStart()
    expect((await handler(new Request('https://site.test/.netlify/functions/csp-report'))).status).toBe(405)
    expect((await post(handler, '{not json')).status).toBe(400)
    expect((await post(handler, JSON.stringify({ padding: 'x'.repeat(40_000) }))).status).toBe(413)
    expect((await post(handler, { hello: 'world' })).status).toBe(204)
    expect(stored).toEqual([])
    // no service key on the host: nowhere to keep it, and no request that could only fail
    vi.stubEnv('SUPABASE_SERVICE_KEY', '')
    expect((await post(await coldStart(), report())).status).toBe(204)
    // the error log not there yet: still a quiet 204
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'sb_secret_service')
    storeFails = true
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await post(await coldStart(), report())).status).toBe(204)
    expect(quiet).toHaveBeenCalledWith(expect.stringMatching(/csp-report: could not keep 1 report/))
    expect(stored).toEqual([])
  })
})
