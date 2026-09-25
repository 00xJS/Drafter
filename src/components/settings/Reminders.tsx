import { useEffect, useState } from 'react'
import { copyRemindersOn, setCopyReminders } from '../../calendars'
import {
  LocalPermission,
  PlanDayPref,
  genericRemindersEnabled,
  isNative,
  localNotificationPermission,
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
import { TURN_ON } from '../PushNudge'
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
 * Whether the other member's changes to a task you share reach you: the bell
 * on Home, and your devices with push on. On unless switched off; it is the
 * account's, kept on the server with the other push preferences, so every
 * device reads the same answer — and it needs no push to matter, since the
 * hub keeps what it is told either way. Its own error line, under it.
 */
export function TaskUpdates({ on, busy, error, onChange }: { on: boolean; busy: boolean; error?: string; onChange(on: boolean): void }) {
  return (
    <>
      <h4>Shared tasks</h4>
      <p className="sync-line">
        <label className="cal-source mirror-row">
          <input type="checkbox" checked={on} disabled={busy} onChange={e => onChange(e.target.checked)} />
          <span className="cal-source-name">Tell me when someone updates a task we share</span>
        </label>
        <small className="field-hint">
          When the other member finishes, comments on or changes a task one of you handed the other, it shows under the bell on Home — and on your devices, with push on.
        </small>
      </p>
      {error && <p className="warn">{error}</p>}
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
      <p className="field-hint">
        Drafter sends your reminders itself, so the tasks and events it writes into Google Calendar and Outlook don’t remind you a second time. Your events remind you only
        through Drafter: an iPhone with “Remind me on this iPhone” on, or a browser with Drafter open and notifications allowed — push nudges about tasks alone. With
        neither, turn this on.
      </p>
      <p className="sync-line">
        <label className="cal-source mirror-row">
          <input type="checkbox" checked={on === true} disabled={busy || on === null} onChange={e => onChange(e.target.checked)} />
          <span className="cal-source-name">Calendar copies remind me too</span>
        </label>
        <small className="field-hint">
          Each calendar’s own notification settings apply to those copies again, as Drafter next writes each one: in Google, the Drafter calendar’s default notifications (set
          them there if it has none); in Outlook, its reminder. Off by default.
        </small>
      </p>
      {error && <p className="warn">{error}</p>}
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

/**
 * The morning digest's hour, and whether it comes by email too. Email goes
 * only from a site that can send it: without that the switch is not offered,
 * since a digest that never came looked exactly like one that had, and the
 * line says so instead. The hour is push's as well, so it stays either way.
 * On the 1st the digest brings the month's recap at the same hour, with no
 * switch of its own (netlify/functions/lib/recap.mjs): one line says so.
 */
export function DigestEmail({
  email,
  on,
  configured,
  hour,
  onChange,
  onHour,
}: {
  email: string
  on: boolean
  configured: boolean
  hour: number
  onChange(on: boolean): void
  onHour(hour: number): void
}) {
  return (
    <>
      <p className="sync-line">
        {configured ? (
          <label className="cal-source mirror-row">
            <input type="checkbox" checked={on} onChange={e => onChange(e.target.checked)} />
            <span className="cal-source-name">Also email me the morning digest ({email})</span>
          </label>
        ) : (
          <span className="cal-source-name">Morning digest</span>
        )}
        <label className="digest-hour">
          at
          <select value={hour} onChange={e => onHour(Number(e.target.value))}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, '0')}:00
              </option>
            ))}
          </select>
          <small>{Intl.DateTimeFormat().resolvedOptions().timeZone}</small>
        </label>
      </p>
      <p className="field-hint">On the 1st it also brings last month’s highlights from Insights.</p>
      {!configured && <p className="field-hint">The digest comes by push only: email isn’t set up on this site.</p>}
    </>
  )
}

/** What a switch turned on here hears when iOS says no. */
const NOT_ALLOWED = 'Notifications were not allowed. Turn them on in the iPhone Settings app, under Drafter.'

/**
 * What this phone's reminders are missing from iOS, while one of them is on.
 * A switch here stays ticked when iOS lets Drafter notify nothing — No at the
 * launch prompt, or notifications turned off since in the Settings app — and
 * then nothing is set and nothing comes. So the section says so, and where to
 * turn them on; before iOS has asked at all, it offers to ask.
 */
export function NotificationsOff({ allowed, onAllow }: { allowed: LocalPermission | null; onAllow(): void }) {
  if (allowed === 'denied') return <p className="warn">None of these can reach you: iOS isn’t letting Drafter send notifications. Turn them on in the iPhone Settings app, under Drafter.</p>
  if (allowed !== 'prompt') return null
  return (
    <p className="sync-line">
      <button className="btn" onClick={onAllow}>
        Allow notifications
      </button>
      <small className="field-hint">iOS hasn’t asked yet whether Drafter may notify you, so none of these can come.</small>
    </p>
  )
}

