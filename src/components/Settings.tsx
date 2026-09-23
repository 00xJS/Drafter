import { ComponentType, useState } from 'react'
import { Store } from '../store'
import type { CalendarState, GooglePushState } from '../calendarstate'
import { isSupabaseConfigured } from '../supabase'
import type { HouseholdInfo } from '../household'
import type { SettingsCtx } from './settings/context'
import { useFeedInfo } from './settings/useFeedInfo'
import { About } from './settings/About'
import { AdminLink } from './settings/AdminLink'
import { Appearance } from './settings/Appearance'
import { Assistants } from './settings/Assistants'
import { Calendars } from './settings/Calendars'
import { EmailIn } from './settings/EmailIn'
import { Account, Household } from './settings/Household'
import { Profile } from './settings/Profile'
import { Lock } from './settings/Lock'
import { Reminders } from './settings/Reminders'
import { ImportExport } from './settings/ImportExport'
import { Sync } from './settings/Sync'
import { Templates } from './settings/Templates'

/** A group: its button in the nav, and the sections shown under it, in page order. */
interface SettingsGroupDef {
  key: string
  label: string
  /** Offered only with an account (a Supabase backend). */
  needsAccount?: boolean
  /**
   * Folded away behind "More" until asked for (v3.25). Most of Settings is
   * plumbing somebody sets up once — the calendars they connect, how the
   * reminders behave, the sync buttons — and a second member opening this
   * dialog to change their name should not have to read past all of it. The
   * groups here are the ones that are not about you.
   */
  advanced?: boolean
  sections: ComponentType<SettingsCtx>[]
}

/**
 * Settings was one 800-line scroll; these are the things you come here for,
 * and this list is the one registry of them. Each section (in
 * ./settings/) draws its own `settings-section g-<key>`, or nothing when it
 * does not apply here. A new group is one entry plus its section component,
 * and a `.settings-body.showing-<key> .g-<key>` rule in the stylesheet —
 * settings-groups.test.ts checks all three line up.
 */
const SETTINGS_GROUPS: SettingsGroupDef[] = [
  { key: 'you', label: 'You', needsAccount: true, sections: [Profile, Account] },
  { key: 'appearance', label: 'Appearance', sections: [Appearance, Lock] },
  { key: 'household', label: 'Household', needsAccount: true, sections: [Household, AdminLink] },
  { key: 'reminders', label: 'Reminders', advanced: true, sections: [Reminders] },
  { key: 'calendars', label: 'Calendars', advanced: true, sections: [Calendars] },
  { key: 'assistants', label: 'Assistants', needsAccount: true, advanced: true, sections: [Assistants] },
  { key: 'data', label: 'Data', advanced: true, sections: [Sync, ImportExport, EmailIn, Templates, About] },
]

interface Props {
  store: Store
  calendars: CalendarState
  googlePush: GooglePushState
  microsoftSync: GooglePushState
  household: { info: HouseholdInfo | null; myId: string | null; refresh(): Promise<void>; error?: string }
  /** Leave the Settings screen. Its own header has the back button; this is
      for the section that has to leave on your behalf — signing out. */
  onClose(): void
  /** Owner only. The header's Admin button is hidden on phones, so this is the
      only admin route on the device the owner actually uses. */
  onOpenAdmin?(): void
  /** The group to open on, when the opener asks for one: Today's calendar sign-in banner opens Calendars. */
  initialGroup?: string
}

/**
 * The group Settings opens on: the one asked for (Today's calendar sign-in
 * banner asks for Calendars), when it exists here; else You, when there is an
 * account to be — the first thing a second member wants from Settings is
 * their own name and picture, not the calendar plumbing.
 */
export function openingGroup(asked: string | undefined, supabaseOn: boolean): string {
  if (asked && SETTINGS_GROUPS.some(g => g.key === asked && (!g.needsAccount || supabaseOn))) return asked
  return supabaseOn ? 'you' : 'appearance'
}

export function Settings({ store, calendars, googlePush, microsoftSync, household, onClose, onOpenAdmin, initialGroup }: Props) {
  const supabaseOn = isSupabaseConfigured()
  const [group, setGroup] = useState(() => openingGroup(initialGroup, supabaseOn))
  /** Show the groups that are not about you. Off until asked for, and for this visit only. */
  const [more, setMore] = useState(false)
  // kept here because two sections share each: Sync's buttons, and the feed
  // status that both Calendars and Email in show (so it is fetched once)
  const [syncing, setSyncing] = useState(false)
  const feed = useFeedInfo()
  const ctx: SettingsCtx = { store, calendars, googlePush, microsoftSync, household, onClose, onOpenAdmin, supabaseOn, syncing, setSyncing, feed }

  /*
   * A screen, not a dialog. It was a Modal until v3.30 — with a Done button,
   * which is what a dialog has instead of a way back. PushedScreen draws the
   * header and the ‹ Back, so all that is left here is the sections and the
   * nav that picks between them.
   */
  return (
    <div className={`settings-body showing-${group}`}>
      <nav className="settings-nav" role="tablist" aria-label="Settings sections">
        {SETTINGS_GROUPS.filter(g => (!g.needsAccount || supabaseOn) && (!g.advanced || more || g.key === group)).map(g => (
          <button key={g.key} className={group === g.key ? 'seg on' : 'seg'} onClick={() => setGroup(g.key)} role="tab" aria-selected={group === g.key}>
            {g.label}
          </button>
        ))}
        {!more && (
          <button className="seg settings-more" onClick={() => setMore(true)} role="tab" aria-selected={false}>
            More…
          </button>
        )}
      </nav>
      {/* every section stays mounted, whichever group is showing: the class
          above hides the rest, and their fetches start as Settings opens */}
      {SETTINGS_GROUPS.flatMap(g => g.sections.map((Section, i) => <Section key={`${g.key}-${i}`} {...ctx} />))}
    </div>
  )
}
