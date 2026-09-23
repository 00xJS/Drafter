// Minimal iCalendar (RFC 5545) support shared by the Netlify functions and the
// tests: parse VEVENTs, expand the recurrence rules personal calendars actually
// use (birthdays, weekly classes, monthly bills), and emit a feed of tasks.
// Dependency-free on purpose.
//
// The feeds people subscribe to come from Google, iCloud and Outlook, and each
// writes times its own way. Outlook names its zones the Windows way ("US
// Mountain Standard Time") and puts a VTIMEZONE block in the feed that says
// what that means; iCloud and Google use IANA names; some feeds carry times
// with no zone at all, which RFC 5545 calls floating and which mean the
// reader's own wall clock. A zone Intl did not know used to read as UTC, which
// put every Outlook event seven hours out in Phoenix, and a floating time was
// read as UTC too. So a zone is found in this order: the IANA name itself; a
// Windows name, by the table below; the feed's own VTIMEZONE; and only then
// the calendar's X-WR-TIMEZONE or the reader's zone. The recurrence rules are
// expanded the way RFC 5545 lays them out — period by period, BYxxx expanding
// or limiting as its table says, BYSETPOS last — so "the second Tuesday",
// "the last Friday", "the 1st and the 15th" and "weekdays" come out right.

const DAY = 86_400_000

/** A date's wall-clock parts in its own zone: what recurrence steps on across a DST change. */
interface Wall {
  y: number
  mo: number
  d: number
  h: number
  mi: number
  s: number
}

export interface ParsedDate {
  allDay: boolean
  /** UTC ms for a timed value; the UTC midnight of the calendar date for an all-day one. */
  ms: number
  /**
   * The zone a timed value with no Z is in: an IANA name, or the TZID of a
   * VTIMEZONE the feed defines itself (ParsedCalendar.zones). A floating
   * value is given the calendar's zone or the reader's.
   */
  tz?: string
  /** Its wall clock in that zone, so recurrence can step on wall-clock days. */
  wall?: Wall
}

/** One BYDAY entry: a weekday (0 Sunday … 6 Saturday), and for "2TU" or "-1FR" which one of the month or year. */
export interface ByDay {
  wd: number
  n?: number
}

/** An RRULE, as far as personal calendars use one. */
export interface RRule {
  freq?: string
  interval: number
  count?: number
  /** UNTIL as an instant, when it was written in UTC. */
  until?: number
  /** UNTIL written without a zone (a date, or a floating time): read in the event's own zone. */
  untilWall?: Wall
  byDay?: ByDay[]
  byMonthDay?: number[]
  byMonth?: number[]
  byYearDay?: number[]
  bySetPos?: number[]
  /** The day a week starts on for WEEKLY with an INTERVAL: RFC 5545's default is Monday. */
  wkst: number
}

export interface ParsedEvent {
  uid: string
  summary?: string
  location?: string
  description?: string
  start: ParsedDate
  /** Null when DTEND is there but is not a date. */
  end?: ParsedDate | null
  duration?: number
  rrule?: RRule
  exdates: number[]
  /** EXDATEs written as bare dates on a timed event: every occurrence on that day ('YYYY-MM-DD', its own zone) is left out. */
  exdateDays?: string[]
  recurrenceId?: number
  status?: string
  /** TRANSP:TRANSPARENT — the time is free rather than busy. */
  transparent?: boolean
}

/** One STANDARD or DAYLIGHT part of a VTIMEZONE: from when, the offsets either side, and how it repeats. */
interface Observance {
  start: Wall
  offsetFrom: number
  offsetTo: number
  rule?: RRule
  rdates: Wall[]
}

/** A zone the feed defines itself (VTIMEZONE), for a TZID nothing else knows. */
export interface FeedZone {
  observances: Observance[]
}

export interface ParsedCalendar {
  calendarName?: string
  defaultTz?: string
  events: ParsedEvent[]
  /** The feed's own VTIMEZONEs by TZID, where no IANA zone stands for one. */
  zones?: Record<string, FeedZone>
}

export interface EventInstance {
  id: string
  uid: string
  title: string
  start: string
  end: string
  allDay: boolean
  location?: string
}

