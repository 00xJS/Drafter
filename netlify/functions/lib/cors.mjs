// The iOS app runs the web bundle from capacitor://localhost, so every call it
// makes to this API is cross-origin and WebKit asks permission first. Only the
// app shell's origin is allowed; the browser build is same-origin and never
// needs any of this. No credentials are ever allowed across: the app sends a
// bearer token, and the OAuth cookies are only ever set and read in Safari.

const ALLOWED = new Set(['capacitor://localhost'])

export function corsHeaders(req) {
  const origin = req.headers.get('origin')
  if (!origin || !ALLOWED.has(origin)) return null
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  }
}

/** Wrap a function handler: answers preflights, stamps allowed responses. */
export function withCors(handler) {
  return async (req, context) => {
    const cors = corsHeaders(req)
    if (req.method === 'OPTIONS') return new Response(null, { status: cors ? 204 : 403, headers: cors ?? {} })
    const res = await handler(req, context)
    if (!cors || !res) return res
    const out = new Response(res.body, res)
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v)
    return out
  }
}

/**
 * Open CORS — any origin, never credentials — for the endpoints an assistant
 * reaches from anywhere: /api/mcp, /oauth/* and /.well-known/*. Each is
 * bearer-only or public by design and sets no cookie, so a hostile page has
 * no ambient authority to ride on. Everything the app itself calls
 * (/api/agents, /api/oauth/*) keeps withCors and the Supabase session.
 */
export function withPublicCors(handler, { methods = 'GET, POST, OPTIONS', headers = 'authorization, content-type', expose = 'www-authenticate', maxAge = 86400 } = {}) {
  const preflight = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': methods,
    'access-control-allow-headers': headers,
    'access-control-expose-headers': expose,
    'access-control-max-age': String(maxAge),
  }
  return async (req, context) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: preflight })
    const res = await handler(req, context)
    const out = new Response(res.body, res)
    out.headers.set('access-control-allow-origin', '*')
    out.headers.set('access-control-expose-headers', expose)
    return out
  }
}
