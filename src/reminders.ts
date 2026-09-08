import { OPEN_STATUSES, Person, Task } from './types'
import { upcomingOccasions } from './people'
import { excerpt } from './utils'
import { currentEndpoint } from './push'

// Reminders the phone can fire by itself: one at each task's due time and one
// on the morning of a birthday or anniversary. No server, no account, works
// with the app closed. The set is rebuilt from local data whenever it changes,
// so it is only ever as current as the last time the app ran — which for a
// phone that opens Drafter daily is current enough.

export interface LocalReminder {
  /** Stable integer id — iOS identifies pending notifications by number. */
  id: number
  title: string
  body: string
  at: Date
  /** Where a tap should land, as an in-app query string. */
  url: string
  /** Home-screen badge when the notification fires (iOS). */
  badge?: number
}

/** Stable 31-bit id from a string (djb2), so rescheduling replaces rather than duplicates. */
export function reminderId(key: string): number {
  let h = 5381
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 33) ^ key.charCodeAt(i)) >>> 0
  return h & 0x7fffffff
}

const DAY_MS = 86_400_000
const MORNING = 9

/** A due date stored at local midnight means "that day": remind in the morning, not at 00:00. */
function remindAt(dueAt: string): Date {
  const d = new Date(dueAt)
  if (d.getHours() === 0 && d.getMinutes() === 0) d.setHours(MORNING, 0, 0, 0)
  return d
}

export interface BuildReminderOpts {
  /**
   * When this device is already on the server's APNs/web-push list, skip local
   * "Due now" rows so phone and server don't both fire. Occasion rows stay.
   */
  skipTaskDue?: boolean
}

export function buildLocalReminders(
  tasks: Task[],
  people: Person[],
  now = new Date(),
  horizonDays = 30,
  opts: BuildReminderOpts = {},
): LocalReminder[] {
  const nowMs = now.getTime()
  const until = nowMs + horizonDays * DAY_MS
  const out: LocalReminder[] = []
  if (!opts.skipTaskDue) {
    for (const t of tasks) {
      if (!OPEN_STATUSES.includes(t.status) || !t.dueAt) continue
      const at = remindAt(t.dueAt)
      const ms = at.getTime()
      if (!Number.isFinite(ms) || ms <= nowMs || ms > until) continue
      out.push({
        id: reminderId(`task:${t.id}`),
        title: `Due now: ${t.title || 'Untitled task'}`,
        body: t.description ? excerpt(t.description, 100) : 'Open Drafter for the details.',
        at,
        url: `/?task=${encodeURIComponent(t.id)}`,
        badge: 1,
      })
    }
  }
  for (const o of upcomingOccasions(people, horizonDays, now)) {
    const at = new Date(o.at)
    at.setHours(MORNING, 0, 0, 0)
    if (at.getTime() <= nowMs) continue
    out.push({
      id: reminderId(`occasion:${o.person.id}:${o.kind}:${at.getFullYear()}`),
      title: `${o.person.name}'s ${o.kind} today`,
      body: o.years ? `${o.years} years. Send a message or plan something.` : 'Send a message or plan something.',
      at,
      url: `/?saw=${encodeURIComponent(o.person.id)}`,
      badge: 1,
    })
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime())
}

/** True when this device's push endpoint is already registered server-side. */
export async function deviceHasServerPush(subscriptions: string[]): Promise<boolean> {
  const ep = await currentEndpoint()
  return !!ep && subscriptions.includes(ep)
}
