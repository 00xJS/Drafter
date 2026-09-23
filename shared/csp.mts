// The web app's Content-Security-Policy, and what a report of it breaking may
// say.
//
// vite.config.ts writes the policy into dist/_headers at build time, because
// one piece of it is only known then: the Supabase project the build talks
// to (VITE_SUPABASE_URL). It ships as Content-Security-Policy-Report-Only, so
// nothing it would block is blocked yet: the browser posts a report instead
// (netlify/functions/csp-report.mjs), the report lands in Admin → Data with
// the other errors, and once a week or two shows nothing the owner sets
// CSP_ENFORCE on the host and it is enforced (README → Deploy). The iPhone
// app loads its own copy of the bundle and never sees these headers.
//
// What the page loads, and why each source is here:
//   script   its own chunks; the one inline script in index.html (the theme,
//            before first paint), by its hash; blob: and 'wasm-unsafe-eval'
//            for the garment cut-out, whose MediaPipe runtime is read from
//            Cache Storage into object URLs and compiles WebAssembly
//            (src/cutoutweb.ts). Never 'unsafe-inline' or 'unsafe-eval'.
//   style    its own CSS, and style attributes: React's are set through the
//            DOM and need nothing, but a note's editor lets the browser write
//            some of its own. Style is not a way to run code.
//   img      its own icons, photos drawn from object URLs, data: URIs, and
//            the storage bucket's signed links.
//   connect  its own /api, Supabase (REST, auth, storage, and realtime over a
//            websocket), Open-Meteo for the weather, and blob: for reading a
//            photo or a file back out of its object URL.
//   worker   the service worker and the cut-out's module worker, both its own.

/** Where a browser posts what the policy would block. Straight to the function: no redirect rule is needed. */
export const CSP_REPORT_PATH = '/.netlify/functions/csp-report'

/** The weather (src/weather.ts): the one service the browser calls itself. */
export const WEATHER_ORIGIN = 'https://api.open-meteo.com'

/** Every directive a policy can name, so a report can only ever name one of these. */
export const CSP_DIRECTIVES: readonly string[] = [
  'default-src',
  'script-src',
  'script-src-elem',
  'script-src-attr',
  'style-src',
  'style-src-elem',
  'style-src-attr',
  'img-src',
  'font-src',
  'connect-src',
  'media-src',
  'object-src',
  'frame-src',
  'child-src',
  'worker-src',
  'manifest-src',
  'prefetch-src',
  'base-uri',
  'form-action',
  'frame-ancestors',
  'navigate-to',
  'trusted-types',
  'require-trusted-types-for',
  'upgrade-insecure-requests',
  'sandbox',
]

/** What stands in for a URL in a report: the page's own code, or where a resource came from. */
const KEYWORDS = ['inline', 'eval', 'wasm-eval', 'self', 'data', 'blob', 'trusted-types-policy', 'trusted-types-sink']

/** The origin of a URL, or null when it is not one the policy could name (a local-mode build has no Supabase). */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null
  } catch {
    return null
  }
}

/** The text of every script in a page that is written inline (no src), exactly as the browser hashes it. */
export function inlineScripts(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bsrc\s*=/i.test(m[1])) out.push(m[2])
  }
  return out
}

export interface CspOptions {
  /** VITE_SUPABASE_URL at build time; empty in local mode. */
  supabaseUrl?: string | null
  /** The base64 SHA-256 of each inline script the page carries. */
  scriptHashes?: readonly string[]
}

/** The policy itself, one directive after another. */
export function contentSecurityPolicy({ supabaseUrl, scriptHashes = [] }: CspOptions = {}): string {
  const supabase = originOf(supabaseUrl)
  const realtime = supabase ? supabase.replace(/^http/, 'ws') : null
  const directives: [string, ...string[]][] = [
    ['default-src', "'self'"],
    ['script-src', "'self'", ...scriptHashes.map(h => `'sha256-${h}'`), "'wasm-unsafe-eval'", 'blob:'],
    ['style-src', "'self'", "'unsafe-inline'"],
    ['img-src', "'self'", 'blob:', 'data:', ...(supabase ? [supabase] : [])],
    ['connect-src', "'self'", 'blob:', ...(supabase && realtime ? [supabase, realtime] : []), WEATHER_ORIGIN],
    ['worker-src', "'self'"],
    ['manifest-src', "'self'"],
    ['frame-src', "'none'"],
    ['object-src', "'none'"],
    ['base-uri', "'none'"],
    ['form-action', "'self'"],
    ['frame-ancestors', "'none'"],
    ['report-uri', CSP_REPORT_PATH],
  ]
  return directives.map(d => d.join(' ')).join('; ')
}

