// Fetching an address a person typed, from inside Netlify's network, without
// letting it reach anything but the public internet. The recipe importer
// (lib/recipeimport.mjs) and the calendar subscriptions (lib/icsfeed.mjs)
// both do it, so both go through this one transport.
//
// Why the fetch is careful. Left alone, a server that fetches a URL someone
// chose is a server-side request forgery: http://169.254.169.254/ reads the
// cloud's instance metadata, a name that resolves to 10.0.0.5 reaches whatever
// listens there, and a public page can redirect to either. So every hop is
// checked the same way — http(s) only, the usual ports, no credentials — the
// name is resolved HERE and refused if ANY address is private, loopback,
// link-local, CGNAT or otherwise not public (IPv4, IPv6, and IPv4 dressed as
// IPv6), and the connection is made to the address that was checked rather
// than a second lookup of the name, so a DNS answer that changes between the
// check and the connect cannot slip through. Redirects are followed by hand,
// each hop checked again; one deadline covers all of it; the body is read
// against a size cap and let go the moment it passes it.
//
// Every refusal is a SafeFetchError with a `code` and an HTTP status. Each
// caller words them for its own screen (the importer says "page", the
// calendars say "calendar"); the default wording here is plain.

import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import zlib from 'node:zlib'

/** Why a fetch was refused or failed: one of these, with the status its endpoint answers. */
export const FETCH_FAILURES = Object.freeze({
  not_a_link: { status: 400, message: 'That isn’t a web address — it should start with https://.' },
  scheme: { status: 400, message: 'Only http and https addresses can be opened.' },
  credentials: { status: 400, message: 'An address with a user name or password in it can’t be opened.' },
  port: { status: 400, message: 'That address asks for a port Drafter doesn’t open.' },
  refused: { status: 403, message: 'Drafter won’t open that address: it isn’t on the public internet.' },
  not_found: { status: 502, message: 'Couldn’t find that site — check the address.' },
  encoding: { status: 502, message: 'The site answered in a compression Drafter can’t read.' },
  redirects: { status: 502, message: 'That address redirects too many times.' },
  redirect_nowhere: { status: 502, message: 'The site redirected without saying where to.' },
  redirect_bad: { status: 502, message: 'The site redirected somewhere that isn’t a web address.' },
  http: { status: 502, message: 'The site answered with an error.' },
  type: { status: 415, message: 'That address isn’t the kind of document asked for.' },
  too_big: { status: 413, message: 'That is too big to read.' },
  timeout: { status: 504, message: 'The site took too long to answer.' },
  failed: { status: 502, message: 'Couldn’t open that address.' },
})

/** A refusal or failure, by `code` (FETCH_FAILURES); `detail` is the site's own status for 'http', the content type for 'type'. */
export class SafeFetchError extends Error {
  /**
   * @param {keyof typeof FETCH_FAILURES} code
   * @param {string | number} [detail]
   */
  constructor(code, detail) {
    const known = FETCH_FAILURES[code] ?? FETCH_FAILURES.failed
    super(known.message)
    this.name = 'SafeFetchError'
    this.code = code
    this.status = known.status
    this.detail = detail
  }
}

// ---- the link ------------------------------------------------------------------

/** The ports a web address may name: the usual two, and their two usual stand-ins. */
export const WEB_PORTS = Object.freeze(new Set(['', '80', '443', '8080', '8443']))

/**
 * The address as a URL this transport will fetch, or a SafeFetchError: http
 * and https only, no user name or password in it, a port from `ports`, and no
 * fragment. Run on the typed address and again on every redirect.
 * @param {unknown} raw
 * @param {{ ports?: ReadonlySet<string>, maxLength?: number }} [opts]
 * @returns {URL}
 */
export function checkUrl(raw, { ports = WEB_PORTS, maxLength = 2_048 } = {}) {
  const text = typeof raw === 'string' ? raw.trim() : raw instanceof URL ? raw.toString() : ''
  if (!text || text.length > maxLength) throw new SafeFetchError('not_a_link')
  let url
  try {
    url = new URL(text)
  } catch {
    throw new SafeFetchError('not_a_link')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SafeFetchError('scheme')
  if (url.username || url.password) throw new SafeFetchError('credentials')
  if (!ports.has(url.port)) throw new SafeFetchError('port')
  if (!url.hostname) throw new SafeFetchError('not_a_link')
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
    if (!isAllowed(host)) throw new SafeFetchError('refused')
    return { address: host, family: literal }
  }
  let found
  try {
    found = await resolve(host)
  } catch {
    throw new SafeFetchError('not_found')
  }
  if (!Array.isArray(found) || found.length === 0) throw new SafeFetchError('not_found')
  if (found.some(r => !isAllowed(r.address))) throw new SafeFetchError('refused')
  const first = found[0]
  return { address: bare(first.address), family: net.isIP(bare(first.address)) || first.family }
}

