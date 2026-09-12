import { vi } from 'vitest'

// Everything the calendar functions reach over fetch, held in memory: the
// user_settings table (service role), Supabase auth, Google's and Microsoft's
// token endpoints and the two calendar APIs. A test hands it the provider
// behaviour it needs; nothing here touches the network or a real account.
// Callers undo it with vi.unstubAllEnvs() and vi.unstubAllGlobals().

export const DB = 'https://db.example.test'

export interface SeenRequest {
  method: string
  url: string
  /** The Authorization header as sent. */
  auth: string
  /** A JSON body parsed; anything else as sent. */
  body: unknown
}

export type Answer = { status?: number; body?: unknown } | undefined

export interface WorldOptions {
  /** Bearer token -> the user Supabase's /auth/v1/user answers with. */
  sessions?: Record<string, { id: string; email: string }>
  googleToken?(form: URLSearchParams): Answer
  msToken?(form: URLSearchParams): Answer
  google?(req: SeenRequest): Answer
  graph?(req: SeenRequest): Answer
  /** Google's userinfo, read after a connect for the account's email. */
  userinfo?(req: SeenRequest): Answer
  /** Graph's /me, read after an Outlook connect. */
  me?(req: SeenRequest): Answer
}

export function world(opts: WorldOptions = {}) {
  const env = {
    SUPABASE_URL: DB,
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_KEY: 'service-key',
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    MICROSOFT_CLIENT_ID: 'ms-client',
    MICROSOFT_CLIENT_SECRET: 'ms-secret',
  }
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  /** user_settings rows by user_id. */
  const rows = new Map<string, Record<string, unknown>>()
  const seen: SeenRequest[] = []

  const respond = (a: Answer): Response => {
    if (!a) return new Response(JSON.stringify({ error: { message: 'not stubbed' } }), { status: 404, headers: { 'content-type': 'application/json' } })
    const status = a.status ?? 200
    if (status === 204) return new Response(null, { status })
    return new Response(JSON.stringify(a.body ?? {}), { status, headers: { 'content-type': 'application/json' } })
  }

  // PostgREST as lib/session.mjs uses it: `col=eq.value` filters, and an upsert merge on user_id
  const settings = (url: URL, method: string, body: unknown): Answer => {
    if (method === 'POST') {
      const patch = body as Record<string, unknown>
      const id = String(patch.user_id)
      rows.set(id, { ...(rows.get(id) ?? {}), ...patch })
      return { status: 201, body: {} }
    }
    const filters = [...url.searchParams].filter(([k]) => k !== 'select' && k !== 'limit')
    return { body: [...rows.values()].filter(r => filters.every(([k, v]) => v.startsWith('eq.') && r[k] != null && String(r[k]) === v.slice(3))) }
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input))
      const method = (init.method ?? 'GET').toUpperCase()
      const raw = init.body
      let body: unknown = raw
      if (typeof raw === 'string') {
        try {
          body = JSON.parse(raw)
        } catch {
          body = raw
        }
      }
      const req: SeenRequest = { method, url: url.toString(), auth: new Headers(init.headers).get('authorization') ?? '', body }
      seen.push(req)
      const form = () => new URLSearchParams(String(raw ?? ''))
      if (url.origin === DB && url.pathname === '/rest/v1/user_settings') return respond(settings(url, method, body))
      if (url.origin === DB && url.pathname === '/auth/v1/user') {
        const who = opts.sessions?.[req.auth.replace(/^Bearer\s+/i, '')]
        return respond(who ? { body: who } : { status: 401, body: { msg: 'invalid JWT' } })
      }
      if (url.href.startsWith('https://oauth2.googleapis.com/token')) return respond(opts.googleToken?.(form()))
      if (url.href.startsWith('https://oauth2.googleapis.com/revoke')) return respond({ body: {} })
      if (url.href.startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) return respond(opts.userinfo?.(req) ?? { body: {} })
      if (url.href.startsWith('https://www.googleapis.com/calendar/v3/')) return respond(opts.google?.(req))
      if (url.href.startsWith('https://login.microsoftonline.com/')) return respond(opts.msToken?.(form()))
      if (url.href === 'https://graph.microsoft.com/v1.0/me' && opts.me) return respond(opts.me(req))
      if (url.href.startsWith('https://graph.microsoft.com/v1.0/')) return respond(opts.graph?.(req))
      return respond(undefined)
    }),
  )
  return { rows, seen }
}