/** The header the policy goes out on: reported only, until the owner enforces it. */
export const cspHeaderName = (enforce: boolean): string => (enforce ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only')

/**
 * dist/_headers, which Netlify applies to every page alongside netlify.toml's
 * [[headers]]: the policy for the build's own index.html, hashed with the
 * caller's SHA-256 (base64) so this module needs no crypto of its own.
 */
export function cspHeadersFile({ html, supabaseUrl, enforce = false, sha256 }: { html: string; supabaseUrl?: string | null; enforce?: boolean; sha256: (text: string) => string }): string {
  const policy = contentSecurityPolicy({ supabaseUrl, scriptHashes: inlineScripts(html).map(sha256) })
  return [
    '# Written by vite.config.ts at build time from shared/csp.mts: change the policy there.',
    '/*',
    `  ${cspHeaderName(enforce)}: ${policy}`,
    '',
  ].join('\n')
}

// ---- reports ----------------------------------------------------------------------

/** One violation, as it may be kept: which directive, what it blocked (an origin or a keyword), and whether it was enforced. */
export interface CspViolation {
  directive: string
  blocked: string
  enforced: boolean
}

/** The most violations one request may carry; a browser sends one at a time. */
export const CSP_REPORTS_MAX = 10

/** A directive a report names, first word only (older browsers send the whole clause), or 'other'. */
function directiveOf(value: unknown): string {
  const name = String(value ?? '')
    .trim()
    .split(/\s+/)[0]
    .toLowerCase()
  return CSP_DIRECTIVES.includes(name) ? name : 'other'
}

/**
 * What a report says was blocked, reduced to its origin — never its path or
 * query, which can name a page, a record or a token — or to one of the
 * keywords the reports use for the page's own code.
 */
export function blockedOf(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) return 'inline'
  const word = raw.toLowerCase()
  if (KEYWORDS.includes(word)) return word
  if (/^data:/i.test(raw)) return 'data'
  if (/^blob:/i.test(raw)) return 'blob'
  try {
    const u = new URL(raw)
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'ws:' || u.protocol === 'wss:') return u.origin
    return u.protocol.replace(/:$/, '')
  } catch {
    return 'other'
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * The violations in a report, in either shape a browser posts: report-uri's
 * { "csp-report": { … } } (application/csp-report), or the Reporting API's
 * [{ type: "csp-violation", body: { … } }] (application/reports+json). Only
 * the directive, the blocked origin and the disposition are read; the page's
 * address, the source file, the line and the script sample never are.
 */
export function cspViolations(report: unknown): CspViolation[] {
  const bodies: Record<string, unknown>[] = []
  if (isObject(report) && isObject(report['csp-report'])) bodies.push(report['csp-report'])
  if (Array.isArray(report)) {
    for (const r of report.slice(0, CSP_REPORTS_MAX)) if (isObject(r) && r.type === 'csp-violation' && isObject(r.body)) bodies.push(r.body)
  }
  return bodies.slice(0, CSP_REPORTS_MAX).map(b => ({
    directive: directiveOf(b['effective-directive'] ?? b.effectiveDirective ?? b['violated-directive'] ?? b.violatedDirective),
    blocked: blockedOf(b['blocked-uri'] ?? b.blockedURL),
    enforced: String(b.disposition ?? 'report').toLowerCase() === 'enforce',
  }))
}

/** How a violation reads in Admin → Data, in words the error log's rule keeps (shared/errorreport.mts). */
export function cspMessage(v: CspViolation): string {
  return `CSP ${v.enforced ? 'blocked' : 'would block'} ${v.blocked} (${v.directive})`
}
