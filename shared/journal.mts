// Journal rules shared by the web app, the MCP server and the digest.
// Dependency-free ESM. An entry is one day's writing; several entries for a day
// can exist (two devices offline) and are all kept — the newest edit is the one
// you type into.

import type { JournalEntry, Mood, Person } from '../src/types.ts'
import { dayStreaks } from './stats.mts'

export const DAY_MS = 86_400_000

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** YYYY-MM-DD in the runtime's local zone. */
export function localDayKey(d: Date | string | number = new Date()): string {
  const dt = d instanceof Date ? d : new Date(d)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
}

/** Calendar-day arithmetic on a YYYY-MM-DD key (UTC maths, so no DST drift). */
export function shiftDayKey(key: string, days: number): string {
  const m = String(key).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return key
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]) + days * DAY_MS
  return new Date(t).toISOString().slice(0, 10)
}

/** `journal~<day>~<random>`: the day is in the id for humans, the suffix keeps two writers from colliding. */
export function journalId(date: string, rand?: string): string {
  const suffix = rand ?? Math.random().toString(36).slice(2, 10)
  return `journal~${date}~${suffix}`
}

/** Live entries for a day, newest edit first. */
export function entriesOn(entries: readonly JournalEntry[], date: string): JournalEntry[] {
  return (entries ?? [])
    .filter(e => e && e.kind === 'journal' && !e.deletedAt && e.date === date)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

/** The entry to type into for a day (the most recently edited), or null. */
export function entryOn(entries: readonly JournalEntry[], date: string): JournalEntry | null {
  return entriesOn(entries, date)[0] ?? null
}

/** Entries whose day falls in [fromKey, toKey) — keys are YYYY-MM-DD. Newest day first. */
export function entriesBetween(entries: readonly JournalEntry[], fromKey: string, toKey: string): JournalEntry[] {
  return (entries ?? [])
    .filter(e => e && e.kind === 'journal' && !e.deletedAt && DATE_RE.test(e.date) && e.date >= fromKey && e.date < toKey)
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

/** Unique, non-empty string ids in first-seen order; undefined when there are none (never an empty array on a record). */
export function idSet(...lists: unknown[]): string[] | undefined {
  const out: string[] = []
  for (const list of lists) {
    const ids: readonly unknown[] = Array.isArray(list) ? list : []
    for (const id of ids) if (id && !out.includes(String(id))) out.push(String(id))
  }
  return out.length ? out : undefined
}

export function newEntry(date: string, body: string, mood?: Mood, nowIso: string = new Date().toISOString(), rand?: string, peopleIds?: readonly string[]): JournalEntry {
  const entry: JournalEntry = {
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

/** A stamp strictly newer than the previous one (mirrors shared/domain.mts newerStamp). */
function newer(prevIso?: string): string {
  const prev = prevIso ? Date.parse(prevIso) : 0
  return new Date(Math.max(Date.now(), (Number.isFinite(prev) ? prev : 0) + 1)).toISOString()
}

/**
 * Append a line to a day's entry: from a Shortcut, a share, an agent, or a
 * "log this" button. Creates the entry when the day has none. Never overwrites
 * what was already written.
 */
export function appendEntry(
  existing: JournalEntry | null | undefined,
  date: string,
  text: string,
  opts: { mood?: Mood; now?: string; rand?: string; peopleIds?: readonly string[] } = {},
): JournalEntry {
  const line = String(text ?? '').trim()
  if (!existing) return newEntry(date, line, opts.mood, opts.now, opts.rand, opts.peopleIds)
  const body = existing.body && existing.body.trim() ? `${existing.body.replace(/\s+$/, '')}\n${line}` : line
  const next: JournalEntry = { ...existing, body, updatedAt: newer(existing.updatedAt) }
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
export function mentions(entries: readonly JournalEntry[], personId: string): JournalEntry[] {
  const id = String(personId ?? '')
  if (!id) return []
  return (entries ?? [])
    .filter(e => e && e.kind === 'journal' && !e.deletedAt && Array.isArray(e.peopleIds) && e.peopleIds.includes(id))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

/** id -> name, as a Map or a plain object: how journalLines and peopleNamesOf are told who is who. */
export type PeopleById = ReadonlyMap<string, string> | Readonly<Record<string, string>>

/** A Map of names (anything with a Map's get), rather than a plain object of them. */
function isMap(names: PeopleById): names is ReadonlyMap<string, string> {
  const maybe: { get?: unknown } = names
  return typeof maybe.get === 'function'
}

/** id -> name for live people, the shape journalLines takes. */
export function peopleNameMap(people: readonly (Pick<Person, 'kind' | 'id' | 'name'> & { deletedAt?: string })[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const p of people ?? []) if (p && p.kind === 'person' && !p.deletedAt && p.id) map.set(String(p.id), String(p.name ?? ''))
  return map
}

/** Names for an entry's peopleIds, in the entry's order; ids nobody matches are skipped. */
export function peopleNamesOf(entry: Pick<JournalEntry, 'peopleIds'> | null | undefined, peopleById?: PeopleById): string[] {
  if (!peopleById || !entry || !Array.isArray(entry.peopleIds)) return []
  const lookup = isMap(peopleById) ? (id: string) => peopleById.get(id) : (id: string) => peopleById[id]
  return entry.peopleIds.map(id => lookup(String(id))).filter((n): n is string => typeof n === 'string' && !!n.trim())
}

/** Consecutive days with an entry, counting back from today (or yesterday if today is still blank): the Stats rules' dayStreaks. */
export function streak(entries: readonly JournalEntry[], today: string = localDayKey()): number {
  const days = (entries ?? []).filter(e => e && e.kind === 'journal' && !e.deletedAt && DATE_RE.test(e.date)).map(e => e.date)
  return dayStreaks(days, today).current
}

/** Mean mood of the entries that carry one, to one decimal; undefined when none do. */
export function moodAverage(entries: readonly { mood?: number | null }[]): number | undefined {
  const moods = (entries ?? []).map(e => Number(e?.mood)).filter(m => Number.isFinite(m) && m >= 1 && m <= 5)
  if (moods.length === 0) return undefined
  return Math.round((moods.reduce((s, m) => s + m, 0) / moods.length) * 10) / 10
}

/**
 * Lines for a model prompt: "2026-09-08 (mood 4/5, with Mum, Dad): first 220 chars".
 * Newest last so the story reads forward. peopleById (a Map or a plain object,
 * id -> name) turns peopleIds into names; without it people are left out.
 */
export function journalLines(entries: readonly JournalEntry[], max = 14, chars = 220, peopleById?: PeopleById): string[] {
  const clip = (s: unknown) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim()
    return t.length > chars ? t.slice(0, chars - 1) + '…' : t
  }
  return [...(entries ?? [])]
    .filter(e => e && e.kind === 'journal' && !e.deletedAt && (String(e.body ?? '').trim() || e.mood))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-max)
    .map(e => {
      const notes: string[] = []
      if (e.mood) notes.push(`mood ${e.mood}/5`)
      const names = peopleNamesOf(e, peopleById)
      if (names.length) notes.push(`with ${names.join(', ')}`)
      return `${e.date}${notes.length ? ` (${notes.join(', ')})` : ''}: ${clip(e.body) || '(mood only)'}`
    })
}
