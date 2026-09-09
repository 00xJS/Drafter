/** Deep-link / share-target / drafter:// parsing — one entry point for every inbound URL. */

export interface ParsedLink {
  oauth?: { provider: 'google' | 'microsoft'; ok: boolean; reason?: string }
  view?: string
  tab?: 'people' | 'places' | 'journal'
  saw?: string
  task?: string
  /** A notification action button was pressed rather than the banner itself. */
  act?: 'done' | 'tomorrow' | 'saw'
  capture?: { title: string; description?: string; link?: string; dueAt?: string }
  /** Text to append to today's journal entry (drafter://journal?text=… or ?journal=…). */
  journal?: string
}

const JOURNAL_MAX = 2000

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
export function parseLink(params: URLSearchParams, opts?: { host?: string; allowAct?: boolean }): ParsedLink {
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

  // drafter://journal?text=… — a Shortcut or share that writes a line into today
  if (host === 'journal') {
    const text = params.get('text') ?? params.get('journal') ?? params.get('title')
    if (text && text.trim()) out.journal = text.trim().slice(0, JOURNAL_MAX)
    return out
  }

  if (host && host !== 'new' && host !== 'open' && host !== '') {
    return out
  }

  const view = params.get('view')
  if (view) out.view = view

  const tab = params.get('tab')
  if (tab === 'places' || tab === 'people' || tab === 'journal') out.tab = tab

  const journal = params.get('journal')
  if (journal && journal.trim()) out.journal = journal.trim().slice(0, JOURNAL_MAX)

  const sawId = params.get('saw')
  if (sawId) out.saw = sawId

  const taskId = params.get('task')
  if (taskId) out.task = taskId

  // A reminder's action button appends `&act=…` to that row's own link. It writes
  // on arrival, so it is read only when the caller opts in (the native notification
  // handler, and nothing else), only for the three known actions, and only next to
  // the id they act on — a crafted `?act=done` in a web query string is ignored.
  if (opts?.allowAct && (out.task || out.saw)) {
    const act = params.get('act')
    if (act === 'done' || act === 'tomorrow' || act === 'saw') out.act = act
  }

  let title = params.get('title') ?? params.get('new')
  const text = params.get('text')
  let url = params.get('url')
  // A bare drafter://new — the Home Screen quick action — opens an empty capture.
  // Only the scheme's own `new` host does this: the PWA share target and the web
  // query string arrive with host '' (paramsOf collapses the app's own origin),
  // so an empty query string on the site still parses to nothing.
  if (host === 'new' || title || text || url) {
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
  const base = typeof window !== 'undefined' ? window.location.origin : 'https://drafter.local'
  try {
    const u = new URL(raw, base)
    const host = u.hostname || u.host || ''
    // A link into the app's own origin has no drafter:// host to scope on. Under
    // the iOS shell the page origin is capacitor://localhost, so a notification's
    // `/?task=…` used to resolve to the host "localhost" — which parseLink treats
    // as an unknown drafter:// host and ignores, killing every reminder tap.
    if (host && sameOrigin(u, base)) return { host: '', params: u.searchParams }
    return { host, params: u.searchParams }
  } catch {
    return { host: '', params: new URLSearchParams() }
  }
}

/** Scheme + host equality — URL.origin is "null" for capacitor:// and drafter:// alike. */
function sameOrigin(u: URL, base: string): boolean {
  try {
    const b = new URL(base)
    return u.protocol === b.protocol && u.host === b.host
  } catch {
    return false
  }
}
