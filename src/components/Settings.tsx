import { useEffect, useState } from 'react'
import { Store } from '../store'
import { CalendarFeedInfo, CalendarState, fetchFeedInfo } from '../calendars'
import { newerStamp } from '../itemops'
import { enableNotifications, notificationPermission } from '../notify'
import { getSupabase, isSupabaseConfigured } from '../supabase'
import { PROJECT_COLORS } from '../types'
import { fmtDateTime, timeAgo, uid } from '../utils'

interface Props {
  store: Store
  calendars: CalendarState
  onClose(): void
}

export function Settings({ store, calendars, onClose }: Props) {
  const [notif, setNotif] = useState(notificationPermission())
  const [accountEmail, setAccountEmail] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [calName, setCalName] = useState('')
  const [calUrl, setCalUrl] = useState('')
  const [calColor, setCalColor] = useState(PROJECT_COLORS[3])
  const [feed, setFeed] = useState<CalendarFeedInfo | null>(null)
  const [feedError, setFeedError] = useState('')
  const [copied, setCopied] = useState(false)
  const supabaseOn = isSupabaseConfigured()

  useEffect(() => {
    fetchFeedInfo()
      .then(setFeed)
      .catch(e => setFeedError((e as Error).message))
  }, [])

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
            <p className="field-hint">
              Get a notification when a task's due time arrives. Reminders fire while Drafter is open on this
              device — there is no server-side push (yet).
            </p>
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
            {store.calendars.length > 0 && (
              <ul className="cal-sources">
                {store.calendars.map(c => (
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
                    <button className="btn subtle danger" onClick={() => store.remove(c.id)}>
                      Remove
                    </button>
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

            <h4>Your tasks in Google / Apple Calendar</h4>
            {feed?.configured && feed.url ? (
              <>
                <p className="field-hint">
                  Subscribe to this address once (Google Calendar → <em>Other calendars → From URL</em>; Apple Calendar →{' '}
                  <em>File → New Calendar Subscription</em>). Open tasks with due dates, project targets and milestones
                  appear there and stay in sync. Anyone with the link can read the feed — treat it like a password.
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
                </div>
              </>
            ) : feed ? (
              <p className="field-hint">
                Not enabled yet. Set {feed.missing.join(' and ')} in the host environment (Netlify) and redeploy; the
                subscribe link appears here.
              </p>
            ) : (
              <p className="field-hint">{feedError ? `Feed status unavailable: ${feedError}` : 'Checking feed status…'}</p>
            )}
          </section>

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
