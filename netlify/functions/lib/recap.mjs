// The monthly recap: on the 1st, from the member's digest hour in their own
// zone, last month's highlights — a push and a notice in the hub, once.
//
// It rides on the hourly digest (digest.mjs), which already has the switch
// (push on, or the email digest) and already reads the rows it needs; there
// is no setting of its own. What it says is shared/insights.mts's, the module
// Insights draws its Highlights with, so the recap and the app can never tell
// one member two different Septembers.
//
// Whose records: the scope the app's Highlights count by (scopeRecords).
// Tasks, money and meals are the household's as this member can read them;
// who they saw and where they went is their own log; the journal, habits and
// clothes are theirs alone. The service key bypasses every policy, so each
// row counted has passed readableRow for that member (visibleItemsFor), and
// the personal kinds read here are read for that member alone.
//
// Once a month: the notice's id is the month's, `notice~<user>~recap~YYYY-MM`,
// and it is written BEFORE anything is sent, as the digest writes its
// watermarks first. A run that finds it written sends nothing; a run that dies
// after writing it loses the push rather than repeating it an hour later.

import { localParts, visibleItemsFor } from '../../../shared/digest.mts'
import { insightFigures, lastMonthKey, periodSpan, pickHighlights, recapLines, recapTitle } from '../../../shared/insights.mts'
import { noticeId } from '../../../shared/notices.mts'
import { dayKeysIn } from '../../../shared/people.mts'
import { validTimeZone } from './timezone.mjs'

/** The personal kinds the recap reads beyond the digest's own rows: the member's journal, habits and clothes. */
export const RECAP_KINDS = Object.freeze(['journal', 'habit', 'garment', 'wear'])

/** How many of the highlights the push and the notice carry, most interesting first. */
export const RECAP_LINES = 4

/**
 * The month an account's recap is for, when this hour should send it: on the
 * 1st of its month, at or after its digest hour (8 unless it chose one), the
 * month before. At or after, as the digest itself goes, so a run that was
 * skipped or late still sends it; the notice's id keeps it to once. Null on
 * any other day or hour, or for a zone that cannot be read.
 * @param {{ timezone?: string | null, digest_hour?: number | null }} u
 * @param {Date} now
 */
export function recapDue(u, now) {
  const { hour, day } = localParts(now, validTimeZone(u?.timezone) ?? 'UTC')
  if (hour === null || day === null || day.slice(8) !== '01') return null
  const want = Number.isInteger(u?.digest_hour) ? /** @type {number} */ (u.digest_hour) : 8
  return hour >= want ? lastMonthKey(day) : null
}

/** The recap's notice id for a member and a month: the once-a-month watermark. */
export const recapNoticeId = (userId, month) => noticeId(userId, 'recap', month)

/** Where the push and the hub's row open: Insights' Highlights on that month (useDeepLinks reads it). */
export const recapPath = month => `/?insights=month&period=${month}`

/**
 * The live records of one kind among a member's items, as the app's lists
 * hold them: out of Trash, and of that kind.
 * @template {import('../../../src/types.ts').Item['kind']} K
 * @param {readonly Record<string, unknown>[]} items
 * @param {K} kind
 * @returns {Extract<import('../../../src/types.ts').Item, { kind: K }>[]}
 */
function liveOf(items, kind) {
  return /** @type {Extract<import('../../../src/types.ts').Item, { kind: K }>[]} */ (/** @type {unknown} */ (items.filter(i => i && i.kind === kind && !i.deletedAt)))
}

/**
 * A member's recap for `month` from rows as the database holds them: their
 * readable share of the digest's rows and their own personal rows. Every row
 * is scoped by visibleItemsFor (readableRow, for this member), and personal
 * kinds that are not theirs are dropped there too. The figures are counted as
 * the app's are: the household's tasks, money and meals among what is left,
 * the member's own visits, outings, journal, habits and clothes.
 * @param {{ user_id: string | null, data: unknown }[]} rows
 * @param {string} userId
 * @param {Iterable<string> | null | undefined} peerIds
 * @param {string | null} ownerId
 * @param {string | null | undefined} timezone
 * @param {Date} now
 * @param {string} month YYYY-MM
 */
export function buildRecap(rows, userId, peerIds, ownerId, timezone, now, month) {
  const tz = validTimeZone(timezone) ?? 'UTC'
  const items = visibleItemsFor(rows, userId, peerIds, ownerId)
  const dayOf = dayKeysIn(tz)
  /** @param {string} iso */
  const dayKeyOf = iso => {
    const ms = Date.parse(iso)
    return Number.isFinite(ms) ? dayOf(ms) : null
  }
  const today = localParts(now, tz).day ?? `${month}-01`
  const input = {
    tasks: liveOf(items, 'task'),
    events: liveOf(items, 'event'),
    people: liveOf(items, 'person'),
    places: liveOf(items, 'place'),
    meals: liveOf(items, 'meal'),
    recipes: liveOf(items, 'recipe'),
    journal: liveOf(items, 'journal'),
    habits: liveOf(items, 'habit'),
    garments: liveOf(items, 'garment'),
    wears: liveOf(items, 'wear'),
    myId: userId,
    now,
    today,
    dayKeyOf,
  }
  const cards = pickHighlights(insightFigures(input, periodSpan('month', `${month}-01`, today)))
  return { month, title: recapTitle(month), lines: recapLines(cards, RECAP_LINES), cards }
}

/**
 * The notice the recap keeps in the member's hub: the digest's kind, which a
 * build from before the recap still shows, opening Insights on its month.
 * @param {string} userId
 * @param {{ month: string, title: string, lines: string[] }} recap
 * @param {Date} now
 */
export function recapNotice(userId, recap, now) {
  const stamp = now.toISOString()
  return {
    kind: /** @type {const} */ ('notice'),
    id: recapNoticeId(userId, recap.month),
    at: stamp,
    type: /** @type {const} */ ('digest'),
    title: recap.title,
    lines: recap.lines,
    target: { kind: /** @type {const} */ ('insights'), id: recap.month },
    createdAt: stamp,
    updatedAt: stamp,
  }
}

/** putNotice's merge for the recap: a recap already written is left exactly as it is, so nothing is sent twice. */
export const keepWritten = (existing, incoming) => existing ?? incoming
