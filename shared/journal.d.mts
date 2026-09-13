import { JournalEntry, Mood, Person } from '../src/types.js'

export declare const DAY_MS: number
export declare function localDayKey(d?: Date | string | number): string
export declare function shiftDayKey(key: string, days: number): string
export declare function journalId(date: string, rand?: string): string
export declare function entriesOn(entries: JournalEntry[], date: string): JournalEntry[]
export declare function entryOn(entries: JournalEntry[], date: string): JournalEntry | null
export declare function entriesBetween(entries: JournalEntry[], fromKey: string, toKey: string): JournalEntry[]
export declare function idSet(...lists: (readonly string[] | null | undefined)[]): string[] | undefined
export declare function newEntry(date: string, body: string, mood?: Mood, nowIso?: string, rand?: string, peopleIds?: readonly string[]): JournalEntry
export declare function appendEntry(
  existing: JournalEntry | null | undefined,
  date: string,
  text: string,
  opts?: { mood?: Mood; now?: string; rand?: string; peopleIds?: readonly string[] },
): JournalEntry
export declare function mentions(entries: JournalEntry[], personId: string): JournalEntry[]
export type PeopleById = Map<string, string> | Record<string, string>
export declare function peopleNameMap(people: readonly (Pick<Person, 'kind' | 'id' | 'name'> & { deletedAt?: string })[]): Map<string, string>
export declare function peopleNamesOf(entry: Pick<JournalEntry, 'peopleIds'> | null | undefined, peopleById?: PeopleById): string[]
export declare function streak(entries: JournalEntry[], today?: string): number
export declare function moodAverage(entries: readonly { mood?: number | null }[]): number | undefined
export declare function journalLines(entries: JournalEntry[], max?: number, chars?: number, peopleById?: PeopleById): string[]
