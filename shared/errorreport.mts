// What a client error report may carry, and when two reports are one error.
//
// When something breaks on a device the app tells the site owner
// (src/errorreport.ts) and the server keeps a count of it
// (netlify/functions/log.mjs, public.client_errors). Both clean a report with
// this one module — the app before anything leaves the device, the server
// again before anything is stored — so they cannot disagree about what is
// kept: the error's class and the words of its message, the places in the
// code its stack went through, the build, web or the iOS shell, which screen,
// and the page's path without its query string. Never a record, a title, or
// anything typed.
//
// The message is the hard part. A throw that puts a title in its message puts
// it there whether or not it quotes it ("Could not save Buy milk"), so the
// rule cannot be about quotes. It is about words: a message keeps the words
// error messages are made of (KNOWN, below) and anything that reads as code —
// an identifier with a capital inside, a dot, a digit, an underscore or a $;
// an acronym; a single letter — and every other word becomes MASK. Numbers
// keep their first two digits, ids their first four characters, and a phone
// number, a date or an email address goes whole. So a name, a title or a
// number somebody typed cannot survive, quoted or not; what can is the shape
// of the message, and one lowercase word in quotes, which is how engines name
// a property ("reading 'title'").

export const MESSAGE_MAX = 500
export const STACK_MAX = 4096
/** The most frames a stack keeps. */
export const FRAMES_MAX = 20
export const PATH_MAX = 200
export const BUILD_MAX = 64
export const VIEW_MAX = 32
/** How many times one report may say the error happened. */
export const COUNT_MAX = 1000
/** What a word, a number or an id that may be somebody's becomes. */
export const MASK = '…'

export type ReportPlatform = 'web' | 'ios'
export const PLATFORMS: readonly ReportPlatform[] = ['web', 'ios']

/** A report as the app sends it and the server stores it (public.client_errors). */
export interface CleanReport {
  fingerprint: string
  message: string
  stack: string | null
  build: string | null
  platform: ReportPlatform | null
  view: string | null
  path: string | null
  count: number
}

/**
 * The words error messages are made of: English's small words, the ones the
 * engines, the browser, Supabase and the network use, the app's own nouns, and
 * the names of the platforms it runs on. A word that is not here and does not
 * read as code is somebody's, and becomes MASK. When a real message in Admin
 * lost a word it needed, add the word here — never a word that names a person,
 * a day or a thing people write down.
 */
