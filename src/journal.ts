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
