// Importing a recipe from a link: fetch the page without letting the link
// reach anything but the public internet, then read the schema.org Recipe the
// page describes itself with, or failing that, its readable text for the app
// to read with ✨ (readRecipe in src/ai.ts). netlify/functions/recipe-import.mjs
// is the HTTP face; everything here is testable without a network.
//
// The fetch is lib/safefetch.mjs, the one careful transport the calendar
// subscriptions use too: every hop checked and pinned to a public address,
// redirects followed by hand, at most three, each hop checked again. Here the
// whole import has six seconds and two megabytes, and only HTML is read.

import { SafeFetchError, WEB_PORTS, checkUrl, safeGet } from './safefetch.mjs'
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

/** The importer's own words for each way the shared transport can refuse (lib/safefetch.mjs FETCH_FAILURES). */
const WORDS = {
  not_a_link: () => NOT_A_LINK,
  scheme: () => 'Only http and https links can be imported.',
  credentials: () => 'A link with a user name or password in it can’t be imported.',
  port: () => 'That link asks for a port Drafter doesn’t open.',
  refused: () => REFUSED,
  not_found: () => 'Couldn’t find that site — check the link.',
  encoding: () => 'That page is compressed in a way Drafter can’t read.',
  redirects: () => 'That link redirects too many times.',
  redirect_nowhere: () => 'The site redirected without saying where to.',
  redirect_bad: () => 'The site redirected somewhere that isn’t a web address.',
  http: status => `The site answered ${status}, so there was nothing to read.`,
  type: () => 'That link isn’t a web page (only pages can be imported, not files or images).',
  too_big: () => TOO_BIG,
  timeout: () => TOO_SLOW,
  failed: () => 'Couldn’t open that page — check the link, or paste the recipe instead.',
}

/** A refusal of the shared transport as the importer says it; anything else as it came. */
function asImportError(err) {
  if (!(err instanceof SafeFetchError)) return err
  return new ImportError((WORDS[err.code] ?? WORDS.failed)(err.detail), err.status)
}

// ---- the link ------------------------------------------------------------------

/**
 * The link as a URL the importer will fetch, or an ImportError: http and https
 * only, no user name or password in it, the usual web ports, and no fragment.
 * The transport runs the same check again on every redirect.
 * @param {unknown} raw
 * @returns {URL}
 */
export function parseImportUrl(raw) {
  try {
    return checkUrl(typeof raw === 'string' ? raw : '', { ports: WEB_PORTS, maxLength: IMPORT_LIMITS.urlMax })
  } catch (err) {
    throw asImportError(err)
  }
}

// the guard and the transport, where the importer's callers and tests have always found them
export { ipv6Groups, isPublicAddress, isPublicIPv4, isPublicIPv6, nodeTransport } from './safefetch.mjs'

// ---- the fetch ---------------------------------------------------------------------

const REQUEST_HEADERS = Object.freeze({
  accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
  'accept-encoding': 'gzip, br',
  'accept-language': 'en-US,en;q=0.8',
  // a browser's shape, since some recipe sites turn away anything else, and our name after it
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 DrafterRecipeImport/1.0',
})

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

const isHtml = type => /^\s*(text\/html|application\/xhtml\+xml)\b/.test(type)

/**
 * @typedef {import('./safefetch.mjs').TransportResponse} TransportResponse
 * @typedef {import('./safefetch.mjs').Transport} Transport
 * @typedef {{ resolve?: (host: string) => Promise<{ address: string, family: number }[]>, transport?: Transport, isAllowed?: (ip: string) => boolean, timeoutMs?: number, maxBytes?: number, maxRedirects?: number }} FetchOptions
 */

/**
 * GET a page the careful way (lib/safefetch.mjs): every hop checked and
 * pinned, redirects by hand, a deadline over all of it, a size cap on the
 * decompressed body, HTML only. Answers the page's final URL and its text.
 * @param {URL} start from parseImportUrl
 * @param {FetchOptions} [opts]
 * @returns {Promise<{ url: URL, html: string }>}
 */
export async function fetchPage(start, opts = {}) {
  const { resolve, transport, isAllowed, timeoutMs = IMPORT_LIMITS.timeoutMs, maxBytes = IMPORT_LIMITS.maxBytes, maxRedirects = IMPORT_LIMITS.maxRedirects } = opts
  try {
    const page = await safeGet(start, { resolve, transport, isAllowed, timeoutMs, maxBytes, maxRedirects, headers: REQUEST_HEADERS, accept: isHtml })
    return { url: page.url, html: decodeBody(page.body, page.header('content-type').toLowerCase()) }
  } catch (err) {
    throw asImportError(err)
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

/** Tags that style words rather than break lines: dropped with no space, as a browser draws them. */
const INLINE_TAG = /<\/?(?:a|abbr|b|bdi|bdo|cite|code|data|dfn|em|font|i|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var)\b[^<>]*>/gi

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
    // inline tags sit inside a word or against its comma, as a browser draws them: "<b>there</b>," is "there,"
    .replace(INLINE_TAG, '')
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
