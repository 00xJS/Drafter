import { CalendarEntry, Meal, OPEN_STATUSES, Person, Place, Task } from './types'
import { upcomingOccasions } from './people'
import { placeCadenceStatus } from './places'
import { dateKey, excerpt, fmtTime } from './utils'
import { hasDueTime } from '../shared/due.mts'
import { isMineTask } from '../shared/domain.mts'
import { bucketByDue } from '../shared/today.mts'
import { OCCASION_ACTION_TYPE, TASK_ACTION_TYPE, type PlanDayPref } from './native'

// Reminders the phone can fire by itself: one at each of your tasks' due
// times, one at the start of each of your own events, one on the morning of a
// birthday or anniversary, and a morning nudge for a place whose rhythm you
// set and clearly missed. No server, no account, works with the app closed.
// The set is rebuilt from local data whenever it changes, so it is only ever
// as current as the last time the app ran — which for a phone that opens
// Drafter daily is current enough. The morning's Plan your day is the one that
// repeats by itself, so it comes whether or not the app ran. Drafter alone
// reminds: the copies the mirrors write into Google and Outlook stay silent
// unless the owner asks for theirs too.
//
// The phone keeps its task reminders with server push on, too. The server's
// "Due now" nudges go to browsers only (netlify/functions/digest.mjs), so the
// two never ring for the same task, and the phone's own rule — 9am for a day
// with no time — is the one an iPhone hears.

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
   * offer to finish it either.
   */
  actionTypeId?: string
  /** Repeats every day at this hour and minute rather than firing once at `at`: the morning's Plan your day. */
  daily?: { hour: number; minute: number }
  /** The Home Screen badge as it rings: badgeCount at `at`. deviceReminders sets it; one that repeats has none. */
  badge?: number
}

/** A due date's day on this phone's calendar, or null for one that is no date. */
const dueDay = (iso: string): string | null => (Number.isFinite(Date.parse(iso)) ? dateKey(iso) : null)

/**
 * What the Home Screen badge says at `at`: my open tasks overdue or due that
 * day. The morning digest's number (buildDigest in shared/digest.mts: the same
 * bucketByDue, over the tasks isMineTask gives me), read on this phone's
 * calendar as Today reads it. The digest sets it each morning, the phone's own
 * reminders as each rings, and the app whenever it is open.
 */
export function badgeCount(tasks: readonly Task[], myId: string | null | undefined, at: Date): number {
  const { overdue, dueToday } = bucketByDue(
    tasks.filter(t => isMineTask(t, myId)),
    { today: dateKey(at), dayKey: dueDay },
  )
  return overdue.length + dueToday.length
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

/**
 * When a task reminds: at its time, or, for a due date with no time (stored at
 * local midnight, shared/due.mts), at 9am on its day — never at 00:00. The
 * phone and a browser with Drafter open both go by this.
 */
export function taskRemindAt(dueAt: string): Date {
  const d = new Date(dueAt)
  if (!hasDueTime(dueAt)) d.setHours(MORNING, 0, 0, 0)
  return d
}

/** The same rule for an event: a timed one at its start, an all-day one on the morning of its first day. */
export function eventRemindAt(e: CalendarEntry): Date | null {
  if (!e.allDay) return new Date(e.start)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(e.start)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), MORNING, 0, 0, 0) : null
}

/**
 * Whether one of Drafter's own events reminds me at all. A work day is where
 * you work, not something to be told has started, and a household member's
 * evening is theirs. The phone's own reminders and a browser's while Drafter is
 * open (notify.ts) both go by this.
 */
export function remindsMe(e: CalendarEntry | null | undefined, myId?: string | null): boolean {
  if (!e || e.deletedAt || e.work) return false
  return !(myId && e.ownerId && e.ownerId !== myId)
}

export interface BuildReminderOpts {
  /**
   * Keep titles and names off the lock screen: "Something is due" / "An
   * occasion today" with the detail one tap away inside the app.
   */
  generic?: boolean
  /**
   * Drafter's own events (store.events). Their copies in Google and Outlook no
   * longer remind, so the phone does. Never a feed's event: its own calendar
   * reminds about that.
   */
  events?: CalendarEntry[]
  /** Only my own events, and only the tasks I am doing, remind me: a household member's evening, and chore, is theirs. */
  myId?: string | null
}

