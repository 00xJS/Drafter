// Importing a recipe from a link: fetch the page without letting the link
// reach anything but the public internet, then read the schema.org Recipe the
// page describes itself with, or failing that, its readable text for the app
// to read with ✨ (readRecipe in src/ai.ts). netlify/functions/recipe-import.mjs
// is the HTTP face; everything here is testable without a network.
//
// Why the fetch is careful. The server fetches a URL a person typed, from
// inside Netlify's network. Left alone that is a server-side request forgery:
// http://169.254.169.254/ reads the cloud's instance metadata, a name that
// resolves to 10.0.0.5 reaches whatever listens there, and a public page can
// redirect to either. So every hop is checked the same way — http(s) only, the
// usual ports, no credentials — the name is resolved HERE and refused if ANY
// address is private, loopback, link-local, CGNAT or otherwise not public
// (IPv4, IPv6, and IPv4 dressed as IPv6), and the connection is made to the
// address that was checked rather than a second lookup of the name, so a DNS
// answer that changes between the check and the connect cannot slip through.
// Redirects are followed by hand, at most three, each hop checked again; the
// whole import has six seconds and two megabytes; only HTML is read.

import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import zlib from 'node:zlib'
import { parseIngredientLine } from '../../../shared/recipes.mts'
import { slidingWindow } from './ratelimit.mjs'
import { requireUser } from './session.mjs'

export const IMPORT_LIMITS = Object.freeze({
  timeoutMs: 6_000,
  maxBytes: 2 * 1024 * 1024,
  maxRedirects: 3,
  /** The readable text handed back when a page has no Recipe data: enough for one recipe, not a whole site. */
  textMax: 12_000,
  urlMax: 2_048,
  ingredientsMax: 60,
  stepsMax: 40,
})

/** Something the person can act on, with the HTTP status the endpoint answers with. */
export class ImportError extends Error {
  /**
   * @param {string} message
   * @param {number} [status]
   */
  constructor(message, status = 502) {
    super(message)
    this.name = 'ImportError'
    this.status = status
  }
}

const NOT_A_LINK = 'That isn’t a web address — it should start with https://.'
const REFUSED = 'Drafter won’t open that address: it isn’t a public web page.'
const TOO_BIG = 'That page is too big to read (over 2 MB).'
const TOO_SLOW = 'The site took too long to answer — try again, or paste the recipe instead.'

// ---- the link ------------------------------------------------------------------

const PORTS = new Set(['', '80', '443', '8080', '8443'])

/**
 * The link as a URL the importer will fetch, or an ImportError: http and https
 * only, no user name or password in it, the usual web ports, and no fragment.
 * Run on the typed link and again on every redirect.
 * @param {unknown} raw
 * @returns {URL}
 */
export function parseImportUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text || text.length > IMPORT_LIMITS.urlMax) throw new ImportError(NOT_A_LINK, 400)
  let url
  try {
    url = new URL(text)
  } catch {
    throw new ImportError(NOT_A_LINK, 400)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ImportError('Only http and https links can be imported.', 400)
  if (url.username || url.password) throw new ImportError('A link with a user name or password in it can’t be imported.', 400)
  if (!PORTS.has(url.port)) throw new ImportError('That link asks for a port Drafter doesn’t open.', 400)
  if (!url.hostname) throw new ImportError(NOT_A_LINK, 400)
  url.hash = ''
  return url
}

// ---- addresses -------------------------------------------------------------------

const bare = ip => String(ip ?? '').replace(/^\[|\]$/g, '')

/** [a, b, c, d] for a dotted IPv4 address, else null. */
function ipv4Parts(ip) {
  const s = bare(ip)
  return net.isIPv4(s) ? s.split('.').map(Number) : null
}

