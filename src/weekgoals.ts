import type { Review } from './types'
import { newerStamp } from './itemops'
import { shiftRange, weekRange } from './review'

// This week's 3: the goals Home shows, sets and ticks.
//
// They are the Review's Top 3, kept where the Review keeps them: record N's
// `top` holds the goals for week N + 1, written in week N's review "for next
// week" — on the Review page, in Plan next week, or now on Home. `topDone` is
// indexed like `top`. Reviews are personal, one record per member a week, so
// every list handed in here is the member's own (store.reviews).
//
// A record with only `top` and `topDone` is a week's goals, not a review:
// what says a week was reviewed is its summary, its reflections and Sunday's
// `draftedAt`, and nothing here writes those. So setting goals on Home never
// reads as a written review, and Sunday's draft still writes the week
// (netlify/functions/lib/sundaydraft.mjs wantsDraft, which week-goals tests hold).

/** How many goals a week has: "This week's 3". */
export const WEEK_GOALS = 3

/** A goal as Home draws it. */
export interface WeekGoal {
  text: string
  /** Its place in the record's `top`, which `topDone` is indexed by. */
  index: number
  done: boolean
}

type Lines = Pick<Review, 'top' | 'topDone'> | null | undefined

/** A review's Top 3 lines that say something, trimmed, each with its place in `top` and its tick. */
function linesOf(review: Lines): WeekGoal[] {
  const out: WeekGoal[] = []
  ;(review?.top ?? []).forEach((line, index) => {
    const text = String(line ?? '').trim()
    if (text) out.push({ text, index, done: !!review?.topDone?.[index] })
  })
  return out
}

/** The week's goals in a record: its first three lines that say something. */
export const goalsOf = (review: Lines): WeekGoal[] => linesOf(review).slice(0, WEEK_GOALS)

const norm = (line: string) => line.trim().toLowerCase()

/** A week's live records by its key. */
const weekRecords = (reviews: readonly Review[], key: string): Review[] => reviews.filter(r => !!r && r.period === 'week' && r.key === key && !r.deletedAt)

/**
 * Of a week's records, the one to read. There is one per member, but a save
 * made offline can meet one the server made meanwhile: the one holding goals
 * is read before one without.
 */
const pick = (rows: readonly Review[]): Review | undefined => rows.find(r => goalsOf(r).length > 0) ?? rows[0]

/**
 * The record whose Top 3 are this week's: last week's, written "for next
 * week", and this week's own when last week has none at all. Home's card and
 * Plan my day's "this week's 3" both read it here. `noon` is a moment on
 * today (the page's clock, never a fresh reading).
 */
export function weekGoalsRecord(reviews: readonly Review[], noon: Date): Review | undefined {
  const thisWeek = weekRange(noon)
  return pick(weekRecords(reviews, shiftRange(thisWeek, -1).key)) ?? pick(weekRecords(reviews, thisWeek.key))
}

/** The week a goal set on Home is written to: last week, whose "Top 3 for next week" this week's are. */
export const goalsWeekKey = (noon: Date): string => shiftRange(weekRange(noon), -1).key

/**
 * When "→ task" makes one of this week's 3 due: the week's last day (the
 * weeks run Sunday to Saturday), as a date with no time — local midnight, as
 * the task editor writes a day alone — so it is due by the end of the week the
 * goal is for, and not overdue before that day is out.
 */
export function goalTaskDue(noon: Date): string {
  const last = new Date(weekRange(noon).end)
  last.setDate(last.getDate() - 1)
  return last.toISOString()
}

/** What an edit of the goals keeps: the words, trimmed, the empty lines dropped, three at most. */
export const cleanGoals = (lines: readonly string[]): string[] =>
  lines
    .map(l => String(l ?? '').trim())
    .filter(Boolean)
    .slice(0, WEEK_GOALS)

/**
 * The record to save when the week's 3 are set on Home: last week's own
 * record with its Top 3 replaced — stamped newer than the copy it was made
 * on — or, with none, a new one as the Review page makes one (a random id,
 * never one of Sunday's draft ids, which the draft keeps to itself). A goal
 * kept keeps its tick; a new or reworded one starts unticked. Nothing but
 * `top` and `topDone` is written.
 */
export function withWeekGoals(reviews: readonly Review[], lines: readonly string[], o: { noon: Date; now: Date; newId(): string }): Review {
  const key = goalsWeekKey(o.noon)
  const top = cleanGoals(lines)
  // the ticks of the goals as they were shown, the fallback's included
  const shown = goalsOf(weekGoalsRecord(reviews, o.noon))
  const topDone = top.map(line => shown.some(g => g.done && norm(g.text) === norm(line)))
  const prev = pick(weekRecords(reviews, key))
  if (prev) return { ...prev, top, topDone, updatedAt: newerStamp(prev.updatedAt) }
  const stamp = o.now.toISOString()
  return { kind: 'review', id: o.newId(), period: 'week', key, top, topDone, createdAt: stamp, updatedAt: stamp }
}

/** A goal ticked or unticked: its place in `topDone` flipped, the rest as they were. */
export function withGoalToggled(record: Review, index: number): Review {
  const next = [...(record.topDone ?? [])]
  while (next.length < Math.max(record.top?.length ?? 0, WEEK_GOALS)) next.push(false)
  next[index] = !next[index]
  return { ...record, topDone: next, updatedAt: newerStamp(record.updatedAt) }
}

/** Whether ticking goal `index` finishes the week's goals: every one done after it, and it not before. */
export function finishesGoals(goals: readonly WeekGoal[], index: number): boolean {
  const goal = goals.find(g => g.index === index)
  return !!goal && !goal.done && goals.every(g => g === goal || g.done)
}

/** "All 3 done", "Both done", "Done": what the card says once every goal is ticked. */
export function allDoneLine(count: number): string {
  if (count >= WEEK_GOALS) return `All ${WEEK_GOALS} done`
  return count === 2 ? 'Both done' : 'Done'
}

/**
 * The goals a period ended with unticked, for its review's "Top 3 for next
 * …": `prev` is the record holding them (the one before the period
 * reviewed), and a line already among `top` is not offered again.
 */
export function unfinishedGoals(prev: Lines, top: readonly string[]): string[] {
  const taken = new Set(top.map(norm).filter(Boolean))
  const out: string[] = []
  for (const g of linesOf(prev)) {
    if (g.done || taken.has(norm(g.text))) continue
    taken.add(norm(g.text))
    out.push(g.text)
  }
  return out
}

/** `top` with `line` in its first empty place, or as it was when every place is taken. */
export function intoFirstEmpty(top: readonly string[], line: string): string[] {
  const at = top.findIndex(t => !String(t ?? '').trim())
  return at < 0 ? [...top] : top.map((t, i) => (i === at ? line : t))
}
