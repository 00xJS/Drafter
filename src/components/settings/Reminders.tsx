import { useEffect, useState } from 'react'
import {
  PlanDayPref,
  genericRemindersEnabled,
  isNative,
  localRemindersEnabled,
  planDayPref,
  requestLocalNotificationPermission,
  scheduleLocalReminders,
  setGenericRemindersEnabled,
  setLocalRemindersEnabled,
  setPlanDayPref,
  validTime,
} from '../../native'
import { enableNotifications, notificationPermission } from '../../notify'
import { PushInfo, currentEndpoint, disablePush, enablePush, fetchPushInfo, pushSupported, savePushPrefs, testPush } from '../../push'
import { deviceReminders } from '../../reminders'
import { isSupabaseConfigured } from '../../supabase'
import type { SettingsCtx } from './context'
import { useAsyncAction } from './useAsyncAction'

/**
 * Sunday's review draft is written on the server for every account, push or
 * not, so its one switch sits apart from push and says nothing about it. The
 * AI provider writes it: on a host with no AI key none is ever written, so the
 * switch is drawn disabled, with the reason in one line.
 */
export function SundayDraft({ journal, ai = true, onChange }: { journal: boolean; ai?: boolean; onChange(on: boolean): void }) {
  return (
    <>
      <h4>Sunday’s review</h4>
      <p className="field-hint">
        {ai
          ? 'Each Sunday, last week’s review is drafted for you, ready on Home → Week. It never writes over your own summary or reflections.'
          : 'No Sunday draft is written: the server has no AI provider key.'}
      </p>
      <p className="sync-line">
        <label className="cal-source mirror-row">
          <input type="checkbox" checked={journal} disabled={!ai} onChange={e => onChange(e.target.checked)} />
          <span className="cal-source-name">Let Sunday’s draft read my journal</span>
        </label>
        {ai && <small className="field-hint">The week’s entries go to the AI provider with the draft. Off by default; the ✨ summary you press for on Home → Week always may.</small>}
      </p>
    </>
  )
}

/**
 * The morning's Plan your day: a notification this iPhone fires by itself
 * every day at the time chosen, with no push and no server, that opens Plan my
 * day on Today. On, at 8:00, until changed here.
 */
export function PlanDayReminder({ pref, onChange }: { pref: PlanDayPref; onChange(next: PlanDayPref): void }) {
  return (
    <>
      <h4>Plan your day</h4>
      <p className="sync-line">
        <label className="cal-source mirror-row">
          <input type="checkbox" checked={pref.on} onChange={e => onChange({ ...pref, on: e.target.checked })} />
          <span className="cal-source-name">Remind me every morning</span>
        </label>
        <label className="digest-hour">
          at
          <input
            type="time"
            value={pref.time}
            disabled={!pref.on}
            onChange={e => {
              const time = validTime(e.target.value)
              if (time) onChange({ ...pref, time })
            }}
          />
        </label>
      </p>
      <p className="field-hint">The phone sends it itself, with no push and no server; tapping it opens Plan my day.</p>
    </>
  )
}

/** Reminders: server push and the morning digest, Sunday's review draft, then this iPhone's own reminders and its Plan your day, or the browser's. */
export function Reminders({ store }: SettingsCtx) {
  const [notif, setNotif] = useState(notificationPermission())
  const [push, setPush] = useState<PushInfo | null>(null)
  const { busy: pushBusy, error: pushError, run, setError: setPushError } = useAsyncAction()
  const [thisEndpoint, setThisEndpoint] = useState<string | null>(null)
  const [digestHour, setDigestHour] = useState(8)
  const [localOn, setLocalOn] = useState(localRemindersEnabled())
  const [genericOn, setGenericOn] = useState(genericRemindersEnabled())
  const [localErr, setLocalErr] = useState('')
  const [planDay, setPlanDay] = useState(planDayPref)
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
  const runPush = (fn: () => Promise<unknown>, after?: () => void) =>
    run(async () => {
      await fn()
      after?.()
      setPush(await fetchPushInfo())
      setThisEndpoint(await currentEndpoint())
    })
  // this phone's own reminders are one set, replaced whole (deviceReminders),
  // so every switch below schedules all of it as it now stands
  const serverPushHere = !!(thisEndpoint && push?.subscriptions?.includes(thisEndpoint))
  const reschedule = (over: { local?: boolean; generic?: boolean; planDay?: PlanDayPref } = {}) =>
    scheduleLocalReminders(
      deviceReminders(store, new Date(), { local: over.local ?? localOn, skipTaskDue: serverPushHere, generic: over.generic ?? genericOn, planDay: over.planDay ?? planDay }),
    )

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
        <SundayDraft journal={!!push.digestJournal} ai={push.aiConfigured !== false} onChange={on => runPush(() => savePushPrefs({ digestEmail: push.digestEmail, digestHour, digestJournal: on }))} />
      )}
      {isNative() ? (
        <>
          <h4>On this iPhone</h4>
          <p className="field-hint">
            {thisEndpoint && push?.subscriptions?.includes(thisEndpoint)
              ? 'Server push is on for this phone — local “Due now” alerts are off so you are not nudged twice. Occasion reminders (birthdays) and place nudges still fire here.'
              : 'A notification at each task’s due time, on the morning of a birthday or anniversary, and when a place you set a rhythm for is well overdue. The phone fires these itself. Turn on server push above to use Apple’s delivery instead for due tasks.'}
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
                    await reschedule({ local: true })
                  } else {
                    setLocalRemindersEnabled(false)
                    setLocalOn(false)
                    // the morning's Plan your day has a switch of its own, and stays
                    await reschedule({ local: false })
                  }
                }}
              />
              <span className="cal-source-name">
                {thisEndpoint && push?.subscriptions?.includes(thisEndpoint)
                  ? 'Local occasion reminders (due tasks via push)'
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
                    await reschedule({ generic: on })
                  }}
                />
                <span className="cal-source-name">Hide details on the lock screen</span>
              </label>
              <small className="field-hint">Reminders say “Something is due” or “An occasion today” instead of a task title or a person's name. Tapping one still opens the right thing.</small>
            </p>
          )}
          <PlanDayReminder
            pref={planDay}
            onChange={async next => {
              setLocalErr('')
              if (next.on && !planDay.on && !(await requestLocalNotificationPermission())) {
                setLocalErr('Notifications were not allowed. Turn them on in the iPhone Settings app, under Drafter.')
                return
              }
              setPlanDayPref(next)
              setPlanDay(next)
              await reschedule({ planDay: next })
            }}
          />
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
