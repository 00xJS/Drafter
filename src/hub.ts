import { useMemo, useSyncExternalStore } from 'react'
import { relativeDayLabel } from './journal'
import { isNative, localRemindersEnabled } from './native'
import { notificationPermission } from './notify'
import { firedReminders, type FiredReminder, type ReminderTarget } from './reminders'
import type { CalendarEntry, Meal, Notice, NoticeType, Person, Place, Task } from './types'
import { useNow } from './useNow'
import { dateKey } from './utils'

// The notification hub on Home: the bell's count and the sheet's rows.
//
// Two things are listed. Notices (v3.32) are records — the other member
// finishing a task you share, this morning's digest — written by the server
// for their reader; a tap marks one read, and that syncs to the reader's
// other devices. Reminders that rang are worked out again from the rules that
// set them (firedReminders in reminders.ts) and never stored, so whether one
// has been seen is this device's alone: everything that rang before the hub
// was last opened here counts as seen.

const SEEN_KEY = 'drafter:hub-seen'
const listeners = new Set<() => void>()

/** When the hub was last opened on this device (epoch ms), or null for never. */
export function readHubSeen(): number | null {
  try {
    const n = Number(localStorage.getItem(SEEN_KEY))
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** The hub was opened, now: what rang before this counts as seen. */
export function markHubSeen(at: number): void {
  try {
    localStorage.setItem(SEEN_KEY, String(at))
  } catch {
    /* read again as unseen next launch */
  }
  for (const l of [...listeners]) l()
}

/** For useSyncExternalStore: the bell hears when the sheet marks the hub seen. */
export function subscribeHubSeen(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** When the hub was last opened on this device, kept current as it is opened. */
export function useHubSeen(): number | null {
  return useSyncExternalStore(subscribeHubSeen, readHubSeen, () => null)
}

/**
 * Which reminders this device rings, if any: the phone's own while "Remind me
 * on this iPhone" is on; a browser's while it may show notifications. None
 * ring otherwise, so none are listed as having rung.
 */
export function ringingDevice(): 'phone' | 'browser' | null {
  // a server render (and these tests' node) has no device to ring
  if (typeof window === 'undefined') return null
  if (isNative()) return localRemindersEnabled() ? 'phone' : null
  return notificationPermission() === 'granted' ? 'browser' : null
}

/** What the reminders are worked out from: the store's lists, and whose they are. */
export interface ReminderSources {
  tasks: Task[]
  people: Person[]
  places: Place[]
  meals: Meal[]
  /** Drafter's own events (store.events). */
  events: CalendarEntry[]
  myId: string | null
}

/**
 * The reminders that have rung on this device in the last week, worked out
 * again each minute (useNow) — and which device this is, with it: a switch
 * turned off in Settings stops the list on the next minute.
 */
export function useFiredReminders({ tasks, people, places, meals, events, myId }: ReminderSources): FiredReminder[] {
  const minute = useNow()
  return useMemo(() => {
    const device = ringingDevice()
    return device ? firedReminders({ tasks, people, places, meals }, new Date(minute), { events, myId, device }) : []
  }, [tasks, people, places, meals, events, myId, minute])
}

/** One line in the hub. */
export interface HubRow {
  key: string
  at: number
  type: NoticeType | 'reminder'
  title: string
  lines: string[]
  unread: boolean
  /** The notice itself, which a tap marks read; none for a reminder. */
  notice?: Notice
  /** What a tap opens: a notice's target, or what a reminder was about. */
  target?: Notice['target'] | ReminderTarget
}

/** A notice not yet opened, here or on the reader's other devices. */
export const unreadNotice = (n: Notice): boolean => !n.readAt && !n.deletedAt

/** Everything in the hub, newest first. */
export function hubRows(notices: readonly Notice[], reminders: readonly FiredReminder[], seenAt: number | null): HubRow[] {
  const rows: HubRow[] = [
    ...notices
      .filter(n => !n.deletedAt)
      .map(n => ({ key: n.id, at: Date.parse(n.at), type: n.type, title: n.title, lines: n.lines ?? [], unread: unreadNotice(n), notice: n, target: n.target })),
    ...reminders.map(r => ({ key: r.key, at: r.at.getTime(), type: 'reminder' as const, title: r.title, lines: [], unread: seenAt === null || r.at.getTime() > seenAt, target: r.target })),
  ]
  return rows.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key))
}

/** The bell's number: notices not yet read, and reminders that rang since the hub was last opened here. */
export function hubUnread(notices: readonly Notice[], reminders: readonly FiredReminder[], seenAt: number | null): number {
  return notices.filter(unreadNotice).length + reminders.filter(r => seenAt === null || r.at.getTime() > seenAt).length
}

/** Rows under the day each happened: Today, Yesterday, then the date. */
export function byDay(rows: readonly HubRow[], today: string): { day: string; label: string; rows: HubRow[] }[] {
  const out: { day: string; label: string; rows: HubRow[] }[] = []
  for (const row of rows) {
    const day = dateKey(new Date(row.at))
    const last = out[out.length - 1]
    if (last?.day === day) last.rows.push(row)
    else out.push({ day, label: relativeDayLabel(day, today), rows: [row] })
  }
  return out
}

/** How long ago, as a row says it: "Just now", "12 min ago", "3 h ago", then the time of day under its day's heading. */
export function howLongAgo(at: number, now: number): string {
  const min = Math.floor((now - at) / 60_000)
  if (min < 1) return 'Just now'
  if (min < 60) return `${min} min ago`
  if (min < 6 * 60) return `${Math.floor(min / 60)} h ago`
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** The bell's accessible name: "Notifications, 3 unread". */
export const bellLabel = (unread: number): string => (unread > 0 ? `Notifications, ${unread} unread` : 'Notifications')
