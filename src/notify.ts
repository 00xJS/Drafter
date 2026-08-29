import { Post } from './types'
import { excerpt } from './utils'

// Reminders are device-local by design: each open device notifies once per
// post. Nothing here writes to the synced store (a UI event must never win a
// data merge). While the app is closed no reminder fires — server-side push
// would be the upgrade path.

const SEEN_KEY = 'drafter:notified'

function seen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

function markSeen(ids: Set<string>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...ids].slice(-500)))
  } catch {
    /* ignore */
  }
}

export function notificationsSupported(): boolean {
  return 'Notification' in window
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return notificationsSupported() ? Notification.permission : 'unsupported'
}

export async function enableNotifications(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported'
  return Notification.requestPermission()
}

async function show(title: string, body: string): Promise<boolean> {
  // Android Chrome forbids the page-context constructor when a service worker
  // is registered — go through the registration when one exists.
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    if (reg) {
      await reg.showNotification(title, { body })
      return true
    }
  } catch {
    /* fall through */
  }
  try {
    new Notification(title, { body })
    return true
  } catch (e) {
    console.error('Notification failed', e)
    return false
  }
}

const MAX_AGE_MS = 86_400_000 // don't nag about posts overdue by more than a day

/** Fire a reminder for every scheduled post whose time has arrived. */
export async function notifyDue(posts: Post[]): Promise<void> {
  if (!notificationsSupported() || Notification.permission !== 'granted') return
  const now = Date.now()
  const already = seen()
  let dirty = false
  for (const p of posts) {
    if (p.status !== 'scheduled' || !p.scheduledFor || p.deletedAt || already.has(p.id)) continue
    const due = new Date(p.scheduledFor).getTime()
    if (due <= now && now - due < MAX_AGE_MS) {
      const shown = await show(`Time to post: ${p.title || 'Untitled'}`, excerpt(p.body, 120) || 'Open Drafter to copy the content.')
      if (shown) {
        already.add(p.id)
        dirty = true
      }
    }
  }
  if (dirty) markSeen(already)
}
