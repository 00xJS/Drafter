// Types for the pure helpers src/ imports in tests. The runtime is
// microsoft.mjs; this exists only so tsc (which checks src/) does not see an
// implicit any. Netlify bundles the .mjs directly and never reads this file.

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
  /** Present on a work day: where it is spent. */
  work?: 'home' | 'office'
  [key: string]: unknown
}

export type EntryPlan = { op: 'create' } | { op: 'skip' } | { op: 'patch'; id: string } | { op: 'delete'; id: string }

/**
 * The short, safe reason a failed connect sends back to the browser, read out
 * of Microsoft's { error, error_description } — always matches /^[a-z0-9_]{1,40}$/.
 */
export declare function oauthFailureCode(body: unknown): string

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

/** One Graph call as the account; retries once with a fresh token after a 401. */
export declare function graph(userId: string, accountId: string, path: string, init?: RequestInit): Promise<unknown>
export declare function pickGraphDrafterCalendar(calendars: { id: string; name?: string; writable?: boolean }[] | null | undefined, storedId: string | null): string | null
/** The account's Drafter calendar, found or made; `replaced` when the stored one had gone. */
export declare function resolveDrafterCalendar(userId: string, accountId: string): Promise<{ id: string; replaced: boolean; created: boolean }>

export declare function graphEntryChange(ev: unknown): EntryChangeRow | null
export declare function pullEntryChanges(userId: string, accountId: string, calendarId: string, sinceIso: string): Promise<EntryChangeRow[]>
export declare function mirroredTaskIds(userId: string, accountId: string, calendarId: string): Promise<{ ids: Set<string>; complete: boolean }>
export declare function outlookMissing(
  live: string[],
  present: Set<string> | string[],
  opts?: { maxAbs?: number; maxShare?: number },
): { missing: string[]; suspicious: boolean; absent: string[] }

/** Graph hard-deletes, so there is no cancelled state and no revive option. */
export declare function graphEntryPlan(existing: { id: string } | null, entry: EntryLike): EntryPlan

export declare function graphEntryBody(
  entry: EntryLike,
  site: string,
): {
  subject: string
  body: { contentType: 'text'; content: string }
  location?: { displayName: string }
  isAllDay: boolean
  showAs: 'busy' | 'free' | 'workingElsewhere'
  start: { dateTime: string; timeZone: 'UTC' }
  end: { dateTime: string; timeZone: 'UTC' }
  singleValueExtendedProperties: [{ id: string; value: string }]
}
