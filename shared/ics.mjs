// Minimal iCalendar (RFC 5545) support shared by the Netlify functions and the
// tests: parse VEVENTs, expand the recurrence rules personal calendars actually
// use (birthdays, weekly classes, monthly bills), and emit a feed of tasks.
// Dependency-free on purpose.

const DAY = 86_400_000

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Unfold continuation lines and split into [name, params, value] triples. */
function lines(text) {
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '')
  const out = []
  for (const raw of unfolded.split('\n')) {
    if (!raw) continue
    const colon = findValueColon(raw)
    if (colon === -1) continue
    const head = raw.slice(0, colon)
    const value = raw.slice(colon + 1)
    const [name, ...paramParts] = head.split(';')
    const params = {}
    for (const p of paramParts) {
      const eq = p.indexOf('=')
      if (eq !== -1) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '')
    }
    out.push([name.toUpperCase(), params, value])
  }
  return out
}

/** The first colon outside a quoted parameter value. */
function findValueColon(line) {
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') quoted = !quoted
    else if (ch === ':' && !quoted) return i
  }
  return -1
}

function unescape(v) {
  return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\')
}

/** Offset (ms) of an IANA zone at a UTC instant, via Intl. */
function tzOffsetMs(utcMs, tz) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map(x => [x.type, x.value]))
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
    return asUtc - utcMs
  } catch {
    return 0
  }
}

/** Wall-clock time in a zone → UTC ms. */
function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s)
  const off1 = tzOffsetMs(guess, tz)
  const utc = guess - off1
  const off2 = tzOffsetMs(utc, tz)
  return off1 === off2 ? utc : guess - off2
}

/**
 * Parse a DATE or DATE-TIME value into { allDay, ms, tz?, wall? } where ms is
 * UTC for timed values, and the UTC midnight of the calendar date for all-day
 * values (all-day dates are handled as dates, never shifted by zones).
 * When TZID is present, wall holds Y-M-D h:m:s in that zone so recurrence can
 * step on wall-clock days across DST.
 */
export function parseDateValue(value, params = {}, defaultTz) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/)
  if (!m) return null
  const [, y, mo, d, h, mi, s, z] = m
  if (params.VALUE === 'DATE' || h === undefined) {
    return { allDay: true, ms: Date.UTC(+y, +mo - 1, +d) }
  }
  if (z) return { allDay: false, ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s ?? 0)) }
  const tz = params.TZID ?? defaultTz
  if (tz) {
    const wall = { y: +y, mo: +mo, d: +d, h: +h, mi: +mi, s: +(s ?? 0) }
    return { allDay: false, ms: zonedToUtc(wall.y, wall.mo, wall.d, wall.h, wall.mi, wall.s, tz), tz, wall }
  }
  // floating time: treat as UTC (rare in exported personal calendars)
  return { allDay: false, ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s ?? 0)) }
}

function parseDuration(v) {
  const m = v.match(/^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
  if (!m) return 0
  const [, neg, w, d, h, mi, s] = m
  const ms = ((+w || 0) * 7 + (+d || 0)) * DAY + (+h || 0) * 3_600_000 + (+mi || 0) * 60_000 + (+s || 0) * 1000
  return neg ? -ms : ms
}

function parseRRule(v) {
  const rule = {}
  for (const part of v.split(';')) {
    const [k, val] = part.split('=')
    if (!k || val === undefined) continue
    rule[k.toUpperCase()] = val
  }
  return {
    freq: rule.FREQ,
    interval: Math.max(1, parseInt(rule.INTERVAL ?? '1', 10) || 1),
    count: rule.COUNT ? parseInt(rule.COUNT, 10) : undefined,
    until: rule.UNTIL ? parseDateValue(rule.UNTIL)?.ms : undefined,
    // there are only 7 weekdays; a feed repeating one 200,000 times is an
    // attack, and de-duplicating is lossless
    byDay: rule.BYDAY ? [...new Set(rule.BYDAY.split(','))].slice(0, 7) : undefined,
    byMonthDay: rule.BYMONTHDAY ? rule.BYMONTHDAY.split(',').map(Number) : undefined,
    byMonth: rule.BYMONTH ? rule.BYMONTH.split(',').map(Number) : undefined,
  }
}

/** Parse an ICS document into raw VEVENT records (recurrence not yet expanded). */
export function parseICS(text) {
  const events = []
  let calendarName
  let defaultTz
  /** @type {Partial<import('./ics.mjs').ParsedEvent> | null} */
  let cur = null
  let depth = 0 // nested VALARM etc.
  for (const [name, params, value] of lines(text)) {
    if (name === 'X-WR-CALNAME' && !calendarName) calendarName = unescape(value)
    if (name === 'X-WR-TIMEZONE' && !defaultTz) defaultTz = value
    if (name === 'BEGIN') {
      if (value === 'VEVENT') cur = { exdates: [] }
      else if (cur) depth++
      continue
    }
    if (name === 'END') {
      if (value === 'VEVENT' && cur) {
        if (cur.uid && cur.start) events.push(cur)
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
        cur.start = parseDateValue(value, params, defaultTz)
        break
      case 'DTEND':
        cur.end = parseDateValue(value, params, defaultTz)
        break
      case 'DURATION':
        cur.duration = parseDuration(value)
        break
      case 'RRULE':
        cur.rrule = parseRRule(value)
        break
      case 'EXDATE':
        for (const v of value.split(',')) {
          const d = parseDateValue(v, params, defaultTz)
          if (d) cur.exdates.push(d.ms)
        }
        break
      case 'RECURRENCE-ID':
        cur.recurrenceId = parseDateValue(value, params, defaultTz)?.ms
        break
      case 'STATUS':
        cur.status = value.toUpperCase()
        break
      case 'TRANSP':
        cur.transparent = value.toUpperCase() === 'TRANSPARENT'
        break
    }
  }
  return { calendarName, defaultTz, events }
}

// ---------------------------------------------------------------------------
// Recurrence expansion
// ---------------------------------------------------------------------------

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

function addMonthsUTC(ms, n, dayOfMonth) {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + n
  const target = new Date(Date.UTC(y, m, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()))
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(dayOfMonth, last))
  return target.getTime()
}

/** Add calendar months to a wall-clock Y-M-D, clamping the day. */
function addMonthsWall(wall, n) {
  const m0 = wall.mo - 1 + n
  const y = wall.y + Math.floor(m0 / 12)
  const mo = ((m0 % 12) + 12) % 12
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()
  return { ...wall, y, mo: mo + 1, d: Math.min(wall.d, last) }
}

/** Wall parts of a UTC instant in an IANA zone (for recovering TZID starts without wall). */
function wallInZone(utcMs, tz) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
    const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map(x => [x.type, x.value]))
    const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday] ?? 0
    return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, wd }
  } catch {
    const d = new Date(utcMs)
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), wd: d.getUTCDay() }
  }
}