export interface FeedItem {
  uid: string
  title: string
  start: number
  end?: number
  allDay: boolean
  /** All-day only: the reader's own calendar day, 'YYYY-MM-DD'. Without it the
      day is derived from `start` in UTC, which publishes an untimed task a day
      early anywhere east of UTC. */
  date?: string
  /** All-day only: last day of a multi-day event, 'YYYY-MM-DD' (inclusive). */
  endDate?: string
  /** Available time rather than busy: emits TRANSP:TRANSPARENT. */
  transparent?: boolean
  description?: string
  url?: string
  categories?: string[]
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

/**
 * Windows zone names, as Outlook and Exchange write them in TZID, and the IANA
 * zone each stands for (CLDR's windowsZones, the territory-001 zone). The
 * common ones, not every one: a name missing here still reads right when the
 * feed carries its VTIMEZONE, which Outlook's do.
 */
const WINDOWS_ZONES: Record<string, string> = {
  'dateline standard time': 'Etc/GMT+12',
  'utc-11': 'Etc/GMT+11',
  'aleutian standard time': 'America/Adak',
  'hawaiian standard time': 'Pacific/Honolulu',
  'alaskan standard time': 'America/Anchorage',
  'pacific standard time (mexico)': 'America/Tijuana',
  'pacific standard time': 'America/Los_Angeles',
  'us mountain standard time': 'America/Phoenix',
  'mountain standard time (mexico)': 'America/Mazatlan',
  'mountain standard time': 'America/Denver',
  'yukon standard time': 'America/Whitehorse',
  'central america standard time': 'America/Guatemala',
  'central standard time': 'America/Chicago',
  'central standard time (mexico)': 'America/Mexico_City',
  'canada central standard time': 'America/Regina',
  'sa pacific standard time': 'America/Bogota',
  'eastern standard time (mexico)': 'America/Cancun',
  'eastern standard time': 'America/New_York',
  'us eastern standard time': 'America/Indiana/Indianapolis',
  'haiti standard time': 'America/Port-au-Prince',
  'cuba standard time': 'America/Havana',
  'venezuela standard time': 'America/Caracas',
  'atlantic standard time': 'America/Halifax',
  'sa western standard time': 'America/La_Paz',
  'pacific sa standard time': 'America/Santiago',
  'newfoundland standard time': 'America/St_Johns',
  'e. south america standard time': 'America/Sao_Paulo',
  'argentina standard time': 'America/Argentina/Buenos_Aires',
  'sa eastern standard time': 'America/Cayenne',
  'montevideo standard time': 'America/Montevideo',
  'utc-02': 'Etc/GMT+2',
  'azores standard time': 'Atlantic/Azores',
  'cape verde standard time': 'Atlantic/Cape_Verde',
  utc: 'UTC',
  'coordinated universal time': 'UTC',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'morocco standard time': 'Africa/Casablanca',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'romance standard time': 'Europe/Paris',
  'central european standard time': 'Europe/Warsaw',
  'w. central africa standard time': 'Africa/Lagos',
  'gtb standard time': 'Europe/Bucharest',
  'middle east standard time': 'Asia/Beirut',
  'egypt standard time': 'Africa/Cairo',
  'e. europe standard time': 'Europe/Chisinau',
  'south africa standard time': 'Africa/Johannesburg',
  'fle standard time': 'Europe/Kiev',
  'israel standard time': 'Asia/Jerusalem',
  'kaliningrad standard time': 'Europe/Kaliningrad',
  'arabic standard time': 'Asia/Baghdad',
  'turkey standard time': 'Europe/Istanbul',
  'arab standard time': 'Asia/Riyadh',
  'belarus standard time': 'Europe/Minsk',
  'russian standard time': 'Europe/Moscow',
  'e. africa standard time': 'Africa/Nairobi',
  'iran standard time': 'Asia/Tehran',
  'arabian standard time': 'Asia/Dubai',
  'azerbaijan standard time': 'Asia/Baku',
  'georgian standard time': 'Asia/Tbilisi',
  'afghanistan standard time': 'Asia/Kabul',
  'west asia standard time': 'Asia/Tashkent',
  'pakistan standard time': 'Asia/Karachi',
  'india standard time': 'Asia/Kolkata',
  'sri lanka standard time': 'Asia/Colombo',
  'nepal standard time': 'Asia/Kathmandu',
  'central asia standard time': 'Asia/Bishkek',
  'bangladesh standard time': 'Asia/Dhaka',
  'myanmar standard time': 'Asia/Yangon',
  'se asia standard time': 'Asia/Bangkok',
  'n. central asia standard time': 'Asia/Novosibirsk',
  'china standard time': 'Asia/Shanghai',
  'north asia east standard time': 'Asia/Irkutsk',
  'singapore standard time': 'Asia/Singapore',
  'w. australia standard time': 'Australia/Perth',
  'taipei standard time': 'Asia/Taipei',
  'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul',
  'cen. australia standard time': 'Australia/Adelaide',
  'aus central standard time': 'Australia/Darwin',
  'e. australia standard time': 'Australia/Brisbane',
  'aus eastern standard time': 'Australia/Sydney',
  'west pacific standard time': 'Pacific/Port_Moresby',
  'tasmania standard time': 'Australia/Hobart',
  'vladivostok standard time': 'Asia/Vladivostok',
  'new zealand standard time': 'Pacific/Auckland',
  'utc+12': 'Etc/GMT-12',
  'fiji standard time': 'Pacific/Fiji',
  'tonga standard time': 'Pacific/Tongatapu',
  'samoa standard time': 'Pacific/Apia',
  'line islands standard time': 'Pacific/Kiritimati',
}

const formatters = new Map<string, Intl.DateTimeFormat | null>()

/** Intl's formatter for a zone, or null for a name it does not know. Made once per zone. */
function formatterFor(tz: string): Intl.DateTimeFormat | null {
  if (!formatters.has(tz)) {
    let f: Intl.DateTimeFormat | null = null
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    } catch {
      /* not a zone Intl knows */
    }
    formatters.set(tz, f)
  }
  return formatters.get(tz) ?? null
}

/**
 * The IANA zone a TZID or X-WR-TIMEZONE names, or null: the name itself when
 * Intl knows it; the tail of an old Lightning or Evolution path
 * ("/mozilla.org/20050126_1/America/New_York"); a Windows name, by the table.
 */
export function ianaZoneOf(name: string | null | undefined): string | null {
  const raw = String(name ?? '')
    .trim()
    .replace(/^"|"$/g, '')
  if (!raw || raw.length > 100) return null
  if (formatterFor(raw)) return raw
  const tail = /\/((?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[\w+-]+(?:\/[\w+-]+)?)$/.exec(raw)?.[1]
  if (tail && formatterFor(tail)) return tail
  const windows = WINDOWS_ZONES[raw.toLowerCase()]
  return windows && formatterFor(windows) ? windows : null
}

/** Offset (ms) of an IANA zone at a UTC instant, via Intl. */
function ianaOffset(utcMs: number, tz: string): number {
  const f = formatterFor(tz)
  if (!f) return 0
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map(x => [x.type, x.value]))
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(utcMs / 1000) * 1000
}

