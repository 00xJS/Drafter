import { JournalEntry, Mood, Person } from './types'
import { dateKey } from './utils'
import { weekDayKeys, weekStartKey } from '../shared/weeks.mjs'
import {
  PeopleById,
  appendEntry as sharedAppend,
  entriesBetween as sharedBetween,
  entriesOn as sharedEntriesOn,
  entryOn as sharedEntryOn,
  idSet,
  journalId as sharedJournalId,
  journalLines as sharedLines,
  localDayKey,
  mentions as sharedMentions,
  moodAverage as sharedMoodAverage,
  newEntry as sharedNewEntry,
  peopleNameMap,
  peopleNamesOf,
  shiftDayKey,
  streak as sharedStreak,
} from '../shared/journal.mjs'

// A journal entry is one day's writing. The rules (one editable entry per day,
// append never overwrites, streaks, who the day was about) live in
// shared/journal.mjs so the MCP server and the Sunday digest agree with the app.

export { localDayKey, shiftDayKey, idSet, peopleNameMap }
export type { PeopleById }

export const journalId = (date: string): string => sharedJournalId(date)
export const entriesOn = (entries: JournalEntry[], date: string): JournalEntry[] => sharedEntriesOn(entries, date)
export const entryOn = (entries: JournalEntry[], date: string): JournalEntry | undefined => sharedEntryOn(entries, date) ?? undefined
export const newEntry = (date: string, body: string, mood?: JournalEntry['mood'], peopleIds?: readonly string[]): JournalEntry =>
  sharedNewEntry(date, body, mood, undefined, undefined, peopleIds)
export const appendEntry = (existing: JournalEntry | undefined, date: string, text: string, mood?: JournalEntry['mood']): JournalEntry =>
  sharedAppend(existing, date, text, mood != null ? { mood } : {})
export const streak = (entries: JournalEntry[], today = localDayKey()): number => sharedStreak(entries, today)
export const moodAverage = (entries: readonly { mood?: number }[]): number | undefined => sharedMoodAverage(entries)
export const journalLines = (entries: JournalEntry[], max = 14, peopleById?: PeopleById): string[] => sharedLines(entries, max, 220, peopleById)

/** Entries that name a person, newest day first. A mention is not a visit: it never touches cadence. */
export const mentions = (entries: JournalEntry[], personId: string): JournalEntry[] => sharedMentions(entries, personId)

/** The people an entry names, in the entry's order; ids nobody matches (deleted, another household) are skipped. */
export function peopleOf(entry: Pick<JournalEntry, 'peopleIds'>, people: Person[]): Person[] {
  return (entry.peopleIds ?? []).map(id => people.find(p => p.id === id)).filter((p): p is Person => !!p)
}

/**
 * How many faces a one-line summary may draw, and how many it had to leave off.
 * A journal day header is a single row on a 375pt phone; a whole household of
 * 22px avatars overflows it and takes the Edit button — the only way to reopen
 * that day — off the clipped page with it.
 */
export function faceGroup<T>(who: readonly T[], max = 3): { shown: T[]; extra: number } {
  const cap = Math.max(1, Math.floor(max))
  return who.length <= cap ? { shown: [...who], extra: 0 } : { shown: who.slice(0, cap), extra: who.length - cap }
}

/** True when two people lists name the same ids in the same order (both empty counts as the same). */
export function samePeople(a?: readonly string[], b?: readonly string[]): boolean {
  const x = a ?? []
  const y = b ?? []
  return x.length === y.length && x.every((id, i) => id === y[i])
}

/** Entries inside a review range (end exclusive), newest day first. */
export function entriesInRange(entries: JournalEntry[], range: { start: Date; end: Date }): JournalEntry[] {
  return sharedBetween(entries, dateKey(range.start), dateKey(range.end))
}

/** Entries from the last `days` days including today, newest first. */
export function recentEntries(entries: JournalEntry[], days: number, today = localDayKey()): JournalEntry[] {
  return sharedBetween(entries, shiftDayKey(today, -(days - 1)), shiftDayKey(today, 1))
}

/** Unique days with an entry, newest first. */
export function journalDays(entries: JournalEntry[]): string[] {
  return [...new Set(entries.filter(e => !e.deletedAt).map(e => e.date))].sort((a, b) => b.localeCompare(a))
}

/** "Monday 8 September" for a YYYY-MM-DD key, in the viewer's locale. */
export function dayLabel(key: string, opts: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' }): string {
  const m = key.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return key
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).toLocaleDateString(undefined, opts)
}

/** Today / Yesterday / weekday + date. */
export function relativeDayLabel(key: string, today = localDayKey()): string {
  if (key === today) return 'Today'
  if (key === shiftDayKey(today, -1)) return 'Yesterday'
  return dayLabel(key, { weekday: 'short', day: 'numeric', month: 'short' })
}

