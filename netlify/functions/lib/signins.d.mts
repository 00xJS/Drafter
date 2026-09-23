// Types for signins.mjs. The runtime is signins.mjs.

type SettingsRow = { google_email?: string | null; google_refresh_token?: string | null; google_drafter_calendar_id?: string | null; microsoft_accounts?: unknown } | null | undefined

/** The calendars whose sign-in has stopped working, by name ("Google Calendar", "Outlook (me@example.com)"). */
export declare function calendarsNeedingSignIn(settings: SettingsRow): string[]

/** The morning digest's line for them, or null. */
export declare function signInLine(settings: SettingsRow): string | null
