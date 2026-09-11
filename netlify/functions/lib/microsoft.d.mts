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