/** Where a zone is read from: Intl by name, or a VTIMEZONE of the feed's own. */
type Zone = { iana: string } | { feed: FeedZone }

function zoneFor(tz: string | undefined, zones: Record<string, FeedZone> | undefined): Zone | null {
  if (!tz) return null
  const own = zones?.[tz]
  if (own) return { feed: own }
  return formatterFor(tz) ? { iana: tz } : null
}

const utcOf = (w: Wall) => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s)

function wallOfUtc(ms: number): Wall {
  const d = new Date(ms)
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }
}

/** Each feed zone's transitions by year, worked out once: an offset is read for every occurrence. */
const transitionCache = new WeakMap<FeedZone, Map<number, { at: number; offset: number }[]>>()

/** The instants each observance of a feed's zone begins at in `year`, oldest first. */
function transitionsIn(zone: FeedZone, year: number): { at: number; offset: number }[] {
  let byYear = transitionCache.get(zone)
  if (!byYear) transitionCache.set(zone, (byYear = new Map()))
  const hit = byYear.get(year)
  if (hit) return hit
  const out: { at: number; offset: number }[] = []
  for (const ob of zone.observances) {
    const at = (w: Wall) => utcOf(w) - ob.offsetFrom
    const first = at(ob.start)
    const walls = ob.rule ? ruleDates(ob.rule, ob.start, year) : ob.start.y === year ? [ob.start] : []
    for (const w of [...walls, ...ob.rdates.filter(r => r.y === year)]) {
      const t = at(w)
      if (t < first) continue
      if (ob.rule?.until !== undefined && t > ob.rule.until) continue
      if (ob.rule?.untilWall && utcOf(w) > utcOf(ob.rule.untilWall)) continue
      out.push({ at: t, offset: ob.offsetTo })
    }
  }
  out.sort((a, b) => a.at - b.at)
  byYear.set(year, out)
  return out
}

/** A feed zone's offset at an instant: the observance begun most recently, this year or last. */
function feedOffset(zone: FeedZone, utcMs: number): number {
  const year = new Date(utcMs).getUTCFullYear()
  let best: { at: number; offset: number } | null = null
  for (const y of [year - 1, year]) {
    for (const t of transitionsIn(zone, y)) if (t.at <= utcMs && (!best || t.at >= best.at)) best = t
  }
  if (best) return best.offset
  // before any of them began: what the earliest one began from
  const earliest = [...zone.observances].sort((a, b) => utcOf(a.start) - utcOf(b.start))[0]
  return earliest ? earliest.offsetFrom : 0
}

const offsetIn = (utcMs: number, zone: Zone) => ('iana' in zone ? ianaOffset(utcMs, zone.iana) : feedOffset(zone.feed, utcMs))

/** Wall-clock time in a zone → UTC ms. The second pass settles a time next to a DST change. */
function zonedToUtc(w: Wall, zone: Zone): number {
  const guess = utcOf(w)
  const off1 = offsetIn(guess, zone)
  const utc = guess - off1
  const off2 = offsetIn(utc, zone)
  return off1 === off2 ? utc : guess - off2
}

/** The wall clock of a UTC instant in a zone. */
function wallIn(utcMs: number, zone: Zone): Wall {
  return wallOfUtc(utcMs + offsetIn(utcMs, zone))
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Unfold continuation lines and split into [name, params, value] triples. */
function lines(text: string): [string, Record<string, string>, string][] {
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '')
  const out: [string, Record<string, string>, string][] = []
  for (const raw of unfolded.split('\n')) {
    if (!raw) continue
    const colon = findValueColon(raw)
    if (colon === -1) continue
    const head = raw.slice(0, colon)
    const value = raw.slice(colon + 1)
    const [name, ...paramParts] = head.split(';')
    const params: Record<string, string> = {}
    for (const p of paramParts) {
      const eq = p.indexOf('=')
      if (eq !== -1) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '')
    }
    out.push([name.toUpperCase(), params, value.trim()])
  }
  return out
}

/** The first colon outside a quoted parameter value. */
function findValueColon(line: string): number {
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') quoted = !quoted
    else if (ch === ':' && !quoted) return i
  }
  return -1
}

function unescape(v: string): string {
  return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\')
}

/** A DATE or DATE-TIME as written: its wall parts, whether it is a date, and whether it is UTC. */
function readStamp(value: string, params: Record<string, string> = {}): { wall: Wall; date: boolean; utc: boolean } | null {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/)
  if (!m) return null
  const [, y, mo, d, h, mi, s, z] = m
  const date = params.VALUE === 'DATE' || h === undefined
  return { wall: { y: +y, mo: +mo, d: +d, h: date ? 0 : +h, mi: date ? 0 : +mi, s: date ? 0 : +(s ?? 0) }, date, utc: !!z }
}

/** How a parse reads a time without Z: the zone it names (resolved), else the zone floating times take. */
interface TimeContext {
  zones: Record<string, FeedZone>
  /** The zone a floating time is read in: the calendar's X-WR-TIMEZONE, else the reader's, else UTC. */
  floating?: string
}

/** The zone key a TZID resolves to: an IANA name, a VTIMEZONE of the feed's own, else the floating zone. */
function zoneKey(tzid: string | undefined, ctx: TimeContext): string | undefined {
  if (!tzid) return ctx.floating
  const iana = ianaZoneOf(tzid)
  if (iana) return iana
  if (ctx.zones[tzid]) return tzid
  return ctx.floating
}

