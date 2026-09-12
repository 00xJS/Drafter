import type { CalendarState, GooglePushState } from '../../calendars'
import type { HouseholdInfo } from '../../household'
import type { Store } from '../../store'
import type { FeedInfo } from './useFeedInfo'

/**
 * What every Settings section is handed: the dialog's own props, plus the
 * state two sections share (kept once, in the shell). Each section takes what
 * it needs and ignores the rest.
 */
export interface SettingsCtx {
  store: Store
  calendars: CalendarState
  googlePush: GooglePushState
  microsoftSync: GooglePushState
  household: { info: HouseholdInfo | null; myId: string | null; refresh(): Promise<void>; error?: string }
  onClose(): void
  /** Owner only: on a phone this is the one way into Admin. */
  onOpenAdmin?(): void
  /** A backend is configured (false in local mode). */
  supabaseOn: boolean
  /** Sync now or Full resync is running. */
  syncing: boolean
  setSyncing(on: boolean): void
  /** The subscribe link and the email-in address, fetched once for Calendars and Email in. */
  feed: FeedInfo
}