export function buildLocalReminders(
  tasks: Task[],
  people: Person[],
  places: Place[],
  /** A meal eaten out counts as going there, as on Places: last night's takeaway is not a place to nudge about. */
  meals: Meal[],
  now = new Date(),
  horizonDays = 30,
  opts: BuildReminderOpts = {},
): LocalReminder[] {
  const nowMs = now.getTime()
  const until = nowMs + horizonDays * DAY_MS
  const out: LocalReminder[] = []
  for (const t of tasks) {
    // only the person doing it: its assignee, or whoever filed it when nobody
    // is (isMineTask). A chore assigned to the other member rang on both phones.
    if (!OPEN_STATUSES.includes(t.status) || !t.dueAt || !isMineTask(t, opts.myId)) continue
    const at = taskRemindAt(t.dueAt)
    const ms = at.getTime()
    if (!Number.isFinite(ms) || ms <= nowMs || ms > until) continue
    const title = t.title || 'Untitled task'
    out.push({
      id: reminderId(`task:${t.id}`),
      // a day with no time is due all of it, so its 9am says so rather than "now"
      title: opts.generic ? 'Something is due' : hasDueTime(t.dueAt) ? `Due now: ${title}` : `Due today: ${title}`,
      body: opts.generic ? 'Open Drafter to see what.' : t.description ? excerpt(t.description, 100) : 'Open Drafter for the details.',
      at,
      url: `/?task=${encodeURIComponent(t.id)}`,
      ...(opts.generic ? {} : { actionTypeId: TASK_ACTION_TYPE }),
    })
  }
  // My own events (remindsMe), on the rule a task's due date follows. There is
  // nothing a banner's button could do about an event, so it carries none.
  for (const e of opts.events ?? []) {
    if (!remindsMe(e, opts.myId)) continue
    const at = eventRemindAt(e)
    const ms = at?.getTime() ?? NaN
    if (!at || !Number.isFinite(ms) || ms <= nowMs || ms > until) continue
    const title = e.title || 'Untitled event'
    out.push({
      id: reminderId(`event:${e.id}`),
      title: opts.generic ? 'Something on your calendar' : e.allDay ? `Today: ${title}` : `Starts now: ${title}`,
      body: opts.generic ? 'Open Drafter to see what.' : e.location || (e.notes ? excerpt(e.notes, 100) : 'Open Drafter for the details.'),
      at,
      url: '/?view=calendar',
    })
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
  // soonest-60 window. Your own outings (myId), as Today counts them, and
  // never a place on No reminders: its status is 'off', not 'overdue'.
  const overduePlaces = places
    .filter(p => p && !p.deletedAt)
    .map(p => ({ place: p, status: placeCadenceStatus(p, tasks, now, meals, opts.myId) }))
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
  // stable sort: rows added at the same minute keep the order above, so tasks,
  // events and occasions still lead the 9am group
  return out.sort((a, b) => a.at.getTime() - b.at.getTime())
}

/** Where a tap on Plan your day lands: Today, with Plan my day open over it (the morning digest's own link). */
export const PLAN_DAY_URL = '/?plan=day'

/**
 * The morning's Plan your day, when it is on: one notification that repeats
 * every day at the time chosen (`daily`), with no push and no server. `at` is
 * its next time, for ordering only: on the morning the clocks go forward,
 * setHours moves a time in the skipped hour an hour on, so the hour and
 * minute it repeats at are carried as chosen.
 */
export function planDayReminder(pref: PlanDayPref, now = new Date()): LocalReminder | null {
  if (!pref.on) return null
  const [hour, minute] = pref.time.split(':').map(Number)
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  const at = new Date(now)
  at.setHours(hour, minute, 0, 0)
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1)
  return { id: reminderId('plan-day'), title: 'Plan your day', body: 'Pick today’s focus and see what is due.', at, url: PLAN_DAY_URL, daily: { hour, minute } }
}

/**
 * Everything this phone holds, as one set: the local reminders while they
 * are on (Remind me on this iPhone), and the morning's Plan your day while it
 * is. scheduleLocalReminders replaces what is pending with the whole set, so
 * a caller that left a part out would cancel it.
 */
export function deviceReminders(
  data: { tasks: Task[]; people: Person[]; places: Place[]; meals: Meal[] },
  now: Date,
  opts: BuildReminderOpts & { local: boolean; planDay: PlanDayPref },
): LocalReminder[] {
  const plan = planDayReminder(opts.planDay, now)
  // each one that rings once leaves the badge at what is overdue or due by
  // then, as the tasks stand now; the set is rebuilt whenever they change. Plan
  // your day repeats, and a number fixed now would be wrong from its second morning.
  const once = (opts.local ? buildLocalReminders(data.tasks, data.people, data.places, data.meals, now, 30, opts) : []).map(r => ({
    ...r,
    badge: badgeCount(data.tasks, opts.myId, r.at),
  }))
  return distinctIds([...once, ...(plan ? [plan] : [])])
}

/**
 * iOS knows a pending notification by its number alone, so two in one set
 * with the same number would leave one of them unset. Every key is its own
 * (task:, event:, occasion:, place:, plan-day), but a 31-bit hash can still
 * meet another's: the later of the two moves to the next free number. The set
 * is replaced whole each time, so a moved number is never left pending.
 */
