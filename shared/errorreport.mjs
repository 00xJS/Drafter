// What a client error report may carry, and when two reports are one error.
//
// When something breaks on a device the app tells the site owner
// (src/errorreport.ts) and the server keeps a count of it
// (netlify/functions/log.mjs, public.client_errors). Both clean a report with
// this one module — the app before anything leaves the device, the server
// again before anything is stored — so they cannot disagree about what is
// kept: the error's own message and stack, trimmed; the build; web or the iOS
// shell; which screen; and the page's path without its query string. Never a
// record, a title, or anything typed.

export const MESSAGE_MAX = 500
export const STACK_MAX = 4096
export const PATH_MAX = 200
export const BUILD_MAX = 64
export const VIEW_MAX = 32
/** How many times one report may say the error happened. */
export const COUNT_MAX = 1000
export const PLATFORMS = ['web', 'ios']

/** A quoted run longer than this is somebody's text rather than code, so it is left out. */
const QUOTED_MAX = 24
const URLS = /[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>()]+/gi
const EMAILS = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi
/** Each kind of quote with its own closing mark, so an apostrophe inside double quotes does not end them. */
const QUOTED = [
  ['"', '"'],
  ['“', '”'],
  ['`', '`'],
  ["'", "'"],
  ['‘', '’'],
].map(([open, close]) => new RegExp(`${open}[^${close}\\n]{${QUOTED_MAX + 1},}${close}`, 'g'))
// every control character but the newline a stack is made of
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/g

/**
 * Every URL's query string and fragment cut off — they carry tokens, ids and
 * search words — keeping the `:line:column` a stack frame ends with.
 */
export function stripQueries(text) {
  return String(text ?? '').replace(URLS, url => {
    const cut = url.search(/[?#]/)
    if (cut === -1) return url
    const position = /:\d+(?::\d+)?$/.exec(url.slice(cut))?.[0] ?? ''
    return url.slice(0, cut) + position
  })
}

/** A message or a stack as it may be kept: no query strings, email addresses, long quoted text or control characters, at most `max` characters. */
export function scrubText(text, max) {
  if (text == null) return ''
  const unquoted = QUOTED.reduce((t, re) => t.replace(re, m => `${m[0]}…${m[m.length - 1]}`), stripQueries(String(text)))
  return unquoted
    .replace(EMAILS, '<email>')
    .replace(CONTROL, ' ')
    .trim()
    .slice(0, max)
}

/** A page's path, never its query string or fragment; null for anything that is not a path. */
export function cleanPath(path) {
  if (typeof path !== 'string') return null
  const bare = path.split(/[?#]/)[0].replace(/[^A-Za-z0-9/_.~%-]/g, '')
  return bare.startsWith('/') ? bare.slice(0, PATH_MAX) : null
}

/**
 * Which screen: a few lowercase words the app itself names ("home",
 * "settings", "the task editor"), or "other". Never free text.
 */
export function cleanView(view) {
  if (typeof view !== 'string' || !view.trim()) return null
  const v = view.trim().toLowerCase().replace(/’/g, "'")
  return new RegExp(`^[a-z][a-z ']{0,${VIEW_MAX - 1}}$`).test(v) ? v : 'other'
}

/** The build stamp (index.html's drafter-build meta): letters, digits, dots, dashes and underscores. */
export function cleanBuild(build) {
  if (typeof build !== 'string') return null
  const b = build.replace(/[^A-Za-z0-9._-]/g, '').slice(0, BUILD_MAX)
  return b || null
}

export function cleanPlatform(platform) {
  return PLATFORMS.includes(platform) ? platform : null
}

/** How many times a report says the error happened: a whole number from 1 to COUNT_MAX. */
export function cleanCount(count) {
  const n = Math.floor(Number(count))
  return Number.isFinite(n) ? Math.min(COUNT_MAX, Math.max(1, n)) : 1
}

/** The first line of a stack that says where it happened: Chrome's "at f (url:1:2)", Safari's "f@url:1:2". */
function topFrame(stack) {
  for (const raw of String(stack ?? '').split('\n')) {
    const line = raw.trim()
    if (/^at\s/.test(line) || /@.*:\d+(?::\d+)?\)?$/.test(line)) return line
  }
  return ''
}

/**
 * A frame without what changes from one deploy to the next: the origin, a
 * bundle file's content hash, the line and column. The same bug in the next
 * build is the same error.
 */
function steadyFrame(frame) {
  return frame
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^/\s)]*/gi, '')
    .replace(/-[A-Za-z0-9_-]{6,}(\.m?js)\b/g, '$1')
    .replace(/:\d+(?::\d+)?/g, '')
}

/** A message without the numbers and ids that differ each time the same thing goes wrong. */
function steadyMessage(message) {
  return String(message ?? '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '#')
    .replace(/\d{3,}/g, '#')
}

function fnv1a(text, seed) {
  let h = seed >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * The name one error goes by, however often it happens: its message and the
 * frame it was thrown from, on one platform. Not the build, so a bug that
 * outlives a deploy stays one line in Admin with its count still going up.
 */
export function fingerprintOf({ message, stack, platform }) {
  const basis = `${platform ?? ''}\n${steadyMessage(message)}\n${steadyFrame(topFrame(stack))}`
  return fnv1a(basis, 0x811c9dc5) + fnv1a(basis, 0x5bd1e995)
}

/** A report as it may be sent and stored, or null when it says nothing. */
export function cleanReport(report) {
  if (!report || typeof report !== 'object') return null
  const message = scrubText(report.message, MESSAGE_MAX)
  if (!message) return null
  const stack = scrubText(report.stack, STACK_MAX) || null
  const platform = cleanPlatform(report.platform)
  return {
    fingerprint: fingerprintOf({ message, stack, platform }),
    message,
    stack,
    build: cleanBuild(report.build),
    platform,
    view: cleanView(report.view),
    path: cleanPath(report.path),
    count: cleanCount(report.count),
  }
}
