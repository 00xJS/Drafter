import { apiFetch } from './api'
import { isNative } from './native'

// Web push: the browser's subscription is registered with /api/push, keyed to
// the signed-in user; the hourly digest function sends to it.

export interface PushInfo {
  configured: boolean
  missing: string[]
  /** Which channels the host can send on. */
  webPush: boolean
  apns: boolean
  publicKey: string | null
  subscriptions: string[]
  digestEmail: boolean
  /**
   * Whether this site can send the digest by email at all. Without it the
   * switch is not offered: it was, and a digest that never came looked like
   * one that had. An older server leaves it out, which reads as yes.
   */
  emailConfigured?: boolean
  digestHour: number
  /** Sunday's unattended review draft may read the week's journal (off by default). */
  digestJournal: boolean
  timezone: string | null
  /** Sunday's review draft runs for this account — push or not — and its journal switch can be saved. */
  sundayDraft: boolean
  /**
   * An AI provider key is set on the host. Sunday's draft is written by the
   * provider, so without one none ever is, and the journal switch says so.
   * Only a yes or no; an older server leaves it out, which reads as yes.
   */
  aiConfigured?: boolean
  email: string
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok || !body) throw new Error(body?.error ?? `HTTP ${res.status}`)
  return body
}

export const pushSupported = () => isNative() || ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window)

/** The iOS app's APNs device token, remembered so it can be unsubscribed later. */
const APNS_KEY = 'drafter:apns-token'
const storedApnsToken = (): string | null => {
  try {
    return localStorage.getItem(APNS_KEY)
  } catch {
    return null
  }
}

/**
 * A build signed by a free personal team carries no `aps-environment`
 * entitlement, so Apple refuses registration with a message about the missing
 * entitlement string. Say what that actually means for this app.
 */
export function apnsRegistrationError(raw: string): string {
  if (/aps-environment|entitlement/i.test(raw)) {
    return 'This build cannot receive server push: Apple only issues device tokens to apps signed by an Apple Developer Program team. Reminders scheduled on this iPhone still work.'
  }
  return raw
}

/** The part of the push plugin a token is asked through: the real one, or a test's. */
export interface TokenSource {
  checkPermissions(): Promise<{ receive: string }>
  requestPermissions(): Promise<{ receive: string }>
  addListener(event: 'registration', fn: (t: { value: string }) => void): Promise<{ remove(): Promise<void> }>
  addListener(event: 'registrationError', fn: (e: { error: string }) => void): Promise<{ remove(): Promise<void> }>
  register(): Promise<void>
}

const loadPlugin = async (): Promise<TokenSource> => (await import('@capacitor/push-notifications')).PushNotifications as unknown as TokenSource

/**
 * Ask iOS for a device token: after asking for permission when `ask` is on,
 * or only when it is already given (the launch's quiet re-check).
 *
 * Each attempt takes its two listeners away again once it has an answer. They
 * used to stay, so every later attempt — each Enable, and now each launch —
 * left one more pair behind, all of them answering the next token at once.
 * The listeners are in place before register() runs: Apple can answer at once
 * with a token it has already issued, and the plugin keeps no answer nobody
 * was listening for.
 */
export async function nativeToken({ ask = true, plugin }: { ask?: boolean; plugin?: TokenSource } = {}): Promise<string> {
  const push = plugin ?? (await loadPlugin())
  let perm = await push.checkPermissions()
  if (perm.receive !== 'granted' && ask) perm = await push.requestPermissions()
  if (perm.receive !== 'granted') throw new Error('Notifications were not allowed. Turn them on in the iPhone Settings app, under Drafter.')
  const handles: { remove(): Promise<void> }[] = []
  let settled = false
  const dropListeners = () => {
    settled = true
    for (const h of handles.splice(0)) void h.remove().catch(() => {})
  }
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Apple did not hand back a device token. The build needs the push capability and the phone needs to be online.')), 15_000)
      const answer = (fn: () => void) => {
        clearTimeout(timer)
        fn()
      }
      Promise.all([
        push.addListener('registration', t => answer(() => resolve(t.value))),
        push.addListener('registrationError', e => answer(() => reject(new Error(apnsRegistrationError(e.error))))),
      ])
        .then(added => {
          handles.push(...added)
          // an attempt that timed out while its listeners were being added takes them away at once
          if (settled) dropListeners()
          else return push.register()
        })
        .catch(e => answer(() => reject(e instanceof Error ? e : new Error(String(e)))))
    })
  } finally {
    dropListeners()
  }
}