// ---- the fetch ---------------------------------------------------------------------

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
        reject(new SafeFetchError('encoding'))
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
      if (total > maxBytes) throw new SafeFetchError('too_big')
      chunks.push(chunk)
    }
  } finally {
    if (!finished) discard(body)
  }
  return Buffer.concat(chunks)
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])

/**
 * @typedef {{ status: number, headers: Record<string, string | string[] | undefined>, body: AsyncIterable<Uint8Array | string> }} TransportResponse
 * @typedef {(req: { url: URL, address: string, family: number, signal: AbortSignal, headers: Record<string, string> }) => Promise<TransportResponse>} Transport
 * @typedef {{
 *   resolve?: (host: string) => Promise<{ address: string, family: number }[]>,
 *   transport?: Transport,
 *   isAllowed?: (ip: string) => boolean,
 *   timeoutMs?: number,
 *   maxBytes?: number,
 *   maxRedirects?: number,
 *   ports?: ReadonlySet<string>,
 *   headers?: Record<string, string>,
 *   accept?: (contentType: string) => boolean,
 * }} SafeGetOptions
 */

/**
 * GET an address the careful way (see the top of this file): every hop
 * checked and pinned, redirects by hand, one deadline over all of it, a size
 * cap on the decompressed body. `accept` refuses a content type the caller
 * cannot use before any of the body is read. A 304 — the answer to a
 * conditional request (If-None-Match or If-Modified-Since in `headers`) — comes
 * back with an empty body; every other status outside 2xx is refused.
 * Answers the final URL, the status, a header reader and the body's bytes.
 * @param {URL} start a URL checkUrl has passed
 * @param {SafeGetOptions} [opts]
 * @returns {Promise<{ url: URL, status: number, header(name: string): string, body: Buffer }>}
 */
export async function safeGet(start, opts = {}) {
  const { resolve, transport = nodeTransport, isAllowed, timeoutMs = 10_000, maxBytes = 2 * 1024 * 1024, maxRedirects = 3, ports = WEB_PORTS, headers = {}, accept } = opts
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), timeoutMs)
  try {
    let url = start
    for (let hop = 0; ; hop++) {
      const target = await beforeDeadline(publicAddressOf(url.hostname, { resolve, isAllowed }), deadline.signal)
      const res = await beforeDeadline(transport({ url, address: target.address, family: target.family, signal: deadline.signal, headers: { ...headers } }), deadline.signal)
      const header = name => {
        const v = res.headers?.[name]
        return String(Array.isArray(v) ? v[0] : (v ?? ''))
      }
      if (REDIRECTS.has(res.status)) {
        discard(res.body)
        if (hop >= maxRedirects) throw new SafeFetchError('redirects')
        const location = header('location')
        if (!location) throw new SafeFetchError('redirect_nowhere')
        let next
        try {
          next = new URL(location, url).toString()
        } catch {
          throw new SafeFetchError('redirect_bad')
        }
        url = checkUrl(next, { ports })
        continue
      }
      if (res.status === 304) {
        discard(res.body)
        return { url, status: 304, header, body: Buffer.alloc(0) }
      }
      if (res.status < 200 || res.status >= 300) {
        discard(res.body)
        throw new SafeFetchError('http', res.status)
      }
      const type = header('content-type').toLowerCase()
      if (accept && !accept(type)) {
        discard(res.body)
        throw new SafeFetchError('type', type)
      }
      const declared = Number(header('content-length'))
      if (header('content-length') && Number.isFinite(declared) && declared > maxBytes) {
        discard(res.body)
        throw new SafeFetchError('too_big')
      }
      const body = await readCapped(res.body, maxBytes, deadline.signal)
      return { url, status: res.status, header, body }
    }
  } catch (err) {
    if (err instanceof SafeFetchError) throw err
    if (deadline.signal.aborted) throw new SafeFetchError('timeout')
    throw new SafeFetchError('failed')
  } finally {
    clearTimeout(timer)
  }
}
