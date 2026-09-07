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