/**
 * Whether an IPv4 address is on the public internet. Everything a request
 * from inside a data centre must never reach is refused: this network (0/8),
 * private (10/8, 172.16/12, 192.168/16), shared CGNAT space (100.64/10, where
 * Alibaba keeps its metadata), loopback (127/8), link-local (169.254/16, the
 * metadata address of AWS, Google Cloud and Azure), the IETF block (192.0.0/24,
 * Oracle's metadata), documentation and benchmarking ranges, the old 6to4
 * relay, multicast, reserved and broadcast.
 * @param {string} ip
 */
export function isPublicIPv4(ip) {
  const p = ipv4Parts(ip)
  if (!p) return false
  const [a, b, c] = p
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 192 && b === 88 && c === 99) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  if (a >= 224) return false
  return true
}

/** The eight 16-bit groups of an IPv6 address, a dotted IPv4 tail included, else null. */
export function ipv6Groups(ip) {
  let s = bare(ip).toLowerCase()
  // a zone ("fe80::1%en0") only exists on a local link
  if (!s || s.includes('%') || !net.isIPv6(s)) return null
  const lastColon = s.lastIndexOf(':')
  const tail = s.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = ipv4Parts(tail)
    if (!v4) return null
    s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const part = h => (h ? h.split(':') : [])
  const head = part(halves[0])
  const rest = halves.length === 2 ? part(halves[1]) : []
  if (![...head, ...rest].every(g => /^[0-9a-f]{1,4}$/.test(g))) return null
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0
  if (fill < 0 || (halves.length === 2 && fill < 1)) return null
  const groups = [...head, ...Array(fill).fill('0'), ...rest].map(g => parseInt(g, 16))
  return groups.length === 8 ? groups : null
}

/**
 * Whether an IPv6 address is on the public internet: global unicast (2000::/3)
 * outside its special blocks, or an IPv4 address carried in IPv6 (mapped,
 * translated, NAT64) that is itself public. So ::1, ::, fe80::/10, fc00::/7
 * (where AWS keeps fd00:ec2::254), multicast, documentation, Teredo, 6to4 and
 * ::ffff:127.0.0.1 are all refused.
 * @param {string} ip
 */
