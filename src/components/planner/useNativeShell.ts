import { useEffect, useRef } from 'react'
import type { Store } from '../../store'
import { notifyDue } from '../../notify'
import {
  clearAppBadge,
  genericRemindersEnabled,
  initNative,
  isAppLockShowing,
  isNative,
  localRemindersEnabled,
  planDayPref,
  requestLocalNotificationPermission,
  scheduleLocalReminders,
} from '../../native'
import { deviceHasServerPush, deviceReminders } from '../../reminders'
import { fetchPushInfo } from '../../push'
import { useWidgetBridge } from '../../widgetbridge'
import type { useDeepLinks } from './useDeepLinks'

interface Deps {
  store: Store
  applyLinkRef: ReturnType<typeof useDeepLinks>['applyLinkRef']
  /** Who is signed in: only my own events remind me on this phone. */
  myId?: string | null
}

/**
 * The device around the app: the iOS shell's links, push taps and resume
 * sync, due reminders while the app is open, the local notifications the
 * phone fires on its own, and the widget and Siri.
 */
export function useNativeShell({ store, applyLinkRef, myId }: Deps) {
  // the iOS shell: links, push taps, and a sync whenever the app comes forward
  useEffect(() => {
    // the effect can be torn down before initNative resolves (React's
    // development double-mount does exactly that), and a disposer assigned
    // after the cleanup ran would leave every listener subscribed twice
    let disposed = false
    let dispose: (() => void) | null = null
    void initNative({
      // only a tap on one of our own reminders may carry an `act=` that writes on
      // arrival; a drafter:// link from Safari or a Shortcut still just navigates
      onUrl: (url, fromNotif) => applyLinkRef.current(url, '', !!fromNotif),
      onResume: () => {
        void store.syncNowManual()
        remindersRef.current()
        void clearAppBadge()
      },
    }).then(d => {
      if (disposed) {
        d()
        return
      }
      dispose = d
      // resume does not fire at launch, so a cold start clears the badge here
      void clearAppBadge()
    })
    return () => {
      disposed = true
      dispose?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // due tasks and my events as they start, while the app is open (device-local,
  // never a store write): the copies in Google and Outlook no longer ring
  const notifyRef = useRef(() => {})
  notifyRef.current = () => {
    notifyDue(store.tasks, { events: store.events, myId })
  }
  useEffect(() => {
    notifyRef.current()
    const t = window.setInterval(() => notifyRef.current(), 30_000)
    return () => window.clearInterval(t)
  }, [])

  // iOS: the phone itself fires a notification at each due time, at the start
  // of each of my events and on occasion mornings — no server involved, so it
  // works with no account and the app closed — and the morning's Plan your
  // day, which is on until turned off
  const remindersRef = useRef(() => {})
  remindersRef.current = () => {
    if (!isNative()) return
    const local = localRemindersEnabled()
    const planDay = planDayPref()
    if (!local && !planDay.on) return
    void (async () => {
      // Plan your day is on by default, so the first run that would set it asks
      // iOS for notifications; after that iOS answers from the choice made,
      // without asking again. Never over the lock screen: a later run asks
      if (planDay.on && !isAppLockShowing()) await requestLocalNotificationPermission().catch(() => false)
      let skipTaskDue = false
      if (local) {
        try {
          const info = await fetchPushInfo()
          skipTaskDue = await deviceHasServerPush(info.subscriptions ?? [])
        } catch {
          /* offline / unsigned — keep local due reminders */
        }
      }
      await scheduleLocalReminders(
        deviceReminders(store, new Date(), { local, skipTaskDue, generic: genericRemindersEnabled(), planDay, events: store.events, myId }),
      )
    })()
  }
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