/** Reminders: server push and the morning digest, Sunday's review draft, the calendar copies' own reminders, then this iPhone's own reminders and its Plan your day, or the browser's. */
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
  const { busy: updatesBusy, error: updatesError, run: runUpdates } = useAsyncAction()
  const { busy: copiesBusy, error: copiesError, run: runCopies, setError: setCopiesError } = useAsyncAction()
  const [planDay, setPlanDay] = useState(planDayPref)
  // whether iOS lets Drafter notify: read on open, and again on coming back
  // from the Settings app, the one place it changes after the first answer
  const [allowed, setAllowed] = useState<LocalPermission | null>(null)
  useEffect(() => {
    if (!isNative()) return
    let live = true
    const read = () =>
      void localNotificationPermission().then(p => {
        if (!live) return
        setAllowed(p)
        if (p === 'granted') setLocalErr('')
      })
    read()
    const onShow = () => {
      if (document.visibilityState === 'visible') read()
    }
    document.addEventListener('visibilitychange', onShow)
    return () => {
      live = false
      document.removeEventListener('visibilitychange', onShow)
    }
  }, [])
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
  const runPush = (fn: () => Promise<unknown>, after?: () => void) =>
    run(async () => {
      await fn()
      after?.()
      setPush(await fetchPushInfo())
      setThisEndpoint(await currentEndpoint())
    })
  // this phone's own reminders are one set, replaced whole (deviceReminders),
  // so every switch below schedules all of it as it now stands — server push
  // or not: its "Due now" nudges go to browsers only, never to this iPhone
  const reschedule = (over: { local?: boolean; generic?: boolean; planDay?: PlanDayPref } = {}) =>
    scheduleLocalReminders(
      deviceReminders(store, new Date(), {
        local: over.local ?? localOn,
        generic: over.generic ?? genericOn,
        planDay: over.planDay ?? planDay,
        events: store.events,
        myId: household.myId,
      }),
    )
  // iOS asks only the first time; after that it answers from the choice made
  const ask = async () => {
    const ok = await requestLocalNotificationPermission()
    setAllowed(ok ? 'granted' : 'denied')
    return ok
  }

  return (
    <section className="settings-section g-reminders">
      <h3>Notifications</h3>
      <h4>Push notifications: household messages, shared tasks and the morning digest, even with the app closed</h4>
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
                  {/* the bell's nudge says the same: one phrase for one switch */}
                  {pushBusy ? 'Turning on…' : TURN_ON}
                </button>
                <small>
                  {!pushSupported()
                    ? 'Not supported in this browser (on iPhone, install the app to the Home Screen first).'
                    : push.subscriptions.length > 0
                      ? `On for ${push.subscriptions.length} other device${push.subscriptions.length === 1 ? '' : 's'} — turn it on here too.`
                      : isNative()
                        ? 'A morning digest. Your due tasks are reminded by this iPhone itself, below.'
                        : 'A morning digest plus a nudge when your timed tasks come due.'}
                </small>
              </>
            )}
          </p>
          <DigestEmail
            email={push.email}
            on={push.digestEmail}
            configured={push.emailConfigured !== false}
            hour={digestHour}
            onChange={on => runPush(() => savePushPrefs({ digestEmail: on, digestHour }))}
            onHour={h => {
              setDigestHour(h)
              runPush(() => savePushPrefs({ digestEmail: push.digestEmail, digestHour: h }))
            }}
          />
        </>
      ) : push ? (
        <p className="field-hint">Push reminders aren’t available yet.</p>
      ) : !isSupabaseConfigured() ? (
        <p className="field-hint">Push reminders are sent by the server, so they need a signed-in account.</p>
      ) : (
        <p className="field-hint">{pushError ? `Push status unavailable: ${pushError}` : 'Checking push…'}</p>
      )}
      {pushError && push && <p className="warn">{pushError}</p>}
      {/* the hub keeps notices whether or not push can bring them, so this is not push's */}
      {push?.sundayDraft && (
        <TaskUpdates
          on={push.notifyActivity !== false}
          busy={updatesBusy}
          error={updatesError}
          onChange={on =>
            runUpdates(async () => {
              await savePushPrefs({ digestEmail: push.digestEmail, digestHour, notifyActivity: on })
              setPush({ ...push, notifyActivity: on })
            })
          }
        />
      )}
      {push?.sundayDraft && (
        <SundayDraft journal={!!push.digestJournal} ai={push.aiConfigured !== false} onChange={on => runPush(() => savePushPrefs({ digestEmail: push.digestEmail, digestHour, digestJournal: on }))} />
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
            A notification when each task you are doing comes due (9am on a day with no time), at the start of each of your events, on the morning of a birthday or
            anniversary, and when a place you set a rhythm for is well overdue. The phone fires these itself, with push on or off: push brings the morning digest, never a
            second “Due now”.
          </p>
          <p className="sync-line">
            <label className="cal-source mirror-row">
              <input
                type="checkbox"
                checked={localOn}
                onChange={async e => {
                  setLocalErr('')
                  if (e.target.checked) {
                    if (!(await ask())) {
                      setLocalErr(NOT_ALLOWED)
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
              <span className="cal-source-name">Remind me on this iPhone</span>
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
              <small className="field-hint">Reminders say “Something is due”, “Something on your calendar”, “An occasion today” or “Somewhere to revisit” instead of a task title, an event, a person's name or a place. Tapping one still opens the right thing.</small>
            </p>
          )}
          <PlanDayReminder
            pref={planDay}
            onChange={async next => {
              setLocalErr('')
              // every change that leaves it on asks first, a new time too: iOS
              // may have been told no since, and then nothing would come
              const ok = next.on ? await ask() : true
              if (!ok && !planDay.on) {
                // switched on and refused, it stays off
                setLocalErr(NOT_ALLOWED)
                return
              }
              // a new time is kept even so, and the line below says why it won't come
              setPlanDayPref(next)
              setPlanDay(next)
              await reschedule({ planDay: next })
            }}
          />
          {localErr ? (
            <p className="warn">{localErr}</p>
          ) : (
            (localOn || planDay.on) && (
              <NotificationsOff
                allowed={allowed}
                onAllow={async () => {
                  if (await ask()) await reschedule()
                }}
              />
            )
          )}
        </>
      ) : (
        <>
          <h4>While the app is open</h4>
          <p className="field-hint">Browser notifications on this device when a task you are doing comes due (9am on a day with no time), and as each of your own events starts (9am on the first day of an all-day one; not work days, a household member's events or a subscribed calendar's), unless it is already over.</p>
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
