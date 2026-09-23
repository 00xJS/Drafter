import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_ORIGIN } from '../../shared/apphost.mts'
import { MESSAGE_MAX, STACK_MAX } from '../../shared/errorreport.mts'
import { MAX_REPORTS, cleanReports } from '../../netlify/functions/lib/errorlog.mjs'
// @ts-expect-error — a function file ships with no .d.mts: Netlify would deploy one as a function of its own
import logFunction from '../../netlify/functions/log.mjs'

// /api/log keeps what broke on a device for the site owner (public.client_errors).
// Signed-in accounts only; each report cleaned again on the server with the
// app's own rule, capped, merged by fingerprint and counted; a ceiling per
// account so a page stuck throwing cannot fill the table.

type Handler = (req: Request, context?: unknown) => Promise<Response>
const log = logFunction as Handler
const SUPABASE = 'https://db.example.test'

let stored: { p_user: string; p_reports: Record<string, unknown>[] }[]
let storeFails: boolean
let serial = 0

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE)
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key')
  stored = []
  storeFails = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `${SUPABASE}/auth/v1/user`) {
        // "good-<id>" is a live session for account <id>
        const m = /^Bearer good-(.+)$/.exec(new Headers(init?.headers).get('authorization') ?? '')
        return m ? Response.json({ id: m[1], email: `${m[1]}@example.test` }) : Response.json({ msg: 'invalid JWT' }, { status: 401 })
      }
      if (url === `${SUPABASE}/rest/v1/rpc/log_client_errors`) {
        if (storeFails) return new Response('{"message":"relation client_errors does not exist"}', { status: 404 })
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

/** A fresh account per test: the ceiling is per account, and it lives as long as the module does. */
const account = () => `acct-${++serial}`
const send = (token: string | null, body: unknown, headers: Record<string, string> = {}) =>
  log(
    new Request('https://site.test/api/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
const report = (over: Record<string, unknown> = {}) => ({ message: 'TypeError: a is undefined', stack: 'TypeError: a is undefined\n    at f (https://site/assets/index-abc12345.js:1:2)', build: 'b1', platform: 'web', view: 'home', path: '/', count: 1, ...over })

describe('/api/log', () => {
  it('takes reports from a signed-in account only', async () => {
    expect((await send(null, { reports: [report()] })).status).toBe(401)
    expect((await send('forged', { reports: [report()] })).status).toBe(401)
    expect((await log(new Request('https://site.test/api/log'))).status).toBe(405)
    expect(stored).toEqual([])
  })

  it('answers the iOS shell’s preflight, as every endpoint it calls does', async () => {
    const res = await log(new Request('https://site.test/api/log', { method: 'OPTIONS', headers: { origin: APP_ORIGIN, 'access-control-request-method': 'POST' } }))
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN)
  })

  it('stores them as the account that sent them, cleaned again: capped, no query strings, repeats counted', async () => {
    const me = account()
    const res = await send(`good-${me}`, {
      reports: [
        report({ message: `Failed: https://x.supabase.co/rest/v1/posts?select=*&apikey=secret ${'y'.repeat(900)}`, stack: `at f (https://site/a.js?token=abc:1:2)\n${'z'.repeat(9000)}`, path: '/oauth/authorize?code=abc#x' }),
        report(),
        report({ count: 4 }),
      ],
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ stored: 2 })
    expect(stored).toHaveLength(1)
    const [{ p_user, p_reports }] = stored
    expect(p_user).toBe(me)
    expect(p_reports).toHaveLength(2)
    const [long, twice] = p_reports as { message: string; stack: string; path: string; count: number }[]
    expect(long.message.length).toBeLessThanOrEqual(MESSAGE_MAX)
    expect(long.stack.length).toBeLessThanOrEqual(STACK_MAX)
    expect(JSON.stringify(long)).not.toMatch(/apikey|secret|token=abc|code=abc/)
    expect(long.path).toBe('/oauth/authorize')
    // the same error twice in one request is one row with both counted
    expect(twice.count).toBe(5)
  })

  it('cleans what an older app sent by today’s rule: no title, name or number it quoted or not', async () => {
    const res = await send(`good-${account()}`, {
      reports: [
        report({
          message: 'Error: Could not save Pick up dry cleaning for Maria Gonzalez, +1 (602) 555-0142',
          stack: 'Error: Could not save Pick up dry cleaning\n    at saveTask (https://site/assets/index-abc12345.js:1:2)',
        }),
      ],
    })
    expect(res.status).toBe(200)
    const [{ message, stack }] = stored[0].p_reports as { message: string; stack: string }[]
    expect(`${message}\n${stack}`).not.toMatch(/Pick|dry|cleaning|Maria|Gonzalez|602|555|0142|saveTask/)
    expect(message).toBe('Error: Could not save … up … for …, <number>')
    expect(stack).toBe('at /assets/index-abc12345.js:1:2')
  })

  it('reads at most ten reports a request, and refuses a body past 64 KB', async () => {
    // numbers of three digits or fewer survive cleaning, so these are 25 different errors
    expect(cleanReports(Array.from({ length: 25 }, (_, i) => report({ message: `failure number ${i}` })))).toHaveLength(MAX_REPORTS)
    const huge = JSON.stringify({ reports: [report({ message: 'x'.repeat(70_000) })] })
    expect((await send(`good-${account()}`, huge)).status).toBe(413)
    expect((await send(`good-${account()}`, '{not json')).status).toBe(400)
    expect(stored).toEqual([])
  })

  it('stops an account after twenty requests in ten minutes, and nobody else', async () => {
    const busy = account()
    for (let i = 0; i < 20; i++) expect((await send(`good-${busy}`, { reports: [report()] })).status).toBe(200)
    const refused = await send(`good-${busy}`, { reports: [report()] })
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await send(`good-${account()}`, { reports: [report()] })).status).toBe(200)
  })

  it('stores nothing, and says so plainly, with nowhere to keep it or nothing worth keeping', async () => {
    expect(await (await send(`good-${account()}`, { reports: [{ message: '' }, 'boom', null] })).json()).toEqual({ stored: 0 })
    vi.stubEnv('SUPABASE_SERVICE_KEY', '')
    expect(await (await send(`good-${account()}`, { reports: [report()] })).json()).toEqual({ stored: 0 })
    expect(stored).toEqual([])
  })

  it('answers 502 when the table is not there yet — the device gives up either way', async () => {
    storeFails = true
    const res = await send(`good-${account()}`, { reports: [report()] })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/Could not keep the report/)
  })
})
