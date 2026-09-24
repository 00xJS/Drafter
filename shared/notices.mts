// Notices, the notification hub's records (v3.32): the rules the server that
// writes them (netlify/functions/notify.mjs, digest.mjs) and the app that
// reports edits and reads them (src/activity.ts, the hub on Home) share.
//
// A notice is its RECIPIENT's row. What one member does to one task within a
// quarter of an hour is one notice — a line per change — so ticking five
// steps is one entry in the hub and one banner on the lock screen that keeps
// being replaced, not five. What one member says in the household's chat
// within a quarter of an hour is one notice the same way, a line per message.
// Dependency-free ESM, like the rest of shared/.

import type { Notice, NoticeType, Task } from '../src/types.ts'
import { hasDueTime } from './due.mts'

/** What one member does to one task within this long is one notice. */
export const NOTICE_BUCKET_MS = 15 * 60_000
/** The most lines one notice keeps: the newest. */
export const NOTICE_LINES_MAX = 8
/** The longest a line is, as a lock screen shows one. */
export const NOTICE_LINE_MAX = 160
/** How long a notice stays; the nightly job lets older ones go (lib/notices.mjs). */
export const NOTICE_KEEP_DAYS = 30
/** The most message ids a message notice keeps, the newest: far more than a quarter of an hour's chat, so its count holds. */
export const NOTICE_MESSAGES_MAX = 50

/** What an edit on a device can report about a task (src/activity.ts), as /api/notify takes it. */
export type ActivityType = 'status' | 'checklist' | 'comment' | 'due' | 'title' | 'assigned'
export const ACTIVITY_TYPES: readonly ActivityType[] = ['status', 'checklist', 'comment', 'due', 'title', 'assigned']

/**
 * One change to a task. `detail` is what changed to: the new status, the
 * step's text, the comment, the new due instant ('' when it was taken off),
 * the new title, the member it was handed to. `done` says which way a
 * checklist step went.
 */
export interface ActivityEvent {
  type: ActivityType
  detail?: string
  done?: boolean
}

/** The quarter of an hour an instant falls in: the last part of a task's or a message's notice id. */
export const noticeBucket = (ms: number): number => Math.floor(ms / NOTICE_BUCKET_MS)

/** A notice's id: whose, about what (a task's id, `messages-<sender>`, `digest`, `alarm`), and which bucket or day. */
export const noticeId = (recipientId: string, about: string, bucket: number | string): string => `notice~${recipientId}~${about}~${bucket}`

/** The part of a task that decides who hears about it. */
export type TaskParties = Pick<Task, 'ownerId' | 'assigneeId' | 'assignedBy'>

const isDone = (e: ActivityEvent) => e.type === 'status' && e.detail === 'done'

/**
 * Who hears about `events`, which `actorId` just made on a task, and which of
 * the events each of them hears.
 *
 * The assigner — whoever handed it over (`assignedBy`), or its owner for a
 * task assigned before that was kept — hears everything the assignee does to
 * it: progress, a comment, finishing it. The assignee hears what the assigner
 * does that changes their job: handing it to them, a comment, a new due date
 * or title, and a status they did not set themselves. On a shared task nobody
 * is assigned, its owner hears when someone else finishes it or comments; so
 * does whoever is doing an assigned task when a third hand does either.
 * Never the actor, whatever the roles say.
 *
 * Whether a recipient may read the task and is in the actor's household is
 * the server's to check (netlify/functions/notify.mjs): this is only the
 * question of who, by role.
 */
export function noticeRecipients(task: TaskParties, actorId: string, events: readonly ActivityEvent[]): Map<string, ActivityEvent[]> {
  const out = new Map<string, ActivityEvent[]>()
  const add = (who: string | undefined, list: ActivityEvent[]) => {
    if (!who || who === actorId || list.length === 0) return
    out.set(who, [...(out.get(who) ?? []), ...list])
  }
  const assignee = task.assigneeId
  const assigner = task.assignedBy ?? task.ownerId
  const finishedOrSaid = events.filter(e => isDone(e) || e.type === 'comment')
  if (assignee && actorId === assignee) add(assigner, [...events])
  else if (assignee && (actorId === assigner || actorId === task.ownerId)) {
    add(
      assignee,
      events.filter(e => e.type === 'assigned' || e.type === 'comment' || e.type === 'due' || e.type === 'title' || e.type === 'status'),
    )
  } else if (assignee) add(assignee, finishedOrSaid)
  else add(task.ownerId, finishedOrSaid)
  return out
}

