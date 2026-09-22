import type { SettingsCtx } from './context'

/**
 * Household → Admin, the owner's only. The header's Admin button is hidden on
 * a phone, so this is the way in there — and it moved out of Data in v3.29,
 * because Data is behind "More…" and that made the route Settings → More… →
 * Data → scroll. Four steps to the accounts screen is a screen nobody finds.
 * Household is one tap from the front of Settings and is what Admin is about.
 */
export function AdminLink({ onOpenAdmin }: SettingsCtx) {
  if (!onOpenAdmin) return null
  return (
    <section className="settings-section g-household">
      <h3>Admin</h3>
      <p className="field-hint">Accounts, backups and integration tests. The header shortcut is hidden on a phone, so this is the way in.</p>
      <button className="btn" onClick={onOpenAdmin}>
        Open admin
      </button>
    </section>
  )
}
