import { OPEN_STATUSES, Person, Place, Task } from './types'
import { upcomingOccasions } from './people'
import { placeCadenceStatus } from './places'
import { excerpt } from './utils'
import { currentEndpoint } from './push'
import { OCCASION_ACTION_TYPE, TASK_ACTION_TYPE } from './native'

// Reminders the phone can fire by itself: one at each task's due time, one on
// the morning of a birthday or anniversary, and a morning nudge for a place
// whose rhythm you set and clearly missed. No server, no account, works
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
  /**
   * The action buttons the banner offers (Done / Tomorrow, or Saw them). Left
   * off generic reminders: a banner that will not say which task it is must not
   * offer to finish it either. The badge is not set here — scheduleLocalReminders
   * numbers the whole set in time order.
   */
  actionTypeId?: string
}

/** Stable 31-bit id from a string (djb2), so rescheduling replaces rather than duplicates. */
export function reminderId(key: string): number {
  let h = 5381
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 33) ^ key.charCodeAt(i)) >>> 0
  return h & 0x7fffffff
}

const DAY_MS = 86_400_000
const MORNING = 9

/**
 * Places are the only cadence row with no date of its own, so they fire in a
 * morning slot — the same 9am a date-only task or an occasion uses. Which
 * morning is nextPlaceMorning's job.
 */
function nextMorning(now: Date): Date {
  const at = new Date(now)
  at.setHours(MORNING, 0, 0, 0)
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1)
  return at
}

/**
 * One weekday per place, derived from its own id, so a rebuild lands on the
 * same slot instead of re-arming for tomorrow. An overdue place never stops
 * being overdue until you actually go, and buildLocalReminders re-runs on
 * every open, so without this the same banner would fire every single
 * morning. Pinning the slot caps a place at one nudge a week — the digest's
 * PERSON_NUDGE_GAP_DAYS gap, reached without remembering anything.
 */
function nextPlaceMorning(placeId: string, now: Date): Date {
  const at = nextMorning(now)
  at.setDate(at.getDate() + (((reminderId(`place:${placeId}`) % 7) - at.getDay() + 7) % 7))
  return at
}

/**
 * At most this many place rows per rebuild. iOS keeps 64 pending notifications
 * and scheduleLocalReminders already trims to the soonest 60: a dozen lapsed
 * restaurants must never push tomorrow's actual work off the phone.
 */
const MAX_PLACE_REMINDERS = 3

/** A due date stored at local midnight means "that day": remind in the morning, not at 00:00. */
function remindAt(dueAt: string): Date {
  const d = new Date(dueAt)
  if (d.getHours() === 0 && d.getMinutes() === 0) d.setHours(MORNING, 0, 0, 0)
  return d
}

export interface BuildReminderOpts {
  /**
   * When this device is already on the server's APNs/web-push list, skip local
   * "Due now" rows so phone and server don't both fire. Occasion and place
   * rows stay — the server's channel for those is the emailed digest, not a
   * banner, so they cannot double up.
   */
  skipTaskDue?: boolean
  /**
   * Keep titles and names off the lock screen: "Something is due" / "An
   * occasion today" with the detail one tap away inside the app.
   */
  generic?: boolean
}

export function buildLocalReminders(
  tasks: Task[],
  people: Person[],
  places: Place[] = [],
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
        title: opts.generic ? 'Something is due' : `Due now: ${t.title || 'Untitled task'}`,
        body: opts.generic ? 'Open Drafter to see what.' : t.description ? excerpt(t.description, 100) : 'Open Drafter for the details.',
        at,
        url: `/?task=${encodeURIComponent(t.id)}`,
        ...(opts.generic ? {} : { actionTypeId: TASK_ACTION_TYPE }),
      })
    }
  }
  for (const o of upcomingOccasions(people, horizonDays, now)) {
    const at = new Date(o.at)
    at.setHours(MORNING, 0, 0, 0)
    if (at.getTime() <= nowMs) continue
    out.push({
      id: reminderId(`occasion:${o.person.id}:${o.kind}:${at.getFullYear()}`),
      title: opts.generic ? 'An occasion today' : `${o.person.name}'s ${o.kind} today`,
      body: opts.generic ? 'Open Drafter to see whose.' : o.years ? `${o.years} years. Send a message or plan something.` : 'Send a message or plan something.',
      at,
      url: `/?saw=${encodeURIComponent(o.person.id)}`,
      ...(opts.generic ? {} : { actionTypeId: OCCASION_ACTION_TYPE }),
    })
  }
  // A place with a rhythm you set and clearly missed (1.5× the cadence). Only
  // 'overdue', never 'due', and at most one nudge a week per place
  // (nextPlaceMorning) — both halves of the rule the morning digest follows,
  // because a phone that interrupts you about a restaurant you are merely due
  // to revisit — or about the same one every morning — is a phone you turn
  // reminders off on. Places come last: they carry no schedule of their own,
  // so a cap here is what keeps them from crowding out real work in the
  // soonest-60 window.
  const overduePlaces = places
    .filter(p => p && !p.deletedAt)
    .map(p => ({ place: p, status: placeCadenceStatus(p, tasks, now) }))
    .filter(x => x.status.status === 'overdue')
    // longest overdue first, so the cap keeps the places you have drifted
    // furthest from rather than whichever happened to load first
    .sort((a, b) => (b.status.daysSince ?? 0) - (a.status.daysSince ?? 0) || a.place.name.localeCompare(b.place.name))
    .slice(0, MAX_PLACE_REMINDERS)
  for (const { place, status } of overduePlaces) {
    const at = nextPlaceMorning(place.id, now)
    if (at.getTime() > until) continue
    out.push({
      id: reminderId(`place:${place.id}`),
      title: opts.generic ? 'Somewhere to revisit' : `Been a while: ${place.name}`,
      body: opts.generic ? 'Open Drafter to see where.' : status.reason || 'Open Drafter for the details.',
      at,
      url: `/?place=${encodeURIComponent(place.id)}`,
    })
  }
  // stable sort: rows added at the same minute keep the order above, so tasks
  // and occasions still lead the 9am group
  return out.sort((a, b) => a.at.getTime() - b.at.getTime())
}

/** True when this device's push endpoint is already registered server-side. */
export async function deviceHasServerPush(subscriptions: string[]): Promise<boolean> {
  const ep = await currentEndpoint()
  return !!ep && subscriptions.includes(ep)
}