export function distinctIds(list: LocalReminder[]): LocalReminder[] {
  const taken = new Set<number>()
  return list.map(r => {
    let id = r.id
    while (taken.has(id)) id = (id + 1) & 0x7fffffff
    taken.add(id)
    return id === r.id ? r : { ...r, id }
  })
}


/** What a reminder that rang is about, for the hub to open. */
export type ReminderTarget = { kind: 'task' | 'event' | 'person' | 'place'; id: string }

/** A reminder that has rung, as the hub on Home lists it. */
export interface FiredReminder {
  /** Stable across rebuilds: what it was about, and when it rang. */
  key: string
  at: Date
  /** "Reminder · Take bins out was due 9:00 AM" */
  title: string
  target: ReminderTarget
}

/** How far back the hub looks for reminders that rang. */
export const FIRED_REMINDER_DAYS = 7

/**
 * The reminders this device has rung in the last `days` days, worked out again
 * by the rules that set them — never stored. The hub on Home lists them, so
 * one swiped away unread can still be read.
 *
 * A phone rings each open task of mine at its time (9am for a day with no
 * time), each of my own events as it starts, each birthday and anniversary at
 * 9am, and a place whose rhythm I set and clearly missed at its weekly slot
 * (buildLocalReminders). A browser rings tasks and events alone, and only while
 * Drafter is open (notify.ts), so `device: 'browser'` lists those two. What is
 * done, deleted or moved since is gone from the list, as it is from the day.
 */
export function firedReminders(
  data: { tasks: Task[]; people: Person[]; places: Place[]; meals: Meal[] },
  now: Date,
  opts: { events?: CalendarEntry[]; myId?: string | null; device: 'phone' | 'browser'; days?: number },
): FiredReminder[] {
  const nowMs = now.getTime()
  const since = nowMs - (opts.days ?? FIRED_REMINDER_DAYS) * DAY_MS
  const rang = (ms: number) => Number.isFinite(ms) && ms <= nowMs && ms > since
  const sameDay = (a: Date) => a.getFullYear() === now.getFullYear() && a.getMonth() === now.getMonth() && a.getDate() === now.getDate()
  const out: FiredReminder[] = []
  for (const t of data.tasks) {
    if (!OPEN_STATUSES.includes(t.status) || !t.dueAt || t.deletedAt || !isMineTask(t, opts.myId)) continue
    const at = taskRemindAt(t.dueAt)
    if (!rang(at.getTime())) continue
    const when = hasDueTime(t.dueAt) ? `was due ${fmtTime(t.dueAt)}` : sameDay(at) ? 'is due today' : 'was due that day'
    out.push({ key: `task:${t.id}@${at.getTime()}`, at, title: `Reminder · ${t.title || 'Untitled task'} ${when}`, target: { kind: 'task', id: t.id } })
  }
  for (const e of opts.events ?? []) {
    if (!remindsMe(e, opts.myId)) continue
    const at = eventRemindAt(e)
    if (!at || !rang(at.getTime())) continue
    const when = e.allDay ? (sameDay(at) ? 'is today' : 'was that day') : `started at ${fmtTime(e.start)}`
    out.push({ key: `event:${e.id}@${at.getTime()}`, at, title: `Reminder · ${e.title || 'Untitled event'} ${when}`, target: { kind: 'event', id: e.id } })
  }
  if (opts.device === 'phone') {
    const from = new Date(since)
    for (const o of upcomingOccasions(data.people, opts.days ?? FIRED_REMINDER_DAYS, from)) {
      const at = new Date(o.at)
      at.setHours(MORNING, 0, 0, 0)
      if (!rang(at.getTime())) continue
      out.push({
        key: `occasion:${o.person.id}:${o.kind}@${at.getTime()}`,
        at,
        title: `Reminder · ${o.person.name}'s ${o.kind}${sameDay(at) ? ' is today' : ''}`,
        target: { kind: 'person', id: o.person.id },
      })
    }
    // the slot a place last had, while it stays clearly overdue: the weekly
    // nudge buildLocalReminders sets, longest overdue first and three at most
    const overdue = data.places
      .filter(p => p && !p.deletedAt)
      .map(p => ({ place: p, status: placeCadenceStatus(p, data.tasks, now, data.meals, opts.myId) }))
      .filter(x => x.status.status === 'overdue')
      .sort((a, b) => (b.status.daysSince ?? 0) - (a.status.daysSince ?? 0) || a.place.name.localeCompare(b.place.name))
      .slice(0, MAX_PLACE_REMINDERS)
    for (const { place } of overdue) {
      const at = nextPlaceMorning(place.id, from)
      if (!rang(at.getTime())) continue
      out.push({ key: `place:${place.id}@${at.getTime()}`, at, title: `Reminder · Been a while: ${place.name}`, target: { kind: 'place', id: place.id } })
    }
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime())
}
