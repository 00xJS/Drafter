import { ComponentType, useState } from 'react'
import { Store } from '../store'
import { CalendarState, GooglePushState } from '../calendars'
import { isSupabaseConfigured } from '../supabase'
import type { HouseholdInfo } from '../household'
import type { SettingsCtx } from './settings/context'
import { Modal, ModalHead } from './Modal'
import { useFeedInfo } from './settings/useFeedInfo'
import { AdminLink } from './settings/AdminLink'
import { Assistants } from './settings/Assistants'
import { Calendars } from './settings/Calendars'
import { EmailIn } from './settings/EmailIn'
import { Account, Household } from './settings/Household'
import { Lock } from './settings/Lock'
import { Reminders } from './settings/Reminders'
import { Sync } from './settings/Sync'
import { Templates } from './settings/Templates'

/** A group: its button in the nav, and the sections shown under it, in page order. */
interface SettingsGroupDef {
  key: string
  label: string
  /** Offered only with an account (a Supabase backend). */
  needsAccount?: boolean
  sections: ComponentType<SettingsCtx>[]
}

/**
 * Settings was one 800-line scroll; these are the four things you come here
 * for, and this list is the one registry of them. Each section (in
 * ./settings/) draws its own `settings-section g-<key>`, or nothing when it
 * does not apply here. A new group is one entry plus its section component,
 * and a `.settings-body.showing-<key> .g-<key>` rule in the stylesheet —
 * settings-groups.test.ts checks all three line up.
 */
const SETTINGS_GROUPS: SettingsGroupDef[] = [
  { key: 'calendars', label: 'Calendars', sections: [Calendars] },
  { key: 'reminders', label: 'Reminders', sections: [Lock, Reminders] },
  { key: 'household', label: 'Household', needsAccount: true, sections: [Household, Account] },
  { key: 'assistants', label: 'Assistants', needsAccount: true, sections: [Assistants] },
  { key: 'data', label: 'Data', sections: [Sync, EmailIn, Templates, AdminLink] },
]

interface Props {
  store: Store
  calendars: CalendarState
  googlePush: GooglePushState
  microsoftSync: GooglePushState
  household: { info: HouseholdInfo | null; myId: string | null; refresh(): Promise<void>; error?: string }
  onClose(): void
  /** Owner only. The header's Admin button is hidden on phones, so this is the
      only admin route on the device the owner actually uses. */
  onOpenAdmin?(): void
}

export function Settings({ store, calendars, googlePush, microsoftSync, household, onClose, onOpenAdmin }: Props) {
  const [group, setGroup] = useState('calendars')
  const supabaseOn = isSupabaseConfigured()
  // kept here because two sections share each: Sync's buttons, and the feed
  // status that both Calendars and Email in show (so it is fetched once)
  const [syncing, setSyncing] = useState(false)
  const feed = useFeedInfo()
  const ctx: SettingsCtx = { store, calendars, googlePush, microsoftSync, household, onClose, onOpenAdmin, supabaseOn, syncing, setSyncing, feed }

  return (
    <Modal onClose={onClose} className="modal settings-modal">
        <ModalHead title="Settings" />

        <div className={`modal-body settings-body showing-${group}`}>
          <nav className="settings-nav" role="tablist" aria-label="Settings sections">
            {SETTINGS_GROUPS.filter(g => !g.needsAccount || supabaseOn).map(g => (
              <button key={g.key} className={group === g.key ? 'seg on' : 'seg'} onClick={() => setGroup(g.key)} role="tab" aria-selected={group === g.key}>
                {g.label}
              </button>
            ))}
          </nav>
          {/* every section stays mounted, whichever group is showing: the class
              above hides the rest, and their fetches start as Settings opens */}
          {SETTINGS_GROUPS.flatMap(g => g.sections.map((Section, i) => <Section key={`${g.key}-${i}`} {...ctx} />))}
        </div>

        <footer className="modal-foot">
          <span className="spacer" />
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </footer>
    </Modal>
  )
}
