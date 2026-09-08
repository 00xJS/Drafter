/** Deep-link / share-target / drafter:// parsing — one entry point for every inbound URL. */

export interface ParsedLink {
  oauth?: { provider: 'google' | 'microsoft'; ok: boolean; reason?: string }
  view?: string
  tab?: 'people' | 'places'
  saw?: string
  task?: string
  capture?: { title: string; description?: string; link?: string; dueAt?: string }
}

const OAUTH_REASONS = new Set([
  'not_configured',
  'bad_state',
  'expired',
  'denied',
  'access_denied',
  'missing_code',
  'token_exchange',
  'unknown',
  'unknown_error',
])

/** Map an OAuth failure code to a short, known toast fragment (never echo arbitrary attacker text). */
export function oauthReasonLabel(raw: string | null | undefined): string {
  const key = (raw ?? 'unknown').toLowerCase().replace(/\s+/g, '_')
  if (OAUTH_REASONS.has(key)) return key.replace(/_/g, ' ')
  if (/^[a-z0-9_]{1,40}$/i.test(key)) return key.replace(/_/g, ' ')
  return 'unknown error'
}

const looksLikeHttpUrl = (s: string | null | undefined): s is string => !!s && /^https?:\/\//i.test(s)

/** Only http(s) links are stored — blocks javascript:/data: from drafter://new?url=. */
export function safeHttpUrl(s: string | null | undefined): string | undefined {
  if (!looksLikeHttpUrl(s)) return undefined
  try {
    const u = new URL(s!)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
    return u.toString()
  } catch {
    return undefined
  }
}

/**
 * Parse query params from a page URL, push tap, Shortcut, or drafter:// link.
 * Host-scoped: drafter://oauth is OAuth-only; unknown hosts are ignored.
 */
export function parseLink(params: URLSearchParams, opts?: { host?: string }): ParsedLink {
  const host = (opts?.host ?? '').toLowerCase()
  const out: ParsedLink = {}

  const ms = params.get('microsoft')
  const google = params.get('google')
  if (ms || google || host === 'oauth') {
    const provider: 'google' | 'microsoft' = ms ? 'microsoft' : 'google'
    const status = ms ?? google ?? 'error'
    const ok = status === 'connected'
    out.oauth = { provider, ok, reason: ok ? undefined : oauthReasonLabel(params.get('reason')) }
    return out
  }

  if (host && host !== 'new' && host !== 'open' && host !== '') {
    return out
  }

  const view = params.get('view')
  if (view) out.view = view

  const tab = params.get('tab')
  if (tab === 'places' || tab === 'people') out.tab = tab

  const sawId = params.get('saw')
  if (sawId) out.saw = sawId

  const taskId = params.get('task')
  if (taskId) out.task = taskId

  let title = params.get('title') ?? params.get('new')
  const text = params.get('text')
  let url = params.get('url')
  if (title || text || url) {
    if (!url && looksLikeHttpUrl(title)) {
      url = title!
      title = null
    }
    const link = safeHttpUrl(url) ?? safeHttpUrl(text)
    const dueRaw = params.get('due')
    const dueMs = dueRaw ? Date.parse(dueRaw) : NaN
    const presetTitle = (title ?? (looksLikeHttpUrl(text) ? '' : text) ?? '').slice(0, 140)
    out.capture = {
      title: presetTitle,
      description: text && text !== link ? text : undefined,
      link,
      ...(Number.isFinite(dueMs) ? { dueAt: new Date(dueMs).toISOString() } : {}),
    }
  }

  return out
}

/** Extract host + search params from any absolute or relative URL / drafter:// string. */
export function paramsOf(raw: string): { host: string; params: URLSearchParams } {
  try {
    const u = new URL(raw, typeof window !== 'undefined' ? window.location.origin : 'https://drafter.local')
    return { host: u.hostname || u.host || '', params: u.searchParams }
  } catch {
    return { host: '', params: new URLSearchParams() }
  }
}
