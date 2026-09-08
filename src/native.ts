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
  try {
    const stopKeyboard = await watchKeyboard()
    handles.push({ remove: async () => stopKeyboard() })
  } catch {
    /* optional */
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

const GENERIC_REMINDERS_KEY = 'drafter:reminders-generic'

/** When on, lock-screen reminders say "Something is due" instead of a task title or a person's name. */
export function genericRemindersEnabled(): boolean {
  try {
    return localStorage.getItem(GENERIC_REMINDERS_KEY) === '1'
  } catch {
    return false
  }
}

export function setGenericRemindersEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(GENERIC_REMINDERS_KEY, '1')
    else localStorage.removeItem(GENERIC_REMINDERS_KEY)
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

// ---- keyboard: lift modal chrome above the software keyboard ----------------

/** Keep `--keyboard-h` in sync so sheets sit above the iOS keyboard. */
export async function watchKeyboard(): Promise<() => void> {
  if (!isNative()) return () => {}
  try {
    const { Keyboard } = await import('@capacitor/keyboard')
    const set = (h: number) => document.documentElement.style.setProperty('--keyboard-h', `${Math.max(0, h)}px`)
    const show = await Keyboard.addListener('keyboardWillShow', e => set(e.keyboardHeight))
    const hide = await Keyboard.addListener('keyboardWillHide', () => set(0))
    return () => {
      void show.remove()
      void hide.remove()
      set(0)
    }
  } catch {
    return () => {}
  }
}

// ---- Face ID / device passcode lock ----------------------------------------

const APP_LOCK_KEY = 'drafter:app-lock'

export function appLockEnabled(): boolean {
  try {
    return localStorage.getItem(APP_LOCK_KEY) === '1'
  } catch {
    return false
  }
}

export function setAppLockEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(APP_LOCK_KEY, '1')
    else localStorage.removeItem(APP_LOCK_KEY)
  } catch {
    /* ignore */
  }
}

export type BiometryStatus = {
  available: boolean
  /** Face ID, Touch ID, or device passcode. */
  label: string
  reason?: string
}

export async function checkAppLock(): Promise<BiometryStatus> {
  try {
    const { BiometricAuth, BiometryType } = await import('@aparajita/capacitor-biometric-auth')
    const info = await BiometricAuth.checkBiometry()
    const type =
      info.biometryType === BiometryType.faceId
        ? 'Face ID'
        : info.biometryType === BiometryType.touchId
          ? 'Touch ID'
          : info.deviceIsSecure
            ? 'device passcode'
            : 'biometrics'
    const available = info.isAvailable || info.deviceIsSecure
    return { available, label: type, reason: available ? undefined : info.reason || undefined }
  } catch {
    return { available: false, label: 'biometrics', reason: 'Not available on this device.' }
  }
}

/** Prompt Face ID / Touch ID / device passcode. False if cancelled or unavailable. */
export async function authenticateAppLock(reason = 'Unlock Drafter'): Promise<boolean> {
  try {
    const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth')
    await BiometricAuth.authenticate({ reason, allowDeviceCredential: true, cancelTitle: 'Cancel' })
    return true
  } catch {
    return false
  }
}

/**
 * Lock when the app returns from the background (native resume, or the tab
 * hidden for 12s). Does not steal URL / launch events from initNative.
 */
export async function watchAppLock(onLock: () => void): Promise<() => void> {
  let hiddenAt = 0
  const onVis = () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now()
    else if (appLockEnabled() && hiddenAt && Date.now() - hiddenAt > 12_000) onLock()
  }
  document.addEventListener('visibilitychange', onVis)
  if (!isNative()) return () => document.removeEventListener('visibilitychange', onVis)
  try {
    const { App } = await import('@capacitor/app')
    const handle = await App.addListener('resume', () => {
      if (appLockEnabled()) onLock()
    })
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      void handle.remove()
    }
  } catch {
    return () => document.removeEventListener('visibilitychange', onVis)
  }
}