export function isPublicIPv6(ip) {
  const g = ipv6Groups(ip)
  if (!g) return false
  const zero = (from, to) => g.slice(from, to).every(x => x === 0)
  const v4 = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`
  if (zero(0, 5) && g[5] === 0xffff) return isPublicIPv4(v4())
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return isPublicIPv4(v4())
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return isPublicIPv4(v4())
  if ((g[0] & 0xe000) !== 0x2000) return false
  if (g[0] === 0x2001 && g[1] < 0x0200) return false
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false
  if (g[0] === 0x2002) return false
  if (g[0] === 0x3fff && g[1] < 0x1000) return false
  return true
}

/** Whether an address, of either family, is on the public internet. A name is not an address. */
export function isPublicAddress(ip) {
  const s = bare(ip)
  const family = net.isIP(s)
  if (family === 4) return isPublicIPv4(s)
  if (family === 6) return isPublicIPv6(s)
  return false
}

/** Every address the system resolver gives for a name, in its own order. */
async function systemResolve(hostname) {
  const found = await dns.promises.lookup(hostname, { all: true, verbatim: true })
  return found.map(r => ({ address: r.address, family: r.family }))
}

/**
 * The address to connect to for a host: the host itself when it is an
 * address, else the first the resolver answers. Refused when any answer is
 * not public, so a name that resolves both ways cannot be played for luck.
 * @param {string} hostname
 * @param {{ resolve?: (host: string) => Promise<{ address: string, family: number }[]>, isAllowed?: (ip: string) => boolean }} [opts]
 */
export async function publicAddressOf(hostname, { resolve = systemResolve, isAllowed = isPublicAddress } = {}) {
  const host = bare(hostname)
  const literal = net.isIP(host)
  if (literal) {
    if (!isAllowed(host)) throw new ImportError(REFUSED, 403)
    return { address: host, family: literal }
  }
  let found
  try {
    found = await resolve(host)
  } catch {
    throw new ImportError('Couldn’t find that site — check the link.', 502)
  }
  if (!Array.isArray(found) || found.length === 0) throw new ImportError('Couldn’t find that site — check the link.', 502)
  if (found.some(r => !isAllowed(r.address))) throw new ImportError(REFUSED, 403)
  const first = found[0]
  return { address: bare(first.address), family: net.isIP(bare(first.address)) || first.family }
}

// ---- the fetch ---------------------------------------------------------------------

const REQUEST_HEADERS = Object.freeze({
  accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
  'accept-encoding': 'gzip, br',
  'accept-language': 'en-US,en;q=0.8',
  // a browser's shape, since some recipe sites turn away anything else, and our name after it
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 DrafterRecipeImport/1.0',
})

/**
 * The real transport: one GET over node:http(s), CONNECTED TO `address` — the
 * one publicAddressOf checked — however the name would resolve now. The name
 * still goes in the Host header and TLS still verifies the certificate for
 * it. The body comes back decompressed.
 * @param {{ url: URL, address: string, family: number, signal: AbortSignal, headers: Record<string, string> }} req
 */
export function nodeTransport({ url, address, family, signal, headers }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http
    const pinned = (_host, options, callback) => {
      const done = typeof options === 'function' ? options : callback
      // Node asks for every address when it races IPv4 against IPv6
      if (options && typeof options === 'object' && options.all) done(null, [{ address, family }])
      else done(null, address, family)
    }
    const req = client.request(url, { method: 'GET', headers, signal, agent: false, lookup: pinned }, res => {
      const encoding = String(res.headers['content-encoding'] ?? '')
        .trim()
        .toLowerCase()
      /** @type {import('node:stream').Readable} */
      let body = res
      if (encoding === 'gzip' || encoding === 'x-gzip') body = res.pipe(zlib.createGunzip())
      else if (encoding === 'br') body = res.pipe(zlib.createBrotliDecompress())
      else if (encoding === 'deflate') body = res.pipe(zlib.createInflate())
      else if (encoding && encoding !== 'identity') {
        res.destroy()
        reject(new ImportError('That page is compressed in a way Drafter can’t read.', 502))
        return
      }
      if (body !== res) res.on('error', err => body.destroy(err))
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body })
    })
    req.on('error', reject)
    req.end()
  })
}

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

/** The promise, or a rejection the moment the deadline passes — a DNS lookup or a stalled stream cannot be cancelled. */
function beforeDeadline(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      err => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

/** Let go of a body we will not read: a stream is destroyed, an iterator returned. */
function discard(body) {
  try {
    if (body && typeof body.destroy === 'function') body.destroy()
    else if (body && typeof body[Symbol.asyncIterator] === 'function') void body[Symbol.asyncIterator]().return?.()?.catch?.(() => {})
  } catch {
    /* it is going anyway */
  }
}

/** The body, whole, refused the moment it passes `maxBytes`. */
async function readCapped(body, maxBytes, signal) {
  const chunks = []
  let total = 0
  const it = body[Symbol.asyncIterator]()
  let finished = false
  try {
    for (;;) {
      const { value, done } = await beforeDeadline(it.next(), signal)
      if (done) {
        finished = true
        break
      }
      const chunk = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      total += chunk.byteLength
      if (total > maxBytes) throw new ImportError(TOO_BIG, 413)
      chunks.push(chunk)
    }
  } finally {
    if (!finished) discard(body)
  }
  return Buffer.concat(chunks)
}

/** The character set a page says it is in, from its header or an early <meta>, else UTF-8. */
function charsetOf(contentType, bytes) {
  const header = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType)?.[1]
  if (header) return header
  const head = bytes.subarray(0, 2048).toString('latin1')
  return /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1] ?? 'utf-8'
}

function decodeBody(bytes, contentType) {
  try {
    return new TextDecoder(charsetOf(contentType, bytes)).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])

/**
 * @typedef {{ status: number, headers: Record<string, string | string[] | undefined>, body: AsyncIterable<Uint8Array> }} TransportResponse
 * @typedef {(req: { url: URL, address: string, family: number, signal: AbortSignal, headers: Record<string, string> }) => Promise<TransportResponse>} Transport
 * @typedef {{ resolve?: (host: string) => Promise<{ address: string, family: number }[]>, transport?: Transport, isAllowed?: (ip: string) => boolean, timeoutMs?: number, maxBytes?: number, maxRedirects?: number }} FetchOptions
 */

/**
 * GET a page the careful way (see the top of this file): every hop checked
 * and pinned, redirects by hand, a deadline over all of it, a size cap on the
 * decompressed body, HTML only. Answers the page's final URL and its text.
 * @param {URL} start from parseImportUrl
 * @param {FetchOptions} [opts]
 * @returns {Promise<{ url: URL, html: string }>}
 */
export async function fetchPage(start, opts = {}) {
  const {
    resolve,
    transport = nodeTransport,
    isAllowed,
    timeoutMs = IMPORT_LIMITS.timeoutMs,
    maxBytes = IMPORT_LIMITS.maxBytes,
    maxRedirects = IMPORT_LIMITS.maxRedirects,
  } = opts
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), timeoutMs)
  try {
    let url = start
    for (let hop = 0; ; hop++) {
      const target = await beforeDeadline(publicAddressOf(url.hostname, { resolve, isAllowed }), deadline.signal)
      const res = await beforeDeadline(
        transport({ url, address: target.address, family: target.family, signal: deadline.signal, headers: { ...REQUEST_HEADERS } }),
        deadline.signal,
      )
      const header = name => {
        const v = res.headers?.[name]
        return Array.isArray(v) ? v[0] : (v ?? '')
      }
      if (REDIRECTS.has(res.status)) {
        discard(res.body)
        if (hop >= maxRedirects) throw new ImportError('That link redirects too many times.', 502)
        const location = header('location')
        if (!location) throw new ImportError('The site redirected without saying where to.', 502)
        let next
        try {
          next = new URL(location, url).toString()
        } catch {
          throw new ImportError('The site redirected somewhere that isn’t a web address.', 502)
        }
        url = parseImportUrl(next)
        continue
      }
      if (res.status < 200 || res.status >= 300) {
        discard(res.body)
        throw new ImportError(`The site answered ${res.status}, so there was nothing to read.`, 502)
      }
      const type = String(header('content-type')).toLowerCase()
      if (!/^\s*(text\/html|application\/xhtml\+xml)\b/.test(type)) {
        discard(res.body)
        throw new ImportError('That link isn’t a web page (only pages can be imported, not files or images).', 415)
      }
      const declared = Number(header('content-length'))
      if (Number.isFinite(declared) && declared > maxBytes) {
        discard(res.body)
        throw new ImportError(TOO_BIG, 413)
      }
      const bytes = await readCapped(res.body, maxBytes, deadline.signal)
      return { url, html: decodeBody(bytes, type) }
    }
  } catch (err) {
    if (err instanceof ImportError) throw err
    if (deadline.signal.aborted) throw new ImportError(TOO_SLOW, 504)
    throw new ImportError('Couldn’t open that page — check the link, or paste the recipe instead.', 502)
  } finally {
    clearTimeout(timer)
  }
}

// ---- reading HTML ------------------------------------------------------------------

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  deg: '°',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  frac13: '⅓',
  frac23: '⅔',
  frac18: '⅛',
  times: '×',
  bull: '•',
  middot: '·',
  reg: '®',
  copy: '©',
  trade: '™',
  shy: '',
  eacute: 'é',
  egrave: 'è',
  ecirc: 'ê',
  euml: 'ë',
  aacute: 'á',
  agrave: 'à',
  acirc: 'â',
  auml: 'ä',
  iacute: 'í',
  icirc: 'î',
  iuml: 'ï',
  oacute: 'ó',
  ocirc: 'ô',
  ouml: 'ö',
  uacute: 'ú',
  ucirc: 'û',
  uuml: 'ü',
  ntilde: 'ñ',
  ccedil: 'ç',
  szlig: 'ß',
}

function decodeOnce(s) {
  return s.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi, (whole, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ''
    }
    return NAMED_ENTITIES[e] ?? NAMED_ENTITIES[e.toLowerCase()] ?? whole
  })
}

/** HTML entities decoded — twice when a site encoded them twice ("&amp;#39;"), which recipe plugins do. */
export function decodeEntities(text) {
  const once = decodeOnce(String(text ?? ''))
  return /&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/i.test(once) ? decodeOnce(once) : once
}

/**
 * A tag, as opposed to a "<" in prose ("cook for < 5 minutes"). `[^<>]`, not
 * `[^>]`: a page of unclosed "<a<a<a…" would otherwise send every attempt to
 * the end of two megabytes, and this is someone else's page.
 */
const TAG = /<\/?[a-z][^<>]*>/gi

/** One line of text from a value that may hold entities and tags. */
function cleanText(value, max) {
  if (typeof value !== 'string') return ''
  return decodeEntities(value).replace(TAG, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim()
}

/** The first string in a value that may be a string, an array of them, or an object with a name. */
function firstString(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(firstString).find(Boolean) ?? ''
  if (value && typeof value === 'object' && typeof value['@value'] === 'string') return value['@value']
  return ''
}

/**
 * The document without every element named: scripts, styles, navigation.
 * A linear scan, not a regex — a lazy `<script[\s\S]*?</script>` over two
 * megabytes of unclosed tags is quadratic, and the page is someone else's.
 * An element that never closes takes the rest of the document with it, as a
 * browser would read an unclosed <script>.
 */
function withoutElements(html, tags) {
  let out = html
  for (const tag of tags) {
    const lower = out.toLowerCase()
    const open = `<${tag}`
    const close = `</${tag}`
    let result = ''
    let i = 0
    for (;;) {
      const start = lower.indexOf(open, i)
      if (start === -1) {
        result += out.slice(i)
        break
      }
      const after = lower.charAt(start + open.length)
      if (after && !/[\s>/]/.test(after)) {
        result += out.slice(i, start + open.length)
        i = start + open.length
        continue
      }
      result += `${out.slice(i, start)} `
      const end = lower.indexOf(close, start + open.length)
      if (end === -1) break
      const gt = lower.indexOf('>', end)
      i = gt === -1 ? out.length : gt + 1
    }
    out = result
  }
  return out
}

/** The document without its <!-- comments -->, by the same linear scan. */
function withoutComments(html) {
  let out = ''
  let i = 0
  for (;;) {
    const start = html.indexOf('<!--', i)
    if (start === -1) return out + html.slice(i)
    out += `${html.slice(i, start)} `
    const end = html.indexOf('-->', start + 4)
    if (end === -1) return out
    i = end + 3
  }
}

/** Between the first opening of a tag and its last closing, when the page has one. */
function spanOf(html, tag) {
  const lower = html.toLowerCase()
  const start = lower.search(new RegExp(`<${tag}[\\s>]`))
  if (start === -1) return null
  const openEnd = lower.indexOf('>', start)
  const end = lower.lastIndexOf(`</${tag}`)
  if (openEnd === -1 || end <= openEnd) return null
  return html.slice(openEnd + 1, end)
}

/** Name → content for every <meta> with both. */
function metaTags(html) {
  const out = new Map()
  for (const m of html.matchAll(/<meta\b[^<>]*>/gi)) {
    const attrs = new Map()
    for (const a of m[0].matchAll(/\b([a-z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) attrs.set(a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? '')
    const key = (attrs.get('property') ?? attrs.get('name') ?? '').toLowerCase()
    if (key && attrs.has('content') && !out.has(key)) out.set(key, attrs.get('content'))
  }
  return out
}

/** What the page calls itself: its og:title, else its <title>, without the site's name after a bar. */
export function pageTitle(html) {
  const og = metaTags(html).get('og:title')
  const title = og ?? spanOf(html, 'title') ?? ''
  const clean = cleanText(title, 160)
  const first = clean.split(/\s+[|·]\s+|\s+[-–—]\s+(?=[^-–—]*$)/)[0]
  return (first && first.length >= 3 ? first : clean).slice(0, 120)
}

const DROP = ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'nav', 'header', 'footer', 'aside', 'form', 'button', 'select', 'dialog']

/**
 * A page's readable text, for when it has no Recipe data: its <main> when it
 * marks one, without scripts, styles, navigation, headers, footers and forms;
 * a line per block; capped. The app reads it with ✨, as it reads a paste.
 * @param {string} html
 * @param {number} [max]
 */
export function readableText(html, max = IMPORT_LIMITS.textMax) {
  const body = spanOf(html, 'body') ?? html
  const main = spanOf(body, 'main')
  let s = withoutElements(withoutComments(main && main.length > 400 ? main : body), DROP)
  s = s
    .replace(/<(br|hr)\b[^<>]*>/gi, '\n')
    .replace(/<li\b[^<>]*>/gi, '\n• ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|ul|ol|table|blockquote|dd|dt|figcaption|header|main)\s*>/gi, '\n')
    .replace(TAG, ' ')
  const lines = decodeEntities(s)
    .split('\n')
    .map(line => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter(line => line && line !== '•')
  const out = []
  for (const line of lines) if (out[out.length - 1] !== line) out.push(line)
  return out.join('\n').slice(0, max).trim()
}

// ---- schema.org Recipe ---------------------------------------------------------------

const ESCAPED = { '\n': '\\n', '\r': '\\r', '\t': '\\t' }

/** JSON as sites write it: raw line breaks inside strings (kept, as the breaks they mean), and trailing commas. */
function repairJson(text) {
  let out = ''
  let inString = false
  let escaped = false
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      else if (ch < ' ') {
        out += ESCAPED[ch] ?? ' '
        continue
      }
    } else if (ch === '"') inString = true
    out += ch
  }
  return out.replace(/,\s*([}\]])/g, '$1')
}

function parseLenientJson(raw) {
  const text = raw
    .trim()
    .replace(/^<!--/, '')
    .replace(/-->$/, '')
    .replace(/^\/\*\s*<!\[CDATA\[\s*\*\//, '')
    .replace(/\/\*\s*\]\]>\s*\*\/$/, '')
    .replace(/^\/\/\s*<!\[CDATA\[/, '')
    .replace(/\/\/\s*\]\]>$/, '')
    .trim()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    try {
      return JSON.parse(repairJson(text))
    } catch {
      return undefined
    }
  }
}

/** Every <script type="application/ld+json"> on the page that parses, as JSON. A linear scan, like withoutElements. */
export function jsonLdBlocks(html) {
  const lower = html.toLowerCase()
  const out = []
  let i = 0
  while (out.length < 50) {
    const start = lower.indexOf('<script', i)
    if (start === -1) break
    const openEnd = lower.indexOf('>', start)
    if (openEnd === -1) break
    const end = lower.indexOf('</script', openEnd)
    const stop = end === -1 ? html.length : end
    if (/\btype\s*=\s*["']?\s*application\/ld\+json/i.test(html.slice(start + 7, openEnd))) {
      const value = parseLenientJson(html.slice(openEnd + 1, stop))
      if (value !== undefined) out.push(value)
    }
    i = end === -1 ? html.length : end + 8
  }
  return out
}

const typeIs = (node, name) => {
  const t = node?.['@type']
  const list = Array.isArray(t) ? t : [t]
  const want = new RegExp(`(?:^|[/:#])${name}$`, 'i')
  return list.some(x => typeof x === 'string' && want.test(x.trim()))
}

/**
 * Every Recipe in some JSON-LD, wherever it sits: the top level, a top-level
 * array, an `@graph`, or under a page's mainEntity. `@type` may be "Recipe",
 * a URL ending in it, or an array holding it.
 */
export function findRecipes(root) {
  const out = []
  const seen = new Set()
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 10 || seen.has(node) || out.length >= 20) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const x of node.slice(0, 500)) walk(x, depth + 1)
      return
    }
    if (typeIs(node, 'Recipe')) {
      out.push(node)
      return
    }
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value, depth + 1)
  }
  walk(root, 0)
  return out
}