function toParsedDate(stamp: { wall: Wall; date: boolean; utc: boolean }, tz: string | undefined, zones: Record<string, FeedZone>): ParsedDate {
  const { wall } = stamp
  if (stamp.date) return { allDay: true, ms: Date.UTC(wall.y, wall.mo - 1, wall.d) }
  if (stamp.utc) return { allDay: false, ms: utcOf(wall) }
  const zone = zoneFor(tz, zones)
  if (!zone) return { allDay: false, ms: utcOf(wall) }
  return { allDay: false, ms: zonedToUtc(wall, zone), tz, wall }
}

/**
 * Parse a DATE or DATE-TIME value into { allDay, ms, tz?, wall? } where ms is
 * UTC for timed values, and the UTC midnight of the calendar date for all-day
 * values (all-day dates are handled as dates, never shifted by zones).
 * `defaultTz` is the zone a value with neither Z nor TZID is read in; a TZID
 * is read as ianaZoneOf reads it, and one it cannot place falls back to
 * `defaultTz` too. With no zone at all, the time is read as UTC.
 */
export function parseDateValue(value: string, params: Record<string, string> = {}, defaultTz?: string): ParsedDate | null {
  const stamp = readStamp(value, params)
  if (!stamp) return null
  const floating = defaultTz ? (ianaZoneOf(defaultTz) ?? undefined) : undefined
  return toParsedDate(stamp, zoneKey(params.TZID, { zones: {}, floating }), {})
}

