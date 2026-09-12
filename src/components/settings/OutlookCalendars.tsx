import { useEffect, useState } from 'react'
import { MicrosoftCalendarInfo, MicrosoftStatus, connectCalendarAccount, disconnectOutlook, microsoftAction, msPushId, msPushUrl, msSourceUrl, oauthCompleting, onOAuthSettled, resetMicrosoftPushCursor } from '../../calendars'
import { newerStamp } from '../../itemops'
import { PROJECT_COLORS } from '../../types'
import { timeAgo, uid } from '../../utils'
import { ConfirmButton } from '../ConfirmButton'
import type { SettingsCtx } from './context'
import { useAsyncAction } from './useAsyncAction'

/** One connected Outlook account's calendars, or why they could not be listed. */
type AccountCalendars = { account: { id: string; name: string; email: string }; calendars: MicrosoftCalendarInfo[]; error?: string }

/** Calendars → Outlook / Microsoft 365: any number of accounts, each with its calendars and its own mirror. */
export function OutlookCalendars({ store, calendars, microsoftSync }: SettingsCtx) {
  const [ms, setMs] = useState<MicrosoftStatus | null>(null)
  const [msCals, setMsCals] = useState<AccountCalendars[] | null>(null)
  // the app may be finishing an Outlook sign-in as Settings reopens on its return
  const { busy: msBusy, error: msError, setBusy: setMsBusy, setError: setMsError } = useAsyncAction(() => oauthCompleting() === 'microsoft')

  useEffect(() => {
    const loadMicrosoft = () =>
      microsoftAction<MicrosoftStatus>('status')
        .then(st => {
          setMs(st)
          if (st.accounts.length > 0) {
            microsoftAction<{ accounts: AccountCalendars[] }>('calendars')
              .then(r => setMsCals(r.accounts))
              .catch(e => setMsError((e as Error).message))
          }
        })
        .catch(e => setMsError((e as Error).message))
    // A sign-in the app is finishing right now reports below; asking for its
    // status before it lands would offer "Connect" all over again.
    if (oauthCompleting() !== 'microsoft') void loadMicrosoft()
    // The iOS app finishes a calendar sign-in itself when Safari hands it back
    // (connectCalendarAccount), and the planner reopens Settings as it does:
    // the result, or the reason it failed, is heard here.
    return onOAuthSettled(r => {
      if (r.provider === 'google') return
      setMsBusy(false)
      if (r.ok) void loadMicrosoft()
      else setMsError(r.error ?? 'Outlook could not be connected.')
    })
  }, [setMsBusy, setMsError])

  const connectOutlook = async () => {
    setMsBusy(true)
    setMsError('')
    try {
      const mode = await connectCalendarAccount('microsoft')
      if (mode === 'native') setMsBusy(false)
    } catch (e) {
      setMsError((e as Error).message)
      setMsBusy(false)
    }
  }

  return (
    <>
      <h4>Outlook / Microsoft 365</h4>
      {ms?.configured ? (
        <>
          {ms.accounts.length === 0 ? (
            <p className="sync-line">
              <button className="btn primary" disabled={msBusy} onClick={connectOutlook}>
                {msBusy ? 'Opening Microsoft…' : 'Connect Outlook'}
              </button>
              <small>Personal and work accounts both work — connect as many as you like.</small>
            </p>
          ) : (
            <>
              {(msCals ?? ms.accounts.map(a => ({ account: a, calendars: [] as MicrosoftCalendarInfo[] }))).map(entry => {
                const acct = entry.account
                const mirrorSource = store.calendars.find(c => c.url === msPushUrl(acct.id))
                // each account's own trouble: one dead account no longer speaks for the rest
                const mirrorError = mirrorSource?.enabled ? microsoftSync.accountErrors?.[acct.id] : undefined
                return (
                  <div key={acct.id} className="ms-account">
                    <p className="sync-line">
                      <strong>{acct.name}</strong>
                      <small className="muted">{acct.email}</small>
                      <span className="spacer" />
                      <ConfirmButton
                        className="btn subtle danger"
                        confirmLabel="Disconnect?"
                        onConfirm={async () => {
                          setMsError('')
                          // the server first: a refused disconnect must not look done here
                          try {
                            await disconnectOutlook(acct.id, store.calendars, id => store.remove(id))
                          } catch (e) {
                            setMsError(`Could not disconnect ${acct.email || acct.name}: ${(e as Error).message} Nothing was changed.`)
                            return
                          }
                          setMsCals(cur => (cur ?? []).filter(x => x.account.id !== acct.id))
                          try {
                            setMs(await microsoftAction<MicrosoftStatus>('status'))
                          } catch {
                            setMs(cur => (cur ? { ...cur, accounts: cur.accounts.filter(a => a.id !== acct.id) } : cur))
                          }
                        }}
                      >
                        Disconnect
                      </ConfirmButton>
                    </p>
                    {'error' in entry && entry.error ? (
                      <p className="warn">{entry.error}</p>
                    ) : (
                      <ul className="cal-sources">
                        {entry.calendars.map(cal => {
                          const src = store.calendars.find(c => c.url === msSourceUrl(acct.id, cal.id))
                          // the account's own Drafter calendar would draw every entry twice; listed only to untick one ticked before
                          if (cal.drafter && !src) return null
                          return (
                            <li key={cal.id} className="cal-source">
                              <input
                                type="checkbox"
                                checked={!!src?.enabled}
                                aria-label={`Show ${cal.name}`}
                                onChange={e => {
                                  const url = msSourceUrl(acct.id, cal.id)
                                  const existing = store.calendars.find(c => c.url === url)
                                  const now = new Date().toISOString()
                                  if (e.target.checked && !existing) {
                                    store.upsert({ kind: 'calendar', id: uid(), name: `${cal.name} (${acct.email || acct.name})`, url, color: PROJECT_COLORS[2], enabled: true, createdAt: now, updatedAt: now })
                                  } else if (e.target.checked && existing) {
                                    store.upsert({ ...existing, enabled: true, updatedAt: newerStamp(existing.updatedAt) })
                                  } else if (existing) {
                                    store.remove(existing.id)
                                  }
                                }}
                              />
                              <span className="pdot" style={{ background: PROJECT_COLORS[2] }} />
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
                    )}
                    <label className="cal-source mirror-row">
                      <input
                        type="checkbox"
                        checked={!!mirrorSource?.enabled}
                        onChange={e => {
                          const now = new Date().toISOString()
                          if (mirrorSource) store.upsert({ ...mirrorSource, enabled: e.target.checked, updatedAt: newerStamp(mirrorSource.updatedAt) })
                          else if (e.target.checked)
                            store.upsert({ kind: 'calendar', id: msPushId(acct.id), name: `Drafter → ${acct.email || acct.name}`, url: msPushUrl(acct.id), color: PROJECT_COLORS[0], enabled: true, createdAt: now, updatedAt: now })
                          if (e.target.checked) {
                            resetMicrosoftPushCursor(acct.id)
                            window.setTimeout(() => microsoftSync.pushNow(), 500)
                          }
                        }}
                      />
                      <span className="cal-source-name">Mirror my tasks into a “Drafter” calendar here</span>
                      <span className="cal-source-status">
                        {mirrorError ? (
                          <span className="warn">{mirrorError}</span>
                        ) : !mirrorSource?.enabled ? null : microsoftSync.pending ? (
                          <small>syncing…</small>
                        ) : microsoftSync.lastAt ? (
                          <small>synced {timeAgo(microsoftSync.lastAt)}</small>
                        ) : null}
                      </span>
                    </label>
                    {microsoftSync.notices?.[acct.id] && (
                      <p className="sync-line">
                        <span className="warn">{microsoftSync.notices[acct.id]}</span>
                        <button className="btn subtle" onClick={() => microsoftSync.dismissNotice?.(acct.id)}>
                          Got it
                        </button>
                      </p>
                    )}
                  </div>
                )
              })}
              <p className="sync-line">
                <button className="btn" disabled={msBusy} onClick={connectOutlook}>
                  + Connect another account
                </button>
                <small>Add your work account alongside your personal one.</small>
              </p>
            </>
          )}
          <p className="field-hint">
            Outlook events show on the Month view, the Timeline and Today. Mirroring writes open, dated tasks into a Drafter
            calendar there, and moving one in Outlook moves its due date back here.
          </p>
        </>
      ) : ms ? (
        <p className="field-hint">Calendar sync isn’t available yet.</p>
      ) : (
        <p className="field-hint">{msError ? `Outlook status unavailable: ${msError}` : 'Checking Outlook…'}</p>
      )}
      {msError && ms?.configured && <p className="warn">{msError}</p>}
    </>
  )
}