/** One calendar day of the mood chart; `mood` is absent when the day has no entry or its entry has no face. */
export interface MoodDay {
  date: string
  mood?: Mood
}

/** A Sunday-start week of the mood chart: `avg` to one decimal over the days that carry a mood, absent when none do. */
export interface MoodWeek {
  start: string
  avg?: number
  count: number
}

export interface MoodSeries {
  /** Oldest first, exactly weeks × 7 days ending on `today`. */
  days: MoodDay[]
  /** Every Sunday-start week that touches the range, oldest first (the first and last are usually partial). */
  weekly: MoodWeek[]
}

/**
 * The mood chart's data: one point per day over the last `weeks` weeks and a
 * weekly average. The newest entry of a day is the one that counts (`entryOn`),
 * matching what the page shows for that day.
 */
export function moodSeries(entries: JournalEntry[], weeks = 12, today = localDayKey()): MoodSeries {
  const n = Math.max(1, Math.round(weeks)) * 7
  const first = shiftDayKey(today, -(n - 1))
  const days: MoodDay[] = []
  for (let i = 0; i < n; i++) {
    const date = shiftDayKey(first, i)
    const mood = entryOn(entries, date)?.mood
    days.push(mood !== undefined && mood >= 1 && mood <= 5 ? { date, mood } : { date })
  }
  const byDate = new Map(days.map(d => [d.date, d]))
  const weekly: MoodWeek[] = []
  const seen = new Set<string>()
  for (const d of days) {
    const start = weekStartKey(d.date)
    if (!start || seen.has(start)) continue
    seen.add(start)
    const scored = weekDayKeys(start)
      .map(k => byDate.get(k))
      .filter((x): x is MoodDay => x !== undefined && x.mood !== undefined)
    const avg = moodAverage(scored)
    weekly.push(avg === undefined ? { start, count: 0 } : { start, avg, count: scored.length })
  }
  return { days, weekly }
}

/**
 * How many weeks of mood a card `width` CSS pixels wide should draw. A quarter
 * of days needs roughly 480px before the columns stop being a smear: at 375pt a
 * 12-week chart is 84 columns under 2px wide, so the phone gets six weeks of
 * readable ones instead. Read off the measured card, never off a media query —
 * the same component sits in a wide desktop column and a 351px phone page.
 */
export const moodWeeksFor = (width: number): number => (width < 480 ? 6 : 12)

/**
 * Which day column a scrub at `x` (viewBox units, so CSS pixels of the chart)
 * lands on, clamped into the series. Touch has no hover, so the readout is
 * driven by this rather than by the 7px-wide per-day rects.
 */
export function moodIndexAt(x: number, left: number, slot: number, count: number): number {
  if (count <= 0 || !(slot > 0)) return 0
  return Math.max(0, Math.min(count - 1, Math.floor((x - left) / slot)))
}

/**
 * One search hit. The snippet is split into three parts rather than marked-up
 * text so the row can wrap the match in a `<mark>` element without ever handing
 * a journal body — the most personal text in the app — to
 * `dangerouslySetInnerHTML`. `match` is empty when the entry matched only on a
 * tagged person's name.
 */
export interface JournalHit {
  entry: JournalEntry
  /** Text before the match; starts with an ellipsis when the snippet was cut. */
  before: string
  /** The matched run in the body's own casing. */
  match: string
  /** Text after the match; ends with an ellipsis when the snippet was cut. */
  after: string
}

export interface JournalSearch {
  /** Every matching entry, not only the `hits` this page asked for. */
  total: number
  hits: JournalHit[]
}

/** Characters of context either side of a match. */
export const SNIPPET_PAD = 40
/** Hits rendered before the reader asks for more. */
export const SEARCH_PAGE = 100

/**
 * The words around the first occurrence of `query` in `body`, whitespace
 * collapsed to one line, with an ellipsis on whichever end was cut. An entry
 * that does not contain the query at all (it matched on a tagged person's name)
 * gets the head of its body instead, so the row still says something.
 */
export function snippetAround(body: string, query: string, pad = SNIPPET_PAD): { before: string; match: string; after: string } {
  const text = String(body ?? '').replace(/\s+/g, ' ').trim()
  const p = Number.isFinite(pad) ? Math.max(0, Math.round(pad)) : SNIPPET_PAD
  const q = String(query ?? '').trim()
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1
  if (at < 0) {
    const head = text.slice(0, p * 2)
    return { before: '', match: '', after: head + (text.length > head.length ? '…' : '') }
  }
  const start = Math.max(0, at - p)
  const end = Math.min(text.length, at + q.length + p)
  return {
    before: (start > 0 ? '…' : '') + text.slice(start, at),
    match: text.slice(at, at + q.length),
    after: text.slice(at + q.length, end) + (end < text.length ? '…' : ''),
  }
}