function parseDuration(v: string): number {
  const m = v.match(/^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
  if (!m) return 0
  const [, neg, w, d, h, mi, s] = m
  const ms = ((+w || 0) * 7 + (+d || 0)) * DAY + (+h || 0) * 3_600_000 + (+mi || 0) * 60_000 + (+s || 0) * 1000
  return neg ? -ms : ms
}

/** "+hhmm", "-hhmm" or "-hhmmss" (TZOFFSETFROM / TZOFFSETTO) in ms; NaN otherwise. */
function parseOffset(v: string): number {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(v.trim())
  if (!m) return NaN
  const ms = (+m[2] * 3600 + +m[3] * 60 + +(m[4] ?? 0)) * 1000
  return m[1] === '-' ? -ms : ms
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

/** A list of whole numbers from an RRULE part, within ±`max` and not zero, each once, and never more than `cap`. */
function numbers(v: string | undefined, max: number, cap: number): number[] | undefined {
  if (!v) return undefined
  const out = [
    ...new Set(
      v
        .split(',')
        .map(x => Number(x.trim()))
        .filter(n => Number.isInteger(n) && n !== 0 && Math.abs(n) <= max),
    ),
  ].slice(0, cap)
  return out.length ? out : undefined
}

function parseRRule(v: string): RRule {
  const rule: Partial<Record<string, string>> = {}
  for (const part of v.split(';')) {
    const [k, val] = part.split('=')
    if (!k || val === undefined) continue
    rule[k.trim().toUpperCase()] = val.trim()
  }
  const until = rule.UNTIL ? readStamp(rule.UNTIL) : null
  // "2TU", "-1FR", "MO": each distinct entry once — there are only so many
  // weekdays and ordinals, and a feed repeating one 200,000 times is an attack
  const byDay = rule.BYDAY
    ? [...new Set(rule.BYDAY.toUpperCase().split(','))]
        .map(x => /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x.trim()))
        .filter((m): m is RegExpExecArray => !!m)
        .map(m => ({ wd: WEEKDAYS.indexOf(m[2]), ...(m[1] && Number(m[1]) !== 0 ? { n: Math.max(-53, Math.min(53, Number(m[1]))) } : {}) }))
        .slice(0, 60)
    : undefined
  const wkst = WEEKDAYS.indexOf(String(rule.WKST ?? 'MO').toUpperCase())
  return {
    freq: rule.FREQ?.toUpperCase(),
    interval: Math.max(1, parseInt(rule.INTERVAL ?? '1', 10) || 1),
    count: rule.COUNT ? parseInt(rule.COUNT, 10) : undefined,
    ...(until?.utc ? { until: utcOf(until.wall) } : until ? { untilWall: until.date ? { ...until.wall, h: 23, mi: 59, s: 59 } : until.wall } : {}),
    byDay: byDay?.length ? byDay : undefined,
    byMonthDay: numbers(rule.BYMONTHDAY, 31, 62),
    byMonth: numbers(rule.BYMONTH, 12, 12)?.filter(n => n > 0),
    byYearDay: numbers(rule.BYYEARDAY, 366, 60),
    bySetPos: numbers(rule.BYSETPOS, 366, 60),
    wkst: wkst === -1 ? 1 : wkst,
  }
}

/** A VEVENT while it is read: anything may still be missing, and its dates are read once the whole event is in. */
interface EventDraft {
  uid?: string
  summary?: string
  location?: string
  description?: string
  duration?: number
  rrule?: RRule
  status?: string
  transparent?: boolean
  dtstart?: [string, Record<string, string>]
  dtend?: [string, Record<string, string>]
  recurrenceId?: [string, Record<string, string>]
  exdates: [string, Record<string, string>][]
}

/** A VTIMEZONE while it is read. */
interface ZoneDraft {
  tzid?: string
  observances: Observance[]
  cur: (Partial<Observance> & { rdates: Wall[] }) | null
}

/**
 * Parse an ICS document into raw VEVENT records (recurrence not yet expanded).
 * `opts.tz` is the reader's own zone: a floating time — one with neither Z
 * nor TZID — in a calendar with no X-WR-TIMEZONE is read on their wall clock.
 */
export function parseICS(text: string, opts: { tz?: string | null } = {}): ParsedCalendar {
  const all = lines(text)
  let calendarName: string | undefined
  let defaultTz: string | undefined
  const zones: Record<string, FeedZone> = {}

  // First the calendar's own name and zones, wherever in the file they are:
  // a VTIMEZONE may follow the events that use it.
  let zone: ZoneDraft | null = null
  for (const [name, params, value] of all) {
    if (name === 'X-WR-CALNAME' && !calendarName) calendarName = unescape(value)
    if (name === 'X-WR-TIMEZONE' && !defaultTz) defaultTz = value
    if (name === 'BEGIN' && value.toUpperCase() === 'VTIMEZONE') {
      zone = { observances: [], cur: null }
      continue
    }
    if (!zone) continue
    const kind = value.toUpperCase()
    if (name === 'BEGIN' && (kind === 'STANDARD' || kind === 'DAYLIGHT')) zone.cur = { rdates: [] }
    else if (name === 'END' && (kind === 'STANDARD' || kind === 'DAYLIGHT')) {
      const ob = zone.cur
      if (ob?.start && Number.isFinite(ob.offsetFrom) && Number.isFinite(ob.offsetTo)) zone.observances.push(ob as Observance)
      zone.cur = null
    } else if (name === 'END' && kind === 'VTIMEZONE') {
      if (zone.tzid && zone.observances.length && Object.keys(zones).length < 50) zones[zone.tzid] = { observances: zone.observances.slice(0, 20) }
      zone = null
    } else if (name === 'TZID' && !zone.cur) zone.tzid = value
    else if (zone.cur) {
      if (name === 'DTSTART') zone.cur.start = readStamp(value)?.wall
      else if (name === 'TZOFFSETFROM') zone.cur.offsetFrom = parseOffset(value)
      else if (name === 'TZOFFSETTO') zone.cur.offsetTo = parseOffset(value)
      else if (name === 'RRULE') zone.cur.rule = parseRRule(value)
      else if (name === 'RDATE') for (const v of value.split(',').slice(0, 50)) {
        const r = readStamp(v, params)
        if (r) zone.cur.rdates.push(r.wall)
      }
    }
  }
  const floating = ianaZoneOf(defaultTz) ?? ianaZoneOf(opts.tz) ?? undefined
  const ctx: TimeContext = { zones, floating }
  const date = ([value, params]: [string, Record<string, string>], fallbackTz?: string): ParsedDate | null => {
    const stamp = readStamp(value, params)
    if (!stamp) return null
    // a time with no TZID on an event whose start has one is in the start's zone
    const tz = params.TZID ? zoneKey(params.TZID, ctx) : (fallbackTz ?? ctx.floating)
    return toParsedDate(stamp, tz, zones)
  }

  const events: ParsedEvent[] = []
  let cur: EventDraft | null = null
  let depth = 0 // nested VALARM etc.
  for (const [name, params, value] of all) {
    if (name === 'BEGIN') {
      if (value.toUpperCase() === 'VEVENT') cur = { exdates: [] }
      else if (cur) depth++
      continue
    }
    if (name === 'END') {
      if (value.toUpperCase() === 'VEVENT' && cur) {
        const start = cur.dtstart ? date(cur.dtstart) : null
        if (cur.uid && start) {
          const exdates: number[] = []
          const exdateDays: string[] = []
          for (const ex of cur.exdates) {
            const d = date(ex, start.tz)
            if (!d) continue
            // a bare date on a timed event: every occurrence that day
            if (d.allDay && !start.allDay) exdateDays.push(new Date(d.ms).toISOString().slice(0, 10))
            else exdates.push(d.ms)
          }
          events.push({
            uid: cur.uid,
            summary: cur.summary,
            location: cur.location,
            description: cur.description,
            start,
            ...(cur.dtend ? { end: date(cur.dtend, start.tz) } : {}),
            ...(cur.duration !== undefined ? { duration: cur.duration } : {}),
            ...(cur.rrule ? { rrule: cur.rrule } : {}),
            exdates,
            ...(exdateDays.length ? { exdateDays } : {}),
            ...(cur.recurrenceId ? { recurrenceId: date(cur.recurrenceId, start.tz)?.ms } : {}),
            ...(cur.status ? { status: cur.status } : {}),
            ...(cur.transparent !== undefined ? { transparent: cur.transparent } : {}),
          })
        }
        cur = null
      } else if (cur && depth > 0) depth--
      continue
    }
    if (!cur || depth > 0) continue
    switch (name) {
      case 'UID':
        cur.uid = value
        break
      case 'SUMMARY':
        cur.summary = unescape(value)
        break
      case 'LOCATION':
        cur.location = unescape(value)
        break
      case 'DESCRIPTION':
        cur.description = unescape(value)
        break
      case 'DTSTART':
        cur.dtstart = [value, params]
        break
      case 'DTEND':
        cur.dtend = [value, params]
        break
      case 'DURATION':
        cur.duration = parseDuration(value)
        break
      case 'RRULE':
        cur.rrule = parseRRule(value)
        break
      case 'EXDATE':
        for (const v of value.split(',')) if (cur.exdates.length < 5000) cur.exdates.push([v.trim(), params])
        break
      case 'RECURRENCE-ID':
        cur.recurrenceId = [value, params]
        break
      case 'STATUS':
        cur.status = value.toUpperCase()
        break
      case 'TRANSP':
        cur.transparent = value.toUpperCase() === 'TRANSPARENT'
        break
    }
  }
  return { calendarName, defaultTz, events, ...(Object.keys(zones).length ? { zones } : {}) }
}

// ---------------------------------------------------------------------------
// Recurrence expansion
// ---------------------------------------------------------------------------

/** A calendar date as a day number (days since 1970-01-01), for stepping and sorting. */
const dayNo = (y: number, mo: number, d: number) => Math.round(Date.UTC(y, mo - 1, d) / DAY)

function fromDayNo(n: number): { y: number; mo: number; d: number } {
  const t = new Date(n * DAY)
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() }
}

