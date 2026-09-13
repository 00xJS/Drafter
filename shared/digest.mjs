// Pure digest helpers shared by the scheduled Netlify function and tests.
// Keep declarations in shared/digest.d.mts (not under netlify/functions/).

import { legacyPostToTask } from './domain.mjs'
import { seenStatus, seenTasks, upcomingOccasions, plannedVisit } from './people.mjs'
import { OPEN, bucketByDue, focusTasks } from './today.mjs'
import { tonightLine } from './kitchen.mjs'
import { placeCadenceStatus } from './places.mjs'
import { PERSONAL_KINDS } from './kinds.mjs'

const DAY = 86_400_000
/** Don't re-nag the same person (or place) more often than this. */
const PERSON_NUDGE_GAP_DAYS = 7
const NEVER_MIN_AGE_DAYS = 30
/** How many names a Catch up / Been a while line spells out before "+n more". */
const DIGEST_NAMES = 3

/** Local hour + calendar day for an instant. Never throws: an invalid date yields nulls. */
export function localParts(date, tz) {
  const ms = date instanceof Date ? date.getTime() : Date.parse(date)
  if (!Number.isFinite(ms)) return { hour: null, day: null, weekday: null }
  try {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
        .formatToParts(new Date(ms))
        .map(x => [x.type, x.value]),
    )
    return { hour: Number(p.hour), day: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday ?? null }
  } catch {
    const d = new Date(ms)
    return { hour: d.getUTCHours(), day: d.toISOString().slice(0, 10), weekday: null }
  }
}

const dayKeyIn = (iso, tz) => localParts(iso, tz).day

/** Mirror of household_user_ids() + legacy null-owner rows for the site owner. */
export function visibleItemsFor(rows, userId, peerIds, ownerId) {
  const visible = new Set([userId, ...(peerIds ?? [])])
  // Mirrors the posts policy: a peer's rows are visible except PERSONAL_KINDS
  // (journal, review, calendar, habit, routine), which only their owner sees. ownerId
  // rides along (as sync_posts does on read) so callers can tell whose row it is.
  return (rows ?? [])
    .filter(r => {
      if (r.user_id === userId) return true
      if (r.user_id === null) return userId === ownerId
      return visible.has(r.user_id) && !PERSONAL_KINDS.has(r.data?.kind ?? 'task')
    })
    .map(r => ({ ...legacyPostToTask(r.data), ownerId: r.user_id ?? undefined }))
}

/**
 * Morning digest lines. `nudged` is { personId | placeId: dayKey } — a name
 * repeats at most every PERSON_NUDGE_GAP_DAYS. Returns { …, nudgedNext } to persist.
 * `userId` is the reader: their focus for today opens the digest, and a
 * household member's picks are left out. `extra.weekPlan` is Sunday's week-plan
 * summary, worked out by the caller, which closes it.
 * @param {any[]} items
 */
