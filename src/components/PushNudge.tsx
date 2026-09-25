import { useEffect, useState } from 'react'
import { APP_SETTINGS_URL, isNative } from '../native'
import { currentEndpoint, enablePush, fetchPushInfo, pushPermission, pushSupported, testPush } from '../push'

type State = 'hidden' | 'offer' | 'blocked' | 'busy' | 'on' | 'tested'

/** "Not now" on this device: the nudge is not offered here again. Settings → Notifications keeps the switch. */
export const PUSH_NUDGE_NOT_NOW_KEY = 'drafter:push-nudge-not-now'

function saidNotNow(): boolean {
  try {
    return !!localStorage.getItem(PUSH_NUDGE_NOT_NOW_KEY)
  } catch {
    return false
  }
}

function rememberNotNow(): void {
  try {
    localStorage.setItem(PUSH_NUDGE_NOT_NOW_KEY, new Date().toISOString())
  } catch {
    /* storage refused: it is offered again next time, which is all that is lost */
  }
}

/** The button's words, and Settings → Notifications' too: one phrase for one switch. */
export const TURN_ON = 'Turn on for this device'

/**
 * Where iOS has said no, asking again shows nothing: this goes to Drafter's
 * page in the iPhone Settings app instead, where notifications are given
 * back. The shell only: a browser's site settings have no address to open.
 */
export function OpenSettings({ primary = false }: { primary?: boolean }) {
  if (!isNative()) return null
  return (
    <a className={primary ? 'btn primary' : 'btn'} href={APP_SETTINGS_URL}>
      Open Settings
    </a>
  )
}

/**
 * The bell's own switch for this device. A notice always lands in the bell;
 * it reaches the lock screen only once this device has asked for pushes, and
 * that lived three taps deep in Settings. Both phones went days without it, so
 * a finished task or a household message waited in here until someone looked.
 *
 * Shown only when the server can push and this device is not one of the
 * account's subscriptions — the test Settings → Notifications makes — and
 * silent wherever push cannot work: local mode, a browser without it, offline.
 * "Not now" puts it away on this device for good. Where iOS or the browser has
 * already said no, asking again would show nothing, so it says where to turn
 * notifications on instead, and looks again when the app comes back to the front.
 */
export function PushNudge() {
  const [state, setState] = useState<State>('hidden')
  const [publicKey, setPublicKey] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!pushSupported() || saidNotNow()) return
    let live = true
    Promise.all([fetchPushInfo(), currentEndpoint(), pushPermission()])
      .then(([info, mine, allowed]) => {
        if (!live || !info.configured) return
        setPublicKey(info.publicKey ?? '')
        if (!(mine && info.subscriptions.includes(mine))) setState(allowed === 'denied' ? 'blocked' : 'offer')
      })
      // no server to ask (local mode) or no connection: there is nothing to offer
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  // turned on in the Settings app meanwhile: offer it here again on coming back
  useEffect(() => {
    if (state !== 'blocked') return
    let live = true
    const onShow = () => {
      if (document.visibilityState !== 'visible') return
      void pushPermission().then(allowed => {
        if (live && allowed !== 'denied') setState(s => (s === 'blocked' ? 'offer' : s))
      })
    }
    document.addEventListener('visibilitychange', onShow)
    return () => {
      live = false
      document.removeEventListener('visibilitychange', onShow)
    }
  }, [state])

  if (state === 'hidden') return null

  const turnOn = () => {
    setState('busy')
    setError('')
    enablePush(publicKey)
      .then(() => setState('on'))
      .catch(async (e: unknown) => {
        // said no just now: asking again would show nothing, so say where the switch is
        const allowed = await pushPermission().catch(() => null)
        if (allowed === 'denied') {
          setState('blocked')
          return
        }
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
  const notNow = () => {
    rememberNotNow()
    setState('hidden')
  }

  const on = state === 'on' || state === 'tested'
  const later = (
    <button type="button" className="btn subtle" onClick={notNow}>
      Not now
    </button>
  )
  if (state === 'blocked') {
    return (
      <div className="push-nudge" role="status">
        <p>
          {isNative()
            ? 'iOS isn’t letting Drafter send notifications, so these stay in here. Turn them on in iPhone Settings → Notifications → Drafter.'
            : 'This browser is blocking Drafter’s notifications, so these stay in here. Allow them in the browser’s settings for this site.'}
        </p>
        {isNative() ? (
          <div className="push-nudge-actions">
            <OpenSettings primary />
            {later}
          </div>
        ) : (
          later
        )}
      </div>
    )
  }
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
        <div className="push-nudge-actions">
          <button type="button" className="btn primary" disabled={state === 'busy'} onClick={turnOn}>
            {state === 'busy' ? 'Turning on…' : TURN_ON}
          </button>
          {later}
        </div>
      )}
      {error && <p className="field-hint push-nudge-error">{error}</p>}
    </div>
  )
}
