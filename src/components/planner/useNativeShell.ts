import { useEffect, useEffectEvent, useLayoutEffect, useRef } from 'react'
import type { Store } from '../../store'
import { notifyDue } from '../../notify'
import { clearAppBadge, genericRemindersEnabled, initNative, isNative, localRemindersEnabled, onNotificationsAllowed, planDayPref, scheduleLocalReminders } from '../../native'
import { refreshNativePush } from '../../push'
import { deviceReminders } from '../../reminders'
import { useWidgetBridge } from '../../widgetbridge'
import type { useDeepLinks } from './useDeepLinks'

interface Deps {
  store: Store
  applyLinkRef: ReturnType<typeof useDeepLinks>['applyLinkRef']
  /** Who is signed in: only my own events, and the tasks I am doing, remind me on this phone. */
  myId?: string | null
}

/**
 * The device around the app: the iOS shell's links, push taps and resume
 * sync, due reminders while the app is open, the local notifications the
 * phone fires on its own, and the widget and Siri.
 */
export function useNativeShell({ store, applyLinkRef, myId }: Deps) {
  // What the listeners below call, from the render last committed: set before
  // any of them can run.
  const notifyRef = useRef(() => {})
  // iOS: the phone itself fires a notification at each of my tasks' due
  // times, at the start of each of my events and on occasion mornings — no
  // server involved, so it works with no account and the app closed — and the
  // morning's Plan your day, which is on until turned off. Server push on this
  // phone changes none of it: the server's "Due now" nudges go to browsers
  // alone (digest.mjs), so the phone's task reminders are the only ones it hears.
  const remindersRef = useRef(() => {})
  // the data a queued rewrite reads when its turn comes: the render last committed, never the one it was asked from
  const latest = useRef({ store, myId })
  useLayoutEffect(() => {
    latest.current = { store, myId }
    notifyRef.current = () => {
      notifyDue(store.tasks, { events: store.events, myId })
    }
    remindersRef.current = () => {
      if (!isNative()) return
      if (!localRemindersEnabled() && !planDayPref().on) return
      // Never asks iOS whether it may notify: that question comes only from a
      // button someone pressed — the bell's Turn on, Settings → Notifications,
      // the offer after a task is given a time (src/reminderoffer.ts) — and a
      // yes to any of them runs this again (onNotificationsAllowed, below).
      // Until then scheduleLocalReminders sets nothing. One rewrite at a time,
      // each worked out when its turn comes, from the data and the switches as
      // they are by then.
      void scheduleLocalReminders(() => {
        const { store: now, myId: me } = latest.current
        return deviceReminders(now, new Date(), { local: localRemindersEnabled(), generic: genericRemindersEnabled(), planDay: planDayPref(), events: now.events, myId: me })
      }).catch(() => {})
    }
  })

  // What the shell's listeners call, from the render last committed: they are
  // set up once, at mount, and never again (useEffectEvent).
  // Only a tap on one of our own reminders may carry an `act=` that writes on
  // arrival; a drafter:// link from Safari or a Shortcut still just navigates.
  const openUrl = useEffectEvent((url: string, fromNotif?: boolean) => applyLinkRef.current(url, '', !!fromNotif))
  const resumed = useEffectEvent(() => {
    void store.syncNowManual()
    remindersRef.current()
    void clearAppBadge()
  })

  // the iOS shell: links, push taps, and a sync whenever the app comes forward
  useEffect(() => {
    // the effect can be torn down before initNative resolves (React's
    // development double-mount does exactly that), and a disposer assigned
    // after the cleanup ran would leave every listener subscribed twice
    let disposed = false
    let dispose: (() => void) | null = null
    void initNative({
      onUrl: (url, fromNotif) => openUrl(url, fromNotif),
      onResume: () => resumed(),
    }).then(d => {
      if (disposed) {
        d()
        return
      }
      dispose = d
      // resume does not fire at launch, so a cold start clears the badge here
      void clearAppBadge()
      // while server push is on for this iPhone, the token Apple holds for it
      // is asked for again, and the server told when it changed
      void refreshNativePush().catch(() => {})
    })
    return () => {
      disposed = true
      dispose?.()
    }
  }, [])

  // iOS has just said this phone may notify, from whichever button asked: the
  // reminders that were waiting on it are set now, not at the next change
  useEffect(() => onNotificationsAllowed(() => remindersRef.current()), [])

  // due tasks and my events as they start, while the app is open (device-local,
  // never a store write): the copies in Google and Outlook no longer ring
  useEffect(() => {
    notifyRef.current()
    const t = window.setInterval(() => notifyRef.current(), 30_000)
    return () => window.clearInterval(t)
  }, [])

  // meals too: a takeaway logged tonight takes that place's nudge off the phone;
  // and who I am, which may be known only after the last change, so a household
  // member's events never stay on this phone for want of it
  useEffect(() => {
    if (!store.loaded) return
    const t = window.setTimeout(() => remindersRef.current(), 1500)
    return () => window.clearTimeout(t)
  }, [store.loaded, store.tasks, store.people, store.places, store.meals, store.events, myId])

  // iOS: the Home Screen widget's snapshot of the day, and what Siri was asked
  // to add while the app was shut (src/widgetbridge.ts)
  useWidgetBridge(store)
}
