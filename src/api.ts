import { getSupabase } from './supabase'

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
    return await fetch(path, { ...init, headers, signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) })
  } catch {
    throw new ApiError('The server is unreachable from here — this runs on the hosted site (or via `netlify dev` locally).')
  }
}