const KNOWN = new Set(
  `a about above across after again against ago all almost along already also although always am among an and another any
  anyone anything anywhere are around as at away back be because been before behind being below between both but by can
  cannot could did do does doing done down during each either else enough even ever every everyone everything for from
  further had has have having here how however if in inside instead into is it its itself just last least less like many
  may maybe might more most much must near need needed needs neither never next no none nor not nothing now of off often on
  once one only onto or other others otherwise our out outside over own per please rather really same should since so some
  someone something somewhere soon still such than that the their them then there these they this those though through
  thus to together too toward towards under unless until up upon us very via was way we were what whatever when where
  whether which while who whom whose why will with within without would yes yet you your yourself
  aren't can't couldn't didn't doesn't don't hasn't haven't isn't it's let's shouldn't that's there's wasn't weren't won't
  wouldn't what's you're we're they're i'm
  zero two three four five six seven eight nine ten first second third half
  abort aborted aborting access accessed accessing accept accepted action actions active add added adding address addresses
  agent algorithm allocation allow allowed allows alive anonymous answer answered answers api append appended application
  apply argument arguments array arrays asked asks assert assertion assign assigned assignment async attempt attempted
  attempting attempts attribute attributes audio auth authenticate authenticated authentication authorization authorized
  available await bad base batch bigint binary bind blank blob blobs block blocked blocking blocks body boolean bound
  boundary browser buffer build builds bundle busy button byte bytes cache cached caches call callback called caller calling
  calls cancel canceled cancelled capability capture certificate change changed changes channel character characters check
  checked child children chunk chunks circular class classes clear cleared click client clients clipboard clone cloned close
  closed closing code codec codes column columns compile compiled complete completed component components compressed config
  configuration configured conflict connect connected connecting connection connections console const constant constraint
  construct constructed constructor contain contains content context contexts control converting cookie cookies copies copy
  corrupt could count create created creating credential credentials cross crypto current cursor data database databases date
  debug declaration declared decode decoded decoding default defined delete deleted deleting denied deny depth destination
  detached dev development device devices different directive disabled disconnected display document documents dom domain
  download downloaded downloading draw drawing drop dropped due duplicate dynamic dynamically edit editable editing editor
  element elements email empty enabled encode encoded encoding end ended endpoint entries entry environment equal error
  errors eval evaluate evaluating evaluation event events exceeded exceeds exception exceptions execute executed executing
  exist exists expected expire expired expires export exported expression extension external fail failed failing fails
  failure false fetch fetched fetching field fields file files filter find finished focus font fonts forbidden form format
  found frame frames fulfilled full function functions gateway generated gesture get gets getting given global
  granted handle handled handler handlers hash header headers height hidden history hook hooks host html https idle illegal
  image images implemented import imported importing imports include includes incoming index indexed infinity info
  initialization initialized inline input insecure insert inserted install installed instance integer interaction internal
  interrupted invalid invocation invoke iterable iterator item items join json key keyboard keys kind kinds label large
  later layout left length level limit limits line lines link links list listener listeners lists load loaded loading loads
  local location lock locked log logged login logs long longer look lookup loop lost main malformed manifest map mask masks
  match matched maximum media memory merge message messages method methods migration min minified minimum missing mixed
  mode model models module modules moment mount mounted multiple name named names native navigation navigator network new
  node nodes non null number numbers object objects observer offline offset ok old online open opened opening operation
  operations option options order origin origins output overflow owner page pages param parameter parameters parent parse
  parsed parser parsing part partial passive password paste pasting path paths pattern payload pending permission
  permissions picture pictures pipe platform play playback pointer policy pool port position possibly post posted posts
  precache prefetch preload preview previous private processing production program promise promises prompt
  properties property protocol provided provider proxy public push put queue quota range ranges rate raw reached read reader
  reading reads ready reason receive received record records recursion reduce reference refresh refreshed refused register
  registered registration reject rejected rejection reload remote remove removed removing render rendered rendering replace
  replaced reply report reported reporting reports request requested requests require required requires reset resize resolve
  resolved resource resources response responses restore result results retried retry retrying return returned returning
  returns revoke revoked right root route row rows rule rules run running runs safe sample save saved saving schema scope
  scopes screen script scripts scroll search secure security select selection send sending sends sent server servers
  service session sessions set sets setting settings setup shader shape sheet sign signal signed site size sizes skipped
  slice slow small socket sort source sources space split src stack start started state states static status step storage
  store stored stores stream streams string strings structure structured style styles subscribe subscribed subscription
  success supported support supports switched sync synced syncing syntax system table tables take takes target temporarily
  temporary text texture thread threw throw thrown time timed timeout times title token tokens took top touch trace track
  transaction transactions transfer transform tried trigger true try trying turn type types undefined unexpected unhandled
  unique unknown unable unauthorized uninitialized unlock unmounted unreachable unsupported update updated updates updating
  upload uploaded uploading uri url usage use used user users using valid validation value values variable variables version
  versions video view views violates violation visible visit wait waiting warning warnings wasm webassembly webgl websocket
  width window windows word words work worker workers write writer writing written wrong yield
  ms sec secs minute minutes hour hours day days week weeks month months year years today tomorrow yesterday kb mb gb px
  account accounts admin agents alarm alarms app apps assistant assistants attachment attachments backup backups
  bot calendar calendars canary chat checklist cutout cut digest draft drafts feed feeds finance garment garments grocery
  groceries habit habits home household households inbox insights invitation invite invites journal kitchen meal meals member
  members note notes notice notices notification notifications outfit outfits people person photo photos place places project
  projects recipe recipes reminder reminders review reviews routine routines segmenter snapshot snapshots snooze tag tags task
  tasks trash wardrobe weather widget widgets csp elem attr ancestors
  android anthropic apns capacitor chrome claude drafter firefox github google icloud ios ipad iphone mac macos mediapipe
  microsoft netlify nominatim nvidia openstreetmap outlook react resend safari supabase vite webkit workbox
  asset assets js mjs css png svg jpg webp gif ico ics txt webmanifest phone phones additional helpful basic
  rest rpc realtime graphql oauth authorize`.split(/\s+/),
)

