// Journal rules shared by the web app, the MCP server and the digest.
// Dependency-free ESM. An entry is one day's writing; several entries for a day
// can exist (two devices offline) and are all kept — the newest edit is the one
// you type into.

export const DAY_MS = 86_400_000

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** YYYY-MM-DD in the runtime's local zone. */
export function localDayKey(d = new Date()) {
  const dt = d instanceof Date ? d : new Date(d)
  const p = x => String(x).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
}

/** Calendar-day arithmetic on a YYYY-MM-DD key (UTC maths, so no DST drift). */
export function shiftDayKey(key, days) {
  const m = String(key).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return key
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]) + days * DAY_MS
  return new Date(t).toISOString().slice(0, 10)
}

/** `journal~<day>~<random>`: the day is in the id for humans, the suffix keeps two writers from colliding. */
export function journalId(date, rand) {
  const suffix = rand ?? Math.random().toString(36).slice(2, 10)
  return `journal~${date}~${suffix}`
}

/** Live entries for a day, newest edit first. */
export function entriesOn(entries, date) {
  return (entries ?? [])
    .filter(e => e && e.kind === 'journal' && !e.deletedAt && e.date === date)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

/** The entry to type into for a day (the most recently edited), or null. */
export function entryOn(entries, date) {
  return entriesOn(entries, date)[0] ?? null
}

/** Entries whose day falls in [fromKey, toKey) — keys are YYYY-MM-DD. Newest day first. */
export function entriesBetween(entries, fromKey, toKey) {
  return (entries ?? [])
    .filter(e => e && e.kind === 'journal' && !e.deletedAt && DATE_RE.test(e.date) && e.date >= fromKey && e.date < toKey)
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

/** Unique, non-empty string ids in first-seen order; undefined when there are none (never an empty array on a record). */
export function idSet(...lists) {
  const out = []
  for (const list of lists) for (const id of Array.isArray(list) ? list : []) if (id && !out.includes(String(id))) out.push(String(id))
  return out.length ? out : undefined
}

export function newEntry(date, body, mood, nowIso = new Date().toISOString(), rand, peopleIds) {
  const entry = {
    kind: 'journal',
    id: journalId(date, rand),
    date,
    body: String(body ?? ''),
    createdAt: nowIso,
    updatedAt: nowIso,
  }
  if (mood != null) entry.mood = mood
  const people = idSet(peopleIds)
  if (people) entry.peopleIds = people
  return entry
}

/** A stamp strictly newer than the previous one (mirrors shared/domain.mjs newerStamp). */
function newer(prevIso) {
  const prev = prevIso ? Date.parse(prevIso) : 0
  return new Date(Math.max(Date.now(), (Number.isFinite(prev) ? prev : 0) + 1)).toISOString()
}

/**
 * Append a line to a day's entry: from a Shortcut, a share, an agent, or a
 * "log this" button. Creates the entry when the day has none. Never overwrites
 * what was already written.
 */
export function appendEntry(existing, date, text, opts = {}) {
  const line = String(text ?? '').trim()
  if (!existing) return newEntry(date, line, opts.mood, opts.now, opts.rand, opts.peopleIds)
  const body = existing.body && existing.body.trim() ? `${existing.body.replace(/\s+$/, '')}\n${line}` : line
  const next = { ...existing, body, updatedAt: newer(existing.updatedAt) }
  if (opts.mood != null) next.mood = opts.mood
  // people only ever join a day; nothing appended can take someone off it
  const people = idSet(existing.peopleIds, opts.peopleIds)
  if (people) next.peopleIds = people
  return next
}

/**
 * Live entries that name a person, newest day first, then newest edit. A
 * mention is "this day was about them" — it is not a visit and never feeds
 * the people cadence.
 */
export function mentions(entries, personId) {
  const id = String(personId ?? '')
  if (!id) return []
  return (entries ?? [])
    .filter(e => e && e.kind === 'journal' && !e.deletedAt && Array.isArray(e.peopleIds) && e.peopleIds.includes(id))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

/** id -> name for live people, the shape journalLines takes. */
export function peopleNameMap(people) {
  const map = new Map()
  for (const p of people ?? []) if (p && p.kind === 'person' && !p.deletedAt && p.id) map.set(String(p.id), String(p.name ?? ''))
  return map
}

/** Names for an entry's peopleIds, in the entry's order; ids nobody matches are skipped. */
export function peopleNamesOf(entry, peopleById) {
  if (!peopleById || !Array.isArray(entry?.peopleIds)) return []
  const lookup = typeof peopleById.get === 'function' ? id => peopleById.get(id) : id => peopleById[id]
  return entry.peopleIds.map(id => lookup(String(id))).filter(n => typeof n === 'string' && n.trim())
}

/** Consecutive days with an entry, counting back from today (or yesterday if today is still blank). */
export function streak(entries, today = localDayKey()) {
  const days = new Set((entries ?? []).filter(e => e && e.kind === 'journal' && !e.deletedAt && DATE_RE.test(e.date)).map(e => e.date))
  let day = days.has(today) ? today : shiftDayKey(today, -1)
  let n = 0
  while (days.has(day)) {
    n++
    day = shiftDayKey(day, -1)
  }
  return n
}

/** Mean mood of the entries that carry one, to one decimal; undefined when none do. */
export function moodAverage(entries) {
  const moods = (entries ?? []).map(e => Number(e?.mood)).filter(m => Number.isFinite(m) && m >= 1 && m <= 5)
  if (moods.length === 0) return undefined
  return Math.round((moods.reduce((s, m) => s + m, 0) / moods.length) * 10) / 10
}

/**
 * Lines for a model prompt: "2026-09-08 (mood 4/5, with Mum, Dad): first 220 chars".
 * Newest last so the story reads forward. peopleById (a Map or a plain object,
 * id -> name) turns peopleIds into names; without it people are left out.
 */
export function journalLines(entries, max = 14, chars = 220, peopleById) {
  const clip = s => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim()
    return t.length > chars ? t.slice(0, chars - 1) + '…' : t
  }
  return [...(entries ?? [])]
    .filter(e => e && e.kind === 'journal' && !e.deletedAt && (String(e.body ?? '').trim() || e.mood))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-max)
    .map(e => {
      const notes = []
      if (e.mood) notes.push(`mood ${e.mood}/5`)
      const names = peopleNamesOf(e, peopleById)
      if (names.length) notes.push(`with ${names.join(', ')}`)
      return `${e.date}${notes.length ? ` (${notes.join(', ')})` : ''}: ${clip(e.body) || '(mood only)'}`
    })
}
