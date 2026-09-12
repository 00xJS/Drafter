import type { SettingsCtx } from './context'

/** Data → Admin (the owner only): the header's Admin button is hidden on a phone, so this is the way in there. */
export function AdminLink({ onOpenAdmin }: SettingsCtx) {
  if (!onOpenAdmin) return null
  return (
    <section className="settings-section g-data">
      <h3>Admin</h3>
      <p className="field-hint">Accounts, backups and integration tests. The header shortcut is hidden on a phone, so this is the way in.</p>
      <button className="btn" onClick={onOpenAdmin}>
        Open admin
      </button>
    </section>
  )
}
