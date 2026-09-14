import { useEffect, useState } from 'react'
import { copyRemindersOn, setCopyReminders } from '../../calendars'
import { genericRemindersEnabled, isNative, localRemindersEnabled, requestLocalNotificationPermission, scheduleLocalReminders, setGenericRemindersEnabled, setLocalRemindersEnabled } from '../../native'
import { enableNotifications, notificationPermission } from '../../notify'
import { PushInfo, currentEndpoint, disablePush, enablePush, fetchPushInfo, pushSupported, savePushPrefs, testPush } from '../../push'
import { buildLocalReminders } from '../../reminders'
import { isSupabaseConfigured } from '../../supabase'
import type { SettingsCtx } from './context'
import { useAsyncAction } from './useAsyncAction'

/**
 * Sunday's review draft is written on the server for every account, push or
 * not, so its one switch sits apart from push and says nothing about it.
 */
export function SundayDraft({ journal, onChange }: { journal: boolean; onChange(on: boolean): void }) {
  return (
    <>
      <h4>Sunday’s review</h4>
      <p className="field-hint">Each Sunday, last week’s review is drafted for you, ready on Home → Week. It never writes over your own summary or reflections.</p>
      <p className="sync-line">
        <label className="cal-source mirror-row">
          <input type="checkbox" checked={journal} onChange={e => onChange(e.target.checked)} />
          <span className="cal-source-name">Let Sunday’s draft read my journal</span>
        </label>
        <small className="field-hint">The week’s entries go to the AI provider with the draft. Off by default; the ✨ summary you press for on Home → Week always may.</small>
      </p>
    </>
  )
}

/**
 * Drafter sends every reminder itself, so the tasks and events it writes into
 * Google and Outlook stay silent there; this one switch brings each calendar's
 * own reminders back on them. It is the account's, not this device's: every
 * device and the mirrors read the same answer.
 */
export function CopyReminders({ on, busy, error, onChange }: { on: boolean | null; busy: boolean; error?: string; onChange(on: boolean): void }) {
  return (
    <>
      <h4>Calendar copies</h4>
      <p className="field-hint">Drafter sends your reminders itself — an iPhone’s own reminders, and push — so the tasks and events it writes into Google Calendar and Outlook don’t remind you a second time.</p>
      <p className="sync-line">
        <label className="cal-source mirror-row">
          <input type="checkbox" checked={on === true} disabled={busy || on === null} onChange={e => onChange(e.target.checked)} />
          <span className="cal-source-name">Calendar copies remind me too</span>
        </label>
        <small className="field-hint">Each calendar’s own reminders come back on those copies, as Drafter next writes each one. Off by default.</small>
      </p>
      {error && <p className="warn">{error}</p>}
    </>
  )
}

