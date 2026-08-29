import { useEffect, useState } from 'react'
import { Store } from '../store'
import { enableNotifications, notificationPermission } from '../notify'
import { getSupabase, isSupabaseConfigured } from '../supabase'
import { fmtDateTime } from '../utils'

interface Props {
  store: Store
  onClose(): void
}

export function Settings({ store, onClose }: Props) {
  const [notif, setNotif] = useState(notificationPermission())
  const [accountEmail, setAccountEmail] = useState('')
  const [syncing, setSyncing] = useState(false)
  const supabaseOn = isSupabaseConfigured()

  useEffect(() => {
    getSupabase()
      ?.auth.getSession()
      .then(({ data }) => setAccountEmail(data.session?.user.email ?? ''))
  }, [])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal narrow" role="dialog" aria-modal="true">
        <header className="modal-head">
          <h2>Settings</h2>
          <button className="btn subtle" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal-body">
          <section className="settings-section">
            <h3>Sync</h3>
            <p className={store.syncInfo.online ? 'sync-ok' : 'sync-off'}>
              {store.syncInfo.online
                ? `Connected — last synced ${store.syncInfo.lastAt ? fmtDateTime(store.syncInfo.lastAt) : 'just now'}.`
                : store.syncInfo.authError
                  ? 'Session expired — sign in again to resume syncing.'
                  : 'Offline — changes stay on this device until the connection returns.'}
            </p>
            <p className="field-hint">
              {supabaseOn
                ? 'Your data lives in Supabase Postgres, shared with every signed-in device and your bots. Images sync through Supabase Storage.'
                : 'No backend configured — data stays in this browser. Use Export in the Posts tab for backups.'}
            </p>
            <button
              className="btn"
              disabled={syncing}
              onClick={async () => {
                setSyncing(true)
                await store.syncNowManual()
                setSyncing(false)
              }}
            >
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
          </section>

          {supabaseOn && (
            <section className="settings-section">
              <h3>Account</h3>
              <p>{accountEmail ? `Signed in as ${accountEmail}.` : 'Signed in.'}</p>
              <button
                className="btn"
                onClick={async () => {
                  await getSupabase()?.auth.signOut()
                  onClose()
                }}
              >
                Sign out
              </button>
            </section>
          )}

          <section className="settings-section">
            <h3>Reminders</h3>
            <p className="field-hint">
              Get a notification when a scheduled post's time arrives. Reminders fire while Drafter is open on this
              device — there is no server-side push (yet).
            </p>
            <p>
              {notif === 'granted'
                ? 'Notifications are on.'
                : notif === 'denied'
                  ? 'Notifications are blocked — allow them in the browser’s site settings.'
                  : notif === 'unsupported'
                    ? 'Not supported in this browser.'
                    : 'Notifications are off.'}
            </p>
            {notif === 'default' && (
              <button
                className="btn"
                onClick={async () => {
                  setNotif(await enableNotifications())
                }}
              >
                Enable notifications
              </button>
            )}
          </section>

          <section className="settings-section">
            <h3>AI assist</h3>
            <p className="field-hint">
              The ✨ features run through the site's server-side proxy — configure <code>ANTHROPIC_API_KEY</code> in the
              host environment (Netlify). No key is ever stored in the browser.
            </p>
          </section>
        </div>

        <footer className="modal-foot">
          <span className="spacer" />
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  )
}