/** "4", "4 servings", ["4", "4 servings"], "Serves 4-6", 6: the first whole number from 1 to 64. */
function servingsOf(value) {
  for (const x of Array.isArray(value) ? value : [value]) {
    const n = typeof x === 'number' ? x : typeof x === 'string' ? Number(/\d+/.exec(x)?.[0]) : NaN
    const whole = Math.round(n)
    if (Number.isFinite(n) && whole >= 1 && whole <= 64) return whole
  }
  return undefined
}

/** The ingredient lines: an array of strings (or of objects with a name), or one string of lines. */
function ingredientLines(value) {
  if (typeof value === 'string') return decodeEntities(value).split(/\n|<br\s*\/?>/i)
  if (!Array.isArray(value)) return []
  return value.flatMap(x => (typeof x === 'string' ? [x] : x && typeof x === 'object' ? [firstString(x.text) || firstString(x.name)] : []))
}

/** One instruction text as steps: a line per paragraph, list item or line break, numbering gone. */
function splitSteps(raw) {
  let text = decodeEntities(String(raw ?? ''))
  // "1. Brown the beef. 2. Add the beans." on one line is still two steps
  if (!/[\n<]/.test(text) && (text.match(/(?:^|\s)\d{1,2}[.)]\s+(?=\p{Lu})/gu) ?? []).length >= 2) text = text.replace(/\s+(?=\d{1,2}[.)]\s+\p{Lu})/gu, '\n')
  const steps = text
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|li|div|h\d)\s*>/gi, '\n')
    .replace(TAG, ' ')
    .split(/\n+/)
    .map(s =>
      decodeEntities(s)
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^(?:step\s*)?\d{1,2}\s*[.):]\s*/i, '')
        .trim(),
    )
    .filter(s => s.length > 1)
  // a whole method as one paragraph is a step per sentence, not one wall to tick
  if (steps.length === 1 && steps[0].length > 240) return steps[0].split(/(?<=[.!?])\s+(?=[A-Z])/).map(s => s.trim()).filter(Boolean)
  return steps
}