/** Reminders: server push and the morning digest, Sunday's review draft, the calendar copies' own reminders, then this iPhone's own reminders or the browser's. */
export function Reminders({ store, household, supabaseOn }: SettingsCtx) {
  const [notif, setNotif] = useState(notificationPermission())
  const [push, setPush] = useState<PushInfo | null>(null)
  const { busy: pushBusy, error: pushError, run, setError: setPushError } = useAsyncAction()
  const [thisEndpoint, setThisEndpoint] = useState<string | null>(null)
  const [digestHour, setDigestHour] = useState(8)
  const [localOn, setLocalOn] = useState(localRemindersEnabled())
  const [genericOn, setGenericOn] = useState(genericRemindersEnabled())
  const [localErr, setLocalErr] = useState('')
  const [copies, setCopies] = useState<boolean | null>(null)
  const { busy: copiesBusy, error: copiesError, run: runCopies, setError: setCopiesError } = useAsyncAction()
  useEffect(() => {
    // push is sent by the server, so without an account there is nothing to ask
    if (!isSupabaseConfigured()) return
    fetchPushInfo()
      .then(info => {
        setPush(info)
        // render the SAVED hour, never the local default
        if (Number.isInteger(info.digestHour)) setDigestHour(info.digestHour)
      })
      .catch(e => setPushError((e as Error).message))
    currentEndpoint().then(setThisEndpoint)
  }, [setPushError])
  useEffect(() => {
    // the copies are written by the mirrors, which need an account
    if (!supabaseOn) return
    copyRemindersOn()
      .then(setCopies)
      .catch(e => setCopiesError((e as Error).message))
  }, [supabaseOn, setCopiesError])
  // this phone's own set, rebuilt now rather than at the next change
  const reschedule = (skipTaskDue: boolean, generic: boolean) =>
    scheduleLocalReminders(buildLocalReminders(store.tasks, store.people, store.places, store.meals, new Date(), 30, { skipTaskDue, generic, events: store.events, myId: household.myId }))
  const runPush = (fn: () => Promise<unknown>, after?: () => void) =>
    run(async () => {
      await fn()
      after?.()
      setPush(await fetchPushInfo())
      setThisEndpoint(await currentEndpoint())
    })

  return (
    <section className="settings-section g-reminders">
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
                <button className="btn primary" disabled={pushBusy || !pushSupported() || (!isNative() && !push.publicKey)} onClick={() => runPush(() => enablePush(push.publicKey ?? ''))}>
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
        <p className="field-hint">Push reminders aren’t available yet.</p>
      ) : !isSupabaseConfigured() ? (
        <p className="field-hint">Push reminders are sent by the server, so they need a signed-in account.</p>
      ) : (
        <p className="field-hint">{pushError ? `Push status unavailable: ${pushError}` : 'Checking push…'}</p>
      )}
      {pushError && push && <p className="warn">{pushError}</p>}
      {push?.sundayDraft && (
        <SundayDraft journal={!!push.digestJournal} onChange={on => runPush(() => savePushPrefs({ digestEmail: push.digestEmail, digestHour, digestJournal: on }))} />
      )}
      {supabaseOn && (
        <CopyReminders
          on={copies}
          busy={copiesBusy}
          error={copiesError}
          onChange={on =>
            runCopies(async () => {
              await setCopyReminders(on)
              setCopies(on)
            })
          }
        />
      )}
      {isNative() ? (
        <>
          <h4>On this iPhone</h4>
          <p className="field-hint">
            {thisEndpoint && push?.subscriptions?.includes(thisEndpoint)
              ? 'Server push is on for this phone — local “Due now” alerts are off so you are not nudged twice. Your events, occasion reminders (birthdays) and place nudges still fire here.'
              : 'A notification at each task’s due time, at the start of each of your events, on the morning of a birthday or anniversary, and when a place you set a rhythm for is well overdue. The phone fires these itself. Turn on server push above to use Apple’s delivery instead for due tasks.'}
          </p>
          <p className="sync-line">
            <label className="cal-source mirror-row">
              <input
                type="checkbox"
                checked={localOn}
                onChange={async e => {
                  setLocalErr('')
                  if (e.target.checked) {
                    if (!(await requestLocalNotificationPermission())) {
                      setLocalErr('Notifications were not allowed. Turn them on in the iPhone Settings app, under Drafter.')
                      return
                    }
                    setLocalRemindersEnabled(true)
                    setLocalOn(true)
                    let skipTaskDue = false
                    try {
                      skipTaskDue = !!(thisEndpoint && push?.subscriptions?.includes(thisEndpoint))
                    } catch {
                      /* ignore */
                    }
                    await reschedule(skipTaskDue, genericRemindersEnabled())
                  } else {
                    setLocalRemindersEnabled(false)
                    setLocalOn(false)
                    await scheduleLocalReminders([])
                  }
                }}
              />
              <span className="cal-source-name">
                {thisEndpoint && push?.subscriptions?.includes(thisEndpoint)
                  ? 'Local event and occasion reminders (due tasks via push)'
                  : 'Remind me on this iPhone'}
              </span>
            </label>
          </p>
          {localOn && (
            <p className="sync-line">
              <label className="cal-source mirror-row">
                <input
                  type="checkbox"
                  checked={genericOn}
                  onChange={async e => {
                    const on = e.target.checked
                    setGenericRemindersEnabled(on)
                    setGenericOn(on)
                    const skipTaskDue = !!(thisEndpoint && push?.subscriptions?.includes(thisEndpoint))
                    await reschedule(skipTaskDue, on)
                  }}
                />
                <span className="cal-source-name">Hide details on the lock screen</span>
              </label>
              <small className="field-hint">Reminders say “Something is due” or “An occasion today” instead of a task title or a person's name. Tapping one still opens the right thing.</small>
            </p>
          )}
          {localErr && <p className="warn">{localErr}</p>}
        </>
      ) : (
        <>
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
        </>
      )}
    </section>
  )
}
