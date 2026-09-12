import { useEffect, useState } from 'react'
import { GOOGLE_PUSH_ID, GOOGLE_PUSH_URL, GoogleCalendarInfo, GoogleStatus, connectCalendarAccount, googleAction, googlePushId, isGoogleSource, mirrorToggle, oauthCompleting, onOAuthSettled, resetGooglePushCursor } from '../../calendars'
import { newerStamp } from '../../itemops'
import { PROJECT_COLORS } from '../../types'
import { timeAgo, uid } from '../../utils'
import type { SettingsCtx } from './context'
import { useAsyncAction } from './useAsyncAction'

/** Calendars → Google Calendar: connect, tick calendars to show, and mirror tasks into a Drafter calendar there. */
export function GoogleCalendar({ store, calendars, googlePush, household }: SettingsCtx) {
  const [google, setGoogle] = useState<GoogleStatus | null>(null)
  const [googleCals, setGoogleCals] = useState<GoogleCalendarInfo[] | null>(null)
  // the app may be finishing a Google sign-in as Settings reopens on its return
  const { busy: googleBusy, error: googleError, setBusy: setGoogleBusy, setError: setGoogleError } = useAsyncAction(() => oauthCompleting() === 'google')
  const myPushId = household.myId ? googlePushId(household.myId) : GOOGLE_PUSH_ID
  const pushSource = store.calendars.find(c => c.id === myPushId) ?? store.calendars.find(c => c.id === GOOGLE_PUSH_ID)
  const mirroring = !!pushSource?.enabled

  useEffect(() => {
    const loadGoogle = () =>
      googleAction<GoogleStatus>('status')
        .then(st => {
          setGoogle(st)
          if (st.connected) googleAction<{ calendars: GoogleCalendarInfo[] }>('calendars').then(r => setGoogleCals(r.calendars)).catch(e => setGoogleError((e as Error).message))
        })
        .catch(e => setGoogleError((e as Error).message))
    // A sign-in the app is finishing right now reports below; asking for its
    // status before it lands would offer "Connect" all over again.
    if (oauthCompleting() !== 'google') void loadGoogle()
    // The iOS app finishes a calendar sign-in itself when Safari hands it back
    // (connectCalendarAccount), and the planner reopens Settings as it does:
    // the result, or the reason it failed, is heard here.
    return onOAuthSettled(r => {
      if (r.provider !== 'google') return
      setGoogleBusy(false)
      if (r.ok) void loadGoogle()
      else setGoogleError(r.error ?? 'Google Calendar could not be connected.')
    })
  }, [setGoogleBusy, setGoogleError])

  const connectGoogle = async () => {
    setGoogleBusy(true)
    setGoogleError('')
    try {
      const mode = await connectCalendarAccount('google')
      if (mode === 'native') setGoogleBusy(false)
    } catch (e) {
      setGoogleError((e as Error).message)
      setGoogleBusy(false)
    }
  }

  const disconnectGoogle = async () => {
    if (!window.confirm('Disconnect Google Calendar? Its calendars disappear from the overlay and mirroring stops (already-mirrored events stay in Google).')) return
    setGoogleBusy(true)
    try {
      await googleAction('disconnect')
      for (const c of store.calendars.filter(isGoogleSource)) store.remove(c.id)
      setGoogle(g => (g ? { ...g, connected: false, email: null } : g))
      setGoogleCals(null)
    } catch (e) {
      setGoogleError((e as Error).message)
    } finally {
      setGoogleBusy(false)
    }
  }

  const toggleGoogleCalendar = (cal: GoogleCalendarInfo, on: boolean) => {
    const url = `google:${cal.id}`
    const existing = store.calendars.find(c => c.url === url)
    if (on && !existing) {
      const now = new Date().toISOString()
      store.upsert({ kind: 'calendar', id: uid(), name: cal.name, url, color: cal.color && /^#/.test(cal.color) ? cal.color : PROJECT_COLORS[4], enabled: true, createdAt: now, updatedAt: now })
    } else if (on && existing && !existing.enabled) {
      store.upsert({ ...existing, enabled: true, updatedAt: newerStamp(existing.updatedAt) })
    } else if (!on && existing) {
      store.remove(existing.id)
    }
  }

  const setMirroring = (on: boolean) => {
    const now = new Date().toISOString()
    // migrate legacy google-push → google-push-${myId}, in BOTH directions:
    // Planner still watches the legacy id, so a leftover enabled row would keep
    // the mirror running with this switch reading off (see mirrorToggle).
    const plan = mirrorToggle(pushSource, myPushId, on)
    if (plan.removeId) store.remove(plan.removeId)
    if (plan.write === 'existing' && pushSource) {
      store.upsert({ ...pushSource, id: myPushId, enabled: on, updatedAt: newerStamp(pushSource.updatedAt) })
    } else if (plan.write === 'fresh') {
      store.upsert({ kind: 'calendar', id: myPushId, name: 'Drafter → Google', url: GOOGLE_PUSH_URL, color: PROJECT_COLORS[0], enabled: on, createdAt: pushSource?.createdAt ?? now, updatedAt: now })
    }
    if (on) {
      resetGooglePushCursor(household.myId)
      window.setTimeout(() => googlePush.pushNow(), 500)
    }
  }

  return (
    <>
      <h4>Google Calendar</h4>
      {google?.connected ? (
        <>
          <p className="sync-line">
            <span>
              Connected{google.email ? ` as ${google.email}` : ''}. Tick the calendars to show; they are tied to your
              account only.
            </span>
            <button className="btn subtle danger" disabled={googleBusy} onClick={disconnectGoogle}>
              Disconnect
            </button>
          </p>
          {googleCals ? (
            <ul className="cal-sources">
              {googleCals.map(cal => {
                const src = store.calendars.find(c => c.url === `google:${cal.id}`)
                // Drafter's own calendar is no overlay: what it holds is already on the grid. Listed only to untick one ticked before.
                if (cal.drafter && !src) return null
                return (
                  <li key={cal.id} className="cal-source">
                    <input type="checkbox" checked={!!src?.enabled} aria-label={`Show ${cal.name}`} onChange={e => toggleGoogleCalendar(cal, e.target.checked)} />
                    <span className="pdot" style={{ background: cal.color ?? PROJECT_COLORS[4] }} />
                    <span className="cal-source-name">
                      {cal.name}
                      {cal.primary && <small> · primary</small>}
                      {cal.drafter && <small> · Drafter’s own calendar — untick it</small>}
                    </span>
                    <span className="cal-source-status">
                      {src && calendars.errors[src.id] ? <span className="warn">{calendars.errors[src.id]}</span> : src ? <small>{calendars.events.filter(e => e.sourceId === src.id).length} events</small> : null}
                    </span>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="field-hint">{googleError || 'Loading your calendars…'}</p>
          )}
          <label className="cal-source mirror-row">
            <input type="checkbox" checked={mirroring} onChange={e => setMirroring(e.target.checked)} />
            <span className="cal-source-name">Mirror my tasks into a “Drafter” calendar in Google</span>
            <span className="cal-source-status">
              {googlePush.error ? (
                <span className="warn">{googlePush.error}</span>
              ) : googlePush.pending ? (
                <small>pushing…</small>
              ) : googlePush.waiting ? (
                <small>{googlePush.waiting} waiting to go out — retrying</small>
              ) : googlePush.lastAt ? (
                <small>pushed {timeAgo(googlePush.lastAt)}</small>
              ) : null}
            </span>
          </label>
          {googlePush.notices?.google && (
            <p className="sync-line">
              <span className="warn">{googlePush.notices.google}</span>
              <button className="btn subtle" onClick={() => googlePush.dismissNotice?.('google')}>
                Got it
              </button>
            </p>
          )}
          <p className="field-hint">
            Open tasks with a due date appear in Google within seconds of a change (and vanish when done). Google's
            own events flow the other way through the ticked calendars above. Edit tasks in Drafter, not in Google.
          </p>
        </>
      ) : google?.configured ? (
        <p className="sync-line">
          <button className="btn primary" disabled={googleBusy} onClick={connectGoogle}>
            {googleBusy ? 'Opening Google…' : 'Connect Google Calendar'}
          </button>
          <small>Read your calendars and mirror tasks. Tokens stay server-side, per account.</small>
        </p>
      ) : google ? (
        <p className="field-hint">Calendar sync isn’t available yet.</p>
      ) : (
        <p className="field-hint">{googleError ? `Google status unavailable: ${googleError}` : 'Checking Google…'}</p>
      )}
      {googleError && google?.connected && <p className="warn">{googleError}</p>}
    </>
  )
}