/** Day-of-week for a wall Y-M-D (UTC date maths — calendar date, not zone). */
function wallDow(wall) {
  return new Date(Date.UTC(wall.y, wall.mo - 1, wall.d)).getUTCDay()
}

/** Add days to a wall Y-M-D. */
function addDaysWall(wall, days) {
  const t = Date.UTC(wall.y, wall.mo - 1, wall.d) + days * DAY
  const d = new Date(t)
  return { ...wall, y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() }
}

/** Starts (UTC ms) of every occurrence of an event between from and to. */
function occurrences(ev, fromMs, toMs) {
  const start = ev.start.ms
  if (!ev.rrule || !ev.rrule.freq) return start < toMs ? [start] : []
  const r = ev.rrule
  const until = r.until !== undefined ? Math.min(r.until, toMs) : toMs
  const out = []
  let produced = 0
  const push = ms => {
    if (r.count !== undefined && produced >= r.count) return false
    produced++
    if (ms >= fromMs && ms < toMs) out.push(ms)
    return true
  }
  const MAX = 5000
  const tz = !ev.start.allDay ? ev.start.tz : undefined
  const wall0 = tz ? ev.start.wall ?? wallInZone(start, tz) : null

  // Zoned timed events: step on wall-clock dates, convert each with zonedToUtc
  // so a Europe/London 18:00 weekly stays 18:00 after the autumn DST change.
  if (tz && wall0) {
    const toUtc = w => zonedToUtc(w.y, w.mo, w.d, w.h, w.mi, w.s, tz)
    if (r.freq === 'DAILY') {
      for (let i = 0; i < MAX; i++) {
        const w = addDaysWall(wall0, i * r.interval)
        const ms = toUtc(w)
        if (ms > until) break
        if (ms < start) continue
        if (!push(ms)) break
      }
    } else if (r.freq === 'WEEKLY') {
      const days = (r.byDay ? r.byDay.map(d => WEEKDAYS.indexOf(d.slice(-2))).filter(i => i >= 0) : [wallDow(wall0)]).sort((a, b) => a - b)
      const startDow = wallDow(wall0)
      const week0 = addDaysWall(wall0, -startDow) // Sunday of first week
      outer: for (let w = 0; w < MAX; w++) {
        const base = addDaysWall(week0, w * r.interval * 7)
        for (const dow of days) {
          const day = addDaysWall(base, dow)
          const ms = toUtc({ ...wall0, y: day.y, mo: day.mo, d: day.d })
          if (ms < start) continue
          if (ms > until) break outer
          if (!push(ms)) break outer
        }
      }
    } else if (r.freq === 'MONTHLY') {
      const dom = r.byMonthDay?.[0] ?? wall0.d
      for (let i = 0; i < MAX; i++) {
        const w = addMonthsWall({ ...wall0, d: dom }, i * r.interval)
        const ms = toUtc(w)
        if (ms > until) break
        if (ms < start) continue
        if (!push(ms)) break
      }
    } else if (r.freq === 'YEARLY') {
      for (let i = 0; i < MAX; i++) {
        const y = wall0.y + i * r.interval
        const month = r.byMonth?.[0] ? r.byMonth[0] : wall0.mo
        const last = new Date(Date.UTC(y, month, 0)).getUTCDate()
        const w = { ...wall0, y, mo: month, d: Math.min(wall0.d, last) }
        const ms = toUtc(w)
        if (ms > until) break
        if (!push(ms)) break
      }
    } else {
      return start < toMs ? [start] : []
    }
    return out
  }

  if (r.freq === 'DAILY') {
    for (let i = 0, ms = start; i < MAX && ms <= until; i++, ms = start + i * r.interval * DAY) if (!push(ms)) break
  } else if (r.freq === 'WEEKLY') {
    const days = (r.byDay ? r.byDay.map(d => WEEKDAYS.indexOf(d.slice(-2))).filter(i => i >= 0) : [new Date(start).getUTCDay()]).sort((a, b) => a - b)
    const startDow = new Date(start).getUTCDay()
    const weekStart = start - startDow * DAY // Sunday of the first week
    outer: for (let w = 0; w < MAX; w++) {
      const base = weekStart + w * r.interval * 7 * DAY
      if (base > until) break
      for (const dow of days) {
        const ms = base + dow * DAY
        if (ms < start) continue
        if (ms > until) break outer
        if (!push(ms)) break outer
      }
    }
  } else if (r.freq === 'MONTHLY') {
    const dom = r.byMonthDay?.[0] ?? new Date(start).getUTCDate()
    for (let i = 0; i < MAX; i++) {
      const ms = addMonthsUTC(start, i * r.interval, dom)
      if (ms > until) break
      if (ms < start) continue
      if (!push(ms)) break
    }
  } else if (r.freq === 'YEARLY') {
    const d = new Date(start)
    for (let i = 0; i < MAX; i++) {
      const y = d.getUTCFullYear() + i * r.interval
      const month = r.byMonth?.[0] ? r.byMonth[0] - 1 : d.getUTCMonth()
      const last = new Date(Date.UTC(y, month + 1, 0)).getUTCDate()
      const ms = Date.UTC(y, month, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds())
      if (ms > until) break
      if (!push(ms)) break
    }
  } else {
    return start < toMs ? [start] : []
  }
  return out
}