/**
 * The steps in recipeInstructions: a string, HowToSteps, HowToSections of
 * them (itemListElement), or a mix. With more than one section, each
 * section's first step says which part of the dish it starts ("For the
 * sauce: Melt the butter"), since the app keeps one list of steps.
 */
function stepTexts(value, depth = 0) {
  if (depth > 6 || value == null) return []
  if (typeof value === 'string') return splitSteps(value)
  if (Array.isArray(value)) {
    const sections = value.filter(x => x && typeof x === 'object' && !Array.isArray(x) && (typeIs(x, 'HowToSection') || (x.itemListElement && !x.text)))
    return value.flatMap(x => {
      const steps = stepTexts(x, depth + 1)
      const label = sections.length > 1 && sections.includes(x) ? cleanText(firstString(x.name), 60).replace(/:$/, '') : ''
      return label && steps.length ? [`${label}: ${steps[0]}`, ...steps.slice(1)] : steps
    })
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string' && value.text.trim()) return splitSteps(value.text)
    if (value.itemListElement) return stepTexts(value.itemListElement, depth + 1)
    const said = firstString(value.name) || firstString(value.description)
    return said ? splitSteps(said) : []
  }
  return []
}

/**
 * A schema.org Recipe as the app stores one: name, servings, ingredients (each
 * line through the app's own reader, shared/recipes.mts) and steps.
 * @returns {{ name: string, servings?: number, ingredients: { name: string, qty?: number, unit?: string }[], steps: string[] }}
 */