/**
 * Which kind of notice wins when several kinds of change land in one: the
 * weightiest. A message notice only ever meets another (its id is the
 * sender's, never a task's), so its weight decides nothing.
 */
const WEIGHT: Record<NoticeType, number> = { done: 6, assigned: 5, comment: 4, message: 4, progress: 3, changed: 2, digest: 1, alarm: 1 }

/** The kind of notice one change makes. */
export function eventNoticeType(e: ActivityEvent): NoticeType {
  if (isDone(e)) return 'done'
  if (e.type === 'assigned') return 'assigned'
  if (e.type === 'comment') return 'comment'
  if (e.type === 'checklist' || (e.type === 'status' && (e.detail === 'doing' || e.detail === 'blocked'))) return 'progress'
  return 'changed'
}

/** The kind of notice for a set of changes, and the weightier of two kinds. */
export const noticeTypeOf = (events: readonly ActivityEvent[]): NoticeType =>
  events.map(eventNoticeType).reduce<NoticeType>((a, b) => weightier(a, b), 'changed')
export const weightier = (a: NoticeType, b: NoticeType): NoticeType => (WEIGHT[b] > WEIGHT[a] ? b : a)

/** A task's title as a headline quotes it, never empty and never a paragraph. */
export function quoteTitle(title: string | undefined): string {
  const t = (title ?? '').replace(/\s+/g, ' ').trim()
  return `“${t ? clip(t, 60) : 'Untitled task'}”`
}

/** A notice's headline, as the lock screen shows it: "Maria finished “Take bins out”". */
export function noticeTitle(type: NoticeType, actorName: string, taskTitle: string | undefined): string {
  const who = actorName.trim() || 'Someone'
  const what = quoteTitle(taskTitle)
  switch (type) {
    case 'done':
      return `${who} finished ${what}`
    case 'assigned':
      return `${who} asked you to do ${what}`
    case 'comment':
      return `${who} commented on ${what}`
    case 'progress':
      return `${who} made progress on ${what}`
    default:
      return `${who} changed ${what}`
  }
}

const STATUS_LINES: Record<string, string> = {
  done: 'Marked it done',
  doing: 'Started it',
  blocked: 'Marked it blocked',
  todo: 'Moved it back to To do',
  wishlist: 'Moved it to the wishlist',
  canceled: 'Canceled it',
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s
}

/** One line of text: whitespace run together, control characters gone, clipped. */
export function oneLine(s: string | undefined, n = NOTICE_LINE_MAX): string {
  // eslint-disable-next-line no-control-regex
  return clip((s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim(), n)
}

/**
 * A due date as the reader's zone says it: "Fri, Sep 26, 5:00 PM", or the day
 * alone for a date with no time (shared/due.mts). The owner reads US English.
 */
export function dueWords(iso: string, tz?: string | null): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const zone = (() => {
    try {
      return tz ? new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone : undefined
    } catch {
      return undefined
    }
  })()
  const timed = hasDueTime(iso, zone ?? null)
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(timed ? { hour: 'numeric', minute: '2-digit' } : {}),
  }).format(new Date(ms))
}

/** What one change says, a line in the notice; null for one with nothing to add to the headline. */
export function activityLine(e: ActivityEvent, tz?: string | null): string | null {
  switch (e.type) {
    case 'status':
      return STATUS_LINES[e.detail ?? ''] ?? null
    case 'checklist': {
      const step = oneLine(e.detail, 80)
      return step ? `${e.done === false ? 'Unticked' : 'Ticked'} “${step}”` : null
    }
    case 'comment': {
      const said = oneLine(e.detail)
      return said ? `“${said}”` : null
    }
    case 'due': {
      const when = e.detail ? dueWords(e.detail, tz) : ''
      return when ? `Due ${when}` : 'Took the due date off'
    }
    case 'title': {
      const name = oneLine(e.detail, 60)
      return name ? `Renamed it “${name}”` : null
    }
    default:
      return null
  }
}

/**
 * A notice with another's news folded in: the lines appended (the newest
 * NOTICE_LINES_MAX kept), the weightier kind and its headline, the later
 * time, and unread again — a new line is news, whatever was read before.
 * The same batch of lines arriving twice (two tabs telling one edit) is
 * appended once.
 */
