import { Capacitor } from '@capacitor/core'

// The iOS app is this same web bundle inside a native shell. Everything that
// differs lives here, behind one check, so the rest of the code never asks
// "am I an app?" more than once per concern.

/** True inside the iOS shell; false in every browser, installed PWA included. */
export const isNative = (): boolean => Capacitor.isNativePlatform()

/** Open a URL outside the web view: Safari's sheet on iOS, a new tab on the web. */
export async function openExternal(url: string): Promise<void> {
  if (isNative()) {
    const { Browser } = await import('@capacitor/browser')
    await Browser.open({ url })
  } else {
    window.open(url, '_blank', 'noopener')
  }
}

/**
 * Start an OAuth consent flow. On native, opens Safari's sheet and returns
 * 'native' so the caller can clear busy state; on web, navigates away.
 */
export async function startOAuth(url: string): Promise<'native' | 'redirect'> {
  if (isNative()) {
    await openExternal(url)
    return 'native'
  }
  window.location.href = url
  return 'redirect'
}

/** Dismiss the sheet opened by openExternal, e.g. once an OAuth flow has come back. */
export async function closeExternal(): Promise<void> {
  if (!isNative()) return
  const { Browser } = await import('@capacitor/browser')
  await Browser.close().catch(() => {})
}

/** A small physical confirmation; silent on the web. */
export async function haptic(kind: 'light' | 'success' = 'light'): Promise<void> {
  if (!isNative()) return
  try {
    const { Haptics, ImpactStyle, NotificationType } = await import('@capacitor/haptics')
    if (kind === 'success') await Haptics.notification({ type: NotificationType.Success })
    else await Haptics.impact({ style: ImpactStyle.Light })
  } catch {
    /* haptics are optional */
  }
}

export interface NativeHooks {
  /** A URL the app was asked to open: drafter://…, a push tap, or an OAuth return. */
  onUrl(url: string): void
  /** The app came back to the foreground. */
  onResume(): void
}

/** Wire the shell's events once. Returns a disposer. No-op on the web. */
export async function initNative(hooks: NativeHooks): Promise<() => void> {
  if (!isNative()) return () => {}
  const { App } = await import('@capacitor/app')
  const handles = [await App.addListener('appUrlOpen', e => hooks.onUrl(e.url)), await App.addListener('resume', () => hooks.onResume())]
  // a cold start from a link arrives here rather than as an event
  const launch = await App.getLaunchUrl().catch(() => null)
  if (launch?.url) hooks.onUrl(launch.url)
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    handles.push(
      await LocalNotifications.addListener('localNotificationActionPerformed', a => {
        const url = (a.notification.extra as { url?: unknown } | undefined)?.url
        if (typeof url === 'string') hooks.onUrl(url)
      }),
    )
  } catch {
    /* optional */
  }
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')
    handles.push(
      await PushNotifications.addListener('pushNotificationActionPerformed', a => {
        const url = (a.notification.data as { url?: unknown } | undefined)?.url
        if (typeof url === 'string') hooks.onUrl(url)
      }),
    )
  } catch {
    /* the plugin is optional at runtime */
  }
  return () => {
    for (const h of handles) void h.remove()
  }
}

// ---- reminders the phone fires by itself --------------------------------------

const LOCAL_REMINDERS_KEY = 'drafter:local-reminders'

export function localRemindersEnabled(): boolean {
  try {
    return localStorage.getItem(LOCAL_REMINDERS_KEY) === '1'
  } catch {
    return false
  }
}

export function setLocalRemindersEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(LOCAL_REMINDERS_KEY, '1')
    else localStorage.removeItem(LOCAL_REMINDERS_KEY)
  } catch {
    /* ignore */
  }
}

/** Ask iOS once; false if the user said no (the fix is then the Settings app). */
export async function requestLocalNotificationPermission(): Promise<boolean> {
  if (!isNative()) return false
  const { LocalNotifications } = await import('@capacitor/local-notifications')
  let p = await LocalNotifications.checkPermissions()
  if (p.display !== 'granted') p = await LocalNotifications.requestPermissions()
  return p.display === 'granted'
}

export interface PendingReminder {
  id: number
  title: string
  body: string
  at: Date
  url: string
  badge?: number
}

/**
 * Replace every pending reminder with this set. iOS holds at most 64 pending
 * local notifications per app, so the soonest 60 win. Returns how many are set.
 */
export async function scheduleLocalReminders(items: PendingReminder[]): Promise<number> {
  if (!isNative()) return 0
  const { LocalNotifications } = await import('@capacitor/local-notifications')
  if ((await LocalNotifications.checkPermissions()).display !== 'granted') return 0
  const pending = await LocalNotifications.getPending()
  if (pending.notifications.length) await LocalNotifications.cancel({ notifications: pending.notifications.map(n => ({ id: n.id })) })
  const now = Date.now()
  const upcoming = items
    .filter(i => i.at.getTime() > now)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(0, 60)
  if (upcoming.length) {
    await LocalNotifications.schedule({
      notifications: upcoming.map(i => ({
        id: i.id,
        title: i.title,
        body: i.body,
        schedule: { at: i.at, allowWhileIdle: true },
        extra: { url: i.url },
        sound: 'default',
        ...(i.badge != null ? { badge: i.badge } : {}),
      })),
    })
  }
  return upcoming.length
}

/** Clear the home-screen badge when the app comes forward. */
export async function clearAppBadge(): Promise<void> {
  if (!isNative()) return
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    // Capacitor 8: setting badge via a delivered notification isn't required —
    // cancel pending already ran; zero via PushNotifications when available.
    const { PushNotifications } = await import('@capacitor/push-notifications')
    await PushNotifications.removeAllDeliveredNotifications?.()
    void LocalNotifications
  } catch {
    /* plugin may be unavailable in simulator builds without push */
  }
}
