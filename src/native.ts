import { Capacitor } from '@capacitor/core'

// The iOS app is this same web bundle inside a native shell. Everything that
// differs lives here, behind one check, so the rest of the code never asks
// "am I an app?" more than once per concern.

/** True inside the iOS shell; false in every browser, installed PWA included. */
export const isNative = (): boolean => Capacitor.isNativePlatform()

/**
 * Stamp the root element with the platform once, at startup, so the stylesheet
 * can diverge inside the native shell — the grouped inset lists, the sheet-style
 * modals, the frosted tab bar and the large title all key off `html.native`.
 * It always adds a truthful class, so in a browser `.native` / `.ios` simply
 * never match and the web layout stands. `?native=1` in the URL forces the
 * classes on in a desktop browser, which is how the iOS look is previewed
 * without a device build.
 */
export function applyPlatformClasses(): void {
  const root = document.documentElement
  const forced = typeof location !== 'undefined' && new URLSearchParams(location.search).has('native')
  const native = isNative() || forced
  root.classList.toggle('native', native)
  const platform = forced && !isNative() ? 'ios' : Capacitor.getPlatform()
  root.classList.add(`platform-${platform}`)
  root.classList.toggle('ios', platform === 'ios')
}

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

/**
 * The haptics plugin, loaded once. A swipe threshold has to buzz within a few
 * milliseconds of the finger crossing it, and a cold `import()` is a chunk
 * fetch — so the first crossing of a session was silent until this was
 * memoised. A failed load is not cached, so a later call may retry.
 */
let hapticsModule: Promise<typeof import('@capacitor/haptics')> | null = null
function loadHaptics(): Promise<typeof import('@capacitor/haptics')> {
  if (!hapticsModule) {
    hapticsModule = import('@capacitor/haptics').catch(err => {
      hapticsModule = null
      throw err
    })
  }
  return hapticsModule
}

/** Pull the haptics chunk in before the first gesture needs it. No-op on the web. */
export async function warmHaptics(): Promise<void> {
  if (!isNative()) return
  try {
    await loadHaptics()
  } catch {
    /* haptics are optional */
  }
}

/** A small physical confirmation; silent on the web. */
export async function haptic(kind: 'light' | 'success' = 'light'): Promise<void> {
  if (!isNative()) return
  try {
    const { Haptics, ImpactStyle, NotificationType } = await loadHaptics()
    if (kind === 'success') await Haptics.notification({ type: NotificationType.Success })
    else await Haptics.impact({ style: ImpactStyle.Light })
  } catch {
    /* haptics are optional */
  }
}

export interface NativeHooks {
  /**
   * A URL the app was asked to open: drafter://…, a push tap, or an OAuth return.
   * `fromNotification` is true only for a tap on one of our own local reminders,
   * which is the only source allowed to carry a write-on-arrival `act=` button.
   * Every other producer — an external drafter:// link from Safari, a Shortcut,
   * a cold-start launch URL, a push tap — leaves it false.
   */
  onUrl(url: string, fromNotification?: boolean): void
  /** The app came back to the foreground. */
  onResume(): void
}

/** How long after launch the same URL is treated as the duplicate it is. */
const LAUNCH_DEDUPE_MS = 5000

