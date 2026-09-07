import { useEffect, useState } from 'react'
import { Store } from '../store'
import { CalendarFeedInfo, CalendarState, GOOGLE_PUSH_ID, GOOGLE_PUSH_URL, GoogleCalendarInfo, GooglePushState, GoogleStatus, MicrosoftCalendarInfo, MicrosoftStatus, feedAction, fetchFeedInfo, googleAction, inboundAction, isGoogleSource, isMicrosoftSource, microsoftAction, msPushId, msPushUrl, msSourceUrl, resetGooglePushCursor, resetMicrosoftPushCursor } from '../calendars'
import { newerStamp } from '../itemops'
import { enableNotifications, notificationPermission } from '../notify'
import { getSupabase, isSupabaseConfigured } from '../supabase'
import { PROJECT_COLORS } from '../types'
import { fmtDateTime, timeAgo, uid } from '../utils'
import { ConfirmButton } from './ConfirmButton'
import { PushInfo, currentEndpoint, disablePush, enablePush, fetchPushInfo, pushSupported, savePushPrefs, testPush } from '../push'
import { householdAction } from '../household'
import type { HouseholdInfo } from '../household'

interface Props {
  store: Store
  calendars: CalendarState
  googlePush: GooglePushState
  microsoftSync: GooglePushState
  household: { info: HouseholdInfo | null; myId: string | null; refresh(): Promise<void>; error?: string }
  onClose(): void
}

