import type { SettingsCtx } from './context'
import { GoogleCalendar } from './GoogleCalendar'
import { OtherCalendars } from './OtherCalendars'
import { OutlookCalendars } from './OutlookCalendars'
import { SubscribeLink } from './SubscribeLink'

/** Calendars: Google, Outlook, any .ics address, and the subscribe link — one section, a block each. */
export function Calendars(ctx: SettingsCtx) {
  return (
    <section className="settings-section g-calendars">
      <h3>Calendars</h3>
      <p className="field-hint">
        Subscribe to your Google or iCloud calendars (birthdays, holidays, family) and their events show up on
        the Month view, the Timeline, and Today's <em>Coming up</em> list — read-only, with a one-tap prep task.
      </p>
      <GoogleCalendar {...ctx} />
      <OutlookCalendars {...ctx} />
      <OtherCalendars {...ctx} />
      <SubscribeLink {...ctx} />
    </section>
  )
}