export function mergeNotice(existing: Notice | null | undefined, incoming: Notice): Notice {
  if (!existing || existing.deletedAt) return { ...incoming, lines: (incoming.lines ?? []).slice(-NOTICE_LINES_MAX), readAt: undefined }
  const type = weightier(existing.type, incoming.type)
  const had = existing.lines ?? []
  const news = incoming.lines ?? []
  const again = news.length > 0 && had.length >= news.length && news.every((l, i) => had[had.length - news.length + i] === l)
  const lines = [...had, ...(again ? [] : news)].slice(-NOTICE_LINES_MAX)
  const later = Date.parse(incoming.at) >= Date.parse(existing.at) ? incoming.at : existing.at
  return {
    ...existing,
    ...incoming,
    type,
    title: type === incoming.type ? incoming.title : existing.title,
    lines: lines.length ? lines : undefined,
    at: later,
    createdAt: existing.createdAt,
    readAt: undefined,
  }
}

// ---- household messages -------------------------------------------------------

/**
 * How far back a message's own stamp is believed: a device lets go of a
 * message it could not tell after a day (src/activity.ts MAX_AGE_MS).
 */
const MESSAGE_TIME_WINDOW_MS = 24 * 3_600_000

/** What a message notice is about, in its id and its push's tag: whose messages they are. */
export const messagesAbout = (senderId: string): string => `messages-${senderId}`

/** A message notice's headline, as the hub lists it: "Maria sent a message", "Maria sent 3 messages". */
export function messageNoticeTitle(senderName: string, count: number): string {
  const who = senderName.trim() || 'Someone'
  return count > 1 ? `${who} sent ${count} messages` : `${who} sent a message`
}

/**
 * When a message was said, as the server takes it: the message's own stamp,
 * but never later than now — a phone whose clock runs fast — nor more than a
 * day back. Its notice is dated by it and filed in its quarter of an hour, so
 * the same message told twice, however far apart, lands in the same notice;
 * and a thread that has shown the message has shown what its notice says
 * (src/hub.ts messageNoticesShown).
 */
export function messageTime(createdAt: string | undefined, now: number): number {
  const ms = Date.parse(createdAt ?? '')
  return Number.isFinite(ms) ? Math.min(now, Math.max(now - MESSAGE_TIME_WINDOW_MS, ms)) : now
}

/** One household message as its notice is built from it: the stored row's words and stamp, and the sender as their own session names them. */
export interface ToldMessage {
  id: string
  body: string
  createdAt?: string
  senderId: string
  senderName: string
}

/**
 * The notice that tells `recipientId` about one household message: a line of
 * its words under a headline with the sender's name, in the notice for that
 * sender and quarter of an hour.
 */
export function messageNotice(recipientId: string, m: ToldMessage, now: Date): Notice {
  const at = new Date(messageTime(m.createdAt, now.getTime()))
  const line = oneLine(m.body)
  const stamp = now.toISOString()
  return {
    kind: 'notice',
    id: noticeId(recipientId, messagesAbout(m.senderId), noticeBucket(at.getTime())),
    at: at.toISOString(),
    type: 'message',
    actorId: m.senderId,
    target: { kind: 'message', id: m.id },
    title: messageNoticeTitle(m.senderName, 1),
    lines: line ? [line] : undefined,
    messageIds: [m.id],
    createdAt: stamp,
    updatedAt: stamp,
  }
}

/**
 * A message notice with more messages folded in: a line each appended (the
 * newest NOTICE_LINES_MAX kept), counted in the headline, the later time, and
 * unread again. A message it tells of already — the same one told twice, by a
 * retry or by two tabs — adds nothing, and when nothing is new `existing`
 * itself comes back: lib/notices.mjs writes nothing then, and nothing is pushed.
 */
export function mergeMessageNotice(existing: Notice | null | undefined, incoming: Notice, senderName: string): Notice {
  if (!existing || existing.deletedAt) return mergeNotice(existing, incoming)
  const had = new Set(existing.messageIds ?? [])
  const fresh = (incoming.messageIds ?? []).map((id, i) => ({ id, line: incoming.lines?.[i] })).filter(m => !had.has(m.id))
  if (fresh.length === 0) return existing
  const messageIds = [...(existing.messageIds ?? []), ...fresh.map(m => m.id)].slice(-NOTICE_MESSAGES_MAX)
  const lines = [...(existing.lines ?? []), ...fresh.flatMap(m => (m.line ? [m.line] : []))].slice(-NOTICE_LINES_MAX)
  const later = Date.parse(incoming.at) >= Date.parse(existing.at)
  return {
    ...existing,
    ...incoming,
    title: messageNoticeTitle(senderName, messageIds.length),
    lines: lines.length ? lines : undefined,
    messageIds,
    at: later ? incoming.at : existing.at,
    target: later ? incoming.target : existing.target,
    createdAt: existing.createdAt,
    readAt: undefined,
  }
}