/**
 * The launch's check on this iPhone's device token, while push is on here.
 *
 * Apple may hand an app a new token — after a restore, a reinstall, or for
 * reasons of its own — and every push the server then sends to the old one
 * goes nowhere, with nothing on the phone to say so. So each launch asks again,
 * without prompting (permission taken away in the Settings app is left
 * alone), and when the answer is a different token the server's entry is
 * swapped for the new one: the new one added first, so a failure in between
 * leaves a working entry rather than none.
 */
export async function refreshNativePush({ plugin, post = postPush }: { plugin?: TokenSource; post?: typeof postPush } = {}): Promise<'off' | 'unchanged' | 'updated'> {
  const stored = storedApnsToken()
  if (!isNative() || !stored) return 'off'
  const token = await nativeToken({ ask: false, plugin })
  if (token === stored) return 'unchanged'
  await post({ action: 'subscribe', subscription: { type: 'apns', token }, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
  rememberApnsToken(token)
  await post({ action: 'unsubscribe', endpoint: `apns:${stored}` }).catch(() => {})
  return 'updated'
}

function rememberApnsToken(token: string): void {
  try {
    localStorage.setItem(APNS_KEY, token)
  } catch {
    /* ignore */
  }
}

/** One POST to /api/push, answered with the subscriptions the account now has. */
function postPush(body: Record<string, unknown>): Promise<{ subscriptions: string[] }> {
  return apiFetch('/api/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json<{ subscriptions: string[] }>)
}

export function fetchPushInfo(): Promise<PushInfo> {
  return apiFetch('/api/push').then(json<PushInfo>)
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/** The current device's subscription endpoint, if any. */
export async function currentEndpoint(): Promise<string | null> {
  if (isNative()) {
    const t = storedApnsToken()
    return t ? `apns:${t}` : null
  }
  if (!pushSupported()) return null
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  return sub?.endpoint ?? null
}

/**
 * A registration with an ACTIVE worker. getRegistration() resolves as soon as
 * register() is called — while the worker may still be installing — and
 * pushManager.subscribe() on such a registration fails; `ready` waits for
 * activation. Raced with a timeout so a page with no worker cannot hang.
 */
async function activeRegistration(): Promise<ServiceWorkerRegistration> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('The service worker is not ready yet. Reload the page and try again.')), 10_000),
    ),
  ])
}

export async function enablePush(publicKey: string): Promise<string[]> {
  if (isNative()) {
    const token = await nativeToken()
    rememberApnsToken(token)
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const r = await postPush({ action: 'subscribe', subscription: { type: 'apns', token }, timezone })
    return r.subscriptions
  }
  if (!pushSupported()) throw new Error('This browser does not support push notifications.')
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notifications were not allowed.')
  const reg = await activeRegistration()
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }))
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const r = await apiFetch('/api/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'subscribe', subscription: sub.toJSON(), timezone }) }).then(json<{ subscriptions: string[] }>)
  return r.subscriptions
}

export async function disablePush(): Promise<string[]> {
  if (isNative()) {
    const endpoint = await currentEndpoint()
    try {
      localStorage.removeItem(APNS_KEY)
    } catch {
      /* ignore */
    }
    try {
      const { PushNotifications } = await import('@capacitor/push-notifications')
      await PushNotifications.unregister()
    } catch {
      /* already off */
    }
    const r = await apiFetch('/api/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'unsubscribe', endpoint }) }).then(json<{ subscriptions: string[] }>)
    return r.subscriptions
  }
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  const endpoint = sub?.endpoint
  await sub?.unsubscribe()
  const r = await apiFetch('/api/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'unsubscribe', endpoint }) }).then(json<{ subscriptions: string[] }>)
  return r.subscriptions
}

export function testPush(): Promise<{ sent: number }> {
  return apiFetch('/api/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'test' }) }).then(json<{ sent: number }>)
}

export function savePushPrefs(prefs: { digestEmail: boolean; digestHour: number; digestJournal?: boolean }): Promise<{ ok: true }> {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return apiFetch('/api/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'prefs', ...prefs, timezone }) }).then(json<{ ok: true }>)
}