/**
 * Expand parsed events into concrete instances inside [fromMs, toMs).
 * Instances: { id, uid, title, start (ISO), end (ISO), allDay, location }.
 * All-day instances use YYYY-MM-DD strings; end is exclusive per RFC 5545.
 */
/** Total instances one feed may produce. Beyond this the feed is malicious or broken. */
const MAX_INSTANCES = 20_000
/** Events one feed may contain. A personal calendar is far below this. */
const MAX_EVENTS = 10_000

export function expandEvents(parsed, fromMs, toMs) {
  const overrides = new Map() // uid -> Set of recurrence-id ms replaced by a detached event
  for (const ev of parsed.events) {
    if (ev.recurrenceId !== undefined) {
      if (!overrides.has(ev.uid)) overrides.set(ev.uid, new Set())
      overrides.get(ev.uid).add(ev.recurrenceId)
    }
  }
  const out = []
  for (const ev of parsed.events.slice(0, MAX_EVENTS)) {
    if (out.length >= MAX_INSTANCES) break
    if (ev.status === 'CANCELLED') continue
    // EXDATE lookup as a set: a long EXDATE list must not make this quadratic
    const excluded = ev.exdates.length > 8 ? new Set(ev.exdates.map(x => Math.round(x / 1000))) : null
    const allDay = ev.start.allDay
    const durationMs = ev.end ? Math.max(ev.end.ms - ev.start.ms, 0) : ev.duration ?? (allDay ? DAY : 0)
    const starts = ev.recurrenceId !== undefined ? (ev.start.ms < toMs && ev.start.ms + durationMs > fromMs ? [ev.start.ms] : []) : occurrences(ev, fromMs - durationMs, toMs)
    const replaced = overrides.get(ev.uid)
    for (const s of starts) {
      if (out.length >= MAX_INSTANCES) break
      if (ev.recurrenceId === undefined && replaced?.has(s)) continue
      if (excluded ? excluded.has(Math.round(s / 1000)) : ev.exdates.some(x => Math.abs(x - s) < 1000)) continue
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

function esc(v) {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')
}

function fold(line) {
  const out = []
  let rest = line
  while (rest.length > 73) {
    out.push(rest.slice(0, 73))
    rest = ' ' + rest.slice(73)
  }
  out.push(rest)
  return out.join('\r\n')
}

const stamp = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')

/**
 * UTC calendar day for an instant. Only correct for an all-day event when the
 * caller's zone is UTC, so it is the FALLBACK — pass `date` instead. An
 * untimed task is stored at local midnight, which in Europe/London summer is
 * 23:00Z the day before, and this would then publish it a day early.
 */
const dateOnly = ms => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '')

/** 'YYYY-MM-DD' (or 'YYYYMMDD') -> 'YYYYMMDD'. */
const compactDay = key => String(key).replace(/-/g, '')

/**
 * The next calendar day of a date-only key. ICS DTEND for an all-day event is
 * exclusive, so a one-day event ends on the following date. Stepped in UTC on
 * purpose: a date-only key carries no time, so no DST rule can apply to it.
 */
const nextDay = key => {
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
export function buildICS(name, items) {
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
