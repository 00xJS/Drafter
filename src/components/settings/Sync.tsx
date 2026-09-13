import { fmtDateTime } from '../../utils'
import { ConfirmButton } from '../ConfirmButton'
import type { SettingsCtx } from './context'

/** Data → Sync: where this device stands, what the server refused, and the two ways to go again. */
export function Sync({ store, supabaseOn, syncing, setSyncing }: SettingsCtx) {
  return (
    <section className="settings-section g-data">
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
          ? 'Projects, tasks, notes, people, places, recipes, meals and grocery lists live in Supabase Postgres and sync to every signed-in device (phone and web). Images sync through Supabase Storage.'
          : 'No backend configured — data stays in this browser. Use Export in the Tasks tab for backups.'}
      </p>
      {!!store.syncInfo.pending && (
        <p className="warn">
          {store.syncInfo.pending} change{store.syncInfo.pending === 1 ? '' : 's'} not confirmed by the server yet — they are kept and
          retried on every sync.
        </p>
      )}
      {store.failures.length > 0 && (
        <>
          <p className="warn">
            <strong>Couldn’t sync ({store.failures.length})</strong> — the server refused these. They stay on this device and are
            tried again on their own; discard this device’s copy to take the server’s instead.
          </p>
          <ul className="dash-list">
            {store.failures.map(f => (
              <li key={f.id} className="trash-row">
                <div className="dash-main">
                  <span className="dash-title">
                    {f.kind && <small className="muted">{f.kind[0].toUpperCase() + f.kind.slice(1)}</small>} {f.label}
                  </span>
                  <span className="dash-meta">
                    <small className="muted">
                      {f.reason ? `${f.reason} · ` : ''}refused {f.attempts === 1 ? 'once' : `${f.attempts} times`}
                    </small>
                  </span>
                </div>
                <span className="trash-actions">
                  <button className="btn" onClick={() => void store.retrySync(f.id)}>
                    Try again
                  </button>
                  <ConfirmButton className="btn subtle danger" confirmLabel="Discard? Click again" onConfirm={() => store.discardLocal(f.id)}>
                    Discard my copy
                  </ConfirmButton>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="sync-line">
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
        <button
          className="btn subtle"
          disabled={syncing}
          title="Forget where this device got to and fetch everything again"
          onClick={async () => {
            setSyncing(true)
            await store.fullResync()
            setSyncing(false)
          }}
        >
          Full resync
        </button>
        <small>Use a full resync if a device looks out of date.</small>
      </p>
    </section>
  )
}
