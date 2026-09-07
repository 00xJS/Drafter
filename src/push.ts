import { apiFetch } from './api'

// Web push: the browser's subscription is registered with /api/push, keyed to
// the signed-in user; the hourly digest function sends to it.

export interface PushInfo {
  configured: boolean
  missing: string[]
  publicKey: string | null
  subscriptions: string[]
  digestEmail: boolean
  digestHour: number
  timezone: string | null
  email: string
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok || !body) throw new Error(body?.error ?? `HTTP ${res.status}`)
  return body
}

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

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

export function savePushPrefs(prefs: { digestEmail: boolean; digestHour: number }): Promise<{ ok: true }> {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return apiFetch('/api/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'prefs', ...prefs, timezone }) }).then(json<{ ok: true }>)
}
