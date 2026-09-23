import { CalendarEntry, OPEN_STATUSES, Task } from './types'
import { excerpt } from './utils'
import { eventRemindAt, remindsMe, taskRemindAt } from './reminders'
import { hasDueTime, isOverdue } from '../shared/due.mts'
import { isMineTask } from '../shared/domain.mts'

// Reminders are device-local by design: each open device notifies once per
// task of mine, and once as each of my own events starts — their copies in
// Google and Outlook no longer ring, so this is where a browser hears of them.
// Nothing here writes to the synced store (a UI event must never win a data
// merge). While the app is closed no reminder fires here; server push nudges a
// browser about timed tasks then (netlify/functions/digest.mjs).

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

const MAX_AGE_MS = 86_400_000 // don't nag about tasks overdue by more than a day

export interface NotifyOpts {
  /** Drafter's own events (store.events). Never a feed's: its own calendar reminds about that. */
  events?: CalendarEntry[]
  /** Only my own events, and only the tasks I am doing (isMineTask), remind me: a household member's evening, and chore, is theirs. */
  myId?: string | null
}

export interface DueNotice {
  /** What this device remembers having shown: a task's id; an event's id and start, so a moved event rings again. */
  key: string
  title: string
  body: string
}

/** When an event is over: its end instant, or the local midnight after an all-day one (its end is exclusive). */
function eventEndMs(e: CalendarEntry): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(e.end)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : Date.parse(e.end)
}

/**
 * What should ring now: each open task of mine (isMineTask) on the phone's
 * rule (taskRemindAt: at its time, or at 9am on a day with no time — never at
 * the 00:00 it is stored at) in the last day, and each of my own events on the
 * phone's rule too (remindsMe and eventRemindAt: a timed one at its start, an
 * all-day one at 9am on its first day, never a work day or a household
 * member's) that has not ended yet — "starts now" about an event already over
 * is no reminder, and neither is "due today" about a day that is over.
 */
export function dueNotices(tasks: Task[], now: number, opts: NotifyOpts = {}): DueNotice[] {
  const out: DueNotice[] = []
  for (const p of tasks) {
    if (!OPEN_STATUSES.includes(p.status) || !p.dueAt || p.deletedAt || !isMineTask(p, opts.myId)) continue
    const at = taskRemindAt(p.dueAt).getTime()
    if (!(at <= now) || now - at >= MAX_AGE_MS) continue
    const timed = hasDueTime(p.dueAt)
    if (!timed && isOverdue(p.dueAt, now)) continue
    out.push({ key: p.id, title: `${p.title || 'Untitled'} ${timed ? 'is due now' : 'is due today'}`, body: excerpt(p.description, 120) || 'Open Drafter for the details.' })
  }
  for (const e of opts.events ?? []) {
    if (!remindsMe(e, opts.myId)) continue
    const at = eventRemindAt(e)?.getTime() ?? NaN
    if (!(at <= now) || now - at >= MAX_AGE_MS || now >= eventEndMs(e)) continue
    const title = e.title || 'Untitled event'
    out.push({
      key: `event:${e.id}@${e.start}`,
      title: e.allDay ? `${title} is today` : `${title} starts now`,
      body: e.location || excerpt(e.notes ?? '', 120) || 'Open Drafter for the details.',
    })
  }
  return out
}

/** Fire a reminder for each open task of mine as it comes due, and for each of my own events as it starts. */
export async function notifyDue(tasks: Task[], opts: NotifyOpts = {}): Promise<void> {
  if (!notificationsSupported() || Notification.permission !== 'granted') return
  const already = seen()
  let dirty = false
  for (const n of dueNotices(tasks, Date.now(), opts)) {
    if (already.has(n.key)) continue
    if (await show(n.title, n.body)) {
      already.add(n.key)
      dirty = true
    }
  }
  if (dirty) markSeen(already)
}
