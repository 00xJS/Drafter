import { isNative } from './native'
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
    /** The request never left this device, for want of a connection. */
    public offline = false,
  ) {
    super(message)
  }
}

/** What a request that could not leave the device says, wherever it is shown. */
export const OFFLINE_MESSAGE = 'You’re offline — try again when you’re connected.'

/**
 * Whether a failed request means this device has no connection: the browser
 * says it is offline, or fetch failed at the network — which Safari, Chrome
 * and the app's web view all throw as a TypeError ("Load failed", "Failed to
 * fetch"). An ApiError says for itself.
 */
export function isOffline(e?: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  if (e instanceof ApiError) return e.offline
  return e instanceof TypeError
}

/**
 * Why a request never got an answer. Every one used to say the server only
 * runs on the hosted site — in the iPhone app too, and when the phone was
 * simply offline — which read as something not set up rather than a
 * connection to wait for.
 */
function unreachable(e: unknown): ApiError {
  if (isOffline(e)) return new ApiError(OFFLINE_MESSAGE, 0, true)
  if ((e as Error | null)?.name === 'TimeoutError') return new ApiError('Drafter’s server took too long to answer — try again in a moment.')
  // the app always talks to the hosted site, so pointing at it is no advice there
  if (isNative()) return new ApiError('Drafter’s server could not be reached — try again in a moment.')
  return new ApiError('The server is unreachable from here — this runs on the hosted site (or via `netlify dev` locally).')
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
  } catch (e) {
    throw unreachable(e)
  }
}