/**
 * Every entry that mentions `query`, newest day first (then newest edit), with
 * a snippet each. Case-insensitive; matches the body and, when `peopleById` is
 * given, the names of the people the day was tagged with — "garden" and "Mum"
 * are both things you would search a diary for.
 *
 * `total` counts every match, `hits` only the first `limit`, so a search that
 * spans years can report "112 entries" and still render a page of them. An
 * empty query is not a search: it returns nothing rather than everything.
 */
export function searchJournal(entries: JournalEntry[], query: string, limit = SEARCH_PAGE, peopleById?: PeopleById): JournalSearch {
  const q = String(query ?? '').trim()
  if (!q) return { total: 0, hits: [] }
  const needle = q.toLowerCase()
  const matched = (entries ?? [])
    .filter(e => e && e.kind === 'journal' && !e.deletedAt)
    .filter(e => String(e.body ?? '').toLowerCase().includes(needle) || peopleNamesOf(e, peopleById).some(n => n.toLowerCase().includes(needle)))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
  const cap = Number.isFinite(limit) ? Math.max(0, Math.round(limit)) : SEARCH_PAGE
  return { total: matched.length, hits: matched.slice(0, cap).map(entry => ({ entry, ...snippetAround(entry.body, q) })) }
}

/** Day of the week for a YYYY-MM-DD key, 0 = Sunday. UTC maths, so no DST drift. */
export function weekdayOf(key: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''))
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay() : 0
}

/** Sunday 6 September 2026, the anchor the weekday names are read off. */
const WEEKDAY_ANCHOR = [2026, 8, 6] as const
const weekdayDate = (weekday: number) => new Date(WEEKDAY_ANCHOR[0], WEEKDAY_ANCHOR[1], WEEKDAY_ANCHOR[2] + weekday, 12)
/** "Monday" in the viewer's locale, 0 = Sunday. */
export const weekdayName = (weekday: number): string => weekdayDate(weekday).toLocaleDateString(undefined, { weekday: 'long' })
/** "M" in the viewer's locale, 0 = Sunday. */
export const weekdayLabel = (weekday: number): string => weekdayDate(weekday).toLocaleDateString(undefined, { weekday: 'narrow' })

/** One weekday's mood: `avg` is absent when no day in the window carried one. */
export interface WeekdayMood {
  /** 0 = Sunday, matching the app's Sunday-start week. */
  weekday: number
  avg?: number
  count: number
}

/**
 * Fewer moods than this and the weekday view is not shown at all: an average
 * over three Mondays is noise, and a chart that reads as a finding when it is
 * arithmetic on three days is worse than no chart.
 */
export const WEEKDAY_MOOD_MIN = 14

/**
 * "Which days are hard": the mean mood for each weekday over the last `weeks`
 * weeks, Sunday first. One day contributes at most once — the newest entry of
 * that day, exactly what the page shows for it — so a day written twice does
 * not weigh double.
 */
export function moodByWeekday(entries: JournalEntry[], weeks = 26, today = localDayKey()): WeekdayMood[] {
  const n = Math.max(1, Math.round(weeks)) * 7
  const first = shiftDayKey(today, -(n - 1))
  // the newest live entry per day in the window, so the scan is one pass over
  // the entries rather than one lookup per day across all of them
  const best = new Map<string, JournalEntry>()
  for (const e of entries ?? []) {
    if (!e || e.kind !== 'journal' || e.deletedAt || e.date < first || e.date > today) continue
    const held = best.get(e.date)
    if (!held || String(e.updatedAt).localeCompare(String(held.updatedAt)) > 0) best.set(e.date, e)
  }
  const buckets: { mood: Mood }[][] = [[], [], [], [], [], [], []]
  for (const [date, e] of best) {
    const mood = e.mood
    if (mood === undefined || mood < 1 || mood > 5) continue
    buckets[weekdayOf(date)].push({ mood })
  }
  return buckets.map((list, weekday) => {
    const avg = moodAverage(list)
    return avg === undefined ? { weekday, count: 0 } : { weekday, avg, count: list.length }
  })
}

/**
 * The weekday with the lowest average, or null when nothing is comparable —
 * one weekday with a score is a fact about that day, not a low point. Ties go
 * to the earlier weekday.
 */
export function lowestMoodWeekday(days: readonly WeekdayMood[]): number | null {
  const scored = (days ?? []).filter(d => d.avg !== undefined)
  if (scored.length < 2) return null
  const low = scored.reduce((a, b) => (b.avg! < a.avg! ? b : a))
  return scored.every(d => d.avg === low.avg) ? null : low.weekday
}
