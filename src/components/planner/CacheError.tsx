import { clearLocalData } from '../../idb'
import { ConfirmButton } from '../ConfirmButton'

/**
 * This device's saved copy would not open (the store's loadError), even after
 * a few tries. Nothing is drawn in its place: an empty planner over a copy
 * that is really there would be synced and written over it, and whatever was
 * edited here and not yet sent went with it. Try again reads it once more;
 * Reload is what a WebKit database that lost its connection needs. With an
 * account, starting afresh from the server is the way out of a copy that will
 * never open again — and it says what it costs.
 */
export function CacheError({ error, retry, withServer }: { error: string; retry(): void; withServer: boolean }) {
  return (
    <div className="empty-hero error-hero" role="alert">
      <h2>Your planner on this device won’t open</h2>
      <p>Its saved copy couldn’t be read. Nothing has been changed or sent: it stays exactly as it was until it can be opened.</p>
      <p className="error-detail">{error}</p>
      <p>
        <button className="btn" onClick={retry}>
          Try again
        </button>{' '}
        <button className="btn subtle" onClick={() => window.location.reload()}>
          Reload
        </button>
      </p>
      {withServer && (
        <p>
          <ConfirmButton
            className="btn subtle danger"
            confirmLabel="Lose unsynced changes? Click again"
            onConfirm={() => void clearLocalData().finally(() => window.location.reload())}
          >
            Start again from the server
          </ConfirmButton>
          <br />
          <small className="muted">Downloads everything again. Changes made on this device that never synced would be lost.</small>
        </p>
      )}
    </div>
  )
}
