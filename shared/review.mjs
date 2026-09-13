// What a review period holds: what got done, what slipped and who you saw.
// Home → Week (src/review.ts buildReview) and Sunday's automatic draft
// (netlify/functions/digest.mjs) both read these lists, so the draft never
// names a task or a person the Week segment does not. Dependency-free ESM.

import { visitDays, visitsFor } from './people.mjs'
import { OPEN } from './today.mjs'

const ms = d => (d instanceof Date ? d.getTime() : Number(d))

/** A logged get-together, not a piece of work: counted separately everywhere. */
export const isVisit = t => (t?.tags ?? []).includes('visit')

/** Whether an instant falls inside [start, end). Dates or epoch ms; a bad instant never does. */
export function inRange(iso, start, end) {
  const t = Date.parse(iso ?? '')
  return Number.isFinite(t) && t >= ms(start) && t < ms(end)
}

/**
 * The period's task lists. `done`: finished inside it, newest first, visits
 * left out. `visitsDone`: the visits logged inside it. `slipped`: still open,
 * due inside it, and that time has passed. `range` is { start, end }, end
 * exclusive. A bill is a task and counts like one; a wishlist item is not open.
 */
export function reviewLists(tasks, range, now = new Date()) {
  const nowMs = ms(now)
  const doneAll = (tasks ?? [])
    .filter(t => t.status === 'done' && inRange(t.completedAt, range.start, range.end))
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
  return {
    done: doneAll.filter(t => !isVisit(t)),
    visitsDone: doneAll.filter(isVisit),
    slipped: (tasks ?? []).filter(t => OPEN.includes(t.status) && inRange(t.dueAt, range.start, range.end) && Date.parse(t.dueAt) < nowMs),
  }
}

/**
 * Who you saw in the period, most days first: each person with their visits
 * in it and the days those fell on. `seen` is what seenTasks gives (the tasks,
 * and your own past events as the visits they amount to); `dayKeyOf` turns an
 * instant into YYYY-MM-DD in the reader's zone.
 */
export function peopleSeen(people, seen, range, dayKeyOf) {
  return (people ?? [])
    .map(p => {
      const visits = visitsFor(p.id, seen).filter(v => inRange(v.at, range.start, range.end))
      return { person: p, visits: visits.map(v => v.task), days: visitDays(visits, dayKeyOf).length }
    })
    .filter(x => x.visits.length > 0)
    .sort((a, b) => b.days - a.days || b.visits.length - a.visits.length)
}