export function Settings({ store, calendars, googlePush, microsoftSync, household, onClose }: Props) {
  const [hhName, setHhName] = useState('')
  const [invite, setInvite] = useState('')
  const [displayName, setDisplayName] = useState(household.info?.me.displayName ?? '')
  const [hhBusy, setHhBusy] = useState(false)
  const [hhError, setHhError] = useState('')
  const runHh = async (fn: () => Promise<unknown>) => {
    setHhBusy(true)
    setHhError('')
    try {
      await fn()
      await household.refresh()
    } catch (e) {
      setHhError((e as Error).message)
    } finally {
      setHhBusy(false)
    }
  }
  const [notif, setNotif] = useState(notificationPermission())
  const [accountEmail, setAccountEmail] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [calName, setCalName] = useState('')
  const [calUrl, setCalUrl] = useState('')
  const [calColor, setCalColor] = useState(PROJECT_COLORS[3])
  const [feed, setFeed] = useState<CalendarFeedInfo | null>(null)
  const [feedError, setFeedError] = useState('')
  const [feedBusy, setFeedBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [ms, setMs] = useState<MicrosoftStatus | null>(null)
  const [msCals, setMsCals] = useState<{ account: { id: string; name: string; email: string }; calendars: MicrosoftCalendarInfo[]; error?: string }[] | null>(null)
  const [msBusy, setMsBusy] = useState(false)
  const [msError, setMsError] = useState('')
  const [google, setGoogle] = useState<GoogleStatus | null>(null)
  const [googleError, setGoogleError] = useState('')
  const [googleCals, setGoogleCals] = useState<GoogleCalendarInfo[] | null>(null)
  const [googleBusy, setGoogleBusy] = useState(false)
  const supabaseOn = isSupabaseConfigured()
  const [push, setPush] = useState<PushInfo | null>(null)
  const [pushError, setPushError] = useState('')
  const [pushBusy, setPushBusy] = useState(false)
  const [thisEndpoint, setThisEndpoint] = useState<string | null>(null)
  const [digestHour, setDigestHour] = useState(8)
  useEffect(() => {
    fetchPushInfo()
      .then(info => {
        setPush(info)
        // render the SAVED hour, never the local default
        if (Number.isInteger(info.digestHour)) setDigestHour(info.digestHour)
      })
      .catch(e => setPushError((e as Error).message))
    currentEndpoint().then(setThisEndpoint)
  }, [])
  const runPush = async (fn: () => Promise<unknown>, after?: () => void) => {
    setPushBusy(true)
    setPushError('')
    try {
      await fn()
      after?.()
      setPush(await fetchPushInfo())
      setThisEndpoint(await currentEndpoint())
    } catch (e) {
      setPushError((e as Error).message)
    } finally {
      setPushBusy(false)
    }
  }
  const pushSource = store.calendars.find(c => c.id === GOOGLE_PUSH_ID)
  const mirroring = !!pushSource?.enabled

  useEffect(() => {
    fetchFeedInfo()
      .then(setFeed)
      .catch(e => setFeedError((e as Error).message))
    microsoftAction<MicrosoftStatus>('status')
      .then(st => {
        setMs(st)
        if (st.accounts.length > 0) {
          microsoftAction<{ accounts: typeof msCals }>('calendars')
            .then(r => setMsCals(r.accounts))
            .catch(e => setMsError((e as Error).message))
        }
      })
      .catch(e => setMsError((e as Error).message))
    googleAction<GoogleStatus>('status')
      .then(st => {
        setGoogle(st)
        if (st.connected) googleAction<{ calendars: GoogleCalendarInfo[] }>('calendars').then(r => setGoogleCals(r.calendars)).catch(e => setGoogleError((e as Error).message))
      })
      .catch(e => setGoogleError((e as Error).message))
  }, [])

  const runFeed = async (action: 'enable' | 'rotate' | 'disable') => {
    setFeedBusy(true)
    setFeedError('')
    try {
      setFeed(await feedAction(action))
    } catch (e) {
      setFeedError((e as Error).message)
    } finally {
      setFeedBusy(false)
    }
  }

  const connectGoogle = async () => {
    setGoogleBusy(true)
    setGoogleError('')
    try {
      const { url } = await googleAction<{ url: string }>('auth')
      window.location.href = url
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
    if (pushSource) store.upsert({ ...pushSource, enabled: on, updatedAt: newerStamp(pushSource.updatedAt) })
    else if (on) store.upsert({ kind: 'calendar', id: GOOGLE_PUSH_ID, name: 'Drafter → Google', url: GOOGLE_PUSH_URL, color: PROJECT_COLORS[0], enabled: true, createdAt: now, updatedAt: now })
    if (on) {
      resetGooglePushCursor()
      window.setTimeout(() => googlePush.pushNow(), 500)
    }
  }

  const addCalendar = () => {
    const url = calUrl.trim().replace(/^webcal:\/\//i, 'https://')
    if (!url) return
    const now = new Date().toISOString()
    store.upsert({ kind: 'calendar', id: uid(), name: calName.trim() || 'Calendar', url, color: calColor, enabled: true, createdAt: now, updatedAt: now })
    setCalName('')
    setCalUrl('')
  }

  useEffect(() => {
    getSupabase()
      ?.auth.getSession()
      .then(({ data }) => setAccountEmail(data.session?.user.email ?? ''))
  }, [])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal narrow" role="dialog" aria-modal="true">
        <header className="modal-head">
          <h2>Settings</h2>
          <button className="btn subtle" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal-body">
          <section className="settings-section">
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
                ? 'Your projects and tasks live in Supabase Postgres, shared with every signed-in device and your AI agents. Images sync through Supabase Storage.'
                : 'No backend configured — data stays in this browser. Use Export in the Tasks tab for backups.'}
            </p>
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
          </section>

          {supabaseOn && (
            <section className="settings-section">
              <h3>Household</h3>
              <p className="field-hint">
                Share the planner with the people you live with: everyone in the household sees the same projects, tasks,
                notes and people, can assign tasks to each other, and keeps their own calendars, reminders and reviews.
              </p>
              <div className="check-add">
                <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Your name as others see it" />
                <button className="btn" disabled={hhBusy} onClick={() => runHh(() => householdAction('me', { displayName }))}>
                  Save name
                </button>
              </div>
              {(household.info?.invites ?? []).length > 0 && (
                <ul className="cal-sources">
                  {household.info!.invites!.map(inv => (
                    <li key={inv.householdId} className="cal-source">
                      <span className="cal-source-name">
                        <strong>{inv.name}</strong> <small>invited you to share their planner</small>
                      </span>
                      <button className="btn primary" disabled={hhBusy} onClick={() => runHh(() => householdAction('accept', { householdId: inv.householdId }))}>
                        Accept
                      </button>
                      <button className="btn subtle" disabled={hhBusy} onClick={() => runHh(() => householdAction('decline'))}>
                        Decline
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {household.info?.household ? (
                <>
                  <p className="sync-line">
                    <strong>{household.info.household.name}</strong>
                    <small className="muted">{household.info.members.length} member{household.info.members.length === 1 ? '' : 's'}</small>
                    <span className="spacer" />
                    <ConfirmButton className="btn subtle danger" confirmLabel="Leave household?" onConfirm={() => runHh(() => householdAction('leave'))}>
                      Leave
                    </ConfirmButton>
                  </p>
                  <ul className="cal-sources">
                    {household.info.members.map(m => (
                      <li key={m.id} className="cal-source">
                        <span className="assignee">{m.displayName.slice(0, 2).toUpperCase()}</span>
                        <span className="cal-source-name">
                          {m.displayName} <small>· {m.email}{m.role === 'owner' ? ' · owner' : ''}{m.id === household.myId ? ' · you' : ''}</small>
                        </span>
                        {m.id !== household.myId && household.info?.members.find(x => x.id === household.myId)?.role === 'owner' && (
                          <ConfirmButton className="btn subtle danger" confirmLabel="Remove?" onConfirm={() => runHh(() => householdAction('remove', { userId: m.id }))}>
                            Remove
                          </ConfirmButton>
                        )}
                      </li>
                    ))}
                  </ul>
                  <div className="check-add">
                    <input value={invite} onChange={e => setInvite(e.target.value)} placeholder="Add a member by their account email" type="email" />
                    <button className="btn" disabled={hhBusy || !invite.trim()} onClick={() => runHh(() => householdAction('invite', { email: invite })).then(() => setInvite(''))}>
                      Add
                    </button>
                  </div>
                  <p className="field-hint">
                    They need an account first (the site owner creates accounts in the Supabase dashboard). They will see the
                    invitation in their own Settings and must accept it — nothing is shared until they do.
                  </p>
                </>
              ) : (
                <div className="check-add">
                  <input value={hhName} onChange={e => setHhName(e.target.value)} placeholder="Household name, e.g. The Sucklings" />
                  <button className="btn primary" disabled={hhBusy} onClick={() => runHh(() => householdAction('create', { name: hhName }))}>
                    Create household
                  </button>
                </div>
              )}
              {(hhError || household.error) && <p className="warn">{hhError || household.error}</p>}
            </section>
          )}

          {supabaseOn && (
            <section className="settings-section">
              <h3>Account</h3>
              <p>{accountEmail ? `Signed in as ${accountEmail}.` : 'Signed in.'}</p>
              <button
                className="btn"
                onClick={async () => {
                  await getSupabase()?.auth.signOut()
                  onClose()
                }}
              >
                Sign out
              </button>
            </section>
          )}

          <section className="settings-section">
            <h3>Reminders</h3>
            <h4>Push notifications (works with the app closed)</h4>
            {push?.configured ? (
              <>
                <p className="sync-line">
                  {thisEndpoint && push.subscriptions.includes(thisEndpoint) ? (
                    <>
                      <span>On for this device{push.subscriptions.length > 1 ? ` (+${push.subscriptions.length - 1} other${push.subscriptions.length > 2 ? 's' : ''})` : ''}.</span>
                      <button className="btn" disabled={pushBusy} onClick={() => runPush(testPush)}>
                        Send a test
                      </button>
                      <button className="btn subtle" disabled={pushBusy} onClick={() => runPush(disablePush)}>
                        Turn off here
                      </button>
                    </>
                  ) : (
                    <>
                      <button className="btn primary" disabled={pushBusy || !pushSupported()} onClick={() => runPush(() => enablePush(push.publicKey!))}>
                        {pushBusy ? 'Enabling…' : 'Enable on this device'}
                      </button>
                      <small>
                        {!pushSupported()
                          ? 'Not supported in this browser (on iPhone, install the app to the Home Screen first).'
                          : push.subscriptions.length > 0
                            ? `On for ${push.subscriptions.length} other device${push.subscriptions.length === 1 ? '' : 's'} — turn it on here too.`
                            : 'A morning digest plus a nudge when timed tasks come due.'}
                      </small>
                    </>
                  )}
                </p>
                <p className="sync-line">
                  <label className="cal-source mirror-row">
                    <input
                      type="checkbox"
                      checked={push.digestEmail}
                      onChange={e => runPush(() => savePushPrefs({ digestEmail: e.target.checked, digestHour }))}
                    />
                    <span className="cal-source-name">Also email me the morning digest ({push.email})</span>
                  </label>
                  <label className="digest-hour">
                    at
                    <select value={digestHour} onChange={e => { setDigestHour(Number(e.target.value)); runPush(() => savePushPrefs({ digestEmail: push.digestEmail, digestHour: Number(e.target.value) })) }}>
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={h}>
                          {String(h).padStart(2, '0')}:00
                        </option>
                      ))}
                    </select>
                    <small>{Intl.DateTimeFormat().resolvedOptions().timeZone}</small>
                  </label>
                </p>
              </>
            ) : push ? (
              <p className="field-hint">Not configured on the host: set {push.missing.join(', ')} on Netlify (run <code>npx web-push generate-vapid-keys</code> for the VAPID pair).</p>
            ) : (
              <p className="field-hint">{pushError ? `Push status unavailable: ${pushError}` : 'Checking push…'}</p>
            )}
            {pushError && push && <p className="warn">{pushError}</p>}
            <h4>While the app is open</h4>
            <p className="field-hint">Browser notifications when a task's due time arrives on this device.</p>
            <p>
              {notif === 'granted'
                ? 'Notifications are on.'
                : notif === 'denied'
                  ? 'Notifications are blocked — allow them in the browser’s site settings.'
                  : notif === 'unsupported'
                    ? 'Not supported in this browser.'
                    : 'Notifications are off.'}
            </p>
            {notif === 'default' && (
              <button
                className="btn"
                onClick={async () => {
                  setNotif(await enableNotifications())
                }}
              >
                Enable notifications
              </button>
            )}
          </section>

          <section className="settings-section">
            <h3>Calendars</h3>
            <p className="field-hint">
              Subscribe to your Google or iCloud calendars (birthdays, holidays, family) and their events show up on
              the Month view, the Timeline, and Today's <em>Coming up</em> list — read-only, with a one-tap prep task.
            </p>
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
                      return (
                        <li key={cal.id} className="cal-source">
                          <input type="checkbox" checked={!!src?.enabled} aria-label={`Show ${cal.name}`} onChange={e => toggleGoogleCalendar(cal, e.target.checked)} />
                          <span className="pdot" style={{ background: cal.color ?? PROJECT_COLORS[4] }} />
                          <span className="cal-source-name">
                            {cal.name}
                            {cal.primary && <small> · primary</small>}
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
                    {googlePush.error ? <span className="warn">{googlePush.error}</span> : googlePush.pending ? <small>pushing…</small> : googlePush.lastAt ? <small>pushed {timeAgo(googlePush.lastAt)}</small> : null}
                  </span>
                </label>
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
              <p className="field-hint">
                Not configured on the host yet: set {google.missing.join(', ')} on Netlify. The OAuth client's redirect URI
                must be <code>{google.redirectUri}</code>.
              </p>
            ) : (
              <p className="field-hint">{googleError ? `Google status unavailable: ${googleError}` : 'Checking Google…'}</p>
            )}
            {googleError && google?.connected && <p className="warn">{googleError}</p>}

            <h4>Outlook / Microsoft 365</h4>
            {ms?.configured ? (
              <>
                {ms.accounts.length === 0 ? (
                  <p className="sync-line">
                    <button
                      className="btn primary"
                      disabled={msBusy}
                      onClick={async () => {
                        setMsBusy(true)
                        setMsError('')
                        try {
                          const { url } = await microsoftAction<{ url: string }>('auth')
                          window.location.href = url
                        } catch (e) {
                          setMsError((e as Error).message)
                          setMsBusy(false)
                        }
                      }}
                    >
                      {msBusy ? 'Opening Microsoft…' : 'Connect Outlook'}
                    </button>
                    <small>Personal and work accounts both work — connect as many as you like.</small>
                  </p>
                ) : (
                  <>
                    {(msCals ?? ms.accounts.map(a => ({ account: a, calendars: [] as MicrosoftCalendarInfo[] }))).map(entry => {
                      const acct = entry.account
                      const mirrorSource = store.calendars.find(c => c.url === msPushUrl(acct.id))
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
                                for (const c of store.calendars.filter(c => c.url.includes(acct.id))) store.remove(c.id)
                                await microsoftAction('disconnect', { accountId: acct.id })
                                setMs(await microsoftAction<MicrosoftStatus>('status'))
                                setMsCals(cur => (cur ?? []).filter(x => x.account.id !== acct.id))
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
                              {microsoftSync.error ? <span className="warn">{microsoftSync.error}</span> : microsoftSync.pending ? <small>syncing…</small> : microsoftSync.lastAt ? <small>synced {timeAgo(microsoftSync.lastAt)}</small> : null}
                            </span>
                          </label>
                        </div>
                      )
                    })}
                    <p className="sync-line">
                      <button
                        className="btn"
                        disabled={msBusy}
                        onClick={async () => {
                          setMsBusy(true)
                          try {
                            const { url } = await microsoftAction<{ url: string }>('auth')
                            window.location.href = url
                          } catch (e) {
                            setMsError((e as Error).message)
                            setMsBusy(false)
                          }
                        }}
                      >
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
              <p className="field-hint">
                Not configured on the host yet: set {ms.missing.join(', ')} on Netlify. In the Azure portal register an app that
                allows <em>any organizational directory and personal Microsoft accounts</em>, with the redirect URI{' '}
                <code>{ms.redirectUri}</code>.
              </p>
            ) : (
              <p className="field-hint">{msError ? `Outlook status unavailable: ${msError}` : 'Checking Outlook…'}</p>
            )}
            {msError && ms?.configured && <p className="warn">{msError}</p>}

            <h4>Other calendars (iCloud, holidays, any .ics link)</h4>
            {store.calendars.filter(c => !isGoogleSource(c) && !isMicrosoftSource(c)).length > 0 && (
              <ul className="cal-sources">
                {store.calendars.filter(c => !isGoogleSource(c) && !isMicrosoftSource(c)).map(c => (
                  <li key={c.id} className="cal-source">
                    <input
                      type="checkbox"
                      checked={c.enabled}
                      aria-label="Enabled"
                      onChange={e => store.upsert({ ...c, enabled: e.target.checked, updatedAt: newerStamp(c.updatedAt) })}
                    />
                    <span className="pdot" style={{ background: c.color }} />
                    <span className="cal-source-name">
                      {c.name}
                      {calendars.names[c.id] && calendars.names[c.id] !== c.name && <small> · {calendars.names[c.id]}</small>}
                    </span>
                    <span className="cal-source-status">
                      {calendars.errors[c.id] ? (
                        <span className="warn">{calendars.errors[c.id]}</span>
                      ) : (
                        <small>{calendars.events.filter(e => e.sourceId === c.id).length} events</small>
                      )}
                    </span>
                    <ConfirmButton className="btn subtle danger" confirmLabel="Sure?" onConfirm={() => store.remove(c.id)}>
                      Remove
                    </ConfirmButton>
                  </li>
                ))}
              </ul>
            )}
            <div className="cal-add">
              <input value={calName} onChange={e => setCalName(e.target.value)} placeholder="Name (e.g. Family)" className="cal-add-name" />
              <input value={calUrl} onChange={e => setCalUrl(e.target.value)} placeholder="https://… or webcal://… (.ics address)" className="cal-add-url" />
              <span className="swatches small">
                {PROJECT_COLORS.map(c => (
                  <button key={c} type="button" className={calColor === c ? 'swatch on' : 'swatch'} style={{ background: c }} onClick={() => setCalColor(c)} aria-label={c} />
                ))}
              </span>
              <button className="btn" disabled={!calUrl.trim()} onClick={addCalendar}>
                Add calendar
              </button>
            </div>
            <p className="field-hint">
              <strong>Google:</strong> calendar settings → <em>Integrate calendar</em> → copy the <em>Secret address in
              iCal format</em>. <strong>iCloud:</strong> Calendar app → share the calendar → tick <em>Public Calendar</em> →
              copy the webcal link. Both stay private to this app; the addresses are stored with your data, never in the
              page.
            </p>
            <p className="sync-line">
              {calendars.error ? (
                <span className="warn">{calendars.error}</span>
              ) : calendars.lastAt ? (
                <small>Events refreshed {timeAgo(calendars.lastAt)}.</small>
              ) : null}{' '}
              {store.calendars.length > 0 && (
                <button className="btn" disabled={calendars.loading} onClick={() => calendars.refresh()}>
                  {calendars.loading ? 'Refreshing…' : 'Refresh now'}
                </button>
              )}
            </p>

            <h4>Subscribe link for Apple Calendar (or any calendar app)</h4>
            {feed?.enabled && feed.url ? (
              <>
                <p className="field-hint">
                  Subscribe once (Apple Calendar → <em>File → New Calendar Subscription</em>; Google → <em>Other calendars →
                  From URL</em>). Open tasks with due dates, project targets and milestones appear there and stay in sync.
                  The link is yours alone and works like a password — reset it if it leaks.
                </p>
                <div className="copy-row">
                  <input readOnly value={feed.url} onFocus={e => e.currentTarget.select()} />
                  <button
                    className="btn"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(feed.url!)
                        setCopied(true)
                        window.setTimeout(() => setCopied(false), 2000)
                      } catch {
                        /* the field is selectable */
                      }
                    }}
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <button className="btn subtle" disabled={feedBusy} onClick={() => runFeed('rotate')}>
                    Reset link
                  </button>
                  <button className="btn subtle danger" disabled={feedBusy} onClick={() => runFeed('disable')}>
                    Turn off
                  </button>
                </div>
              </>
            ) : feed?.configured ? (
              <p className="sync-line">
                <button className="btn" disabled={feedBusy} onClick={() => runFeed('enable')}>
                  {feedBusy ? 'Creating…' : 'Create my subscribe link'}
                </button>
                <small>Generates a private feed address for your account.</small>
              </p>
            ) : feed ? (
              <p className="field-hint">Not available: needs {feed.missing.join(' and ')} on the host (Netlify).</p>
            ) : (
              <p className="field-hint">{feedError ? `Feed status unavailable: ${feedError}` : 'Checking feed status…'}</p>
            )}
            {feedError && feed && <p className="warn">{feedError}</p>}
          </section>

          {feed?.configured && (
            <section className="settings-section">
              <h3>Email in</h3>
              <p className="field-hint">
                Forward an email and it becomes a task (subject → title, body → description, first link → link). Point a
                forwarding rule at this address: Mailgun Routes, SendGrid Inbound Parse, Cloudflare Email Workers, Zapier or
                Make all can call it. The link is yours alone — reset it if it leaks.
              </p>
              {feed.inboundUrl ? (
                <div className="copy-row">
                  <input readOnly value={feed.inboundUrl} onFocus={e => e.currentTarget.select()} />
                  <button className="btn" onClick={() => navigator.clipboard.writeText(feed.inboundUrl!).catch(() => {})}>
                    Copy
                  </button>
                  <button className="btn subtle" disabled={feedBusy} onClick={() => inboundAction('inbound-rotate').then(r => setFeed(f => (f ? { ...f, inboundUrl: r.inboundUrl } : f)))}>
                    Reset
                  </button>
                  <button className="btn subtle danger" disabled={feedBusy} onClick={() => inboundAction('inbound-disable').then(r => setFeed(f => (f ? { ...f, inboundUrl: r.inboundUrl } : f)))}>
                    Turn off
                  </button>
                </div>
              ) : (
                <button className="btn" disabled={feedBusy} onClick={() => inboundAction('inbound-enable').then(r => setFeed(f => (f ? { ...f, inboundUrl: r.inboundUrl } : f)))}>
                  Create my email-in address
                </button>
              )}
            </section>
          )}

          {store.templates.length > 0 && (
            <section className="settings-section">
              <h3>Project templates</h3>
              <p className="field-hint">Saved from your projects. Pick one when creating a new project.</p>
              <ul className="cal-sources">
                {store.templates.map(t => (
                  <li key={t.id} className="cal-source">
                    <span className="pdot" style={{ background: t.color }} />
                    <span className="cal-source-name">
                      {t.emoji ? `${t.emoji} ` : ''}
                      {t.name} <small>· {t.tasks.length} tasks{t.milestones?.length ? `, ${t.milestones.length} milestones` : ''}</small>
                    </span>
                    <ConfirmButton className="btn subtle danger" confirmLabel="Sure?" onConfirm={() => store.remove(t.id)}>
                      Remove
                    </ConfirmButton>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="settings-section">
            <h3>AI assist</h3>
            <p className="field-hint">
              The ✨ features (break a task into steps, suggest tags, platform variants, post analysis) run through the
              site's server-side proxy — configure <code>NVIDIA_API_KEY</code> (free from build.nvidia.com) or{' '}
              <code>ANTHROPIC_API_KEY</code> in the host environment (Netlify). GitHub link cards use{' '}
              <code>GITHUB_TOKEN</code> the same way. No key is ever stored in the browser.
            </p>
          </section>
        </div>

        <footer className="modal-foot">
          <span className="spacer" />
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  )
}
