import { getSupabase } from './supabase'

/**
 * Where the API lives. Empty on the web (same origin). The iOS app is built
 * with VITE_API_BASE pointing at the hosted site, since its pages are served
 * from the app bundle rather than from that site.
 */
export const API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/+$/, '')

/** The hosted site's origin — for links that must open in a real browser. */
export const siteOrigin = (): string => API_BASE || window.location.origin

// Every call to a Netlify function is session-gated: the proxy verifies the
// Supabase access token before spending any credits. No API key ever reaches
// the browser.

export class ApiError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message)
  }
}

export async function apiFetch(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) }
  const sb = getSupabase()
  if (sb) {
    const { data } = await sb.auth.getSession()
    if (data.session) headers.authorization = `Bearer ${data.session.access_token}`
  }
  try {
    return await fetch(`${API_BASE}${path}`, { ...init, headers, signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) })
  } catch {
    throw new ApiError('The server is unreachable from here — this runs on the hosted site (or via `netlify dev` locally).')
  }
}
