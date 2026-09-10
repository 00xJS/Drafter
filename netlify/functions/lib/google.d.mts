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
  [key: string]: unknown
}

export type EntryPlan = { op: 'create' } | { op: 'skip' } | { op: 'patch'; id: string } | { op: 'delete'; id: string }

export declare function googleEntryPlan(
  existing: { id: string; status?: string } | null,
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
  transparency: 'opaque'
  extendedProperties: { private: { drafter: '1'; eventId: string } }
}