/** Acronyms kept as they are written; any other word in capitals is a word like the rest. */
const ACRONYMS = new Set(
  'AI API APNS CORS CPU CSP CSS CSV DB DNS DOM GB GPU HTML HTTP HTTPS ICS ID IDB IO IP JPEG JS JSON JWT KB MB MCP MS OK PDF PKCE PNG RLS RPC SIMD SQL SSL SVG TDZ TLS UI URI URL UTC UTF UUID VAPID WASM XML'.split(' '),
)

/** An identifier: lower case then a capital, as in addEventListener or iPhone. */
const CAMEL = /^\p{Ll}+\p{Lu}[\p{L}]*$/u
/** Two or more capitalised humps with a lower-case letter somewhere, as in TypeError or IDBObjectStore. */
const PASCAL = /^(?=.*\p{Ll})\p{Lu}\p{Ll}*(?:\p{Lu}\p{Ll}*)+$/u
/** An id: eight or more letters, digits, dashes and underscores, with a letter and a digit among them. */
const ID = /^(?=[\p{L}\p{N}_-]*\p{N})(?=[\p{L}\p{N}_-]*\p{L})[\p{L}\p{N}_-]{8,}$/u

/**
 * An id keeps its first four characters when they are letters and digits
 * both, and so read as code the next time round (the server cleans what the
 * app cleaned); any other id goes whole.
 */
const idMask = (id: string): string => {
  const head = id.slice(0, 4)
  return /^[\p{L}\p{N}]{4}$/u.test(head) && /\p{L}/u.test(head) && /\p{N}/u.test(head) ? `${head}${MASK}` : MASK
}

const URLS = /[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>()]+/gi
/**
 * The parts of a message, in the order they are tried at each place: a URL,
 * an email address (%40 too, as a path spells it), a date, a quoted run (a
 * single quote only as a word's neighbour cannot be an apostrophe), a UUID, a
 * run of digits and separators, and a word or identifier. Whatever none of
 * them takes — spaces, punctuation — is kept. No look-behind: the iPhone app
 * runs on iOS 16.0, whose WebKit has none, and one would fail the whole bundle.
 */
const TOKENS = new RegExp(
  [
    String.raw`(?<url>[a-z][a-z0-9+.-]*:\/\/[^\s'"\x60<>()]+)`,
    String.raw`(?<email>[\p{L}\p{N}._%+-]+(?:@|%40)[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,})`,
    String.raw`(?<date>\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?(?!\p{N}))`,
    String.raw`(?<quoted>"[^"\n]*"|“[^”\n]*”|\x60[^\x60\n]*\x60|'[^'\n]*'(?![\p{L}\p{N}])|‘[^’\n]*’(?![\p{L}\p{N}]))`,
    String.raw`(?<uuid>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`,
    String.raw`(?<digits>\+?\(?\d[\d\s().\/-]*\d(?![\p{L}\p{N}_$]))`,
    String.raw`(?<atom>[\p{L}\p{N}_$](?:[\p{L}\p{N}_$.'’-]*[\p{L}\p{N}_$])?)`,
  ].join('|'),
  'giu',
)
// every control character but the newline a stack is made of
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/g

/**
 * Every URL's query string and fragment cut off — they carry tokens, ids and
 * search words — keeping the `:line:column` a stack frame ends with.
 */