const daysInMonth = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate()
const weekdayOf = (n: number) => (((n + 4) % 7) + 7) % 7 // day 0 was a Thursday

/** The days of a month a BYMONTHDAY list names: 1 is the first, -1 the last; a day the month does not have is skipped. */
function monthDays(list: number[], y: number, mo: number): number[] {
  const last = daysInMonth(y, mo)
  return list.map(v => (v > 0 ? v : last + v + 1)).filter(d => d >= 1 && d <= last)
}

/**
 * The day numbers BYDAY names between `first` and `last` (a month, or a year):
 * every such weekday, or with an ordinal just that one — 2TU the second
 * Tuesday, -1FR the last Friday.
 */
function weekdaysIn(byDay: ByDay[], first: number, last: number): number[] {
  const out: number[] = []
  for (const b of byDay) {
    const firstOne = first + ((b.wd - weekdayOf(first) + 7) % 7)
    if (b.n === undefined) {
      for (let n = firstOne; n <= last; n += 7) out.push(n)
      continue
    }
    const lastOne = last - ((weekdayOf(last) - b.wd + 7) % 7)
    const n = b.n > 0 ? firstOne + (b.n - 1) * 7 : lastOne + (b.n + 1) * 7
    if (n >= first && n <= last) out.push(n)
  }
  return out
}

const hasWeekday = (byDay: ByDay[], n: number) => byDay.some(b => b.wd === weekdayOf(n))

/**
 * The dates one period of a rule holds, oldest first, before BYSETPOS: a day
 * for DAILY, a week for WEEKLY (starting on WKST), a month, a year. Each
 * BYxxx part expands the period or limits it as RFC 5545's table says. A plain
 * monthly or yearly rule keeps the start's day, and a month without that day
 * takes its last (the 31st on the 30th, 29 February on the 28th), as this
 * parser always has; a day named in BYMONTHDAY that a month lacks is skipped.
 */
function periodDates(r: RRule, freq: string, period: number, start: { y: number; mo: number; d: number; n: number }): number[] {
  let out: number[]
  if (freq === 'DAILY') {
    const n = period
    const { mo, d, y } = fromDayNo(n)
    const ok =
      (!r.byMonth || r.byMonth.includes(mo)) && (!r.byMonthDay || monthDays(r.byMonthDay, y, mo).includes(d)) && (!r.byDay || hasWeekday(r.byDay, n))
    out = ok ? [n] : []
  } else if (freq === 'WEEKLY') {
    const wds = r.byDay ? [...new Set(r.byDay.map(b => b.wd))] : [weekdayOf(start.n)]
    out = wds.map(wd => period + ((wd - r.wkst + 7) % 7)).filter(n => !r.byMonth || r.byMonth.includes(fromDayNo(n).mo))
  } else if (freq === 'MONTHLY') {
    const y = Math.floor(period / 12)
    const mo = (period % 12) + 1
    if (r.byMonth && !r.byMonth.includes(mo)) return []
    const first = dayNo(y, mo, 1)
    if (r.byMonthDay) {
      out = monthDays(r.byMonthDay, y, mo).map(d => first + d - 1)
      if (r.byDay) out = out.filter(n => hasWeekday(r.byDay!, n))
    } else if (r.byDay) out = weekdaysIn(r.byDay, first, first + daysInMonth(y, mo) - 1)
    else out = [first + Math.min(start.d, daysInMonth(y, mo)) - 1]
  } else {
    const y = period
    const first = dayNo(y, 1, 1)
    const last = dayNo(y, 12, 31)
    const months = r.byMonth ?? null
    if (r.byYearDay) {
      out = r.byYearDay.map(v => (v > 0 ? first + v - 1 : last + v + 1)).filter(n => n >= first && n <= last)
      out = out.filter(n => (!months || months.includes(fromDayNo(n).mo)) && (!r.byDay || hasWeekday(r.byDay, n)))
    } else if (r.byMonthDay) {
      out = (months ?? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).flatMap(mo => monthDays(r.byMonthDay!, y, mo).map(d => dayNo(y, mo, d)))
      if (r.byDay) out = out.filter(n => hasWeekday(r.byDay!, n))
    } else if (r.byDay) {
      // with BYMONTH, "2SU" is the second Sunday of each month named; without, of the year
      out = months ? months.flatMap(mo => weekdaysIn(r.byDay!, dayNo(y, mo, 1), dayNo(y, mo, daysInMonth(y, mo)))) : weekdaysIn(r.byDay, first, last)
    } else {
      out = (months ?? [start.mo]).map(mo => dayNo(y, mo, Math.min(start.d, daysInMonth(y, mo))))
    }
  }
  out = [...new Set(out)].sort((a, b) => a - b)
  if (r.bySetPos) {
    const picked = r.bySetPos.map(p => (p > 0 ? out[p - 1] : out[out.length + p])).filter((n): n is number => n !== undefined)
    out = [...new Set(picked)].sort((a, b) => a - b)
  }
  return out
}