export function recipeFromJsonLd(node) {
  const ingredients = []
  for (const line of ingredientLines(node?.recipeIngredient ?? node?.ingredients)) {
    const ing = parseIngredientLine(cleanText(line, 240))
    if (ing) ingredients.push(ing)
    if (ingredients.length >= IMPORT_LIMITS.ingredientsMax) break
  }
  const steps = stepTexts(node?.recipeInstructions)
    .map(s => s.slice(0, 600).trim())
    .filter(Boolean)
    .slice(0, IMPORT_LIMITS.stepsMax)
  const servings = servingsOf(node?.recipeYield ?? node?.yield)
  return { name: cleanText(firstString(node?.name) || firstString(node?.headline), 120), ...(servings ? { servings } : {}), ingredients, steps }
}

/** The page's Recipe with the most in it, or null when it describes none. */
export function recipeFromHtml(html) {
  let best = null
  let size = -1
  for (const block of jsonLdBlocks(html)) {
    for (const node of findRecipes(block)) {
      const recipe = recipeFromJsonLd(node)
      const n = recipe.ingredients.length + recipe.steps.length
      if (n > size) {
        best = recipe
        size = n
      }
    }
  }
  return best
}

// ---- the import --------------------------------------------------------------------

/**
 * Import the recipe at a link. `{ recipe, sourceUrl }` when the page carries
 * schema.org Recipe data with ingredients or steps; otherwise `{ text, title,
 * sourceUrl }`, the page's readable text for the app to read with ✨.
 * `sourceUrl` is where the page ended up, after any redirects.
 * @param {unknown} rawUrl
 * @param {FetchOptions} [opts]
 */
