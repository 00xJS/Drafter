import { useEffect, useRef } from 'react'
import type { Store } from '../../store'
import { notifyDue } from '../../notify'
import { clearAppBadge, genericRemindersEnabled, initNative, isNative, localRemindersEnabled, scheduleLocalReminders } from '../../native'
import { buildLocalReminders, deviceHasServerPush } from '../../reminders'
import { fetchPushInfo } from '../../push'
import type { useDeepLinks } from './useDeepLinks'

interface Deps {
  store: Store
  applyLinkRef: ReturnType<typeof useDeepLinks>['applyLinkRef']
}

/**
 * The device around the app: the iOS shell's links, push taps and resume
 * sync, due reminders while the app is open, and the local notifications the
 * phone fires on its own.
 */
export function useNativeShell({ store, applyLinkRef }: Deps) {
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

  // due reminders while the app is open (device-local, never a store write)
  const notifyRef = useRef(() => {})
  notifyRef.current = () => {
    notifyDue(store.tasks)
  }
  useEffect(() => {
    notifyRef.current()
    const t = window.setInterval(() => notifyRef.current(), 30_000)
    return () => window.clearInterval(t)
  }, [])

  // iOS: the phone itself fires a notification at each due time and on occasion
  // mornings — no server involved, so it works with no account and the app closed
  const remindersRef = useRef(() => {})
  remindersRef.current = () => {
    if (!isNative() || !localRemindersEnabled()) return
    void (async () => {
      let skipTaskDue = false
      try {
        const info = await fetchPushInfo()
        skipTaskDue = await deviceHasServerPush(info.subscriptions ?? [])
      } catch {
        /* offline / unsigned — keep local due reminders */
      }
      await scheduleLocalReminders(buildLocalReminders(store.tasks, store.people, store.places, new Date(), 30, { skipTaskDue, generic: genericRemindersEnabled() }))
    })()
  }
  useEffect(() => {
    if (!store.loaded) return
    const t = window.setTimeout(() => remindersRef.current(), 1500)
    return () => window.clearTimeout(t)
  }, [store.loaded, store.tasks, store.people, store.places])
}