/** The period a date falls in, as periodDates counts them. */
function periodOf(freq: string, n: number, wkst: number): number {
  if (freq === 'DAILY') return n
  if (freq === 'WEEKLY') return n - ((weekdayOf(n) - wkst + 7) % 7)
  const { y, mo } = fromDayNo(n)
  return freq === 'MONTHLY' ? y * 12 + mo - 1 : y
}

/** The next period `k` intervals on. */
function stepPeriod(freq: string, period: number, k: number): number {
  return freq === 'WEEKLY' ? period + 7 * k : period + k
}

/** How many intervals separate two periods (whole ones, rounding down). */
function intervalsBetween(freq: string, from: number, to: number, interval: number): number {
  const span = freq === 'WEEKLY' ? (to - from) / 7 : to - from
  return Math.floor(span / interval)
}

const FREQS = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])

/** The dates a rule gives in one year, at the start's time: how a VTIMEZONE's observances find their onsets. */
function ruleDates(r: RRule, start: Wall, year: number): Wall[] {
  const freq = r.freq ?? ''
  if (freq !== 'YEARLY' && freq !== 'MONTHLY') return start.y === year ? [start] : []
  const s = { y: start.y, mo: start.mo, d: start.d, n: dayNo(start.y, start.mo, start.d) }
  const periods = freq === 'YEARLY' ? [year] : Array.from({ length: 12 }, (_, i) => year * 12 + i)
  return periods.flatMap(p => periodDates(r, freq, p, s)).map(n => ({ ...fromDayNo(n), h: start.h, mi: start.mi, s: start.s }))
}

/** A cap on the dates one event's rule is walked through, whatever it says. */
const MAX_STEPS = 50_000

/** Starts (UTC ms) of every occurrence of an event between from and to. */
function occurrences(ev: ParsedEvent, fromMs: number, toMs: number, zones: Record<string, FeedZone> | undefined): number[] {
  const start = ev.start.ms
  const r = ev.rrule
  const freq = r?.freq ?? ''
  if (!r || !FREQS.has(freq)) return start < toMs ? [start] : []
  // the wall clock the rule steps on: the event's own zone, else UTC (an all-day date, or a time in Z)
  const zone = ev.start.allDay ? null : zoneFor(ev.start.tz, zones)
  const wall0 = ev.start.allDay ? wallOfUtc(start) : (ev.start.wall ?? (zone ? wallIn(start, zone) : wallOfUtc(start)))
  const instant = (n: number): number => {
    const { y, mo, d } = fromDayNo(n)
    if (ev.start.allDay) return Date.UTC(y, mo - 1, d)
    const w = { y, mo, d, h: wall0.h, mi: wall0.mi, s: wall0.s }
    return zone ? zonedToUtc(w, zone) : utcOf(w)
  }
  const untilMs = r.until ?? (r.untilWall ? (zone && !ev.start.allDay ? zonedToUtc(r.untilWall, zone) : utcOf(r.untilWall)) : undefined)
  const last = untilMs !== undefined ? Math.min(untilMs, toMs) : toMs
  const s = { y: wall0.y, mo: wall0.mo, d: wall0.d, n: dayNo(wall0.y, wall0.mo, wall0.d) }
  const first = periodOf(freq, s.n, r.wkst)
  let period = first
  // With no COUNT nothing before the window matters, so the walk starts a
  // period short of it: a daily rule from 2009 would otherwise spend every
  // step it has on the years in between.
  if (r.count === undefined) {
    const fromDay = Math.floor(fromMs / DAY) - 1
    const ahead = intervalsBetween(freq, first, periodOf(freq, fromDay, r.wkst), r.interval) - 1
    if (ahead > 0) period = stepPeriod(freq, first, ahead * r.interval)
  }
  const out: number[] = []
  let produced = 0
  let steps = 0
  const lastDay = Math.floor(last / DAY) + 2
  for (let i = 0; i < 5000 && steps < MAX_STEPS; i++, period = stepPeriod(freq, period, r.interval)) {
    // every date of this period and those after it is past the end
    if (period > (freq === 'MONTHLY' ? periodOf(freq, lastDay, r.wkst) : freq === 'YEARLY' ? fromDayNo(lastDay).y : lastDay)) break
    for (const n of periodDates(r, freq, period, s)) {
      steps++
      if (n < s.n) continue
      const ms = instant(n)
      if (ms < start) continue
      if (ms > last) return out
      if (r.count !== undefined && produced >= r.count) return out
      produced++
      if (ms >= fromMs && ms < toMs) out.push(ms)
    }
  }
  return out
}

/** Total instances one feed may produce. Beyond this the feed is malicious or broken. */
const MAX_INSTANCES = 20_000
/** Events one feed may contain. A personal calendar is far below this. */
const MAX_EVENTS = 10_000

/**
 * Expand parsed events into concrete instances inside [fromMs, toMs).
 * Instances: { id, uid, title, start (ISO), end (ISO), allDay, location }.
 * All-day instances use YYYY-MM-DD strings; end is exclusive per RFC 5545.
 */