export async function importRecipe(rawUrl, opts = {}) {
  const page = await fetchPage(parseImportUrl(rawUrl), opts)
  const sourceUrl = page.url.toString()
  const recipe = recipeFromHtml(page.html)
  if (recipe && (recipe.ingredients.length || recipe.steps.length)) return { recipe, sourceUrl }
  const text = readableText(page.html)
  if (text.length < 20) throw new ImportError('Nothing on that page reads like a recipe.', 422)
  return { text, title: recipe?.name || pageTitle(page.html), sourceUrl }
}

/**
 * The /api/recipe-import handler. Signed-in accounts only, by the same check
 * /api/ai makes (requireUser: no session is a 401, a host missing its auth
 * settings a 503), and at most 20 imports in ten minutes per account, since
 * each one is a fetch from our servers to somewhere a person chose. The
 * endpoint hands in a limit counted across instances (sharedWindow); by
 * default it is this instance's own.
 * @param {FetchOptions & { limit?: number, perUser?: { take(key: string): { ok: boolean, retryAfterMs: number } | Promise<{ ok: boolean, retryAfterMs: number }> } }} [opts] the fetch's parts and the limit, which tests replace
 */
export function recipeImportHandler(opts = {}) {
  const { limit = 20, perUser = slidingWindow({ limit, windowMs: 10 * 60_000 }), ...fetchOptions } = opts
  return async req => {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
    const { user, response } = await requireUser(req)
    if (response) return response
    let body
    try {
      body = await req.json()
    } catch {
      return Response.json({ error: 'invalid JSON' }, { status: 400 })
    }
    const url = typeof body?.url === 'string' ? body.url.trim() : ''
    if (!url) return Response.json({ error: 'url is required' }, { status: 400 })
    const slot = await perUser.take(user.id)
    if (!slot.ok) {
      const seconds = Math.ceil(slot.retryAfterMs / 1000)
      return Response.json(
        { error: `Too many imports from this account — try again in ${Math.max(1, Math.ceil(seconds / 60))} min.` },
        { status: 429, headers: { 'retry-after': String(seconds) } },
      )
    }
    try {
      return Response.json(await importRecipe(url, fetchOptions))
    } catch (err) {
      if (err instanceof ImportError) return Response.json({ error: err.message }, { status: err.status })
      return Response.json({ error: 'Couldn’t import that page.' }, { status: 502 })
    }
  }
}
