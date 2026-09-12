// Resolve the signed-in Supabase user from the bearer token the app sends.
// Every integration secret is keyed by this user id.

export async function getUser(req) {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY
  if (!supabaseUrl || !anonKey) return { user: null, response: null, unconfigured: true }
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return { user: null, response: Response.json({ error: 'sign in required' }, { status: 401 }) }
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: anonKey, authorization: `Bearer ${token}` } })
  if (!res.ok) return { user: null, response: Response.json({ error: 'invalid session' }, { status: 401 }) }
  const u = await res.json()
  return { user: { id: u.id, email: u.email ?? '' }, response: null }
}

/**
 * getUser, failing closed, for the endpoints that spend the owner's keys
 * (/api/ai, /api/github). They used to skip the check entirely when the auth
 * settings were missing, which would have served anyone; now that is a 503
 * that names what is missing, and no valid session is a 401.
 */
export async function requireUser(req) {
  const { user, response, unconfigured } = await getUser(req)
  if (unconfigured) {
    return {
      user: null,
      response: Response.json(
        { error: 'Sign-in is not configured on this site (SUPABASE_URL and SUPABASE_ANON_KEY are missing on the host), so this endpoint is switched off.' },
        { status: 503 },
      ),
    }
  }
  if (response) return { user: null, response }
  if (!user?.id) return { user: null, response: Response.json({ error: 'invalid session' }, { status: 401 }) }
  return { user, response: null }
}

// ---- user_settings (service role only) ----------------------------------------

function env() {
  return { supabaseUrl: process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_KEY }
}

export function settingsStoreConfigured() {
  const e = env()
  return !!(e.supabaseUrl && e.serviceKey)
}

async function rest(path, init = {}) {
  const e = env()
  if (!e.serviceKey) throw Object.assign(new Error('SUPABASE_SERVICE_KEY is not set on the host'), { status: 501 })
  const res = await fetch(`${e.supabaseUrl}/rest/v1/user_settings${path}`, {
    ...init,
    headers: { apikey: e.serviceKey, authorization: `Bearer ${e.serviceKey}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  if (!res.ok) throw new Error(`settings store ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

export async function settingsGet(userId) {
  const rows = await rest(`?user_id=eq.${encodeURIComponent(userId)}&select=*`)
  return rows?.[0] ?? null
}

/** `init` rides along to fetch, e.g. an abort signal from a caller on a deadline. */
export async function settingsFind(column, value, init = {}) {
  const rows = await rest(`?${column}=eq.${encodeURIComponent(value)}&select=*&limit=1`, init)
  return rows?.[0] ?? null
}

export async function settingsSet(userId, patch) {
  await rest('?on_conflict=user_id', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ user_id: userId, ...patch }),
  })
}