export function buildDigest(items, tz, now, nudged = {}, userId = null, extra = {}) {
  const tasks = items.filter(i => i.kind === 'task' && !i.deletedAt)
  const people = items.filter(i => i.kind === 'person' && !i.deletedAt)
  const places = items.filter(i => i.kind === 'place' && !i.deletedAt)
  const today = localParts(now, tz).day
  const { overdue, dueToday } = bucketByDue(tasks, { today, dayKey: iso => dayKeyIn(iso, tz) })
  const nowMs = now.getTime()
  const nudgedNext = { ...(nudged && typeof nudged === 'object' ? nudged : {}) }

  // your own past events count as seeing whoever was on them, as on the People page
  const seen = seenTasks(tasks, items.filter(i => i.kind === 'event'), now)
  const peopleDue = []
  const peopleIds = []
  for (const p of people) {
    // an open planned visit means the nudge already did its job
    if (plannedVisit(p.id, tasks)) continue
    const { status, daysSince } = seenStatus(p, seen, now)
    if (status !== 'overdue' && status !== 'never') continue
    if (status === 'never') {
      const created = Date.parse(p.createdAt ?? '')
      if (!Number.isFinite(created) || nowMs - created < NEVER_MIN_AGE_DAYS * DAY) continue
    }
    const lastNudge = nudgedNext[p.id]
    if (lastNudge && today) {
      const gap = (Date.parse(today) - Date.parse(lastNudge)) / DAY
      if (Number.isFinite(gap) && gap < PERSON_NUDGE_GAP_DAYS) continue
    }
    const label =
      status === 'never'
        ? `${p.name} (no visit logged)`
        : `${p.name} (${daysSince ?? '?'}d)`
    peopleDue.push(label)
    peopleIds.push(p.id)
  }

  // Places only nag when the user set a rhythm, and only once clearly overdue
  // (1.5× the cadence) — merely "due" stays on Today, never in the inbox.
  const placesDue = []
  const placeIds = []
  for (const p of places) {
    const { status, daysSince } = placeCadenceStatus(p, tasks, now)
    if (status !== 'overdue') continue
    const lastNudge = nudgedNext[p.id]
    if (lastNudge && today) {
      const gap = (Date.parse(today) - Date.parse(lastNudge)) / DAY
      if (Number.isFinite(gap) && gap < PERSON_NUDGE_GAP_DAYS) continue
    }
    placesDue.push(`${p.name} (${daysSince ?? '?'}d)`)
    placeIds.push(p.id)
  }

  // Only the names a line actually reads out count as nudged. Stamping the
  // "+n more" too hid them for a week, after which the first three won again —
  // so a fourth name was never read out while those three stayed overdue.
  if (today) {
    for (const id of [...peopleIds.slice(0, DIGEST_NAMES), ...placeIds.slice(0, DIGEST_NAMES)]) nudgedNext[id] = today
  }

  const occasions = upcomingOccasions(people, 21, now, today).map(
    o => `${o.person.name}'s ${o.kind}${o.daysUntil === 0 ? ' today' : ` in ${o.daysUntil}d`}`,
  )
  // the week's meals are household-shared, so tonight's dinner is everyone's line
  const tonight = today ? tonightLine(items.filter(i => i.kind === 'meal'), items.filter(i => i.kind === 'recipe' && !i.deletedAt), today) : null
  // Today's focus, set at last night's Shut down or this morning — only what is
  // still open: a finished one needs no reminder.
  const focus = today ? focusTasks(tasks, today, userId).filter(t => OPEN.includes(t.status)) : []
  const weekPlan = typeof extra?.weekPlan === 'string' && extra.weekPlan.trim() ? extra.weekPlan.trim() : null

  const lines = []
  if (focus.length) lines.push(`Focus: ${focus.slice(0, DIGEST_NAMES).map(t => t.title || 'Untitled task').join(' · ')}${focus.length > DIGEST_NAMES ? ` · +${focus.length - DIGEST_NAMES} more` : ''}`)
  if (overdue.length) lines.push(`${overdue.length} overdue: ${overdue.slice(0, 3).map(t => t.title).join(', ')}${overdue.length > 3 ? '…' : ''}`)
  if (dueToday.length) lines.push(`${dueToday.length} due today: ${dueToday.slice(0, 3).map(t => t.title).join(', ')}${dueToday.length > 3 ? '…' : ''}`)
  if (occasions.length) lines.push(`Occasions: ${occasions.join(', ')}`)
  const named = list => `${list.slice(0, DIGEST_NAMES).join(', ')}${list.length > DIGEST_NAMES ? `, +${list.length - DIGEST_NAMES} more` : ''}`
  if (peopleDue.length) lines.push(`Catch up with: ${named(peopleDue)}`)
  if (placesDue.length) lines.push(`Been a while: ${named(placesDue)}`)
  if (tonight) lines.push(tonight)
  if (weekPlan) lines.push(`Plan next week: ${weekPlan}`)
  return { overdue, dueToday, occasions, peopleDue, placesDue, tonight, focus, weekPlan, lines, nudgedNext }
}
