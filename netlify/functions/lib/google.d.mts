// Types for google.mjs: what the functions and src/'s tests import from it.
// The runtime is google.mjs; tsc (src/, and tsconfig.server.json for the
// functions) reads this. Netlify bundles the .mjs directly and never reads it.

export declare const SCOPES: string[]
export declare function googleConfigured(): boolean
/** The env names still missing, for the admin panel. */
export declare function missingGoogleEnv(): string[]

/** Google's token endpoint answer. */
export interface GoogleTokens {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  token_type?: string
  id_token?: string
}
/** Trade an authorization code for tokens; throws with Google's reason. */
export declare function exchangeCode(code: string, redirectUri: string): Promise<GoogleTokens>
/** A live access token for the user's grant, cached per warm function. */
export declare function accessToken(userId: string): Promise<string>
/** Revoke the grant at Google and forget it here. */
export declare function revoke(userId: string): Promise<void>

/** An event of a ticked calendar, in the app's CalendarEvent shape. */
export interface OverlayEvent {
  id: string
  sourceId: string
  title: string
  start: string
  end: string
  allDay: boolean
  location?: string
}
/** Google event → OverlayEvent; null for a cancelled event or one of Drafter's own. */
export declare function toEvent(item: unknown, sourceId: string): OverlayEvent | null
/** Google's events in a window, recurring series expanded. */
export declare function listEvents(userId: string, calendarId: string, fromIso: string, toIso: string): Promise<unknown[]>
export declare function listCalendars(userId: string): Promise<ReturnType<typeof googleCalendarRow>[]>
/** The Drafter calendar's id (see resolveDrafterCalendar). */
export declare function drafterCalendarId(userId: string): Promise<string>

/** The parts of a task the mirror reads. Extra fields are allowed. */
export interface TaskLike {
  id: string
  kind?: string
  title?: string
  description?: string
  status?: string
  priority?: string
  dueAt?: string
  deletedAt?: string
  updatedAt?: string
  [key: string]: unknown
}
export type PushOutcome = 'created' | 'updated' | 'removed' | 'skipped'
/** Mirror one task: upsert while open and dated, remove otherwise. `opts.tz` is the owner's zone (null for none). */
export declare function pushTask(
  userId: string,
  calendarId: string,
  task: TaskLike,
  projectName: string | undefined,
  site: string,
  opts?: { tz?: string | null },
): Promise<PushOutcome>
/** Mirror one calendar entry; `opts.revive` brings back a copy Drafter itself cancelled (Undo). */
export declare function pushEntry(userId: string, calendarId: string, entry: EntryLike, site: string, opts?: { revive?: boolean }): Promise<PushOutcome>
/** Every Drafter event changed since `sinceIso`, deleted ones included, as Google sends them. */
export declare function listChangedMirrors(userId: string, calendarId: string, sinceIso: string): Promise<unknown[]>
/** A random token from a CSPRNG, base64url. */
export declare function randomToken(bytes?: number): string

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

/** One calendar as Settings lists it; `drafter` marks Drafter's own calendar. */
export declare function googleCalendarRow(
  c: CalendarListRow & { backgroundColor?: string; primary?: boolean },
  storedId: string | null,
): { id: string; name?: string; color?: string; primary: boolean; writable: boolean; drafter: boolean }

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
