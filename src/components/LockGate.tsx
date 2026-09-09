import { useEffect, useState } from 'react'
import { appLockEnabled, authenticateAppLock, checkAppLock, setAppLockShowing, watchAppLock } from '../native'

/** Blurs the planner until Face ID / device passcode succeeds. */
export function LockGate() {
  const [locked, setLocked] = useState(() => appLockEnabled())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [label, setLabel] = useState('Face ID')

  useEffect(() => {
    if (!appLockEnabled()) {
      setLocked(false)
      return
    }
    setLocked(true)
    void checkAppLock().then(s => setLabel(s.label))
    let dispose = () => {}
    void watchAppLock(() => {
      if (appLockEnabled()) setLocked(true)
    }).then(d => {
      dispose = d
    })
    void authenticateAppLock('Unlock Drafter').then(ok => {
      if (ok) setLocked(false)
    })
    return () => dispose()
  }, [])

  // The planner holds back anything that would write on arrival (a reminder's
  // Done button) until this clears, so the undo toast is not buried under the
  // card. Raising the flag is native.ts's job (watchAppLock sets it inside the
  // same callback that decides to lock, before React has committed anything);
  // this mirror exists for the first mount and, above all, for the clearing
  // edge, which is what replays a held link.
  useEffect(() => {
    setAppLockShowing(locked)
  }, [locked])
  // unmounting is not an unlock — the session dropped and the login overlay took
  // the screen, so clear the flag without releasing anything that was held back
  useEffect(() => () => setAppLockShowing(false, { silent: true }), [])

  const unlock = async () => {
    setBusy(true)
    setError('')
    const ok = await authenticateAppLock(`Unlock Drafter with ${label}`)
    setBusy(false)
    if (ok) setLocked(false)
    else setError('Couldn’t unlock. Try again, or use the device passcode.')
  }

  if (!locked) return null
  return (
    <div className="lock-overlay" role="dialog" aria-modal="true" aria-label="Drafter is locked">
      <div className="lock-card">
        <div className="brand">
          <span className="brand-mark">✈</span>
          <span>Drafter</span>
        </div>
        <p>Unlock with {label} to open your planner.</p>
        <button className="btn primary" disabled={busy} onClick={() => void unlock()}>
          {busy ? 'Waiting…' : `Unlock with ${label}`}
        </button>
        {error && <p className="warn">{error}</p>}
      </div>
    </div>
  )
}
