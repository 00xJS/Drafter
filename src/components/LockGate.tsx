import { useEffect, useState } from 'react'
import { appLockEnabled, authenticateAppLock, checkAppLock, watchAppLock } from '../native'

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
