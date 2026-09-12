// The consent half of Drafter's OAuth server lives in the signed-in app. An
// assistant sends the browser to /oauth/authorize?…; the SPA serves that path,
// and captureAuthorizeRequest (called in src/main.tsx before the first render)
// keeps the query in sessionStorage and puts the address bar back to "/" —
// before the planner's link handling strips the query on mount. App then
// shows Login (with no session) or ConnectAssistantSheet over the planner.
//
// Nothing here decides anything: /api/oauth/request and /api/oauth/approve
// re-check the whole request with the user's session, and a request that does
// not check out never redirects anywhere.

import { apiFetch } from './api'
import { deviceTimeZone } from './agents'
import type { AgentScope } from './agents'

export const OAUTH_REQUEST_KEY = 'drafter:oauth-request'
/** A request older than this is dropped: the assistant has long given up waiting. */
export const OAUTH_REQUEST_MAX_AGE_MS = 10 * 60_000

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function session(): Store | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/**
 * On /oauth/authorize: keep the query for the consent sheet and show "/".
 * True when a request was kept. Call it before anything reads the URL.
 */
export function captureAuthorizeRequest(
  loc: Pick<Location, 'pathname' | 'search'> = window.location,
  hist: Pick<History, 'replaceState'> = window.history,
  store: Store | null = session(),
  now = Date.now(),
): boolean {
  if (loc.pathname.replace(/\/+$/, '') !== '/oauth/authorize') return false
  let kept = false
  if (loc.search.length > 1 && store) {
    try {
      store.setItem(OAUTH_REQUEST_KEY, JSON.stringify({ search: loc.search, at: now }))
      kept = true
    } catch {
      /* storage refused (private mode): the assistant will have to ask again */
    }
  }
  hist.replaceState(null, '', '/')
  return kept
}

export function clearAuthorizeRequest(store: Store | null = session()): void {
  try {
    store?.removeItem(OAUTH_REQUEST_KEY)
  } catch {
    /* nothing kept */
  }
}

/** The request waiting for an answer, or null (none, unreadable, or older than ten minutes). */
export function pendingAuthorizeRequest(store: Store | null = session(), now = Date.now()): URLSearchParams | null {
  let raw: string | null = null
  try {
    raw = store?.getItem(OAUTH_REQUEST_KEY) ?? null
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const kept = JSON.parse(raw) as { search?: unknown; at?: unknown }
    if (typeof kept.search === 'string' && typeof kept.at === 'number' && now - kept.at < OAUTH_REQUEST_MAX_AGE_MS && now >= kept.at) {
      return new URLSearchParams(kept.search)
    }
  } catch {
    /* fall through */
  }
  clearAuthorizeRequest(store)
  return null
}

export type AuthorizeFailure = { ok: false; error: string; message: string }

export type AuthorizeDescription =
  | { ok: true; clientName: string; redirectHost: string; loopback: boolean; requestedScopes: AgentScope[]; existingConnectionId: string | null }
  | AuthorizeFailure

export type AuthorizeAnswer = { ok: true; redirect: string } | AuthorizeFailure

async function answer<T extends { ok: boolean }>(res: Response): Promise<T | AuthorizeFailure> {
  const body = await res.json().catch(() => null)
  if (body && typeof body === 'object' && typeof body.ok === 'boolean') return body as T | AuthorizeFailure
  const message =
    res.status === 401 ? 'Your session ended — sign in again.' : res.status === 501 ? 'Assistants aren’t set up on this site yet.' : `Drafter could not check this request (${res.status}).`
  return { ok: false, error: 'unavailable', message }
}

const postJson = (path: string, body: Record<string, unknown>) =>
  apiFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** Who is asking and where the answer goes, checked by the server. */
export async function describeRequest(params: URLSearchParams): Promise<AuthorizeDescription> {
  try {
    return await answer<AuthorizeDescription & { ok: true }>(await postJson('/api/oauth/request', { params: params.toString() }))
  } catch (e) {
    return { ok: false, error: 'unavailable', message: (e as Error).message }
  }
}

/** The user's answer. On success the caller sends the browser to `redirect`. */
export async function approveRequest(params: URLSearchParams, decision: 'allow' | 'deny', scopes: readonly AgentScope[]): Promise<AuthorizeAnswer> {
  try {
    return await answer<{ ok: true; redirect: string }>(await postJson('/api/oauth/approve', { params: params.toString(), decision, scopes, timezone: deviceTimeZone() }))
  } catch (e) {
    return { ok: false, error: 'unavailable', message: (e as Error).message }
  }
}

/** The server only ever answers with an allow-listed https or loopback address; check again before leaving. */
export function safeRedirect(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))
  } catch {
    return false
  }
}

/** How the sheet names the place the answer goes. */
export function returnsTo(d: { redirectHost: string; loopback: boolean }): string {
  return d.loopback ? 'an app on this computer' : d.redirectHost
}