export function expandEvents(parsed: ParsedCalendar, fromMs: number, toMs: number): EventInstance[] {
  const overrides = new Map<string, Set<number>>() // uid -> Set of recurrence-id ms replaced by a detached event
  for (const ev of parsed.events) {
    if (ev.recurrenceId !== undefined) {
      if (!overrides.has(ev.uid)) overrides.set(ev.uid, new Set())
      overrides.get(ev.uid)!.add(ev.recurrenceId)
    }
  }
  const out: EventInstance[] = []
  for (const ev of parsed.events.slice(0, MAX_EVENTS)) {
    if (out.length >= MAX_INSTANCES) break
    if (ev.status === 'CANCELLED') continue
    // EXDATE lookup as a set: a long EXDATE list must not make this quadratic
    const excluded = ev.exdates.length > 8 ? new Set(ev.exdates.map(x => Math.round(x / 1000))) : null
    const excludedDays = ev.exdateDays?.length ? new Set(ev.exdateDays) : null
    const dayOf = (ms: number) => {
      const zone = zoneFor(ev.start.tz, parsed.zones)
      return (zone ? wallIn(ms, zone) : wallOfUtc(ms)) as Wall
    }
    const allDay = ev.start.allDay
    const durationMs = ev.end ? Math.max(ev.end.ms - ev.start.ms, 0) : ev.duration ?? (allDay ? DAY : 0)
    const starts =
      ev.recurrenceId !== undefined ? (ev.start.ms < toMs && ev.start.ms + durationMs > fromMs ? [ev.start.ms] : []) : occurrences(ev, fromMs - durationMs, toMs, parsed.zones)
    const replaced = overrides.get(ev.uid)
    for (const s of starts) {
      if (out.length >= MAX_INSTANCES) break
      if (ev.recurrenceId === undefined && replaced?.has(s)) continue
      if (excluded ? excluded.has(Math.round(s / 1000)) : ev.exdates.some(x => Math.abs(x - s) < 1000)) continue
      if (excludedDays) {
        const w = dayOf(s)
        if (excludedDays.has(`${w.y}-${String(w.mo).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`)) continue
      }
      const e = s + durationMs
      if (e <= fromMs && !(allDay && s >= fromMs)) continue
      out.push({
        id: `${ev.uid}@${s}`,
        uid: ev.uid,
        title: ev.summary || '(untitled)',
        start: allDay ? new Date(s).toISOString().slice(0, 10) : new Date(s).toISOString(),
        end: allDay ? new Date(e).toISOString().slice(0, 10) : new Date(e).toISOString(),
        allDay,
        location: ev.location || undefined,
      })
    }
  }
  out.sort((a, b) => a.start.localeCompare(b.start))
  return out
}

// ---------------------------------------------------------------------------
// Emitting
// ---------------------------------------------------------------------------

function esc(v: unknown): string {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')
}

function fold(line: string): string {
  const out: string[] = []
  let rest = line
  while (rest.length > 73) {
    out.push(rest.slice(0, 73))
    rest = ' ' + rest.slice(73)
  }
  out.push(rest)
  return out.join('\r\n')
}

const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')

/**
 * UTC calendar day for an instant. Only correct for an all-day event when the
 * caller's zone is UTC, so it is the FALLBACK — pass `date` instead. An
 * untimed task is stored at local midnight, which in Europe/London summer is
 * 23:00Z the day before, and this would then publish it a day early.
 */
const dateOnly = (ms: number): string => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '')

/** 'YYYY-MM-DD' (or 'YYYYMMDD') -> 'YYYYMMDD'. */
const compactDay = (key: string): string => String(key).replace(/-/g, '')

/**
 * The next calendar day of a date-only key. ICS DTEND for an all-day event is
 * exclusive, so a one-day event ends on the following date. Stepped in UTC on
 * purpose: a date-only key carries no time, so no DST rule can apply to it.
 */
const nextDay = (key: string): string => {
  const m = String(key).match(/^(\d{4})-?(\d{2})-?(\d{2})$/)
  if (!m) return key
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

/**
 * Build an ICS document. items: { uid, title, start (ms), end (ms, optional),
 * allDay, description, url, categories }.
 */
export function buildICS(name: string, items: readonly FeedItem[]): string {
  const now = stamp(Date.now())
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Drafter//Planner//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`,
    'X-PUBLISHED-TTL:PT1H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
  ]
  for (const it of items) {
    lines.push('BEGIN:VEVENT')
    lines.push(`UID:${esc(it.uid)}`)
    lines.push(`DTSTAMP:${now}`)
    if (it.allDay) {
      // `date`/`endDate` are the reader's own calendar days ('YYYY-MM-DD').
      // Prefer them: deriving the day from the instant publishes it a day early
      // anywhere east of UTC (see dateOnly).
      const from = it.date ? compactDay(it.date) : dateOnly(it.start)
      const to = it.endDate ? compactDay(it.endDate) : it.date ? it.date : dateOnly(it.end ?? it.start)
      lines.push(`DTSTART;VALUE=DATE:${from}`)
      lines.push(`DTEND;VALUE=DATE:${nextDay(to)}`)
    } else {
      lines.push(`DTSTART:${stamp(it.start)}`)
      lines.push(`DTEND:${stamp(it.end ?? it.start + 3_600_000)}`)
    }
    // Busy is the ICS default; only an item that is explicitly available time
    // says so, which is what makes a calendar leave that slot bookable
    if (it.transparent) lines.push('TRANSP:TRANSPARENT')
    lines.push(`SUMMARY:${esc(it.title)}`)
    if (it.description) lines.push(`DESCRIPTION:${esc(it.description)}`)
    if (it.url) lines.push(`URL:${esc(it.url)}`)
    if (it.categories?.length) lines.push(`CATEGORIES:${it.categories.map(esc).join(',')}`)
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(fold).join('\r\n') + '\r\n'
}
