import { useEffect, useState } from 'react'
import { currentEndpoint, enablePush, fetchPushInfo, pushSupported, testPush } from '../push'

type State = 'hidden' | 'offer' | 'busy' | 'on' | 'tested'

/**
 * The bell's own switch for this device. A notice always lands in the bell;
 * it reaches the lock screen only once this device has asked for pushes, and
 * that lived three taps deep in Settings. Both phones went days without it, so
 * a finished task or a household message waited in here until someone looked.
 *
 * Shown only when the server can push and this device is not one of the
 * account's subscriptions — the test Settings → Notifications makes — and
 * silent wherever push cannot work: local mode, a browser without it, offline.
 */
export function PushNudge() {
  const [state, setState] = useState<State>('hidden')
  const [publicKey, setPublicKey] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!pushSupported()) return
    let live = true
    Promise.all([fetchPushInfo(), currentEndpoint()])
      .then(([info, mine]) => {
        if (!live || !info.configured) return
        setPublicKey(info.publicKey ?? '')
        if (!(mine && info.subscriptions.includes(mine))) setState('offer')
      })
      // no server to ask (local mode) or no connection: there is nothing to offer
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  if (state === 'hidden') return null

  const turnOn = () => {
    setState('busy')
    setError('')
    enablePush(publicKey)
      .then(() => setState('on'))
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
        setState('offer')
      })
  }
  const sendTest = () => {
    setError('')
    testPush()
      .then(() => setState('tested'))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  const on = state === 'on' || state === 'tested'
  return (
    <div className={on ? 'push-nudge on' : 'push-nudge'} role="status">
      <p>{on ? 'Notifications are on for this device.' : 'These stay in here until you turn on notifications for this device.'}</p>
      {state === 'tested' ? (
        <p className="field-hint">A test is on its way.</p>
      ) : on ? (
        <button type="button" className="btn" onClick={sendTest}>
          Send a test
        </button>
      ) : (
        <button type="button" className="btn primary" disabled={state === 'busy'} onClick={turnOn}>
          {state === 'busy' ? 'Turning on…' : 'Turn on'}
        </button>
      )}
      {error && <p className="field-hint push-nudge-error">{error}</p>}
    </div>
  )
}
