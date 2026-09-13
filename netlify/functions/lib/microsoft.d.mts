// Types for microsoft.mjs: what the functions and src/'s tests import from it.
// The runtime is microsoft.mjs; tsc (src/, and tsconfig.server.json for the
// functions) reads this. Netlify bundles the .mjs directly and never reads it.

export declare const SCOPES: string[]
export declare function microsoftConfigured(): boolean
/** The env names still missing, for the admin panel. */
export declare function missingMicrosoftEnv(): string[]
export declare function randomState(): string

/** A connected account as user_settings.microsoft_accounts holds it. Never sent to the browser as is. */
export interface MicrosoftAccount {
  id: string
  email: string
  name: string
  refreshToken?: string
  drafterCalendarId?: string | null
}
/** What the browser may see of an account: never a token. */
export interface PublicAccount {
  id: string
  email: string
  name: string
  hasMirror: boolean
}
export declare function listAccounts(userId: string): Promise<MicrosoftAccount[]>
export declare function publicAccount(a: MicrosoftAccount): PublicAccount

/** Microsoft's token endpoint answer. */
export interface MicrosoftTokens {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  token_type?: string
  id_token?: string
}
/** Trade an authorization code for tokens. A refusal throws with `code` set to oauthFailureCode's reason. */
export declare function exchangeCode(code: string, redirectUri: string): Promise<MicrosoftTokens>
/** A live access token for one account; a rotated refresh token is written back. */
export declare function accessToken(userId: string, accountId: string): Promise<string>
/** Store a newly connected account (the last four are kept) and return its public shape. */
export declare function connectAccount(userId: string, tokens: MicrosoftTokens): Promise<PublicAccount>
export declare function disconnectAccount(userId: string, accountId: string): Promise<void>
export declare function listCalendars(userId: string, accountId: string, drafterCalendarId?: string | null): Promise<ReturnType<typeof graphCalendarRow>[]>

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
/** Graph event → OverlayEvent; null for a cancelled event or one of Drafter's own tasks. */
export declare function toEvent(item: unknown, sourceId: string): OverlayEvent | null
/** Graph's events in a window, recurring series expanded. */
export declare function listEvents(userId: string, accountId: string, calendarId: string, fromIso: string, toIso: string): Promise<unknown[]>
/** The account's Drafter calendar's id (see resolveDrafterCalendar). */
export declare function drafterCalendarId(userId: string, accountId: string): Promise<string>

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
  [key: string]: unknown
}
export type PushOutcome = 'created' | 'updated' | 'removed' | 'skipped'
/** Mirror one task: upsert while open and dated, remove otherwise. `opts.tz` is the owner's zone (null for none). */
export declare function pushTask(
  userId: string,
  accountId: string,
  calendarId: string,
  task: TaskLike,
  projectName: string | undefined,
  site: string,
  opts?: { tz?: string | null },
): Promise<PushOutcome>
/** Mirror one calendar entry into the account's Drafter calendar. */
export declare function pushEntry(userId: string, accountId: string, calendarId: string, entry: EntryLike, site: string): Promise<PushOutcome>

/** A mirrored task as Outlook now holds it. */
export interface TaskChangeRow {
  taskId: string
  deleted: boolean
  start: string | null
  allDay: boolean
  updated: string
}
/** Mirrored tasks changed in Outlook since `sinceIso`. */
export declare function pullChanges(userId: string, accountId: string, calendarId: string, sinceIso: string): Promise<TaskChangeRow[]>
export declare function authUrl(clientId: string, redirectUri: string, state: string, loginHint?: string | null): string

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

/** One of the account's calendars as Settings lists it; `drafter` marks the account's own Drafter calendar. */
export declare function graphCalendarRow(
  c: { id: string; name?: string; canEdit?: boolean; isDefaultCalendar?: boolean },
  drafterCalendarId: string | null,
): { id: string; name?: string; primary: boolean; writable: boolean; drafter: boolean }
export declare function isOwnDrafterCalendar(account: { drafterCalendarId?: string | null } | null | undefined, calendarId: string): boolean

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