/** Wire the shell's events once. Returns a disposer. No-op on the web. */
export async function initNative(hooks: NativeHooks): Promise<() => void> {
  if (!isNative()) return () => {}
  // the first swipe of a session should buzz like every later one
  void warmHaptics()
  const { App } = await import('@capacitor/app')
  // A cold-start drafter:// URL is delivered on BOTH channels: Capacitor's scene
  // proxy replays the launch URL contexts as an `appUrlOpen` (retained until a
  // listener consumes it) and records the same URL for App.getLaunchUrl(). Applied
  // twice, `drafter://journal?text=…` writes the line twice. Whichever channel
  // lands first wins, and the copy from the other one is dropped — but only while
  // the app is starting, so tapping the same Shortcut again later still works.
  const startedAt = Date.now()
  const launchSeen = new Set<string>()
  const deliverUrl = (url: string, fromNotification = false) => {
    if (Date.now() - startedAt < LAUNCH_DEDUPE_MS) {
      if (launchSeen.has(url)) return
      launchSeen.add(url)
    }
    hooks.onUrl(url, fromNotification)
  }
  const handles = [await App.addListener('appUrlOpen', e => deliverUrl(e.url)), await App.addListener('resume', () => hooks.onResume())]
  // a cold start from a link may arrive here rather than as an event
  const launch = await App.getLaunchUrl().catch(() => null)
  if (launch?.url) deliverUrl(launch.url)
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    handles.push(
      await LocalNotifications.addListener('localNotificationActionPerformed', a => {
        const url = (a.notification.extra as { url?: unknown } | undefined)?.url
        if (typeof url !== 'string') return
        // 'tap' is the banner itself; anything else is one of the buttons
        // registered below, and rides along on that row's own link.
        const act = a.actionId && a.actionId !== 'tap' ? a.actionId : ''
        deliverUrl(act ? `${url}${url.includes('?') ? '&' : '?'}act=${encodeURIComponent(act)}` : url, true)
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
  try {
    const stopTextSize = await watchTextSize()
    handles.push({ remove: async () => stopTextSize() })
  } catch {
    /* optional: the app just stays at scale 1 */
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

/** The action buttons a reminder can carry. Omitted from a generic reminder. */
export const TASK_ACTION_TYPE = 'DRAFTER_TASK'
export const OCCASION_ACTION_TYPE = 'DRAFTER_OCCASION'

export interface PendingReminder {
  id: number
  title: string
  body: string
  at: Date
  url: string
  /** TASK_ACTION_TYPE / OCCASION_ACTION_TYPE, or nothing for a title-less banner. */
  actionTypeId?: string
}

/**
 * Register the notification categories once per launch. iOS keeps them for the
 * app, not for a notification, so this only has to beat the first schedule call.
 * Every action is `foreground: true`: a background action would need the web
 * view to be alive when iOS delivers the response, which is not guaranteed —
 * foreground still saves the hunt for the row and lands on an undo toast.
 */
let actionTypesRegistered = false

/**
 * Replace every pending reminder with this set. iOS holds at most 64 pending
 * local notifications per app, so the soonest 60 win. Returns how many are set.
 */
export async function scheduleLocalReminders(items: PendingReminder[]): Promise<number> {
  if (!isNative()) return 0
  const { LocalNotifications } = await import('@capacitor/local-notifications')
  if ((await LocalNotifications.checkPermissions()).display !== 'granted') return 0
  if (!actionTypesRegistered) {
    try {
      await LocalNotifications.registerActionTypes({
        types: [
          {
            id: TASK_ACTION_TYPE,
            actions: [
              { id: 'done', title: 'Done', foreground: true },
              { id: 'tomorrow', title: 'Tomorrow', foreground: true },
            ],
          },
          { id: OCCASION_ACTION_TYPE, actions: [{ id: 'saw', title: 'Saw them', foreground: true }] },
        ],
      })
      actionTypesRegistered = true
    } catch {
      /* an older plugin still schedules fine, just without buttons */
    }
  }
  const pending = await LocalNotifications.getPending()
  if (pending.notifications.length) await LocalNotifications.cancel({ notifications: pending.notifications.map(n => ({ id: n.id })) })
  const now = Date.now()
  const upcoming = items
    .filter(i => i.at.getTime() > now)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(0, 60)
  if (upcoming.length) {
    await LocalNotifications.schedule({
      notifications: upcoming.map((i, idx) => ({
        id: i.id,
        title: i.title,
        body: i.body,
        schedule: { at: i.at, allowWhileIdle: true },
        extra: { url: i.url },
        sound: 'default',
        // the badge counts reminders that have fired since Drafter was last
        // opened — these are in time order, so the nth to fire leaves n behind.
        // clearAppBadge() zeroes it again on the next launch or resume.
        badge: idx + 1,
        ...(i.actionTypeId ? { actionTypeId: i.actionTypeId } : {}),
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
    // This one both empties Notification Centre and sets the icon badge to zero,
    // with no registration guard. The push plugin's identically named method
    // rejects until APNs registration has run, which never happens on a free
    // Apple team — so the badge used to stick to the icon for good.
    await LocalNotifications.removeAllDeliveredNotifications()
  } catch {
    /* the plugin is optional at runtime */
  }
}

// ---- keyboard: signal the keyboard, and give multi-line fields a Done key ----

/**
 * Publish the keyboard state to CSS.
 *
 * `capacitor.config.ts` uses `resize: 'native'`, so iOS already shrinks the
 * WebView by the keyboard height: `--keyboard-h` is a SIGNAL, never an inset to
 * spend on padding — doing that subtracts the keyboard twice. The `keyboard-open`
 * class is what layout rules should key off (see the `.tabs-compact` rule in
 * styles.css, which slides the fixed tab bar out of the caret's way).
 */
export async function watchKeyboard(): Promise<() => void> {
  if (!isNative()) return () => {}
  try {
    const { Keyboard } = await import('@capacitor/keyboard')
    // the plugin hides the system accessory bar by default, which leaves every
    // multi-line field with no way to dismiss the keyboard — and the journal
    // editor only commits on blur, so "no Done key" means "no save". Its own
    // try: a failure here must not cost us the listeners below.
    try {
      await Keyboard.setAccessoryBarVisible({ isVisible: true })
    } catch {
      /* older plugin or a platform without an accessory bar */
    }
    const set = (h: number) => {
      document.documentElement.style.setProperty('--keyboard-h', `${Math.max(0, h)}px`)
      document.documentElement.classList.toggle('keyboard-open', h > 0)
    }
    const show = await Keyboard.addListener('keyboardWillShow', e => set(e.keyboardHeight))
    const hide = await Keyboard.addListener('keyboardWillHide', () => set(0))
    // `keyboard-open` now hides the tab bar outright, so a dropped
    // `keyboardWillHide` (backgrounded with a field focused, a cancelled
    // interactive dismiss) would strand the user with no navigation. Coming
    // back to the foreground always means the keyboard is down.
    const onVisible = () => {
      if (document.visibilityState === 'visible') set(0)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      void show.remove()
      void hide.remove()
      document.removeEventListener('visibilitychange', onVisible)
      set(0)
    }
  } catch {
    return () => {}
  }
}

// ---- Dynamic Type: the OS drives the type ramp -------------------------------

/**
 * iOS body text at the default Dynamic Type size. Everything the reader has
 * asked for is measured against this one number.
 */
const IOS_BODY_PX = 17

/** Below 0.9 the chrome stops being tappable; above 1.6 nothing survives 375pt. */
const TYPE_SCALE_MIN = 0.9
const TYPE_SCALE_MAX = 1.6

/** The `--type-scale` a probe of this computed size should publish. Pure, so it is testable. */
export function typeScaleFor(probePx: number): number {
  if (!Number.isFinite(probePx) || probePx <= 0) return 1
  const raw = probePx / IOS_BODY_PX
  const clamped = Math.min(TYPE_SCALE_MAX, Math.max(TYPE_SCALE_MIN, raw))
  // three decimals is finer than a Dynamic Type step and keeps the CSS short
  return Math.round(clamped * 1000) / 1000
}

/**
 * Publish the user's system text size to CSS as `--type-scale`.
 *
 * WKWebView resolves the `-apple-system-body` font keyword at the reader's
 * current Dynamic Type size, which is the only place the setting is visible to
 * a web view — there is no media query and no JS API for it. So a hidden probe
 * is styled with that keyword and its computed size is read back.
 *
 * iOS does not tell an app its text size changed while it is backgrounded (the
 * user leaves for Settings and comes back), so the probe is re-read on `resume`
 * and on `visibilitychange`. No-op on the web, where the browser's own zoom and
 * default font size already do this job and 1 is the honest answer.
 *
 * Returns a disposer. See `--type-scale` in styles.css for what reads it.
 */
export async function watchTextSize(): Promise<() => void> {
  if (!isNative()) return () => {}
  const probe = document.createElement('div')
  probe.setAttribute('aria-hidden', 'true')
  // Out of flow, unpainted and unreachable: it exists only to be measured. The
  // explicit 17px comes FIRST so the `font` shorthand overwrites it wherever the
  // keyword is understood — and, where it is not, the probe still reports the
  // baseline instead of inheriting a body size that this very reading sets,
  // which would walk --type-scale down to its floor over a few resumes.
  probe.style.cssText =
    'position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;' + `font-size:${IOS_BODY_PX}px;font:-apple-system-body`
  document.body.appendChild(probe)
  const read = () => {
    const px = Number.parseFloat(getComputedStyle(probe).fontSize)
    document.documentElement.style.setProperty('--type-scale', String(typeScaleFor(px)))
  }
  read()
  const onVisible = () => {
    if (document.visibilityState === 'visible') read()
  }
  document.addEventListener('visibilitychange', onVisible)
  let handle: { remove(): Promise<void> } | null = null
  try {
    const { App } = await import('@capacitor/app')
    handle = await App.addListener('resume', read)
  } catch {
    /* a missing app plugin costs the resume re-read, not the initial measure */
  }
  return () => {
    document.removeEventListener('visibilitychange', onVisible)
    void handle?.remove()
    probe.remove()
    document.documentElement.style.removeProperty('--type-scale')
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

// Whether the unlock card is on screen. A link that changes data on arrival —
// a reminder's Done button — has to wait behind it, or its undo toast appears
// (and times out) underneath the lock.
let lockShowing = false
const lockClearedWatchers = new Set<() => void>()

/** True while the Face ID / passcode overlay is covering the app. */
export function isAppLockShowing(): boolean {
  return lockShowing
}

/**
 * LockGate reports the overlay's state here; nothing else should call it.
 * `silent` resets the flag without announcing an unlock — LockGate uses it when
 * it unmounts (the session dropped, so the app is behind the login overlay
 * instead) and for React's development-only double mount.
 */
export function setAppLockShowing(on: boolean, opts?: { silent?: boolean }): void {
  if (lockShowing === on) return
  lockShowing = on
  if (!on && !opts?.silent) for (const cb of [...lockClearedWatchers]) cb()
}

/** Run cb the next time the overlay clears. Returns a disposer. */
export function onAppLockCleared(cb: () => void): () => void {
  lockClearedWatchers.add(cb)
  return () => {
    lockClearedWatchers.delete(cb)
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
 * How long Drafter may be away before coming back asks to unlock again: long
 * enough to glance at a message and return, short enough that a phone put
 * down is locked. One number for the browser tab and the iOS app alike — the
 * app used to ask on every resume, so answering a text cost a Face ID prompt.
 * The App Switcher card is covered natively whatever this says (SceneDelegate).
 */
export const APP_LOCK_GRACE_MS = 12_000

/** True when an absence that began at `awayAt` has outlasted the grace. */
export function pastLockGrace(awayAt: number, now: number): boolean {
  return now - awayAt > APP_LOCK_GRACE_MS
}

/**
 * Lock when the app returns after more than APP_LOCK_GRACE_MS away — a hidden
 * tab on the web, a background and resume in the app. Does not steal URL /
 * launch events from initNative.
 */
export async function watchAppLock(onLock: () => void): Promise<() => void> {
  // when the app was last seen leaving (0 = not yet): the tab hiding or the
  // native `pause`, whichever reports it — in the app both mark one departure
  let awayAt = 0
  // Synchronously, before onLock: raising the lock is a React state change, and
  // `resume` and `localNotificationActionPerformed` arrive in the same burst of
  // bridge callbacks. A reminder's Done button read this flag through
  // isAppLockShowing() one commit too early and wrote (and toasted) behind the
  // Face ID card — the exact case the gate exists to hold back.
  const lock = () => {
    setAppLockShowing(true)
    onLock()
  }
  const onVis = () => {
    if (document.visibilityState === 'hidden') awayAt = Date.now()
    else if (appLockEnabled() && awayAt && pastLockGrace(awayAt, Date.now())) lock()
  }
  document.addEventListener('visibilitychange', onVis)
  if (!isNative()) return () => document.removeEventListener('visibilitychange', onVis)
  try {
    const { App } = await import('@capacitor/app')
    const pause = await App.addListener('pause', () => {
      awayAt = Date.now()
    })
    const resume = await App.addListener('resume', () => {
      // a resume whose departure was never seen can't be timed, so it counts
      // as a long absence: the lock fails closed
      if (appLockEnabled() && (!awayAt || pastLockGrace(awayAt, Date.now()))) lock()
    })
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      void pause.remove()
      void resume.remove()
    }
  } catch {
    return () => document.removeEventListener('visibilitychange', onVis)
  }
}
