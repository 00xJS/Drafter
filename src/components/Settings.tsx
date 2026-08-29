import { useEffect, useState } from 'react'
import { Store } from '../store'
import { getAIKey, getAIWorkspace, setAIKey, setAIWorkspace } from '../ai'
import { BackupStatus, chooseBackupFile, disableBackup, initBackup, resumeBackup } from '../backup'
import { enableNotifications, notificationPermission } from '../notify'
import { getSupabase, isSupabaseConfigured } from '../supabase'
import { fmtDateTime } from '../utils'

interface Props {
  store: Store
  onClose(): void
}

export function Settings({ store, onClose }: Props) {
  const [backup, setBackup] = useState<BackupStatus>('none')
  const [notif, setNotif] = useState(notificationPermission())
  const [aiKey, setKey] = useState(getAIKey())
  const [aiWorkspace, setWorkspace] = useState(getAIWorkspace())
  const [savedFlash, setSavedFlash] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [accountEmail, setAccountEmail] = useState('')
  const supabaseOn = isSupabaseConfigured()

  useEffect(() => {
    initBackup().then(setBackup)
    getSupabase()
      ?.auth.getSession()
      .then(({ data }) => setAccountEmail(data.session?.user.email ?? ''))
  }, [])

  const backupLabel: Record<BackupStatus, string> = {
    unsupported: 'Not supported in this browser (needs Chrome/Edge).',
    none: 'Off — pick a file and every change is written to it automatically.',
    'needs-permission': 'Paused — the browser needs you to re-allow access after a reload.',
    active: 'On — every change is written to your backup file.',
  }

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
                : 'Offline — changes stay in this browser.'}
            </p>
            <p className="field-hint">
              {supabaseOn
                ? 'Syncing to Supabase — your data is shared with every signed-in device and your bots.'
                : 'Run npm run server in the project folder to sync to a local SQLite database, or set the Supabase env vars for cloud sync.'}
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
              Get a notification when a scheduled post's time arrives (while the app is open).
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
            <h3>Auto-backup file</h3>
            <p>{backupLabel[backup]}</p>
            <div className="ai-row">
              {backup === 'needs-permission' && (
                <button className="btn" onClick={async () => setBackup(await resumeBackup())}>
                  Resume backups
                </button>
              )}
              {backup !== 'unsupported' && (
                <button className="btn" onClick={async () => setBackup(await chooseBackupFile())}>
                  {backup === 'none' ? 'Choose backup file' : 'Change file'}
                </button>
              )}
              {backup !== 'none' && backup !== 'unsupported' && (
                <button className="btn subtle" onClick={async () => setBackup(await disableBackup())}>
                  Turn off
                </button>
              )}
            </div>
          </section>

          <section className="settings-section">
            <h3>AI assist</h3>
            <p className="field-hint">
              Powers "Generate platform variants", "Suggest tags", and the Insights analysis. Preferred: run the sync
              server with <code>ANTHROPIC_API_KEY</code> set, so the key never touches the browser. Alternatively,
              paste a key here (stored only in this browser).
            </p>
            <div className="ai-row">
              <input
                type="password"
                placeholder="sk-ant-…"
                value={aiKey}
                onChange={e => setKey(e.target.value)}
                style={{ flex: 1 }}
              />
              <button
                className="btn"
                onClick={() => {
                  setAIKey(aiKey.trim())
                  setAIWorkspace(aiWorkspace.trim())
                  setSavedFlash(true)
                  setTimeout(() => setSavedFlash(false), 1500)
                }}
              >
                {savedFlash ? 'Saved ✓' : 'Save'}
              </button>
            </div>
            <div className="ai-row">
              <input
                placeholder="wrkspc_… (only for keys not scoped to a workspace)"
                value={aiWorkspace}
                onChange={e => setWorkspace(e.target.value)}
                style={{ flex: 1 }}
              />
            </div>
            <p className="field-hint">
              If the API says “anthropic-workspace-id is required”, either paste your workspace ID above — or simpler,
              create the key scoped to a workspace and leave this blank.
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
