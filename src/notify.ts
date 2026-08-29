import { Post } from './types'
import { excerpt } from './utils'

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

const MAX_AGE_MS = 86_400_000 // don't nag about posts overdue by more than a day

/** Fire a reminder for every scheduled post whose time has arrived. */
export function notifyDue(posts: Post[], onNotified: (id: string) => void): void {
  if (!notificationsSupported() || Notification.permission !== 'granted') return
  const now = Date.now()
  for (const p of posts) {
    if (p.status !== 'scheduled' || !p.scheduledFor || p.notifiedAt || p.deletedAt) continue
    const due = new Date(p.scheduledFor).getTime()
    if (due <= now && now - due < MAX_AGE_MS) {
      try {
        new Notification(`Time to post: ${p.title || 'Untitled'}`, {
          body: excerpt(p.body, 120) || 'Open Drafter to copy the content.',
        })
      } catch (e) {
        console.error('Notification failed', e)
      }
      onNotified(p.id)
    }
  }
}
