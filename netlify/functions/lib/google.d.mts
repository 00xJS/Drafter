// Types for the pure helpers src/ imports in tests. The runtime is google.mjs;
// this exists only so tsc (which checks src/) does not see an implicit any.
// Netlify bundles the .mjs directly and never reads this file.

/** The parts of a CalendarEntry the mirrors read. Extra fields are allowed. */
export interface EntryLike {
  id: string
  title: string
  start: string
  end: string
  allDay: boolean
  location?: string
  notes?: string
  deletedAt?: string
  updatedAt?: string
  /** Present on a work day: where it is spent. */
  work?: 'home' | 'office'
  [key: string]: unknown
}

export type EntryPlan = { op: 'create' } | { op: 'skip' } | { op: 'patch'; id: string } | { op: 'delete'; id: string }

export declare function googleEntryPlan(
  existing: GoogleCopy | null,
  entry: EntryLike,
  opts?: { revive?: boolean },
): EntryPlan

export declare function googleEntryBody(
  entry: EntryLike,
  site: string,
): {
  summary: string
  description?: string
  location?: string
  start: { date?: string; dateTime?: string }
  end: { date?: string; dateTime?: string }
  transparency: 'opaque' | 'transparent'
  extendedProperties: { private: { drafter: '1'; eventId: string } }
}

/** Google's view of a mirrored copy: enough to decide which copy speaks for a record. */
export interface GoogleCopy {
  id: string
  status?: string
  updated?: string
}
/** The live copy, or else the most recently cancelled one. */
export declare function newestCopy(items: GoogleCopy[] | undefined | null): GoogleCopy | null
/** True when the record was edited after its Google copy was cancelled. */
export declare function editedSinceCancelled(existing: GoogleCopy | null, record: { updatedAt?: string }): boolean

/** One of our entries as a provider holds it, in the CalendarEntry convention. */
export interface EntryChangeRow {
  eventId: string
  deleted: boolean
  title: string
  start: string | null
  end: string | null
  allDay: boolean
  updated: string
}

export interface TaskChangeRow {
  taskId: string
  deleted: boolean
  start: string | null
  allDay: boolean
  updated: string
}

export declare const DRAFTER_DESCRIPTION: string

export interface CalendarListRow {
  id: string
  summary?: string
  summaryOverride?: string
  description?: string
  accessRole?: string
  hidden?: boolean
  deleted?: boolean
}

/** Which of the account's calendars is Drafter's: the stored one, else the lowest id among ours. */
export declare function pickDrafterCalendar(items: CalendarListRow[] | null | undefined, storedId: string | null): string | null
/** The Drafter calendar, found or made; `replaced` when the stored one had gone. */
export declare function resolveDrafterCalendar(userId: string): Promise<{ id: string; replaced: boolean; created: boolean }>
/** One Calendar API call as the user; retries once with a fresh token after a 401. */
export declare function gapi(userId: string, path: string, init?: RequestInit): Promise<unknown>
/** The settings a completed connect writes: the calendar id survives only a same-account reconnect. */
export declare function reconnectPatch(row: { google_email?: string | null } | null, refreshToken: string, email: string): Record<string, unknown>

export declare function googleEntryChange(ev: unknown): EntryChangeRow | null
export declare function googlePullRows(items: unknown[] | null | undefined): { changes: TaskChangeRow[]; entries: EntryChangeRow[] }
