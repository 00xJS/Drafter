import { useEffect, useRef, useState } from 'react'
import { appLockEnabled, authenticateAppLock, checkAppLock, setAppLockShowing, watchAppLock } from '../native'

/** Blurs the planner until Face ID / device passcode succeeds. */
export function LockGate() {
  const [locked, setLocked] = useState(() => appLockEnabled())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [label, setLabel] = useState('Face ID')
  const card = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (locked) card.current?.focus({ preventScroll: true })
  }, [locked])

  useEffect(() => {
    // The watcher goes on whether the lock is on right now or not.
    //
    // This effect runs once, at mount, and on the phone the page is resumed
    // rather than reloaded — for days, until something force-quits the app. So
    // turning the lock on in Settings mid-session used to leave nothing
    // listening: `pause`, `resume` and `visibilitychange` all fired and no one
    // was there, and the lock did not engage until the next cold start. That
    // is the one moment the setting is most expected to work.
    //
    // Registering it early costs nothing: watchAppLock re-reads
    // appLockEnabled() inside both of its handlers (src/native.ts), and so
    // does the callback below.
    let dispose = () => {}
    void watchAppLock(() => {
      if (appLockEnabled()) setLocked(true)
    }).then(d => {
      dispose = d
    })
    if (!appLockEnabled()) {
      setLocked(false)
      return () => dispose()
    }
    setLocked(true)
    void checkAppLock().then(s => setLabel(s.label))
    void authenticateAppLock('Unlock Drafter').then(ok => {
      if (ok) setLocked(false)
    })
    return () => dispose()
  }, [])

  /**
   * While the lock is up, the planner behind it is inert.
   *
   * The overlay is opaque, but it was only paint: the planner stayed in the
   * tab order and in the accessibility tree underneath. With a hardware
   * keyboard — an iPad, or the browser preview — focus stayed on whatever
   * control was last touched, so Enter pressed a button nobody could see. New
   * task opened the editor, a task row opened it, the sync pill synced, all
   * while the app said it was locked, and Tab walked the whole page.
   *
   * `inert` takes the subtree out of both at once, which is the thing being
   * asked for, rather than a focus trap that would have to keep guessing. It
   * is set on the planner's siblings rather than inside it, so nothing about
   * the planner's own tree has to know about the lock.
   */
  useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.getElementById('root')
    if (!root) return
    const behind = [...root.children].filter(el => !el.classList.contains('lock-overlay')) as HTMLElement[]
    for (const el of behind) el.inert = locked
    return () => {
      for (const el of behind) el.inert = false
    }
  }, [locked])

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
      {/* focused on mount: the first Tab then starts inside the card rather
          than wherever the planner left it */}
      <div className="lock-card" ref={card} tabIndex={-1}>
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