export function stripQueries(text: unknown): string {
  return String(text ?? '').replace(URLS, url => {
    const cut = url.search(/[?#]/)
    if (cut === -1) return url
    const position = /:\d+(?::\d+)?$/.exec(url.slice(cut))?.[0] ?? ''
    return url.slice(0, cut) + position
  })
}

/** Runs of four digits or more keep their first two. */
const maskDigits = (word: string): string => word.replace(/\p{N}{4,}/gu, digits => `${digits.slice(0, 2)}${MASK}`)

/** Masks next to masks are one mask: "… …" and "…-…" say nothing more than "…". */
const collapse = (text: string): string => text.replace(new RegExp(`${MASK}(?:[\\s.,;:'’"\\-/_]*${MASK})+`, 'g'), MASK)

/** One word, with no dot or dash in it: kept when it is code, an acronym or a known word. */
function scrubWord(word: string): string {
  if (!word) return word
  if (ID.test(word)) return idMask(word)
  if (/\p{N}/u.test(word)) return maskDigits(word)
  if (/[_$]/.test(word) || [...word].length === 1) return word
  if (/^\p{Lu}{2,}s?$/u.test(word) && ACRONYMS.has(word.replace(/s$/, ''))) return word
  if (CAMEL.test(word) || PASCAL.test(word)) return word
  const bare = word.toLowerCase().replace(/’/g, "'")
  return KNOWN.has(bare) || KNOWN.has(bare.replace(/'s$/, '')) ? word : MASK
}

/** A word or an identifier, a dotted path (window.localStorage) or a hyphenated word taken a part at a time. */
function scrubAtom(atom: string): string {
  if (/^[\p{N}.'’-]+$/u.test(atom)) return maskDigits(atom)
  if (ID.test(atom)) return idMask(atom)
  if (KNOWN.has(atom.toLowerCase().replace(/’/g, "'"))) return atom
  return atom
    .split(/([.-])/)
    .map((part, i) => (i % 2 ? part : scrubWord(part)))
    .join('')
}

/** A phone number, a card, an address's digits: seven digits or more go whole; fewer keep their short runs. */
function scrubDigits(run: string): string {
  return (run.match(/\d/g)?.length ?? 0) >= 7 ? '<number>' : maskDigits(run)
}

/**
 * A quoted run keeps what it quotes when that is one token the message rules
 * would keep anyway, or a lower-case identifier (an engine naming a property:
 * "reading 'title'"). Anything else in quotes — words with spaces, a name —
 * is somebody's, and goes.
 */
function scrubQuoted(quoted: string): string {
  const open = quoted[0]
  const close = quoted[quoted.length - 1]
  const inner = quoted.slice(1, -1)
  if (!inner) return quoted
  const kept = !/\s/.test(inner) && inner.length <= 40 && (scrubRun(inner) === inner || /^[a-z_$][\w$]{0,23}$/.test(inner))
  return `${open}${kept ? inner : MASK}${close}`
}

const decoded = (segment: string): string => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * A URL keeps its scheme and host — which service it was — and no query or
 * fragment; each part of its path is a message of its own, so a recipe's name
 * or a calendar's private token in a path goes like any other word.
 */
function scrubUrl(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)(.*?)((?::\d+){1,2})?$/i.exec(stripQueries(url))
  if (!m) return MASK
  const [, scheme, authority, path, position = ''] = m
  // whoever was named before an @ in the host
  const host = authority.slice(authority.lastIndexOf('@') + 1)
  const cleanPath = path
    .split('/')
    .map(segment => (segment ? scrubRun(decoded(segment)) : segment))
    .join('/')
  return `${scheme}${host}${collapse(cleanPath)}${position}`
}

function scrubRun(text: string): string {
  return text.replace(TOKENS, (match: string, ...rest: unknown[]) => {
    const part = rest[rest.length - 1] as Record<string, string | undefined>
    if (part.url) return scrubUrl(match)
    if (part.email) return '<email>'
    if (part.date) return '<date>'
    if (part.quoted) return scrubQuoted(match)
    if (part.uuid) return idMask(match)
    if (part.digits) return scrubDigits(match)
    return scrubAtom(match)
  })
}

/**
 * A message as it may be kept: the words error messages are made of and
 * whatever reads as code, with everything else masked (the rules are at the
 * top of this file), no query strings, no control characters, at most `max`
 * characters. Cleaning a cleaned message changes nothing, so the server's
 * pass agrees with the app's.
 */
export function scrubMessage(text: unknown, max: number = MESSAGE_MAX): string {
  if (text == null) return ''
  const raw = String(text).slice(0, max * 4).replace(CONTROL, ' ')
  return collapse(scrubRun(raw)).trim().slice(0, max)
}

/**
 * Where one stack line says it was: the place it ends with — "(url:1:2)",
 * "name@url:1:2" or a bare "url:1:2" — as the file's path, its line and its
 * column, with no origin, query or function name. A line that names no file
 * (the message, "[native code]", "<anonymous>") is null.
 */
function framePlace(line: string): string | null {
  const text = line.trim()
  const m = /([^\s(@]+?):(\d+)(?::(\d+))?\)?$/.exec(text)
  if (!m) return null
  const [, where, row, col] = m
  // Chrome's "at …", Safari's and Firefox's "name@…", or a bare path: a
  // message line that ends in "12:34" is not a frame
  if (!/^at\s/.test(text) && !text.includes('@') && !where.includes('/')) return null
  let file: string
  if (/^blob:/i.test(where)) file = 'blob'
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(where)) {
    try {
      const url = new URL(where)
      file = /^(https?|capacitor|file):$/.test(url.protocol) ? url.pathname : `${url.protocol}${url.pathname}`
    } catch {
      return null
    }
  } else if (/^[\w./~%-]+$/.test(where)) file = where
  else return null
  const safe = file.replace(/[^\w./~%:-]/g, '')
  return safe ? `${safe}:${row}${col ? `:${col}` : ''}` : null
}

/**
 * A stack as it may be kept: one "at file:line:column" a frame, at most
 * FRAMES_MAX of them, and nothing else — not the message (the report has it),
 * not a function's name, not a URL's origin or query.
 */
export function scrubStack(stack: unknown, max: number = STACK_MAX): string {
  if (stack == null) return ''
  const frames: string[] = []
  for (const line of String(stack).slice(0, max * 4).split('\n')) {
    const place = framePlace(line)
    if (place) frames.push(`at ${place}`)
    if (frames.length >= FRAMES_MAX) break
  }
  return frames.join('\n').slice(0, max)
}

/** A page's path, never its query string or fragment; null for anything that is not a path. */
export function cleanPath(path: unknown): string | null {
  if (typeof path !== 'string') return null
  const bare = path.split(/[?#]/)[0].replace(/[^A-Za-z0-9/_.~%-]/g, '')
  return bare.startsWith('/') ? bare.slice(0, PATH_MAX) : null
}

/**
 * Which screen: a few lowercase words the app itself names ("home",
 * "settings", "the task editor"), or "other". Never free text.
 */
export function cleanView(view: unknown): string | null {
  if (typeof view !== 'string' || !view.trim()) return null
  const v = view.trim().toLowerCase().replace(/’/g, "'")
  return new RegExp(`^[a-z][a-z ']{0,${VIEW_MAX - 1}}$`).test(v) ? v : 'other'
}

/** The build stamp (index.html's drafter-build meta): letters, digits, dots, dashes and underscores. */
export function cleanBuild(build: unknown): string | null {
  if (typeof build !== 'string') return null
  const b = build.replace(/[^A-Za-z0-9._-]/g, '').slice(0, BUILD_MAX)
  return b || null
}

export function cleanPlatform(platform: unknown): ReportPlatform | null {
  return PLATFORMS.find(p => p === platform) ?? null
}

/** How many times a report says the error happened: a whole number from 1 to COUNT_MAX. */
export function cleanCount(count: unknown): number {
  const n = Math.floor(Number(count))
  return Number.isFinite(n) ? Math.min(COUNT_MAX, Math.max(1, n)) : 1
}

/** The first line of a stack that says where it happened: Chrome's "at f (url:1:2)", Safari's "f@url:1:2". */
function topFrame(stack: unknown): string {
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
function steadyFrame(frame: string): string {
  return frame
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^/\s)]*/gi, '')
    .replace(/-[A-Za-z0-9_-]{6,}(\.m?js)\b/g, '$1')
    .replace(/:\d+(?::\d+)?/g, '')
}

/** A message without the numbers and ids that differ each time the same thing goes wrong. */
function steadyMessage(message: unknown): string {
  return String(message ?? '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '#')
    .replace(/\d{3,}/g, '#')
}

function fnv1a(text: string, seed: number): string {
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
export function fingerprintOf({ message, stack, platform }: { message: string; stack?: string | null; platform?: string | null }): string {
  const basis = `${platform ?? ''}\n${steadyMessage(message)}\n${steadyFrame(topFrame(stack))}`
  return fnv1a(basis, 0x811c9dc5) + fnv1a(basis, 0x5bd1e995)
}

/** An object whose fields can be read one by one, whatever they turn out to hold. */
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'

/** A report as it may be sent and stored, or null when it says nothing. */
export function cleanReport(report: unknown): CleanReport | null {
  if (!isObject(report)) return null
  const message = scrubMessage(report.message, MESSAGE_MAX)
  if (!message) return null
  const stack = scrubStack(report.stack, STACK_MAX) || null
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
