import { useEffect, useState } from 'react'
import { appLockEnabled, authenticateAppLock, checkAppLock, isNative, setAppLockEnabled } from '../../native'
import { useAsyncAction } from './useAsyncAction'

/** Reminders → Lock this iPhone: Face ID, Touch ID or the passcode after you leave the app. The app only. */
export function Lock() {
  const [lockOn, setLockOn] = useState(appLockEnabled())
  const [lockLabel, setLockLabel] = useState('Face ID')
  const [lockAvail, setLockAvail] = useState(false)
  const { busy: lockBusy, error: lockErr, run, setError: setLockErr } = useAsyncAction()
  useEffect(() => {
    if (!isNative()) return
    void checkAppLock().then(s => {
      setLockAvail(s.available)
      setLockLabel(s.label)
      if (s.reason) setLockErr(s.reason)
    })
  }, [setLockErr])

  if (!isNative()) return null
  return (
    <section className="settings-section g-reminders">
      <h3>Lock this iPhone</h3>
      <p className="field-hint">
        After you leave the app, {lockLabel} is required to see your planner again. Stays on this device — it does
        not change your Drafter password.
      </p>
      <p className="sync-line">
        <label className="cal-source mirror-row">
          <input
            type="checkbox"
            checked={lockOn}
            disabled={lockBusy || !lockAvail}
            onChange={async e => {
              setLockErr('')
              if (e.target.checked) {
                const verified = await run(async () => {
                  if (!(await authenticateAppLock(`Turn on ${lockLabel} for Drafter`))) throw new Error(`Couldn’t verify ${lockLabel}. Try again.`)
                })
                if (!verified) return
                setAppLockEnabled(true)
                setLockOn(true)
              } else {
                setAppLockEnabled(false)
                setLockOn(false)
              }
            }}
          />
          <span className="cal-source-name">Require {lockLabel} when opening Drafter</span>
        </label>
      </p>
      {lockErr && <p className="warn">{lockErr}</p>}
      {!lockAvail && <p className="field-hint">This device has no Face ID, Touch ID, or passcode available for apps.</p>}
    </section>
  )
}
